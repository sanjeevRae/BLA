/**
 * Generate src/lib/openapi/spec.json from the real route tree.
 *
 *   npm run openapi:generate
 *
 * The operation set (method + path) comes from
 * src/lib/openapi/route-scan.ts — the same scanner the anti-drift test
 * uses — so the spec cannot invent or lose endpoints. Summaries are
 * taken from the route files' own doc comments
 * (`METHOD /api/path — description`), with a small curated override
 * map for routes whose comments do not carry a per-method line.
 * Zod schema names are traced factually: route handler → imported
 * service function → schemas that function parses with. Nothing about
 * request/response payloads is invented; where no schema is traced,
 * the operation simply carries no field list.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  scanApiRoutes,
  type ScannedOperation,
} from "../src/lib/openapi/route-scan";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_PATH = path.join(repoRoot, "src", "lib", "openapi", "spec.json");

/** Areas (first path segment) → Swagger tag. */
const TAGS: Record<string, { name: string; description: string }> = {
  auth: { name: "Auth", description: "Auth.js authentication handlers (sign-in, callback, session, sign-out)." },
  bookings: { name: "Bookings", description: "Booking creation, bulk import and booking detail." },
  deliveries: { name: "Deliveries", description: "Delivery batches, assignments, attempts and proof of delivery." },
  finance: { name: "Finance", description: "Invoices, payments, ledger, COD, remittances, settlements, refunds and adjustments." },
  incidents: { name: "Incidents", description: "Operational incident reporting and follow-up." },
  "live-operations": { name: "Live Operations", description: "The live operations board: active trips, drivers and positions." },
  me: { name: "Current User", description: "The signed-in user's own actor context." },
  notifications: { name: "Notifications", description: "In-app notifications for the signed-in user." },
  operations: { name: "Warehouse Operations", description: "Receiving, inventory, custody scans and shift handovers." },
  packages: { name: "Packages", description: "Package detail and lifecycle." },
  public: { name: "Public", description: "Unauthenticated public endpoints." },
  reports: { name: "Reports", description: "Operational and financial reports, including CSV export." },
  returns: { name: "Returns", description: "Return-to-sender / return-to-vendor flows." },
  search: { name: "Search", description: "Command-menu record search." },
  support: { name: "Support", description: "Customer support tickets and their actions." },
  tasks: { name: "Tasks", description: "Warehouse and operations task management." },
  track: { name: "Public Tracking", description: "Public parcel tracking (unauthenticated; the detailed view is phone-gated)." },
  tracking: { name: "Driver Tracking", description: "Driver GPS tracking sessions and location pings." },
  transfers: { name: "Transfers", description: "Inter-warehouse transfers and their receiving flow." },
  trips: { name: "Trips", description: "Line-haul trip actions." },
  vendors: { name: "Vendors", description: "Vendor directory reads." },
  warehouses: { name: "Warehouses", description: "Warehouse directory reads." },
  "docs.json": { name: "API Docs", description: "This OpenAPI document itself (admin-gated)." },
};

/** Path prefixes reachable without a session (by design). */
const PUBLIC_PREFIXES = ["/api/auth/", "/api/public/", "/api/track/"];

/** Summary overrides where a route's doc comment has no per-method line. */
const SUMMARY_OVERRIDES: Record<string, string> = {
  "GET /api/auth/{nextauth}":
    "Auth.js handler — sign-in, OAuth callback, session and sign-out endpoints.",
  "POST /api/auth/{nextauth}":
    "Auth.js handler — sign-in, OAuth callback, session and sign-out endpoints.",
  "GET /api/docs.json":
    "This OpenAPI specification document (admin-gated, like the /api/docs UI).",
};

const PARAM_DESCRIPTIONS: Record<string, string> = {
  id: "Identifier of the resource (as used by the route).",
  trackingId: "Public tracking code of the package (e.g. BLA-…).",
  trackingSessionId: "Identifier of the driver's tracking session.",
  name: "Report name.",
  nextauth: "Auth.js catch-all route segment (e.g. signin, callback, session, signout).",
};

