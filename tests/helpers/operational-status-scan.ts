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
 * V3 Step 7 review hardening (coordinator fix for review findings
 * F-1/F-2): the first write-aware version only flagged literals in
 * PROVEN write contexts, which a future write could evade through
 * indirection (a patch object under a non-payload variable name, a
 * helper's return value, `Object.assign`, a computed key, a bracket
 * assignment, a non-literal/enum value, or a regex literal confusing
 * the tokeniser). The rule is now asymmetric:
 *
 *  - A status LITERAL (`operationalStatus: "DELIVERED"`, in any
 *    object literal, under a plain or computed key) is reported
 *    UNLESS the enclosing context is a PROVEN read: a `where` /
 *    `orderBy` / `select` / `include` / relation-filter key chain, a
 *    `where`/`filter`-named variable, or a type declaration. A bare
 *    object literal is not a read — in service code an object
 *    carrying a status literal is a payload, a patch, or a fake
 *    view, and all three are the lifecycle service's business.
 *  - A NON-literal value (`operationalStatus: nextStatus`,
 *    `operationalStatus: Status.DELIVERED`) is reported only in a
 *    PROVEN write context (Prisma `data`/`create`/`update` payload,
 *    payload-named variable, direct argument of a write call) —
 *    view/audit mappings built from variables stay legal everywhere.
 *  - Direct assignments (`pkg.operationalStatus = …`,
 *    `pkg["operationalStatus"] = …`) are always writes.
 *
 * Proven read/write contexts are decided by walking the tokenised
 * frame stack (comments, strings and regex literals are never
 * mistaken for code). Residual, documented: a non-literal value in a
 * bare object handed through multi-hop dataflow to a write call is
 * not statically provable and stays unflagged — the literal and
 * payload shapes a real regression would take are all caught.
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
/** Variable names that mark an object literal as a read filter. */
const READ_VAR_NAMES = new Set(["where", "filter"]);
const WRITE_CALLS = new Set(["create", "createMany", "update", "updateMany", "upsert"]);
const STATUS_LITERAL = /^[A-Z][A-Z0-9_]*$/;
/** Idents after which a `/` opens a regex literal rather than division. */
const REGEX_PREFIX_IDENTS = new Set([
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "instanceof",
  "yield",
  "await",
]);
const REGEX_PREFIX_PUNCTS = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  "}",
  ";",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
  "<",
  ">",
  "=>",
]);

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
    // Regex literals: a `/` where a value cannot precede it starts a
    // regex, whose body (including any `//`-looking text) is data.
    if (c === "/") {
      const prev = tokens[tokens.length - 1];
      const regexHere =
        !prev ||
        (prev.type === "punct" && REGEX_PREFIX_PUNCTS.has(prev.value)) ||
        (prev.type === "ident" && REGEX_PREFIX_IDENTS.has(prev.value));
      if (regexHere) {
        const startLine = line;
        i += 1;
        let inClass = false;
        while (i < n) {
          const ch = source[i];
          if (ch === "\\") {
            i += 2;
            continue;
          }
          if (ch === "\n") break;
          if (ch === "[") inClass = true;
          else if (ch === "]") inClass = false;
          else if (ch === "/" && !inClass) break;
          i += 1;
        }
        i += 1; // closing slash
        while (i < n && isIdentPart(source[i])) i += 1; // flags
        tokens.push({ type: "string", value: "<regex>", line: startLine });
        continue;
      }
      tokens.push({ type: "punct", value: "/", line });
      i += 1;
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
  /** True for `interface … {` / `type … = {` declaration bodies. */
  isTypeDecl: boolean;
}

function isPayloadVarName(name: string): boolean {
  return name === "data" || name === "payload" || name.endsWith("Data");
}

type Classification =
  | { kind: "write"; context: string }
  | { kind: "read" }
  | { kind: "bare" };

/**
 * Walk the frame stack from the innermost outward. The first KEYED
 * brace frame decides: a payload key means write, a read key means
 * read, any other key (relation names, view fields) is neutral and
 * the walk continues. An unkeyed object that is the direct argument
 * of a Prisma write call is a write; a payload-named variable counts
 * as its payload key, a `where`/`filter`-named variable as a read.
 * If nothing decides, the object is "bare" — not a proven read.
 */
