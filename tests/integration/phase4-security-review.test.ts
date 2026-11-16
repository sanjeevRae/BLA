import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 4 SECURITY REVIEW PoCs (independent reviewer, not the author).
 * Secure-expectation tests: a FAIL here is a reproduced finding.
 * Fixture pattern mirrors tests/integration/phase4-tracking-panel.test.ts.
 */

function loadEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const email = (label: string) => `p4sec-${label}-${RUN}@bla.test`;

let prisma: import("@prisma/client").PrismaClient;
let trackingSvc: typeof import("@/server/services/tracking");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let configMod: typeof import("@/lib/tracking/config");
let engineMod: typeof import("@/lib/tracking/client-engine");

type Actor = Awaited<ReturnType<typeof actorFor>>;
const fx: Record<string, string> = {};
let adminActor: Actor;
let waActor: Actor;
let rider1Actor: Actor;
let rider2Actor: Actor;
let noDriverActor: Actor;

async function actorFor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
      memberships: { where: { revokedAt: null }, include: { role: true } },
    },
  });
  if (!user) throw new Error("fixture user missing");
  const roles: string[] = [];
  const permissions = new Set<string>();
  for (const userRole of user.roles) {
    if (!userRole.role.isActive) continue;
    roles.push(userRole.role.code);
    for (const rp of userRole.role.permissions) permissions.add(rp.permission.code);
  }
  const [vendorLink, customerProfile, driverProfile] = await Promise.all([
    prisma.vendorUser.findFirst({
      where: { userId: user.id, isActive: true, vendor: { isActive: true } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.customer.findUnique({ where: { userId: user.id } }),
    prisma.driver.findUnique({ where: { userId: user.id }, select: { id: true } }),
  ]);
  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    roles: roles as never[],
    primaryRole: catalog.primaryRoleFor(roles as never[]),
    permissions,
    warehouseIds: user.memberships.map((m) => m.warehouseId),
    membershipRoles: user.memberships.map((m) => ({
      warehouseId: m.warehouseId,
      roleCode: m.role.code as never,
    })),
    vendorId: vendorLink?.vendorId ?? null,
    vendorRole: vendorLink?.vendorRole ?? null,
    driverId: driverProfile?.id ?? null,
    customerId: customerProfile?.id ?? null,
    landingPath: catalog.landingPathForRoles(roles as never[]),
  };
}

async function makeUser(label: string, roleCode: string): Promise<string> {
  const { hash } = await import("bcryptjs");
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `P4SEC ${label}`,
      passwordHash: await hash("Fixture#2026", 10),
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role missing: ${roleCode}`);
  await prisma.userRole.create({
    data: { userId: user.id, roleId: role.id, assignedById: fx.adminUser ?? user.id },
  });
  return user.id;
}

async function addMembership(userId: string, warehouseId: string, roleCode: string) {
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  await prisma.warehouseMembership.create({
    data: { userId, warehouseId, roleId: role!.id, isPrimary: true, assignedById: fx.adminUser },
  });
}

async function makeDriver(userId: string, homeWarehouseId: string, label: string) {
  const driver = await prisma.driver.create({
    data: {
      userId,
      homeWarehouseId,
      licenseNumber: `LIC-P4SEC-${label}-${RUN}`,
      licenseExpiry: new Date("2028-01-01"),
    },
  });
  return driver.id;
}

async function makeBatch(riderId: string, warehouseId: string) {
  return prisma.deliveryBatch.create({
    data: {
      riderId,
      warehouseId,
      batchDate: new Date(new Date().toISOString().slice(0, 10)),
      kind: "DELIVERY",
      status: "OPEN",
      createdById: fx.adminUser,
    },
  });
}

beforeAll(async () => {
  const root = process.cwd();
  const env = {
    ...loadEnvFile(join(root, "prisma/.env")),
    ...loadEnvFile(join(root, ".env.local")),
  };
  const url = env.DATABASE_URL ?? "";
  if (!url.includes("/bla_dev")) throw new Error("Expected the bla_dev DATABASE_URL");
  process.env.DATABASE_URL = url.replace("/bla_dev", "/bla_test");

  const clientModule = await import("@prisma/client");
  prisma = new clientModule.PrismaClient();
  trackingSvc = await import("@/server/services/tracking");
  actorErrors = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");
  configMod = await import("@/lib/tracking/config");
  engineMod = await import("@/lib/tracking/client-engine");

  for (const role of catalog.ROLES) {
    await prisma.role.upsert({
      where: { code: role.code },
      update: { name: role.name, isActive: true },
      create: { code: role.code, name: role.name, description: role.description, isSystem: true },
    });
  }
  for (const permission of catalog.PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { name: permission.name, module: permission.module },
      create: { code: permission.code, name: permission.name, module: permission.module },
    });
  }
  const roleRows = await prisma.role.findMany();
  const permissionRows = await prisma.permission.findMany();
  const roleId = new Map(roleRows.map((r) => [r.code, r.id]));
  const permissionId = new Map(permissionRows.map((p) => [p.code, p.id]));
  for (const role of catalog.ROLES) {
    for (const code of catalog.ROLE_PERMISSIONS[role.code]) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: roleId.get(role.code)!, permissionId: permissionId.get(code)! } },
        update: {},
        create: { roleId: roleId.get(role.code)!, permissionId: permissionId.get(code)! },
      });
    }
  }

  const w1 = await prisma.warehouse.create({
    data: { code: `PS4A-${RUN}`, name: `P4SEC Alpha ${RUN}`, district: "Kathmandu", city: "Kathmandu", province: "Bagmati" },
  });
  const w2 = await prisma.warehouse.create({
    data: { code: `PS4B-${RUN}`, name: `P4SEC Beta ${RUN}`, district: "Lalitpur", city: "Lalitpur", province: "Bagmati" },
  });
  fx.w1 = w1.id;
  fx.w2 = w2.id;
  fx.adminUser = await makeUser("admin", "ADMIN");
  adminActor = await actorFor(fx.adminUser);
  const waUser = await makeUser("wa", "WAREHOUSE_ADMIN");
  await addMembership(waUser, fx.w1, "WAREHOUSE_ADMIN");
  waActor = await actorFor(waUser);
  const rider1User = await makeUser("rider1", "RIDER");
  fx.rider1Driver = await makeDriver(rider1User, fx.w1, "R1");
  rider1Actor = await actorFor(rider1User);
  const rider2User = await makeUser("rider2", "RIDER");
  fx.rider2Driver = await makeDriver(rider2User, fx.w2, "R2");
  rider2Actor = await actorFor(rider2User);
  noDriverActor = await actorFor(await makeUser("nodriver", "RIDER"));
  fx.batch1 = (await makeBatch(fx.rider1Driver, fx.w1)).id;
  fx.batch2 = (await makeBatch(fx.rider2Driver, fx.w2)).id;
  const s = await trackingSvc.startTrackingSession(rider1Actor, {
    deliveryBatchId: fx.batch1,
    permissionAcknowledged: true,
  });
  fx.session1 = s.id;
});

describe("PoC-A: non-owners with staff/supervisor roles cannot pause/resume", () => {
  it("admin and warehouse-admin (no tracking.manage_own) are denied pause+resume; state unchanged", async () => {
    for (const actor of [adminActor, waActor]) {
      await expect(trackingSvc.pauseTrackingSession(actor, fx.session1)).rejects.toBeInstanceOf(
        actorErrors.AuthorizationError,
      );
      await expect(trackingSvc.resumeTrackingSession(actor, fx.session1)).rejects.toBeInstanceOf(
        actorErrors.AuthorizationError,
      );
    }
    const row = await prisma.trackingSession.findUnique({ where: { id: fx.session1 } });
    expect(row!.status).toBe("ACTIVE");
  });

  it("permitted actor with NO driver profile cannot pause/resume a foreign session", async () => {
    await expect(trackingSvc.pauseTrackingSession(noDriverActor, fx.session1)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    await expect(trackingSvc.resumeTrackingSession(noDriverActor, fx.session1)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
  });

  it("driver actor with the permission STRIPPED (driverId intact) is denied everywhere", async () => {
    const stripped = { ...rider1Actor, permissions: new Set<string>() };
    await expect(trackingSvc.getOwnTrackingState(stripped)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    await expect(trackingSvc.pauseTrackingSession(stripped, fx.session1)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    await expect(trackingSvc.resumeTrackingSession(stripped, fx.session1)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
  });

  it("empty session id is a validation error, not a mutation", async () => {
    await expect(trackingSvc.pauseTrackingSession(rider1Actor, "")).rejects.toThrow(/required/);
    await expect(trackingSvc.resumeTrackingSession(rider1Actor, "")).rejects.toThrow(/required/);
  });
});

describe("PoC-B: GET current payload is a strict whitelist with no cross-driver / PII data", () => {
  it("summary/session/lastPing keys are exactly the expected whitelist; no foreign identifiers in JSON", async () => {
    await trackingSvc.postLocationPing(rider1Actor, {
      trackingSessionId: fx.session1,
      latitude: 27.7,
      longitude: 85.3,
      accuracyMeters: 12,
      recordedAt: new Date().toISOString(),
      sequenceId: 1,
    });
    const state = await trackingSvc.getOwnTrackingState(rider1Actor);
    const summaryKeys = [
      "completedCount", "deliveryBatchId", "destinationWarehouseCode", "destinationWarehouseName",
      "kind", "label", "originWarehouseCode", "originWarehouseName", "packageCount", "status",
      "trackingType", "tripId",
    ];
    const allSummaries = [...state.eligibleAssignments, ...(state.sessionAssignment ? [state.sessionAssignment] : [])];
    expect(allSummaries.length).toBeGreaterThan(0);
    for (const s of allSummaries) expect(Object.keys(s).sort()).toEqual(summaryKeys);
    expect(Object.keys(state.lastPing!).sort()).toEqual(
      ["accuracyMeters", "freshnessState", "receivedAt", "recordedAt"],
    );
    // Recursive key scan: no PII-shaped keys anywhere in the payload.
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          keys.push(k.toLowerCase());
          walk(val);
        }
      }
    };
    walk(state);
    for (const banned of ["recipient", "phone", "address", "email", "customer", "sender", "contents", "codamount", "codcollected", "price", "amountpaisa"]) {
      expect(keys.some((k) => k.includes(banned))).toBe(false);
    }
    const json = JSON.stringify(state);
    expect(json).not.toContain(fx.batch2);
    expect(json).not.toContain(fx.rider2Driver);
    expect(json).not.toContain(rider2Actor.email);
    expect(json).not.toContain(rider2Actor.userId);
    // Own session's coordinates are NOT in the current-state payload either
    // (lastPing carries timestamps/accuracy/freshness only).
    expect(json).not.toContain("27.7");
    expect(json).not.toContain("85.3");
    expect(json).not.toContain("latitude");
    expect(json).not.toContain("longitude");
  });
});

describe("PoC-C: cadence config cannot weaken the server ping floor", () => {
  it("out-of-range cadence values fall back to defaults; floor values are honoured", () => {
    const r = configMod.resolveTrackingConfig;
    expect(r({ riderMovingIntervalSeconds: 1 }).riderMovingIntervalSeconds).toBe(150);
    expect(r({ riderMovingIntervalSeconds: 29 }).riderMovingIntervalSeconds).toBe(150);
    expect(r({ riderMovingIntervalSeconds: 30 }).riderMovingIntervalSeconds).toBe(30);
    expect(r({ linehaulMovingIntervalSeconds: 0 }).linehaulMovingIntervalSeconds).toBe(240);
    expect(r({ stationaryHeartbeatSeconds: 30 }).stationaryHeartbeatSeconds).toBe(600);
    expect(r({ stationaryHeartbeatSeconds: 60 }).stationaryHeartbeatSeconds).toBe(60);
    expect(r({ movementThresholdMeters: 1 }).movementThresholdMeters).toBe(25);
    expect(r({ riderMovingIntervalSeconds: "5" }).riderMovingIntervalSeconds).toBe(150);
    expect(r({ riderMovingIntervalSeconds: 150.5 }).riderMovingIntervalSeconds).toBe(150);
    // The Phase 3 server floor itself still cannot be pushed below its own min.
    expect(r({ minPingIntervalSeconds: 1 }).minPingIntervalSeconds).toBe(30);
    expect(r({ minPingIntervalSeconds: 5 }).minPingIntervalSeconds).toBe(5);
  });

  it("SECURE EXPECTATION: decidePingSend never sends inside the server minimum interval (documented contract)", () => {
    // Engine header + decidePingSend doc: 'nothing goes out inside the
    // server minimum interval'. With heartbeat (60s min) < minPing (up to
    // 3600s), an identical-coordinate fix at heartbeat expiry must still
    // be blocked by the minimum interval.
    const d = engineMod.decidePingSend({
      lastSent: { latitude: 27.7, longitude: 85.3, at: 1_000_000 },
      fix: {
        latitude: 27.7, longitude: 85.3, accuracyMeters: 10,
        speedMetersPerSecond: null, headingDegrees: null, recordedAt: 1_600_000,
      },
      now: 1_600_000,
      movingIntervalMs: 150_000,
      heartbeatMs: 600_000,
      minIntervalMs: 3_600_000,
      thresholdMeters: 25,
    });
    expect(d.send).toBe(false);
  });
});

describe("PoC-D: resume must not resurrect a session whose assignment is terminal", () => {
  it("SECURE EXPECTATION: resuming a PAUSED session after its batch completed is rejected", async () => {
    const s = await trackingSvc.startTrackingSession(rider2Actor, {
      deliveryBatchId: fx.batch2,
      permissionAcknowledged: true,
    });
    fx.session2 = s.id;
    await trackingSvc.pauseTrackingSession(rider2Actor, fx.session2);
    // Terminal transition WITHOUT the auto-end hook (direct DB write —
    // simulates a missed/future terminal path or admin correction;
    // current close/cancel paths do call the hook in-tx).
    await prisma.deliveryBatch.update({ where: { id: fx.batch2 }, data: { status: "COMPLETED" } });
    await expect(trackingSvc.resumeTrackingSession(rider2Actor, fx.session2)).rejects.toThrow();
  });

  it("mitigation check: pings to that session are refused regardless of its status", async () => {
    await expect(
      trackingSvc.postLocationPing(rider2Actor, {
        trackingSessionId: fx.session2,
        latitude: 27.71,
        longitude: 85.31,
        accuracyMeters: 10,
        recordedAt: new Date().toISOString(),
        sequenceId: 1,
      }),
    ).rejects.toThrow();
  });
});
