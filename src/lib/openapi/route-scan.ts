/**
 * Route-tree scanner for the OpenAPI generator and its anti-drift test.
 *
 * This is TOOLING code: it is imported only by scripts/generate-openapi.ts
 * (run with tsx) and by tests/unit/openapi-*.test.ts. It must never be
 * imported by runtime application code — it reads the filesystem and
 * derives the API surface from src/app/api/**\/route.ts so the committed
 * spec can never silently drift from the real routes.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ScannedOperation {
  /** Uppercase HTTP method, e.g. "GET". */
  method: HttpMethod;
  /** OpenAPI path, e.g. "/api/bookings/{id}". */
  path: string;
  /** Path parameter names in order of appearance, e.g. ["id"]. */
  params: string[];
  /** Repo-relative route file, e.g. "src/app/api/bookings/route.ts". */
  routeFile: string;
}

function walkRouteFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walkRouteFiles(full, out);
    } else if (entry === "route.ts") {
      out.push(full);
    }
  }
}

const METHOD_PATTERNS: Array<{ method: HttpMethod; pattern: RegExp }> = [
  ...HTTP_METHODS.map((method) => ({
    method,
    pattern: new RegExp(
      `export\\s+(?:async\\s+)?function\\s+${method}\\b|export\\s+const\\s+${method}\\b`,
    ),
  })),
];

/** Extract the exported HTTP methods of one route file's source. */
export function extractMethods(source: string): HttpMethod[] {
  const found = new Set<HttpMethod>();
  for (const { method, pattern } of METHOD_PATTERNS) {
    if (pattern.test(source)) found.add(method);
  }
  // Destructured handler exports, e.g. Auth.js:
  //   export const { GET, POST } = handlers;
  const destructured = source.match(/export\s+const\s*\{\s*([^}]*)\}\s*=/);
  if (destructured) {
    for (const name of destructured[1].split(",")) {
      const trimmed = name.trim();
      if ((HTTP_METHODS as readonly string[]).includes(trimmed)) {
        found.add(trimmed as HttpMethod);
      }
    }
  }
  return HTTP_METHODS.filter((m) => found.has(m));
}

/** Convert one route-directory segment to its OpenAPI form. */
function toPathSegment(segment: string, params: string[]): string {
  const catchAll = segment.match(/^\[\.\.\.([^\]]+)\]$/);
  if (catchAll) {
    params.push(catchAll[1]);
    return `{${catchAll[1]}}`;
  }
  const dynamic = segment.match(/^\[([^\]]+)\]$/);
  if (dynamic) {
    params.push(dynamic[1]);
    return `{${dynamic[1]}}`;
  }
  return segment;
}

/**
 * Scan src/app/api under `repoRoot` and return every API operation,
 * sorted by path then by the canonical method order.
 */
export function scanApiRoutes(repoRoot: string): ScannedOperation[] {
  const apiRoot = path.join(repoRoot, "src", "app", "api");
  const files: string[] = [];
  walkRouteFiles(apiRoot, files);
  files.sort();

  const operations: ScannedOperation[] = [];
  for (const file of files) {
    const relative = path.relative(path.join(repoRoot, "src", "app", "api"), file);
    const segments = path.dirname(relative).split(path.sep).filter((s) => s !== ".");
    const params: string[] = [];
    const pathSegments = segments.map((s) => toPathSegment(s, params));
    const apiPath = "/api" + (pathSegments.length ? "/" + pathSegments.join("/") : "");
    const source = readFileSync(file, "utf8");
    for (const method of extractMethods(source)) {
      operations.push({
        method,
        path: apiPath,
        params: [...params],
        routeFile: path.relative(repoRoot, file).split(path.sep).join("/"),
      });
    }
  }

  operations.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method);
  });
  return operations;
}
