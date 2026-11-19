import { describe, expect, it } from "vitest";

import spec from "@/lib/openapi/spec.json";
import { scanApiRoutes } from "@/lib/openapi/route-scan";

/**
 * OpenAPI spec guards (docs/api-docs.md):
 *  - sanity: the committed spec is structurally valid OpenAPI 3 with
 *    the session-cookie scheme and the shared Error envelope;
 *  - anti-drift: the operation set in the spec is EXACTLY the set the
 *    route tree exports — a route added, removed or renamed without
 *    regenerating (npm run openapi:generate) fails here.
 */

interface SpecOperation {
  summary?: string;
  tags?: string[];
  security?: unknown[];
  parameters?: Array<{ name: string; in: string; required?: boolean }>;
  responses?: Record<string, unknown>;
}

const specPaths = spec.paths as unknown as Record<string, Record<string, SpecOperation>>;

function specOperations(): Array<{ method: string; path: string; op: SpecOperation }> {
  const out: Array<{ method: string; path: string; op: SpecOperation }> = [];
  for (const [p, item] of Object.entries(specPaths)) {
    for (const [m, op] of Object.entries(item)) {
      out.push({ method: m.toUpperCase(), path: p, op });
    }
  }
  return out;
}

describe("OpenAPI spec — sanity", () => {
  it("is OpenAPI 3 with the BLA info block", () => {
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.info.title).toBe("BLA Logistics API");
    expect(typeof spec.info.version).toBe("string");
    expect(spec.servers).toEqual([{ url: "/", description: expect.any(String) }]);
  });

  it("documents the real session-cookie scheme (no JWT, no API key)", () => {
    const scheme = spec.components.securitySchemes.sessionCookie;
    expect(scheme.type).toBe("apiKey");
    expect(scheme.in).toBe("cookie");
    expect(scheme.name).toBe("authjs.session-token");
    expect(spec.security).toEqual([{ sessionCookie: [] }]);
  });

  it("defines the shared Error envelope once in components", () => {
    const error = spec.components.schemas.Error as {
      properties: { error: { properties: Record<string, unknown>; required: string[] } };
    };
    expect(error.properties.error.required).toEqual(["code", "message"]);
    expect(Object.keys(error.properties.error.properties)).toEqual(["code", "message"]);
  });

  it("every operation has a summary, a tag and responses", () => {
    for (const { method, path, op } of specOperations()) {
      expect(op.summary, `${method} ${path} summary`).toBeTruthy();
      expect(op.tags?.length, `${method} ${path} tags`).toBeGreaterThan(0);
      expect(Object.keys(op.responses ?? {}).length, `${method} ${path} responses`).toBeGreaterThan(0);
    }
  });

  it("every {param} in a path is declared as a required path parameter", () => {
    for (const { method, path, op } of specOperations()) {
      const declared = new Set(
        (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name),
      );
      for (const m of path.matchAll(/\{(\w+)\}/g)) {
        expect(declared.has(m[1]), `${method} ${path} must declare {${m[1]}}`).toBe(true);
        const param = (op.parameters ?? []).find((p) => p.in === "path" && p.name === m[1]);
        expect(param?.required, `${method} ${path} {${m[1]}} required`).toBe(true);
      }
    }
  });

  it("public operations opt out of the session requirement explicitly", () => {
    for (const { method, path, op } of specOperations()) {
      const isPublic =
        path.startsWith("/api/auth/") ||
        path.startsWith("/api/public/") ||
        path.startsWith("/api/track/");
      if (isPublic) {
        expect(op.security, `${method} ${path} should be public`).toEqual([]);
      } else {
        expect(op.security, `${method} ${path} should inherit the session scheme`).toBeUndefined();
      }
    }
  });
});

describe("OpenAPI spec — anti-drift", () => {
  it("spec operations exactly match the route tree (method + path)", () => {
    const fromTree = scanApiRoutes(process.cwd())
      .map((op) => `${op.method} ${op.path}`)
      .sort();
    const fromSpec = specOperations()
      .map((op) => `${op.method} ${op.path}`)
      .sort();
    expect(fromSpec).toEqual(fromTree);
  });

  it("spec path parameters match the route tree's dynamic segments", () => {
    const scanned = new Map(
      scanApiRoutes(process.cwd()).map((op) => [`${op.method} ${op.path}`, op.params]),
    );
    for (const { method, path, op } of specOperations()) {
      const treeParams = scanned.get(`${method} ${path}`) ?? [];
      const specParams = (op.parameters ?? [])
        .filter((p) => p.in === "path")
        .map((p) => p.name);
      expect(specParams, `${method} ${path} params`).toEqual(treeParams);
    }
  });
});
