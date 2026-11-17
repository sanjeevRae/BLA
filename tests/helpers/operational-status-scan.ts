import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Write-aware source scan for the package-lifecycle invariant:
 * `package-lifecycle.ts` is the ONLY service allowed to WRITE a
 * package's `operationalStatus`. The original guard was a flat regex
 * (/operationalStatus:\s*"[A-Z_]+"/) which could not tell a write from
 * a read — it flagged a legitimate `where:` filter literal in
 * warehouse-home.ts (a `prisma…count()` read introduced in V3 Step 5).
 *
 * This scanner tokenises the source (comments and string contents are
 * never mistaken for code) and tracks object-literal context, so a
 * status literal is reported ONLY in a write context:
 *
 *  - inside a `data:` / `create:` / `update:` payload object — the
 *    Prisma write shapes (create / update / updateMany / upsert,
 *    including nested relation writes such as
 *    `data: { packages: { create: { … } } }`), unless a read key
 *    (`where`, `orderBy`, `select`, `include`, …) intervenes between
 *    the payload key and the literal (e.g. the `where:` of the same
 *    update call stays a read);
 *  - inside an object literal assigned to a payload variable
 *    (`const data = { … }`, `const updateData = { … }`,
 *    `const payload = { … }`) that is later handed to a write call;
 *  - directly as the argument object of a Prisma write call
 *    (`update({ operationalStatus: "…" })`);
 *  - as a direct assignment (`pkg.operationalStatus = "…"`).
 *
 * Read contexts — `where:` filters (however deeply nested), `orderBy`,
 * `select`, comparisons (`===`), audit/view mappings built from
 * variables — are allowed, exactly as the services use them today.
 */

export interface OperationalStatusWrite {
  file: string;
  line: number;
  literal: string;
  context: string;
}

const WRITE_PAYLOAD_KEYS = new Set(["data", "create", "update"]);
const READ_KEYS = new Set([
  "where",
  "orderBy",
  "select",
  "include",
  "is",
  "some",
  "every",
  "none",
  "filter",
  "having",
  "cursor",
  "by",
]);
const WRITE_CALLS = new Set(["create", "createMany", "update", "updateMany", "upsert"]);
const STATUS_LITERAL = /^[A-Z][A-Z0-9_]*$/;

type Token =
  | { type: "ident"; value: string; line: number }
  | { type: "string"; value: string; line: number }
  | { type: "punct"; value: string; line: number };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const n = source.length;
  const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
  const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c);

  while (i < n) {
    const c = source[i];
    if (c === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i += 1;
      continue;
    }
    // Comments.
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    // Strings and template literals (contents are data, not code).
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const startLine = line;
      let value = "";
      i += 1;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\") {
          value += source[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (source[i] === "\n") line += 1;
        value += source[i];
        i += 1;
      }
      i += 1;
      tokens.push({ type: "string", value, line: startLine });
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdentPart(source[i])) i += 1;
      tokens.push({ type: "ident", value: source.slice(start, i), line });
      continue;
    }
    // Multi-character operators that must not be read as `=`.
    const three = source.slice(i, i + 3);
    if (three === "===" || three === "!==" || three === "...") {
      tokens.push({ type: "punct", value: three, line });
      i += 3;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === "=>" || two === ">=" || two === "<=") {
      tokens.push({ type: "punct", value: two, line });
      i += 2;
      continue;
    }
    tokens.push({ type: "punct", value: c, line });
    i += 1;
  }
  return tokens;
}

interface Frame {
  kind: "brace" | "paren" | "bracket";
  /** Property key this object literal sits under (`data`, `where`, …). */
  key: string | null;
  /** Variable name this object literal is assigned to, if any. */
  assignName: string | null;
  /** Method name when this paren is a call's argument list. */
  callName: string | null;
}

function isPayloadVarName(name: string): boolean {
  return name === "data" || name === "payload" || name.endsWith("Data");
}

