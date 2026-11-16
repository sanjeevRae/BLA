import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 3 (V2) — GPS backend against bla_test.
 *
 * Covers the spec §14 GPS backend subset:
 *  - session start: permission, acknowledgement, eligibility,
 *    assignment ownership, one-active-session-per-driver;
 *  - ping ingest: identity from the session only (a foreign
 *    driverId in the body is audit-logged and ignored), duplicate
 *    sequence idempotency, identical-coordinate dedupe, the
 *    server-side minimum interval, payload validation, the
 *    out-of-order snapshot guard, pings refused after stop /
 *    pause / assignment completion (auto-end);
 *  - live operations: snapshot-only reads, global vs warehouse
 *    scope, role denials, COD field gating, freshness transitions,
 *    detail package projection without recipient PII;
 *  - supervisor stop auditing, abandoned-session expiry, and the
 *    30-day ping retention prune (+ SystemSetting override).
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
    if (match) out[match[1]] = match[2].trim().replace(/^[\"']|[\"']$/g, "");
  }
  return out;
}

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const email = (label: string) => `p3-${label}-${RUN}@bla.test`;

let prisma: import("@prisma/client").PrismaClient;
let trackingSvc: typeof import("@/server/services/tracking");
let liveOpsSvc: typeof import("@/server/services/live-operations");
let deliveriesSvc: typeof import("@/server/services/deliveries");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let adminActor: Actor;
let wa1Actor: Actor;
let wa2Actor: Actor;
let staffActor: Actor;
let vendorActor: Actor;
let customerActor: Actor;
let rider1Actor: Actor;
let rider2Actor: Actor;
let linehaulActor: Actor;

/** Mirror of getActorContext (permissions.ts) incl. the driver link. */
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
      fullName: `P3 ${label}`,
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
      licenseNumber: `LIC-${label}-${RUN}`,
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

async function makePackage(shipmentId: string, orderId: string, label: string) {
  return prisma.package.create({
    data: {
      trackingId: `BLA-P3-${label}-${RUN}`,
      shipmentId,
      orderId,
      recipientName: `Recipient ${label}`,
      recipientPhone: `9779800000${label}`,
      deliveryAddress: `Address ${label}`,
      deliveryCity: "Kathmandu",
      deliveryDistrict: "Kathmandu",
      declaredWeightKg: "1.000",
      description: `Parcel ${label}`,
    },
  });
}

const pingBody = (
  sessionId: string,
  sequenceId: number,
  overrides: Record<string, unknown> = {},
) => ({
  trackingSessionId: sessionId,
  latitude: 27.7,
  longitude: 85.3,
  accuracyMeters: 12,
  recordedAt: new Date().toISOString(),
  sequenceId,
  ...overrides,
});