function classify(stack: Frame[]): Classification {
  let unkeyedBracesOnly = true;
  let crossedNeutral = false;
  for (let s = stack.length - 1; s >= 0; s -= 1) {
    const frame = stack[s];
    if (frame.kind === "paren") {
      if (unkeyedBracesOnly && frame.callName && WRITE_CALLS.has(frame.callName)) {
        return { kind: "write", context: `argument of ${frame.callName}()` };
      }
      // Any other call boundary ends the "direct argument" reading,
      // but keyed frames further out (e.g. an enclosing `data:`) can
      // still decide — keep walking.
      unkeyedBracesOnly = false;
      continue;
    }
    if (frame.kind !== "brace") continue;
    if (frame.isTypeDecl) return { kind: "read" };
    const key =
      frame.key ??
      (frame.assignName == null
        ? null
        : isPayloadVarName(frame.assignName)
          ? "data"
          : READ_VAR_NAMES.has(frame.assignName)
            ? "where"
            : frame.assignName);
    if (key == null) continue;
    if (WRITE_PAYLOAD_KEYS.has(key)) {
      // A payload key proves a write only for the payload's OWN
      // fields. Once a neutral key intervenes (an audit `before:` /
      // `after:` snapshot inside an auditLog `data:`, a view field),
      // the member is a sub-object's field, not a payload field —
      // the classification degrades to "bare" (literals still
      // flagged, non-literal mappings allowed). Relation write keys
      // (`create:`/`update:` under a relation name) are met BEFORE
      // the relation's neutral key on the walk out, so nested
      // relation writes still classify as writes.
      if (crossedNeutral) return { kind: "bare" };
      return { kind: "write", context: `${key}: payload` };
    }
    if (READ_KEYS.has(key)) return { kind: "read" };
    // Neutral key (relation name, view field, audit before/after…):
    // it breaks the direct-argument reading but not the walk.
    unkeyedBracesOnly = false;
    crossedNeutral = true;
  }
  return { kind: "bare" };
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
  const isPunct = (tok: Token | undefined, value: string) =>
    tok?.type === "punct" && tok.value === value;

  // Identifiers aliased to the property name itself:
  // `const key = "operationalStatus"` makes `[key]:` a status key.
  const keyAliases = new Set<string>();
  for (let t = 0; t + 2 < tokens.length; t += 1) {
    const name = tokens[t];
    if (
      name.type === "ident" &&
      isPunct(at(t + 1), "=") &&
      at(t + 2)?.type === "string" &&
      at(t + 2)?.value === "operationalStatus"
    ) {
      keyAliases.add(name.value);
    }
  }
  const isStatusKeyToken = (tok: Token | undefined) =>
    (tok?.type === "string" && tok.value === "operationalStatus") ||
    (tok?.type === "ident" && keyAliases.has(tok.value));

  const recordMember = (line: number, valueTok: Token | undefined) => {
    const isStatusLiteral =
      valueTok?.type === "string" && STATUS_LITERAL.test(valueTok.value);
    const cls = classify(stack);
    if (isStatusLiteral) {
      // A status literal is a write unless the context is a proven read.
      if (cls.kind === "write") {
        hits.push({ file, line, literal: valueTok.value, context: cls.context });
      } else if (cls.kind === "bare") {
        hits.push({
          file,
          line,
          literal: valueTok.value,
          context: "object literal outside a proven read context",
        });
      }
    } else if (cls.kind === "write") {
      // Non-literal values are writes only in proven write contexts.
      hits.push({
        file,
        line,
        literal:
          valueTok?.type === "string" ? valueTok.value : "<non-literal value>",
        context: cls.context,
      });
    }
  };

  for (let t = 0; t < tokens.length; t += 1) {
    const tok = tokens[t];

    if (tok.type === "punct") {
      if (tok.value === "{") {
        // Determine the key/assignment context from preceding tokens.
        let key: string | null = null;
        let assignName: string | null = null;
        let isTypeDecl = false;
        const prev = at(t - 1);
        const prev2 = at(t - 2);
        const prev3 = at(t - 3);
        if (isPunct(prev, ":") && prev2 && prev2.type !== "punct") {
          key = prev2.value;
        } else if (isPunct(prev, "=") && prev2?.type === "ident") {
          assignName = prev2.value;
          if (prev3?.type === "ident" && prev3.value === "type") isTypeDecl = true;
        }
        if (prev?.type === "ident" && prev2?.type === "ident" && prev2.value === "interface") {
          isTypeDecl = true;
        }
        stack.push({ kind: "brace", key, assignName, callName: null, isTypeDecl });
        continue;
      }
      if (tok.value === "(") {
        const prev = at(t - 1);
        stack.push({
          kind: "paren",
          key: null,
          assignName: null,
          callName: prev?.type === "ident" ? prev.value : null,
          isTypeDecl: false,
        });
        continue;
      }
      if (tok.value === "[") {
        stack.push({ kind: "bracket", key: null, assignName: null, callName: null, isTypeDecl: false });
        // Bracket assignment: `pkg["operationalStatus"] = …`.
        if (isStatusKeyToken(at(t + 1)) && isPunct(at(t + 2), "]") && isPunct(at(t + 3), "=")) {
          const valueTok = at(t + 4);
          hits.push({
            file,
            line: tok.line,
            literal:
              valueTok?.type === "string" ? valueTok.value : "<non-literal value>",
            context: "direct assignment",
          });
        }
        // Computed-key property: `["operationalStatus"]: value` /
        // `[keyAlias]: value` inside an object literal.
        if (isStatusKeyToken(at(t + 1)) && isPunct(at(t + 2), "]") && isPunct(at(t + 3), ":")) {
          recordMember(tok.line, at(t + 4));
        }
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
      // Direct assignment: `operationalStatus = …` (any value form).
      if (isPunct(next, "=")) {
        const valueTok = at(t + 2);
        hits.push({
          file,
          line: tok.line,
          literal:
            valueTok?.type === "string" ? valueTok.value : "<non-literal value>",
          context: "direct assignment",
        });
        continue;
      }
      // Object member: `operationalStatus: value` — but not a member
      // ACCESS (`pkg.operationalStatus`), whose preceding token is `.`.
      if (isPunct(next, ":") && !isPunct(at(t - 1), ".")) {
        recordMember(tok.line, at(t + 2));
      }
    }
  }
  return hits;
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