/** Scan one source string; returns every write-context status literal. */
export function scanSourceForStatusWrites(
  source: string,
  file: string,
): OperationalStatusWrite[] {
  const tokens = tokenize(source);
  const hits: OperationalStatusWrite[] = [];
  const stack: Frame[] = [];

  const at = (idx: number): Token | undefined => tokens[idx];

  for (let t = 0; t < tokens.length; t += 1) {
    const tok = tokens[t];

    if (tok.type === "punct") {
      if (tok.value === "{") {
        // Determine the key/assignment context from preceding tokens.
        let key: string | null = null;
        let assignName: string | null = null;
        const prev = at(t - 1);
        const prev2 = at(t - 2);
        if (prev?.type === "punct" && prev.value === ":" && prev2 && prev2.type !== "punct") {
          key = prev2.value;
        } else if (
          prev?.type === "punct" &&
          prev.value === "=" &&
          prev2?.type === "ident"
        ) {
          assignName = prev2.value;
        }
        stack.push({ kind: "brace", key, assignName, callName: null });
        continue;
      }
      if (tok.value === "(") {
        const prev = at(t - 1);
        stack.push({
          kind: "paren",
          key: null,
          assignName: null,
          callName: prev?.type === "ident" ? prev.value : null,
        });
        continue;
      }
      if (tok.value === "[") {
        stack.push({ kind: "bracket", key: null, assignName: null, callName: null });
        continue;
      }
      if (tok.value === "}" || tok.value === ")" || tok.value === "]") {
        const want = tok.value === "}" ? "brace" : tok.value === ")" ? "paren" : "bracket";
        // Pop to the matching frame (tolerant of imbalance).
        for (let s = stack.length - 1; s >= 0; s -= 1) {
          if (stack[s].kind === want) {
            stack.length = s;
            break;
          }
        }
        continue;
      }
    }

    if (tok.type === "ident" && tok.value === "operationalStatus") {
      const next = at(t + 1);
      const after = at(t + 2);
      // Direct assignment: `operationalStatus = "LITERAL"`.
      if (
        next?.type === "punct" &&
        next.value === "=" &&
        after?.type === "string" &&
        STATUS_LITERAL.test(after.value)
      ) {
        hits.push({
          file,
          line: tok.line,
          literal: after.value,
          context: "direct assignment",
        });
        continue;
      }
      // Object member: `operationalStatus: "LITERAL"`.
      if (
        next?.type === "punct" &&
        next.value === ":" &&
        after?.type === "string" &&
        STATUS_LITERAL.test(after.value)
      ) {
        const context = writeContextOf(stack);
        if (context) {
          hits.push({ file, line: tok.line, literal: after.value, context });
        }
      }
    }
  }
  return hits;
}

/**
 * Walk the frame stack from the innermost outward. The first KEYED
 * brace frame decides: a payload key means write, a read key means
 * read, any other key (relation names, view fields) is neutral and
 * the walk continues. An unkeyed object that is the direct argument
 * of a Prisma write call is a write; a payload variable assignment
 * counts as its payload key.
 */
function writeContextOf(stack: Frame[]): string | null {
  let unkeyedBracesOnly = true;
  for (let s = stack.length - 1; s >= 0; s -= 1) {
    const frame = stack[s];
    if (frame.kind === "paren") {
      if (unkeyedBracesOnly && frame.callName && WRITE_CALLS.has(frame.callName)) {
        return `argument of ${frame.callName}()`;
      }
      // Any other call boundary ends the "direct argument" reading,
      // but keyed frames further out (e.g. an enclosing `data:`) can
      // still decide — keep walking.
      unkeyedBracesOnly = false;
      continue;
    }
    if (frame.kind !== "brace") continue;
    const key = frame.key ?? (frame.assignName && isPayloadVarName(frame.assignName) ? "data" : frame.assignName);
    if (key == null) continue;
    if (WRITE_PAYLOAD_KEYS.has(key)) return `${key}: payload`;
    if (READ_KEYS.has(key)) return null;
    // Neutral key (relation name, view field, audit before/after…):
    // it breaks the direct-argument reading but not the walk.
    unkeyedBracesOnly = false;
  }
  return null;
}

/**
 * Scan every top-level `.ts` service file (the lifecycle service
 * itself excluded — it is the one legitimate writer).
 */
export function findOperationalStatusWrites(servicesDir: string): OperationalStatusWrite[] {
  const hits: OperationalStatusWrite[] = [];
  for (const file of readdirSync(servicesDir)) {
    if (!file.endsWith(".ts") || file === "package-lifecycle.ts") continue;
    const source = readFileSync(join(servicesDir, file), "utf8");
    hits.push(...scanSourceForStatusWrites(source, file));
  }
  return hits;
}