async function backdateLastPing(sessionId: string, seconds: number) {
  const last = await prisma.driverLocationPing.findFirst({
    where: { trackingSessionId: sessionId },
    orderBy: { receivedAt: "desc" },
  });
  if (!last) throw new Error("no ping to backdate");
  await prisma.driverLocationPing.update({
    where: { id: last.id },
    data: { receivedAt: new Date(last.receivedAt.getTime() - seconds * 1000) },
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
  liveOpsSvc = await import("@/server/services/live-operations");
  deliveriesSvc = await import("@/server/services/deliveries");
  errors = await import("@/lib/errors");
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

  // Warehouses.
  const w1 = await prisma.warehouse.create({
    data: { code: `P3A-${RUN}`, name: `P3 Alpha ${RUN}`, district: "Kathmandu", city: "Kathmandu", province: "Bagmati" },
  });
  const w2 = await prisma.warehouse.create({
    data: { code: `P3B-${RUN}`, name: `P3 Beta ${RUN}`, district: "Lalitpur", city: "Lalitpur", province: "Bagmati" },
  });
  fx.w1 = w1.id;
  fx.w2 = w2.id;

  // Users + actors.
  fx.adminUser = await makeUser("admin", "ADMIN");
  adminActor = await actorFor(fx.adminUser);

  const wa1User = await makeUser("wa1", "WAREHOUSE_ADMIN");
  await addMembership(wa1User, fx.w1, "WAREHOUSE_ADMIN");
  wa1Actor = await actorFor(wa1User);
  const wa2User = await makeUser("wa2", "WAREHOUSE_ADMIN");
  await addMembership(wa2User, fx.w2, "WAREHOUSE_ADMIN");
  wa2Actor = await actorFor(wa2User);

  const staffUser = await makeUser("staff", "WAREHOUSE_STAFF");
  await addMembership(staffUser, fx.w1, "WAREHOUSE_STAFF");
  staffActor = await actorFor(staffUser);

  vendorActor = await actorFor(await makeUser("vendor", "VENDOR"));
  customerActor = await actorFor(await makeUser("customer", "CUSTOMER"));

  const rider1User = await makeUser("rider1", "RIDER");
  fx.rider1Driver = await makeDriver(rider1User, fx.w1, "R1");
  rider1Actor = await actorFor(rider1User);
  const rider2User = await makeUser("rider2", "RIDER");
  fx.rider2Driver = await makeDriver(rider2User, fx.w2, "R2");
  rider2Actor = await actorFor(rider2User);
  const linehaulUser = await makeUser("linehaul", "LINEHAUL_DRIVER");
  fx.linehaulDriver = await makeDriver(linehaulUser, fx.w1, "LH");
  linehaulActor = await actorFor(linehaulUser);

  // Order / shipment / packages for batch assignments + transfer items.
  const service = await prisma.shippingService.create({
    data: { code: `P3SVC-${RUN}`, name: `P3 Service ${RUN}` },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-P3-${RUN}`,
      createdById: fx.adminUser,
      createdByRole: "ADMIN",
      senderName: "P3 Sender",
      senderPhone: "9779811111111",
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  fx.orderId = order.id;
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-P3-${RUN}`,
      orderId: order.id,
      originWarehouseId: fx.w1,
      destinationWarehouseId: fx.w2,
      routeKind: "INTER_WAREHOUSE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(0),
    },
  });
  fx.shipmentId = shipment.id;

  // Batch 1 (rider1 @ W1): two assignments (1 delivered + COD, 1 in progress).
  const batch1 = await makeBatch(fx.rider1Driver, fx.w1);
  fx.batch1 = batch1.id;
  const pkgA = await makePackage(fx.shipmentId, fx.orderId, "01");
  const pkgB = await makePackage(fx.shipmentId, fx.orderId, "02");
  const assignmentA = await prisma.deliveryAssignment.create({
    data: {
      packageId: pkgA.id,
      driverId: fx.rider1Driver,
      batchId: fx.batch1,
      kind: "DELIVERY",
      status: "COMPLETED",
      assignedById: fx.adminUser,
    },
  });
  await prisma.deliveryAssignment.create({
    data: {
      packageId: pkgB.id,
      driverId: fx.rider1Driver,
      batchId: fx.batch1,
      kind: "DELIVERY",
      status: "IN_PROGRESS",
      assignedById: fx.adminUser,
    },
  });
  await prisma.deliveryCodCollection.create({
    data: {
      packageId: pkgA.id,
      shipmentId: fx.shipmentId,
      assignmentId: assignmentA.id,
      batchId: fx.batch1,
      expectedPaisa: BigInt(150000),
      collectedPaisa: BigInt(150000),
      status: "MATCHED",
      collectedById: rider1Actor.userId,
    },
  });

  // Batch 2 (rider1, empty) — concurrency + pause/resume playground.
  fx.batch2 = (await makeBatch(fx.rider1Driver, fx.w1)).id;
  // A completed batch for rider1 — ineligible for tracking.
  fx.batchDone = (await makeBatch(fx.rider1Driver, fx.w1, "COMPLETED")).id;
  // Batches for rider2 @ W2 — scope, close/cancel auto-end.
  fx.batch3 = (await makeBatch(fx.rider2Driver, fx.w2)).id;
  fx.batch4 = (await makeBatch(fx.rider2Driver, fx.w2)).id;

  // Trip fixture: transfer W1 -> W2 with 2 manifested packages.
  const vehicle = await prisma.vehicle.create({
    data: { registration: `VEH-P3-${RUN}`, type: "TRUCK", homeWarehouseId: fx.w1 },
  });
  const transfer = await prisma.transfer.create({
    data: {
      transferNumber: `TRF-P3-${RUN}`,
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
      tripNumber: `TRP-P3-${RUN}`,
      transferId: transfer.id,
      driverId: fx.linehaulDriver,
      vehicleId: vehicle.id,
      status: "DISPATCHED",
    },
  });
  await prisma.transfer.update({ where: { id: transfer.id }, data: { tripId: trip.id } });
  fx.trip = trip.id;
  const pkgT1 = await makePackage(fx.shipmentId, fx.orderId, "03");
  const pkgT2 = await makePackage(fx.shipmentId, fx.orderId, "04");
  fx.tripPkgPhone = pkgT1.recipientPhone;
  for (const pkg of [pkgT1, pkgT2]) {
    await prisma.transferItem.create({
      data: { transferId: transfer.id, packageId: pkg.id, itemStatus: "IN_TRANSIT" },
    });
  }
});