function tagFor(apiPath: string): { key: string; name: string; description: string } {
  const segment = apiPath.split("/")[2] ?? "";
  const tag = TAGS[segment];
  if (tag) return { key: segment, ...tag };
  const name = segment
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return { key: segment, name, description: `${name} endpoints.` };
}

function isPublic(apiPath: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => apiPath.startsWith(prefix));
}

/** Convert a doc-comment path (/api/track/[trackingId]) to spec form. */
function commentPathToSpec(raw: string): string {
  return raw.split("?")[0].replace(/\[(\.\.\.)?([^\]]+)\]/g, "{$2}");
}

/**
 * Extract per-method summaries from a route file's block comments:
 * lines of the form `METHOD /api/path — text`, joining wrapped
 * continuation lines until the sentence closes.
 */
function extractCommentSummaries(source: string): Map<string, string> {
  const summaries = new Map<string, string>();
  const commentBlocks = source.match(/\/\*[\s\S]*?\*\//g) ?? [];
  for (const block of commentBlocks) {
    const lines = block
      .split("\n")
      .map((l) => l.replace(/^\s*\/?\*+\/?/, "").trim());
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/\S+)\s+—\s*(.*)$/);
      if (!m) continue;
      let text = m[3].trim();
      let j = i + 1;
      // The description may start on the following line (`… —\n * text`).
      if (!text && j < lines.length) {
        text = lines[j];
        j++;
      }
      const parenDepth = (s: string) =>
        (s.match(/\(/g) ?? []).length - (s.match(/\)/g) ?? []).length;
      while (
        j < lines.length &&
        lines[j] !== "" &&
        !/^(GET|POST|PUT|PATCH|DELETE)\s+\/api\//.test(lines[j]) &&
        (parenDepth(text) > 0 || !/[.!?…]$/.test(text.replace(/;$/, ".")))
      ) {
        text += " " + lines[j];
        j++;
      }
      text = text
        .replace(/\s+/g, " ")
        .replace(/\*+\/\s*$/, "")
        .replace(/[;\s]+$/, "")
        .trim();
      if (text.length > 220) {
        const cut = text.lastIndexOf(". ", 220);
        text = cut > 80 ? text.slice(0, cut + 1) : text.slice(0, 217).trimEnd() + "…";
      }
      const key = `${m[1]} ${commentPathToSpec(m[2])}`;
      if (!summaries.has(key)) summaries.set(key, text);
    }
  }
  return summaries;
}

/** Fallback summary derived from method + path when no comment exists. */
function derivedSummary(op: ScannedOperation): string {
  const segments = op.path.split("/").filter(Boolean).slice(1); // drop "api"
  const last = [...segments].reverse().find((s) => !s.startsWith("{")) ?? "resource";
  const verbs: Record<string, string> = {
    GET: "Retrieve",
    POST: "Submit",
    PUT: "Replace",
    PATCH: "Update",
    DELETE: "Delete",
  };
  const verb = verbs[op.method] ?? "Call";
  return `${verb} — ${segments.join(" / ")}${last ? "" : ""} (${op.routeFile})`;
}

