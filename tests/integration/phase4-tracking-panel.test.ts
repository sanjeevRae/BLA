import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 4 (V2) — driver panel backend: GET session/current state
 * (getOwnTrackingState) and the pause/resume routes' service
 * layer, against bla_test.
 *
 * The routes are thin wrappers (actor from the Auth.js session →
 * service → JSON), so ownership is proven at the service boundary
 * every route delegates to:
 *  - current returns ONLY the actor's own session, assignments
 *    and last fix — another driver's data never appears;
 *  - pause/resume reject a foreign session (audited);
 *  - a paused session reports OFFLINE freshness and refuses pings;
 *  - the client cadence config comes from the server config,
 *    including the SystemSetting override;
 *  - actors without a driver profile get an empty state, and
 *    actors without tracking.manage_own are denied outright.
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
const email = (label: string) => `p4-${label}-${RUN}@bla.test`;

let prisma: import("@prisma/client").PrismaClient;
let trackingSvc: typeof import("@/server/services/tracking");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let adminActor: Actor;
let waActor: Actor;
let rider1Actor: Actor;
let rider2Actor: Actor;
let noDriverActor: Actor;
let linehaulActor: Actor;

async function actorFor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: {
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      },
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
      fullName: `P4 ${label}`,
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
    data: {
      userId,
      warehouseId,
      roleId: role!.id,
      isPrimary: true,
      assignedById: fx.adminUser,
    },
  });
}

async function makeDriver(userId: string, homeWarehouseId: string, label: string) {
  const driver = await prisma.driver.create({
    data: {
      userId,
      homeWarehouseId,
      licenseNumber: `LIC-P4-${label}-${RUN}`,
      licenseExpiry: new Date("2028-01-01"),
    },
  });
  return driver.id;
}

async function makeBatch(riderId: string, warehouseId: string, status = "OPEN") {
  return prisma.deliveryBatch.create({
    data: {
      riderId,
      warehouseId,
      batchDate: new Date(new Date().toISOString().slice(0, 10)),
      kind: "DELIVERY",
      status,
      createdById: fx.adminUser,
    },
  });
}

const pingBody = (sessionId: string, sequenceId: number) => ({
  trackingSessionId: sessionId,
  latitude: 27.7,
  longitude: 85.3,
  accuracyMeters: 12,
  recordedAt: new Date().toISOString(),
  sequenceId,
});

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

  // Permission catalog into bla_test (same upserts as the seed).
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
        where: {
          roleId_permissionId: {
            roleId: roleId.get(role.code)!,
            permissionId: permissionId.get(code)!,
          },
        },
        update: {},
        create: { roleId: roleId.get(role.code)!, permissionId: permissionId.get(code)! },
      });
    }
  }

  const w1 = await prisma.warehouse.create({
    data: { code: `P4A-${RUN}`, name: `P4 Alpha ${RUN}`, district: "Kathmandu", city: "Kathmandu", province: "Bagmati" },
  });
  const w2 = await prisma.warehouse.create({
    data: { code: `P4B-${RUN}`, name: `P4 Beta ${RUN}`, district: "Lalitpur", city: "Lalitpur", province: "Bagmati" },
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

  const linehaulUser = await makeUser("linehaul", "LINEHAUL_DRIVER");
  fx.linehaulDriver = await makeDriver(linehaulUser, fx.w1, "LH");
  linehaulActor = await actorFor(linehaulUser);

  fx.batch1 = (await makeBatch(fx.rider1Driver, fx.w1)).id;
  fx.batch2 = (await makeBatch(fx.rider2Driver, fx.w2)).id;

  // Trip fixture for the line-haul driver.
  const vehicle = await prisma.vehicle.create({
    data: { registration: `VEH-P4-${RUN}`, type: "TRUCK", homeWarehouseId: fx.w1 },
  });
  const transfer = await prisma.transfer.create({
    data: {
      transferNumber: `TRF-P4-${RUN}`,
      originWarehouseId: fx.w1,
      destinationWarehouseId: fx.w2,
      status: "IN_TRANSIT",
      driverId: fx.linehaulDriver,
      vehicleId: vehicle.id,
      createdById: fx.adminUser,
    },
  });
  const trip = await prisma.trip.create({
    data: {
      tripNumber: `TRP-P4-${RUN}`,
      transferId: transfer.id,
      driverId: fx.linehaulDriver,
      vehicleId: vehicle.id,
      status: "DISPATCHED",
    },
  });
  await prisma.transfer.update({ where: { id: transfer.id }, data: { tripId: trip.id } });
  fx.trip = trip.id;
});

