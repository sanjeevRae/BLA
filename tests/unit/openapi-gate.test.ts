import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Stub ONLY the session-backed actor resolver (the search-api.test.ts
// pattern); the gate itself and the route handler run for real.
const mockState = vi.hoisted(() => ({
  actor: null as import("@/lib/auth/actor").ActorContext | null,
}));
vi.mock("@/lib/auth/permissions", async () => {
  const actorModule = await vi.importActual<typeof import("@/lib/auth/actor")>(
    "@/lib/auth/actor",
  );
  return {
    ...actorModule,
    getActorContext: async () => mockState.actor,
  };
});

import { evaluateDocsAccess } from "@/lib/openapi/gate";
import { GET as getDocsJson } from "@/app/api/docs.json/route";
import type { ActorContext } from "@/lib/auth/actor";
import type { RoleCode } from "@/lib/permissions/catalog";

function fakeActor(roles: RoleCode[], overrides: Partial<ActorContext> = {}): ActorContext {
  return {
    userId: "user-1",
    email: "person@bla.test",
    fullName: "Test Person",
    status: "ACTIVE",
    roles,
    primaryRole: roles[0],
    permissions: new Set<string>(),
    warehouseIds: [],
    vendorId: null,
    driverId: null,
    customerId: null,
    mustChangePassword: false,
    mfaPending: false,
    mfaEnrolmentRequired: false,
    landingPath: "/super-admin",
    ...overrides,
  } as ActorContext;
}

beforeEach(() => {
  mockState.actor = null;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("evaluateDocsAccess", () => {
  it("allows SUPER_ADMIN and ADMIN", async () => {
    mockState.actor = fakeActor(["SUPER_ADMIN"]);
    await expect(evaluateDocsAccess()).resolves.toMatchObject({ allowed: true });

    mockState.actor = fakeActor(["ADMIN"]);
    await expect(evaluateDocsAccess()).resolves.toMatchObject({ allowed: true });
  });

  it("rejects anonymous callers as unauthenticated", async () => {
    mockState.actor = null;
    await expect(evaluateDocsAccess()).resolves.toMatchObject({
      allowed: false,
      reason: "unauthenticated",
    });
  });

  it("rejects signed-in non-admin roles as forbidden", async () => {
    mockState.actor = fakeActor(["WAREHOUSE_ADMIN"]);
    await expect(evaluateDocsAccess()).resolves.toMatchObject({
      allowed: false,
      reason: "forbidden",
    });

    mockState.actor = fakeActor(["CUSTOMER"]);
    await expect(evaluateDocsAccess()).resolves.toMatchObject({
      allowed: false,
      reason: "forbidden",
    });
  });

  it("rejects admins with a pending MFA or password obligation", async () => {
    mockState.actor = fakeActor(["SUPER_ADMIN"], { mfaPending: true });
    await expect(evaluateDocsAccess()).resolves.toMatchObject({
      allowed: false,
      reason: "forbidden",
    });

    mockState.actor = fakeActor(["ADMIN"], { mustChangePassword: true });
    await expect(evaluateDocsAccess()).resolves.toMatchObject({
      allowed: false,
      reason: "forbidden",
    });
  });

  it("is disabled in production unless API_DOCS_ENABLED=true", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("API_DOCS_ENABLED", "");
    mockState.actor = fakeActor(["SUPER_ADMIN"]);
    await expect(evaluateDocsAccess()).resolves.toMatchObject({
      allowed: false,
      reason: "disabled",
    });

    vi.stubEnv("API_DOCS_ENABLED", "true");
    await expect(evaluateDocsAccess()).resolves.toMatchObject({ allowed: true });
  });

  it("stays enabled outside production without the flag", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("API_DOCS_ENABLED", "");
    mockState.actor = fakeActor(["ADMIN"]);
    await expect(evaluateDocsAccess()).resolves.toMatchObject({ allowed: true });
  });
});

describe("GET /api/docs.json", () => {
  it("answers 401 with the API error envelope when anonymous", async () => {
    mockState.actor = null;
    const response = await getDocsJson();
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("answers 403 for a signed-in non-admin", async () => {
    mockState.actor = fakeActor(["FINANCE"]);
    const response = await getDocsJson();
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("serves the spec to an admin", async () => {
    mockState.actor = fakeActor(["SUPER_ADMIN"]);
    const response = await getDocsJson();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { openapi: string; info: { title: string } };
    expect(body.openapi).toMatch(/^3\./);
    expect(body.info.title).toBe("BLA Logistics API");
  });

  it("answers 404 in production when the flag is off — even for an admin", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("API_DOCS_ENABLED", "");
    mockState.actor = fakeActor(["SUPER_ADMIN"]);
    const response = await getDocsJson();
    expect(response.status).toBe(404);
  });
});