/** Extract the body of an exported function from a service module. */
function extractFunctionBody(source: string, name: string): string | null {
  const patterns = [
    new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`),
    new RegExp(`export\\s+const\\s+${name}\\s*=`),
  ];
  for (const pattern of patterns) {
    const m = source.match(pattern);
    if (!m || m.index === undefined) continue;
    const open = source.indexOf("{", m.index);
    if (open === -1) continue;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") {
        depth--;
        if (depth === 0) return source.slice(open, i + 1);
      }
    }
  }
  return null;
}

/**
 * Trace Zod schemas for one route file: identifiers it imports from
 * @/server/services/* and calls, then the `XSchema.parse/safeParse`
 * uses inside those functions' bodies.
 */
function traceSchemas(routeSource: string): string[] {
  const schemas = new Set<string>();
  const importRe = /import\s*\{([^}]*)\}\s*from\s*"(@\/server\/services\/[a-z0-9-]+)"/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(routeSource)) !== null) {
    const names = im[1]
      .split(",")
      .map((n) => n.trim().split(/\s+as\s+/).pop()!.trim())
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
    const modulePath = path.join(
      repoRoot,
      "src",
      im[2].replace("@/", "") + ".ts",
    );
    let moduleSource: string;
    try {
      moduleSource = readFileSync(modulePath, "utf8");
    } catch {
      continue;
    }
    for (const name of names) {
      if (!new RegExp(`\\b${name}\\s*\\(`).test(routeSource)) continue;
      const body = extractFunctionBody(moduleSource, name);
      if (!body) continue;
      // Services validate via `Schema.parse(...)` / `.safeParse(...)`
      // and via the shared `parse(Schema, input)` helper.
      for (const sm of body.matchAll(/(\w+Schema)\.(?:safeParse|parse)\s*\(/g)) {
        schemas.add(sm[1]);
      }
      for (const sm of body.matchAll(/\bparse\(\s*(\w+Schema)\b/g)) {
        schemas.add(sm[1]);
      }
    }
  }
  return [...schemas].sort();
}

function errorResponse(description: string) {
  return {
    description,
    content: {
      "application/json": { schema: { $ref: "#/components/schemas/Error" } },
    },
  };
}

function buildOperation(op: ScannedOperation, routeSource: string) {
  const tag = tagFor(op.path);
  const commentSummaries = extractCommentSummaries(routeSource);
  const key = `${op.method} ${op.path}`;
  const summary =
    SUMMARY_OVERRIDES[key] ?? commentSummaries.get(key) ?? derivedSummary(op);
  const schemas = traceSchemas(routeSource);
  const pub = isPublic(op.path);
  const readsBody = /request\.json\(\)|req\.json\(\)|\.formData\(\)/.test(routeSource);
  const returns201 = /status:\s*201/.test(routeSource);
  const returns204 = /status:\s*204/.test(routeSource);

  const descriptionParts: string[] = [];
  if (schemas.length) {
    descriptionParts.push(
      `Request validated with the ${schemas
        .map((s) => `\`${s}\``)
        .join(", ")} Zod schema${schemas.length > 1 ? "s" : ""} in the service layer.`,
    );
  }
  if (pub && op.path.startsWith("/api/track/")) {
    descriptionParts.push("Public endpoint — no session required.");
  } else if (pub && op.path.startsWith("/api/public/")) {
    descriptionParts.push("Public endpoint — no session required.");
  } else if (pub) {
    descriptionParts.push("Auth.js endpoint — establishes or clears the session.");
  }

  const parameters: unknown[] = op.params.map((name) => ({
    name,
    in: "path",
    required: true,
    description: PARAM_DESCRIPTIONS[name] ?? "Path parameter.",
    schema: { type: "string" },
  }));
  const queryNames = new Set<string>();
  for (const qm of routeSource.matchAll(/searchParams\.get\(\s*["']([\w-]+)["']\s*\)/g)) {
    queryNames.add(qm[1]);
  }
  for (const name of [...queryNames].sort()) {
    parameters.push({
      name,
      in: "query",
      required: false,
      schema: { type: "string" },
    });
  }

  const responses: Record<string, unknown> = {};
  if (returns204) {
    responses["204"] = { description: "Success — no content." };
  } else if (returns201) {
    responses["201"] = {
      description: "Created.",
      content: { "application/json": {} },
    };
  } else {
    responses["200"] = {
      description: "Success.",
      content: { "application/json": {} },
    };
  }
  if (op.method !== "GET" || schemas.length > 0) {
    responses["400"] = errorResponse("Validation or business-rule error.");
  }
  if (!pub) {
    responses["401"] = errorResponse("No valid session.");
    responses["403"] = errorResponse("The caller's role or permissions do not allow this operation.");
  }
  if (op.params.length > 0) {
    responses["404"] = errorResponse("Resource not found.");
  }

  const operation: Record<string, unknown> = {
    tags: [tag.name],
    summary,
    operationId: key.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, ""),
    responses,
  };
  if (descriptionParts.length) operation.description = descriptionParts.join(" ");
  if (parameters.length) operation.parameters = parameters;
  if (readsBody && op.method !== "GET") {
    operation.requestBody = {
      required: true,
      content: { "application/json": {} },
    };
  }
  if (pub) operation.security = [];
  return operation;
}

function main(): void {
  const operations = scanApiRoutes(repoRoot);
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    version: string;
  };

  const paths: Record<string, Record<string, unknown>> = {};
  const usedTags = new Map<string, string>();
  for (const op of operations) {
    const routeSource = readFileSync(path.join(repoRoot, op.routeFile), "utf8");
    const tag = tagFor(op.path);
    usedTags.set(tag.name, tag.description);
    paths[op.path] ??= {};
    paths[op.path][op.method.toLowerCase()] = buildOperation(op, routeSource);
  }

  const spec = {
    openapi: "3.0.3",
    info: {
      title: "BLA Logistics API",
      version: pkg.version,
      description:
        "API for the BLA delivery-operations platform. Generated from the route tree " +
        "(scripts/generate-openapi.ts) — regenerate with `npm run openapi:generate` after " +
        "adding or changing routes; tests/unit/openapi-spec.test.ts fails on drift.\n\n" +
        "Authentication is a session cookie issued by the app's own sign-in (Auth.js " +
        "database sessions — there is no JWT and no API key). Sign in through the BLA " +
        "login page in this browser first, then use Try it out: requests go to the same " +
        "origin with your existing session. These documentation pages themselves require " +
        "a SUPER_ADMIN or ADMIN session and, in production, API_DOCS_ENABLED=true.",
    },
    servers: [{ url: "/", description: "Same origin as this page" }],
    tags: [...usedTags.entries()]
      .map(([name, description]) => ({ name, description }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    security: [{ sessionCookie: [] }],
    paths,
    components: {
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "authjs.session-token",
          description:
            "Auth.js database-session cookie set by the BLA sign-in flow " +
            "(`__Secure-authjs.session-token` when the app is served over HTTPS). " +
            "HttpOnly; 7-day lifetime. There is no token to paste here — sign in " +
            "via the app's login page and the browser sends this cookie itself.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: {
                  type: "string",
                  description:
                    "Machine-readable error code (e.g. UNAUTHENTICATED, FORBIDDEN, NOT_FOUND, VALIDATION).",
                },
                message: { type: "string", description: "Human-readable detail." },
              },
            },
          },
        },
      },
    },
  };

  writeFileSync(SPEC_PATH, JSON.stringify(spec, null, 2) + "\n", "utf8");

  const byMethod = new Map<string, number>();
  for (const op of operations) byMethod.set(op.method, (byMethod.get(op.method) ?? 0) + 1);
  const breakdown = [...byMethod.entries()]
    .map(([m, n]) => `${m} ${n}`)
    .join(", ");
  console.log(
    `Wrote ${path.relative(repoRoot, SPEC_PATH)}: ${operations.length} operations ` +
      `across ${Object.keys(paths).length} paths (${breakdown}).`,
  );

  const missing = operations.filter((op) => {
    const src = readFileSync(path.join(repoRoot, op.routeFile), "utf8");
    const key = `${op.method} ${op.path}`;
    return !SUMMARY_OVERRIDES[key] && !extractCommentSummaries(src).has(key);
  });
  if (missing.length) {
    console.log("Operations using derived fallback summaries:");
    for (const op of missing) console.log(`  ${op.method} ${op.path} (${op.routeFile})`);
  }
}

main();