describe("Phase 4 — session/current (getOwnTrackingState)", () => {
  it("returns the rider's eligible batch and the default cadence config", async () => {
    const state = await trackingSvc.getOwnTrackingState(rider1Actor);
    expect(state.session).toBeNull();
    expect(state.sessionAssignment).toBeNull();
    expect(state.lastPing).toBeNull();
    const batch = state.eligibleAssignments.find((a) => a.deliveryBatchId === fx.batch1);
    expect(batch).toBeDefined();
    expect(batch!.trackingType).toBe("DELIVERY");
    expect(batch!.originWarehouseCode).toBe(`P4A-${RUN}`);
    expect(state.clientConfig.movingIntervalSeconds.DELIVERY).toBe(150);
    expect(state.clientConfig.movingIntervalSeconds.LINEHAUL).toBe(240);
    expect(state.clientConfig.stationaryHeartbeatSeconds).toBe(600);
    expect(state.clientConfig.minPingIntervalSeconds).toBe(30);
  });

  it("returns the line-haul driver's eligible trip with its destination", async () => {
    const state = await trackingSvc.getOwnTrackingState(linehaulActor);
    const trip = state.eligibleAssignments.find((a) => a.tripId === fx.trip);
    expect(trip).toBeDefined();
    expect(trip!.trackingType).toBe("LINEHAUL");
    expect(trip!.destinationWarehouseCode).toBe(`P4B-${RUN}`);
  });

  it("never exposes another driver's session or assignments", async () => {
    const session = await trackingSvc.startTrackingSession(rider1Actor, {
      deliveryBatchId: fx.batch1,
      permissionAcknowledged: true,
    });
    fx.session1 = session.id;

    const other = await trackingSvc.getOwnTrackingState(rider2Actor);
    expect(other.session).toBeNull();
    expect(other.sessionAssignment).toBeNull();
    expect(other.lastPing).toBeNull();
    expect(other.eligibleAssignments.map((a) => a.deliveryBatchId)).toEqual([fx.batch2]);

    const own = await trackingSvc.getOwnTrackingState(rider1Actor);
    expect(own.session?.id).toBe(fx.session1);
    expect(own.session?.status).toBe("ACTIVE");
    expect(own.sessionAssignment?.deliveryBatchId).toBe(fx.batch1);
    expect(own.eligibleAssignments.find((a) => a.deliveryBatchId === fx.batch1)).toBeUndefined();
  });

  it("reports the last accepted fix with FRESH freshness after a ping", async () => {
    await trackingSvc.postLocationPing(rider1Actor, pingBody(fx.session1, 1));
    const state = await trackingSvc.getOwnTrackingState(rider1Actor);
    expect(state.lastPing).not.toBeNull();
    expect(state.lastPing!.accuracyMeters).toBe(12);
    expect(state.lastPing!.freshnessState).toBe("FRESH");
  });

  it("returns an empty state for a permitted actor with no driver profile", async () => {
    const state = await trackingSvc.getOwnTrackingState(noDriverActor);
    expect(state.session).toBeNull();
    expect(state.eligibleAssignments).toEqual([]);
    expect(state.lastPing).toBeNull();
    expect(state.clientConfig.minPingIntervalSeconds).toBe(30);
  });

  it("denies actors without tracking.manage_own (admin, warehouse admin)", async () => {
    await expect(trackingSvc.getOwnTrackingState(adminActor)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    await expect(trackingSvc.getOwnTrackingState(waActor)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
  });

  it("serves the SystemSetting cadence override as the single source of truth", async () => {
    await prisma.systemSetting.upsert({
      where: { key: "tracking.config" },
      update: { value: { riderMovingIntervalSeconds: 200, movementThresholdMeters: 40 } },
      create: {
        key: "tracking.config",
        value: { riderMovingIntervalSeconds: 200, movementThresholdMeters: 40 },
      },
    });
    try {
      const state = await trackingSvc.getOwnTrackingState(rider2Actor);
      expect(state.clientConfig.movingIntervalSeconds.DELIVERY).toBe(200);
      expect(state.clientConfig.movingIntervalSeconds.PICKUP).toBe(200);
      expect(state.clientConfig.movingIntervalSeconds.LINEHAUL).toBe(240);
      expect(state.clientConfig.movementThresholdMeters).toBe(40);
    } finally {
      await prisma.systemSetting.delete({ where: { key: "tracking.config" } });
    }
  });
});

describe("Phase 4 — pause/resume ownership (route service layer)", () => {
  it("the owner can pause; the state reports PAUSED + OFFLINE and pings are refused", async () => {
    const paused = await trackingSvc.pauseTrackingSession(rider1Actor, fx.session1);
    expect(paused.status).toBe("PAUSED");

    const state = await trackingSvc.getOwnTrackingState(rider1Actor);
    expect(state.session?.status).toBe("PAUSED");
    expect(state.lastPing?.freshnessState).toBe("OFFLINE");

    await expect(
      trackingSvc.postLocationPing(rider1Actor, pingBody(fx.session1, 2)),
    ).rejects.toThrow(/not active/);
  });

  it("another driver cannot pause or resume the session", async () => {
    await expect(trackingSvc.pauseTrackingSession(rider2Actor, fx.session1)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    await expect(
      trackingSvc.resumeTrackingSession(rider2Actor, fx.session1),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    const state = await trackingSvc.getOwnTrackingState(rider1Actor);
    expect(state.session?.status).toBe("PAUSED");
  });

  it("the owner can resume and pings flow again", async () => {
    const resumed = await trackingSvc.resumeTrackingSession(rider1Actor, fx.session1);
    expect(resumed.status).toBe("ACTIVE");
    // Move the last accepted ping outside the 30 s server floor
    // and use a fresh position so neither the rate limit nor the
    // identical-coordinate dedupe applies.
    const last = await prisma.driverLocationPing.findFirst({
      where: { trackingSessionId: fx.session1 },
      orderBy: { receivedAt: "desc" },
    });
    await prisma.driverLocationPing.update({
      where: { id: last!.id },
      data: { receivedAt: new Date(last!.receivedAt.getTime() - 60_000) },
    });
    const result = await trackingSvc.postLocationPing(rider1Actor, {
      ...pingBody(fx.session1, 3),
      latitude: 27.701,
    });
    expect(result.deduplicated).toBe(false);
    const state = await trackingSvc.getOwnTrackingState(rider1Actor);
    expect(state.session?.status).toBe("ACTIVE");
    expect(state.lastPing?.freshnessState).toBe("FRESH");
  });

  it("pause/resume reject wrong-state transitions", async () => {
    await expect(trackingSvc.resumeTrackingSession(rider1Actor, fx.session1)).rejects.toThrow(
      /PAUSED/,
    );
    await trackingSvc.pauseTrackingSession(rider1Actor, fx.session1);
    await expect(trackingSvc.pauseTrackingSession(rider1Actor, fx.session1)).rejects.toThrow(
      /ACTIVE/,
    );
    await trackingSvc.resumeTrackingSession(rider1Actor, fx.session1);
  });
});