describe("Phase 3 GPS — catalog grants", () => {
  it("drivers hold tracking.manage_own; staff/vendor/customer do not", () => {
    expect(rider1Actor.permissions.has("tracking.manage_own")).toBe(true);
    expect(linehaulActor.permissions.has("tracking.manage_own")).toBe(true);
    expect(staffActor.permissions.has("tracking.manage_own")).toBe(false);
    expect(vendorActor.permissions.has("tracking.manage_own")).toBe(false);
  });

  it("live_view is held by admin + warehouse admins only", () => {
    expect(adminActor.permissions.has("operations.live_view")).toBe(true);
    expect(wa1Actor.permissions.has("operations.live_view")).toBe(true);
    expect(staffActor.permissions.has("operations.live_view")).toBe(false);
    expect(customerActor.permissions.has("operations.live_view")).toBe(false);
  });
});

describe("Phase 3 GPS — session start", () => {
  it("denies an actor without the driver permission", async () => {
    await expect(
      trackingSvc.startTrackingSession(staffActor, {
        deliveryBatchId: fx.batch1,
        permissionAcknowledged: true,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("denies a missing batch", async () => {
    await expect(
      trackingSvc.startTrackingSession(rider1Actor, {
        deliveryBatchId: "00000000-0000-0000-0000-000000000000",
        permissionAcknowledged: true,
      }),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
  });

  it("denies a start without the permission acknowledgement", async () => {
    await expect(
      trackingSvc.startTrackingSession(rider1Actor, {
        deliveryBatchId: fx.batch1,
        permissionAcknowledged: false,
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
  });

  it("denies a driver starting on another driver's batch", async () => {
    await expect(
      trackingSvc.startTrackingSession(rider2Actor, {
        deliveryBatchId: fx.batch1,
        permissionAcknowledged: true,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("denies a start on a completed (ineligible) batch", async () => {
    await expect(
      trackingSvc.startTrackingSession(rider1Actor, {
        deliveryBatchId: fx.batchDone,
        permissionAcknowledged: true,
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  });

  it("starts a DELIVERY session with warehouse derived from the batch", async () => {
    const view = await trackingSvc.startTrackingSession(rider1Actor, {
      deliveryBatchId: fx.batch1,
      permissionAcknowledged: true,
    });
    fx.session1 = view.id;
    expect(view.status).toBe("ACTIVE");
    expect(view.trackingType).toBe("DELIVERY");
    expect(view.originWarehouseId).toBe(fx.w1);
    expect(view.destinationWarehouseId).toBeNull();
    expect(view.driverId).toBe(fx.rider1Driver);
    expect(view.permissionAcknowledgedAt).toBeTruthy();
  });

  it("blocks a second concurrent session for the same driver", async () => {
    await expect(
      trackingSvc.startTrackingSession(rider1Actor, {
        deliveryBatchId: fx.batch2,
        permissionAcknowledged: true,
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  });
});

describe("Phase 3 GPS — ping ingest", () => {
  it("accepts a first ping and creates the snapshot", async () => {
    const result = await trackingSvc.postLocationPing(
      rider1Actor,
      pingBody(fx.session1, 1, { latitude: 27.7, longitude: 85.3 }),
    );
    expect(result.deduplicated).toBe(false);
    expect(result.freshnessState).toBe("FRESH");
    const snapshot = await prisma.driverCurrentLocation.findUnique({
      where: { driverId: fx.rider1Driver },
    });
    expect(snapshot?.latitude).toBe(27.7);
    expect(snapshot?.longitude).toBe(85.3);
    expect(snapshot?.trackingSessionId).toBe(fx.session1);
  });

  it("treats a duplicate sequenceId as an idempotent replay", async () => {
    const result = await trackingSvc.postLocationPing(
      rider1Actor,
      pingBody(fx.session1, 1, { latitude: 27.9, longitude: 85.9 }),
    );
    expect(result.deduplicated).toBe(true);
    const count = await prisma.driverLocationPing.count({
      where: { trackingSessionId: fx.session1 },
    });
    expect(count).toBe(1);
    const snapshot = await prisma.driverCurrentLocation.findUnique({
      where: { driverId: fx.rider1Driver },
    });
    expect(snapshot?.latitude).toBe(27.7);
  });

  it("deduplicates identical coordinates without a new row", async () => {
    const result = await trackingSvc.postLocationPing(
      rider1Actor,
      pingBody(fx.session1, 2, { latitude: 27.7, longitude: 85.3 }),
    );
    expect(result.deduplicated).toBe(true);
    const count = await prisma.driverLocationPing.count({
      where: { trackingSessionId: fx.session1 },
    });
    expect(count).toBe(1);
  });

  it("enforces the minimum interval between accepted pings", async () => {
    await expect(
      trackingSvc.postLocationPing(
        rider1Actor,
        pingBody(fx.session1, 2, { latitude: 27.701, longitude: 85.301 }),
      ),
    ).rejects.toBeInstanceOf(errors.RateLimitError);
  });

  it("accepts after the interval and moves the snapshot", async () => {
    await backdateLastPing(fx.session1, 31);
    const recordedAt = new Date();
    fx.snapshotRecordedAt = recordedAt.toISOString();
    const result = await trackingSvc.postLocationPing(
      rider1Actor,
      pingBody(fx.session1, 2, {
        latitude: 27.701,
        longitude: 85.301,
        recordedAt: recordedAt.toISOString(),
      }),
    );
    expect(result.deduplicated).toBe(false);
    const snapshot = await prisma.driverCurrentLocation.findUnique({
      where: { driverId: fx.rider1Driver },
    });
    expect(snapshot?.latitude).toBe(27.701);
    expect(snapshot?.lastRecordedAt.toISOString()).toBe(fx.snapshotRecordedAt);
  });

  it("stores an out-of-order ping but never rewinds the snapshot", async () => {
    await backdateLastPing(fx.session1, 31);
    const older = new Date(new Date(fx.snapshotRecordedAt).getTime() - 10_000);
    const result = await trackingSvc.postLocationPing(
      rider1Actor,
      pingBody(fx.session1, 3, {
        latitude: 27.65,
        longitude: 85.25,
        recordedAt: older.toISOString(),
      }),
    );
    expect(result.deduplicated).toBe(false);
    const count = await prisma.driverLocationPing.count({
      where: { trackingSessionId: fx.session1 },
    });
    expect(count).toBe(3);
    const snapshot = await prisma.driverCurrentLocation.findUnique({
      where: { driverId: fx.rider1Driver },
    });
    expect(snapshot?.latitude).toBe(27.701);
    expect(snapshot?.lastRecordedAt.toISOString()).toBe(fx.snapshotRecordedAt);
  });

  it("ignores a foreign driverId in the body and audits the mismatch", async () => {
    await backdateLastPing(fx.session1, 31);
    const result = await trackingSvc.postLocationPing(
      rider1Actor,
      pingBody(fx.session1, 4, {
        latitude: 27.702,
        longitude: 85.302,
        driverId: fx.rider2Driver,
      }),
    );
    expect(result.deduplicated).toBe(false);
    expect(result.ping.driverId).toBe(fx.rider1Driver);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "tracking.identity_mismatch", actorId: rider1Actor.userId },
    });
    expect(audit).not.toBeNull();
  });

  it("refuses a ping posted by a different driver to the session", async () => {
    const before = await prisma.driverLocationPing.count({
      where: { trackingSessionId: fx.session1 },
    });
    await expect(
      trackingSvc.postLocationPing(rider2Actor, pingBody(fx.session1, 99)),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const after = await prisma.driverLocationPing.count({
      where: { trackingSessionId: fx.session1 },
    });
    expect(after).toBe(before);
  });

  it("rejects invalid coordinates, accuracy and future timestamps", async () => {
    const before = await prisma.driverLocationPing.count({
      where: { trackingSessionId: fx.session1 },
    });
    await expect(
      trackingSvc.postLocationPing(rider1Actor, pingBody(fx.session1, 50, { latitude: 91 })),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      trackingSvc.postLocationPing(rider1Actor, pingBody(fx.session1, 51, { longitude: -181 })),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      trackingSvc.postLocationPing(rider1Actor, pingBody(fx.session1, 52, { accuracyMeters: 0 })),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      trackingSvc.postLocationPing(
        rider1Actor,
        pingBody(fx.session1, 53, { accuracyMeters: 20000 }),
      ),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      trackingSvc.postLocationPing(
        rider1Actor,
        pingBody(fx.session1, 54, {
          recordedAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        }),
      ),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    const after = await prisma.driverLocationPing.count({
      where: { trackingSessionId: fx.session1 },
    });
    expect(after).toBe(before);
  });
});

describe("Phase 3 GPS — live operations reads", () => {
  it("admin sees the batch movement with counts, location and COD", async () => {
    const { items } = await liveOpsSvc.listLiveOperations(adminActor, {});
    const item = items.find((i) => i.trackingSessionId === fx.session1);
    expect(item).toBeDefined();
    expect(item?.trackingType).toBe("DELIVERY");
    expect(item?.packageCount).toBe(2);
    expect(item?.deliveredCount).toBe(1);
    expect(item?.remainingCount).toBe(1);
    expect(item?.codCollectedPaisa).toBe("150000");
    expect(item?.location?.latitude).toBe(27.702);
    expect(item?.freshnessState).toBe("FRESH");
  });

  it("warehouse admin sees movements touching their warehouse only", async () => {
    const wa1List = await liveOpsSvc.listLiveOperations(wa1Actor, {});
    expect(wa1List.items.some((i) => i.trackingSessionId === fx.session1)).toBe(true);
    const wa2List = await liveOpsSvc.listLiveOperations(wa2Actor, {});
    expect(wa2List.items.some((i) => i.trackingSessionId === fx.session1)).toBe(false);
  });

  it("a requested warehouse filter never widens a scoped actor", async () => {
    const { items } = await liveOpsSvc.listLiveOperations(wa2Actor, {
      warehouseId: fx.w1,
    });
    expect(items.some((i) => i.trackingSessionId === fx.session1)).toBe(false);
  });

  it("omits COD entirely when the actor holds no finance/COD read", async () => {
    const stripped: Actor = {
      ...wa1Actor,
      permissions: new Set(
        [...wa1Actor.permissions].filter(
          (p) => p !== "finance.read" && p !== "cod.read",
        ),
      ),
    };
    const { items } = await liveOpsSvc.listLiveOperations(stripped, {});
    const item = items.find((i) => i.trackingSessionId === fx.session1);
    expect(item).toBeDefined();
    expect(item && "codCollectedPaisa" in item).toBe(false);
  });

  it("denies vendor, customer and staff actors", async () => {
    for (const actor of [vendorActor, customerActor, staffActor]) {
      await expect(liveOpsSvc.listLiveOperations(actor, {})).rejects.toBeInstanceOf(
        actorErrors.AuthorizationError,
      );
      await expect(
        liveOpsSvc.getLiveOperationDetail(actor, fx.session1),
      ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    }
  });

  it("denies detail for an out-of-scope warehouse admin", async () => {
    await expect(
      liveOpsSvc.getLiveOperationDetail(wa2Actor, fx.session1),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });
});

describe("Phase 3 GPS — trip (linehaul) sessions", () => {
  it("starts a LINEHAUL session with origin/destination from the transfer", async () => {
    const view = await trackingSvc.startTrackingSession(linehaulActor, {
      tripId: fx.trip,
      permissionAcknowledged: true,
    });
    fx.tripSession = view.id;
    expect(view.trackingType).toBe("LINEHAUL");
    expect(view.originWarehouseId).toBe(fx.w1);
    expect(view.destinationWarehouseId).toBe(fx.w2);
  });

  it("denies a rider starting on a trip that is not theirs", async () => {
    await expect(
      trackingSvc.startTrackingSession(rider2Actor, {
        tripId: fx.trip,
        permissionAcknowledged: true,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("detail returns the manifested packages without recipient PII", async () => {
    const detail = await liveOpsSvc.getLiveOperationDetail(adminActor, fx.tripSession);
    expect(detail.packageCount).toBe(2);
    expect(detail.packages).toHaveLength(2);
    expect(detail.packages[0].trackingId).toBeTruthy();
    expect(JSON.stringify(detail)).not.toContain(fx.tripPkgPhone);
    expect(JSON.stringify(detail)).not.toContain("Recipient");
  });

  it("destination warehouse admin sees the incoming trip", async () => {
    const { items } = await liveOpsSvc.listLiveOperations(wa2Actor, {});
    expect(items.some((i) => i.trackingSessionId === fx.tripSession)).toBe(true);
  });
});

describe("Phase 3 GPS — stop, pause, resume", () => {
  it("driver stop ends the session and later pings are refused", async () => {
    const view = await trackingSvc.stopTrackingSession(rider1Actor, fx.session1);
    expect(view.status).toBe("ENDED");
    expect(view.endReason).toBe("DRIVER");
    await expect(
      trackingSvc.postLocationPing(rider1Actor, pingBody(fx.session1, 60)),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  });

  it("an ended session shows OFFLINE inside the recent window", async () => {
    const { items } = await liveOpsSvc.listLiveOperations(adminActor, {});
    const item = items.find((i) => i.trackingSessionId === fx.session1);
    expect(item).toBeDefined();
    expect(item?.freshnessState).toBe("OFFLINE");
  });

  it("pause blocks pings and resume re-enables them", async () => {
    const view = await trackingSvc.startTrackingSession(rider1Actor, {
      deliveryBatchId: fx.batch2,
      permissionAcknowledged: true,
    });
    fx.session2 = view.id;
    const paused = await trackingSvc.pauseTrackingSession(rider1Actor, fx.session2);
    expect(paused.status).toBe("PAUSED");
    await expect(
      trackingSvc.postLocationPing(rider1Actor, pingBody(fx.session2, 1)),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    const resumed = await trackingSvc.resumeTrackingSession(rider1Actor, fx.session2);
    expect(resumed.status).toBe("ACTIVE");
    const result = await trackingSvc.postLocationPing(
      rider1Actor,
      pingBody(fx.session2, 1),
    );
    expect(result.deduplicated).toBe(false);
  });
});

describe("Phase 3 GPS — supervisor stop and assignment auto-end", () => {
  it("an in-scope warehouse admin can supervisor-stop, audited twice", async () => {
    const view = await trackingSvc.startTrackingSession(rider2Actor, {
      deliveryBatchId: fx.batch3,
      permissionAcknowledged: true,
    });
    const stopped = await trackingSvc.stopTrackingSession(wa2Actor, view.id);
    expect(stopped.status).toBe("ENDED");
    expect(stopped.endReason).toBe("SUPERVISOR");
    const generic = await prisma.auditLog.findFirst({
      where: { action: "tracking.session_stopped", entityId: view.id },
    });
    const supervisor = await prisma.auditLog.findFirst({
      where: { action: "tracking.session_stopped_supervisor", entityId: view.id },
    });
    expect(generic).not.toBeNull();
    expect(supervisor).not.toBeNull();
  });

  it("closing the batch auto-ends its tracking session", async () => {
    const view = await trackingSvc.startTrackingSession(rider2Actor, {
      deliveryBatchId: fx.batch3,
      permissionAcknowledged: true,
    });
    fx.session3 = view.id;
    await deliveriesSvc.closeBatch(rider2Actor, fx.batch3);
    const session = await prisma.trackingSession.findUnique({
      where: { id: fx.session3 },
    });
    expect(session?.status).toBe("ENDED");
    expect(session?.endReason).toBe("ASSIGNMENT_COMPLETED");
    await expect(
      trackingSvc.postLocationPing(rider2Actor, pingBody(fx.session3, 1)),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  });

  it("cancelling the batch auto-ends with ASSIGNMENT_CANCELLED", async () => {
    const view = await trackingSvc.startTrackingSession(rider2Actor, {
      deliveryBatchId: fx.batch4,
      permissionAcknowledged: true,
    });
    await deliveriesSvc.cancelBatch(adminActor, fx.batch4);
    const session = await prisma.trackingSession.findUnique({
      where: { id: view.id },
    });
    expect(session?.status).toBe("ENDED");
    expect(session?.endReason).toBe("ASSIGNMENT_CANCELLED");
  });
});

describe("Phase 3 GPS — freshness, expiry, retention", () => {
  const freshnessFixture = async (
    label: string,
    ageSeconds: number,
  ): Promise<string> => {
    const user = await makeUser(label, "RIDER");
    const driverId = await makeDriver(user, fx.w1, label.toUpperCase());
    const batch = await makeBatch(driverId, fx.w1);
    const session = await prisma.trackingSession.create({
      data: {
        driverId,
        deliveryBatchId: batch.id,
        trackingType: "DELIVERY",
        originWarehouseId: fx.w1,
        status: "ACTIVE",
        startReason: "DRIVER",
        permissionAcknowledgedAt: new Date(),
      },
    });
    const receivedAt = new Date(Date.now() - ageSeconds * 1000);
    await prisma.driverCurrentLocation.create({
      data: {
        driverId,
        trackingSessionId: session.id,
        latitude: 27.7,
        longitude: 85.3,
        accuracyMeters: 10,
        lastRecordedAt: receivedAt,
        lastReceivedAt: receivedAt,
        freshnessState: "FRESH",
        activeBatchId: batch.id,
      },
    });
    return session.id;
  };

  it("computes FRESH / DELAYED / STALE from the receive clock", async () => {
    fx.freshSession = await freshnessFixture("fresh", 60);
    fx.delayedSession = await freshnessFixture("delayed", 600);
    fx.staleSession = await freshnessFixture("stale", 1200);
    const { items } = await liveOpsSvc.listLiveOperations(adminActor, {});
    const byId = new Map(items.map((i) => [i.trackingSessionId, i.freshnessState]));
    expect(byId.get(fx.freshSession)).toBe("FRESH");
    expect(byId.get(fx.delayedSession)).toBe("DELAYED");
    expect(byId.get(fx.staleSession)).toBe("STALE");
  });

  it("an out-of-scope warehouse admin cannot stop the session", async () => {
    await expect(
      trackingSvc.stopTrackingSession(wa2Actor, fx.staleSession),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const session = await prisma.trackingSession.findUnique({
      where: { id: fx.staleSession },
    });
    expect(session?.status).toBe("ACTIVE");
  });

  it("expires abandoned sessions but leaves reporting ones alone", async () => {
    const user = await makeUser("old", "RIDER");
    const driverId = await makeDriver(user, fx.w1, "OLD");
    const batch = await makeBatch(driverId, fx.w1);
    const old = await prisma.trackingSession.create({
      data: {
        driverId,
        deliveryBatchId: batch.id,
        trackingType: "DELIVERY",
        originWarehouseId: fx.w1,
        status: "ACTIVE",
        startReason: "DRIVER",
        permissionAcknowledgedAt: new Date(),
        startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      },
    });
    const ended = await trackingSvc.expireAbandonedTrackingSessions(new Date());
    expect(ended).toBeGreaterThanOrEqual(1);
    const after = await prisma.trackingSession.findUnique({ where: { id: old.id } });
    expect(after?.status).toBe("ENDED");
    expect(after?.endReason).toBe("EXPIRED");
    const fresh = await prisma.trackingSession.findUnique({
      where: { id: fx.freshSession },
    });
    expect(fresh?.status).toBe("ACTIVE");
  });

  it("prune deletes only pings older than the retention window", async () => {
    const base = {
      trackingSessionId: fx.freshSession,
      driverId: (await prisma.trackingSession.findUnique({
        where: { id: fx.freshSession },
      }))!.driverId,
      latitude: 27.7,
      longitude: 85.3,
      accuracyMeters: 10,
      source: "BROWSER",
    };
    const old = await prisma.driverLocationPing.create({
      data: {
        ...base,
        sequenceId: 900,
        recordedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
        receivedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000),
      },
    });
    const recent = await prisma.driverLocationPing.create({
      data: {
        ...base,
        sequenceId: 901,
        recordedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
        receivedAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    });
    const { deleted } = await trackingSvc.pruneExpiredLocationPings(new Date());
    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.driverLocationPing.findUnique({ where: { id: old.id } }),
    ).toBeNull();
    expect(
      await prisma.driverLocationPing.findUnique({ where: { id: recent.id } }),
    ).not.toBeNull();
    // Sessions and snapshots are never pruned.
    expect(
      await prisma.trackingSession.findUnique({ where: { id: fx.freshSession } }),
    ).not.toBeNull();
    expect(
      await prisma.driverCurrentLocation.findFirst({
        where: { trackingSessionId: fx.freshSession },
      }),
    ).not.toBeNull();
    fx.recentPingId = recent.id;
  });

  it("honours a SystemSetting retention override, then cleans up", async () => {
    await prisma.systemSetting.upsert({
      where: { key: "tracking.config" },
      update: { value: { retentionDays: 7 } },
      create: { key: "tracking.config", value: { retentionDays: 7 } },
    });
    try {
      const tenDayPing = await prisma.driverLocationPing.create({
        data: {
          trackingSessionId: fx.freshSession,
          driverId: (await prisma.trackingSession.findUnique({
            where: { id: fx.freshSession },
          }))!.driverId,
          latitude: 27.7,
          longitude: 85.3,
          accuracyMeters: 10,
          source: "BROWSER",
          sequenceId: 902,
          recordedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
          receivedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        },
      });
      await trackingSvc.pruneExpiredLocationPings(new Date());
      expect(
        await prisma.driverLocationPing.findUnique({ where: { id: tenDayPing.id } }),
      ).toBeNull();
      // The 1-day-old ping survives even the 7-day override.
      expect(
        await prisma.driverLocationPing.findUnique({ where: { id: fx.recentPingId } }),
      ).not.toBeNull();
    } finally {
      await prisma.systemSetting.delete({ where: { key: "tracking.config" } });
    }
  });
});
