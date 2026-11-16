import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 7 (V2) — getDriverProfile (src/server/services/drivers.ts)
 * against bla_test.
 *
 * Pins the driver-detail contract:
 *  - the fleet read gate (driver.manage / driver.assign) + audited
 *    denial for actors without it;
 *  - scope: unscoped actors read any driver; a warehouse-scoped
 *    actor reads drivers homed at their warehouses OR currently
 *    working out of them (active trip whose transfer originates at
 *    their warehouse, active delivery batch at their warehouse);
 *    a foreign driver with no scope link is denied + audited;
 *  - the profile body: identity, home warehouse, licence + expired
 *    flag, current vehicle, current trip/batch with counts, recent
 *    activity;
 *  - the GPS snapshot key is present only for operations.live_view
 *    holders (null when permitted but no snapshot exists) and
 *    ABSENT entirely otherwise.
 *
 * Fixture warehouses / users are per-run unique (RUN-suffixed).
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
const email = (label: string) => `p7d-${label}-${RUN}@bla.test`;

let prisma: import("@prisma/client").PrismaClient;
let driversSvc: typeof import("@/server/services/drivers");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let adminActor: Actor;
let waAActor: Actor;
let batchDateStr: string;
let tripNumber: string;

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

async function makeUser(
  label: string,
  roleCode: string,
  opts: { fullName?: string; phone?: string } = {},
): Promise<string> {
  const { hash } = await import("bcryptjs");
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: opts.fullName ?? `P7D ${label} ${RUN}`,
      phone: opts.phone ?? null,
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

async function makeDriver(
  label: string,
  opts: {
    roleCode: string;
    homeWarehouseId: string;
    capabilities: string[];
    fullName?: string;
    phone?: string;
  },
): Promise<{ userId: string; driverId: string }> {
  const userId = await makeUser(label, opts.roleCode, {
    fullName: opts.fullName,
    phone: opts.phone,
  });
  const driver = await prisma.driver.create({
    data: {
      userId,
      homeWarehouseId: opts.homeWarehouseId,
      licenseNumber: `LIC-P7D-${label}-${RUN}`,
      licenseCategory: "A",
      licenseExpiry: new Date("2030-01-01"),
      capabilities: { create: opts.capabilities.map((capability) => ({ capability })) },
    },
  });
  return { userId, driverId: driver.id };
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
  driversSvc = await import("@/server/services/drivers");
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

  const wA = await prisma.warehouse.create({
    data: { code: `P7A-${RUN}`, name: `P7 Alpha ${RUN}`, district: "Kathmandu", city: "Kathmandu", province: "Bagmati", status: "ACTIVE" },
  });
  const wB = await prisma.warehouse.create({
    data: { code: `P7B-${RUN}`, name: `P7 Beta ${RUN}`, district: "Kaski", city: "Pokhara", province: "Gandaki", status: "ACTIVE" },
  });
  fx.whA = wA.id;
  fx.whB = wB.id;
  fx.whACode = wA.code;
  fx.whBCode = wB.code;

  fx.adminUser = await makeUser("admin", "ADMIN");
  adminActor = await actorFor(fx.adminUser);

  fx.waAUser = await makeUser("waa", "WAREHOUSE_ADMIN");
  await addMembership(fx.waAUser, fx.whA, "WAREHOUSE_ADMIN");
  waAActor = await actorFor(fx.waAUser);

  // Driver homed at whA — own-warehouse read for WA-A; carries the
  // assigned vehicle + the GPS session/snapshot.
  const home = await makeDriver("home", {
    roleCode: "RIDER",
    homeWarehouseId: fx.whA,
    capabilities: ["DELIVERY", "PICKUP"],
    fullName: `P7D HomeDriver ${RUN}`,
    phone: "+9779800000011",
  });
  fx.homeDriver = home.driverId;
  fx.homeDriverUser = home.userId;

  const vehicle = await prisma.vehicle.create({
    data: {
      registration: `P7D VAN ${RUN}`,
      type: "VAN",
      homeWarehouseId: fx.whA,
      assignedDriverId: fx.homeDriver,
    },
  });
  fx.vehicleReg = vehicle.registration;

  batchDateStr = new Date().toISOString().slice(0, 10);
  const homeBatch = await prisma.deliveryBatch.create({
    data: {
      riderId: fx.homeDriver,
      warehouseId: fx.whA,
      batchDate: new Date(batchDateStr),
      kind: "DELIVERY",
      status: "OPEN",
      createdById: fx.adminUser,
    },
  });
  fx.homeBatch = homeBatch.id;
  const session = await prisma.trackingSession.create({
    data: {
      driverId: fx.homeDriver,
      deliveryBatchId: fx.homeBatch,
      trackingType: "DELIVERY",
      originWarehouseId: fx.whA,
      status: "ACTIVE",
      startReason: "DRIVER",
      permissionAcknowledgedAt: new Date(),
    },
  });
  fx.homeSession = session.id;
  const receivedAt = new Date();
  await prisma.driverCurrentLocation.create({
    data: {
      driverId: fx.homeDriver,
      trackingSessionId: fx.homeSession,
      latitude: 27.71,
      longitude: 85.32,
      accuracyMeters: 12,
      lastRecordedAt: receivedAt,
      lastReceivedAt: receivedAt,
      freshnessState: "FRESH",
      activeBatchId: fx.homeBatch,
    },
  });

  // Foreign driver: homed at whB, no work link to whA. Licence aged
  // directly (the write path refuses past expiries) for the
  // expired-flag assertion.
  const foreign = await makeDriver("foreign", {
    roleCode: "RIDER",
    homeWarehouseId: fx.whB,
    capabilities: ["DELIVERY"],
    fullName: `P7D ForeignDriver ${RUN}`,
    phone: "+9779800000022",
  });
  fx.foreignDriver = foreign.driverId;
  fx.foreignDriverUser = foreign.userId;
  await prisma.driver.update({
    where: { id: fx.foreignDriver },
    data: { licenseExpiry: new Date("2020-01-01T00:00:00.000Z") },
  });

  // Batch worker: homed at whB but running an active batch at whA
  // (3 assignments: 1 completed, 1 in progress, 1 pending).
  const batchWorker = await makeDriver("batchworker", {
    roleCode: "RIDER",
    homeWarehouseId: fx.whB,
    capabilities: ["DELIVERY"],
    fullName: `P7D BatchWorker ${RUN}`,
  });
  fx.batchDriver = batchWorker.driverId;

  const service = await prisma.shippingService.create({
    data: { code: `P7SVC-${RUN}`, name: `P7 Service ${RUN}` },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-P7D-${RUN}`,
      createdById: fx.adminUser,
      createdByRole: "ADMIN",
      senderName: "P7D Sender",
      senderPhone: "9779811111111",
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-P7D-${RUN}`,
      orderId: order.id,
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
      routeKind: "INTER_WAREHOUSE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(0),
    },
  });
  const workBatch = await prisma.deliveryBatch.create({
    data: {
      riderId: fx.batchDriver,
      warehouseId: fx.whA,
      batchDate: new Date(batchDateStr),
      kind: "DELIVERY",
      status: "IN_PROGRESS",
      createdById: fx.adminUser,
    },
  });
  fx.workBatch = workBatch.id;
  const assignmentStatuses = ["COMPLETED", "IN_PROGRESS", "PENDING"];
  for (const [index, status] of assignmentStatuses.entries()) {
    const pkg = await prisma.package.create({
      data: {
        trackingId: `BLA-P7D-${index}-${RUN}`,
        shipmentId: shipment.id,
        orderId: order.id,
        recipientName: `Recipient ${index}`,
        recipientPhone: `977980000010${index}`,
        deliveryAddress: `Address ${index}`,
        deliveryCity: "Kathmandu",
        deliveryDistrict: "Kathmandu",
        declaredWeightKg: "1.000",
        description: `Parcel ${index}`,
      },
    });
    await prisma.deliveryAssignment.create({
      data: {
        packageId: pkg.id,
        driverId: fx.batchDriver,
        batchId: fx.workBatch,
        kind: "DELIVERY",
        status,
        assignedById: fx.adminUser,
      },
    });
  }

  // Trip worker: homed at whB, active trip on a transfer ORIGINATING
  // at whA.
  const tripWorker = await makeDriver("tripworker", {
    roleCode: "LINEHAUL_DRIVER",
    homeWarehouseId: fx.whB,
    capabilities: ["LINEHAUL"],
    fullName: `P7D TripWorker ${RUN}`,
  });
  fx.tripDriver = tripWorker.driverId;
  const tripVehicle = await prisma.vehicle.create({
    data: { registration: `P7D TRK ${RUN}`, type: "TRUCK", homeWarehouseId: fx.whA },
  });
  tripNumber = `TRP-P7D-${RUN}`;
  const transfer = await prisma.transfer.create({
    data: {
      transferNumber: `TRF-P7D-${RUN}`,
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
      status: "IN_TRANSIT",
      driverId: fx.tripDriver,
      vehicleId: tripVehicle.id,
      createdById: fx.adminUser,
    },
  });
  const trip = await prisma.trip.create({
    data: {
      tripNumber,
      transferId: transfer.id,
      driverId: fx.tripDriver,
      vehicleId: tripVehicle.id,
      status: "DISPATCHED",
    },
  });
  await prisma.transfer.update({ where: { id: transfer.id }, data: { tripId: trip.id } });
  fx.tripId = trip.id;
}, 120_000);

describe("getDriverProfile — gate and scope", { timeout: 120_000 }, () => {
  it("an unscoped actor reads any driver, with identity, home warehouse and the expired-licence flag", async () => {
    const profile = await driversSvc.getDriverProfile(adminActor, fx.foreignDriver);
    expect(profile.id).toBe(fx.foreignDriver);
    expect(profile.fullName).toBe(`P7D ForeignDriver ${RUN}`);
    expect(profile.email).toBe(email("foreign"));
    expect(profile.phone).toBe("+9779800000022");
    expect(profile.roles).toContain("RIDER");
    expect(profile.capabilities).toEqual(["DELIVERY"]);
    expect(profile.homeWarehouse).toEqual({
      id: fx.whB,
      code: fx.whBCode,
      name: `P7 Beta ${RUN}`,
    });
    expect(profile.licenseExpiry).toBe("2020-01-01");
    expect(profile.licenseExpired).toBe(true);
    expect(profile.employmentStatus).toBe("ACTIVE");
    // Permitted (operations.live_view) but no snapshot → key present, null.
    expect("gps" in profile).toBe(true);
    expect(profile.gps).toBeNull();
  });

  it("a warehouse admin reads a driver homed at their warehouse, including the current vehicle", async () => {
    const profile = await driversSvc.getDriverProfile(waAActor, fx.homeDriver);
    expect(profile.id).toBe(fx.homeDriver);
    expect(profile.homeWarehouse.id).toBe(fx.whA);
    expect(profile.licenseExpired).toBe(false);
    expect(profile.currentVehicle?.registration).toBe(fx.vehicleReg);
    expect(profile.currentBatch?.id).toBe(fx.homeBatch);
  });

  it("a warehouse admin reading a foreign driver with no scope link is denied and the denial is audited", async () => {
    await expect(
      driversSvc.getDriverProfile(waAActor, fx.foreignDriver),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const denial = await prisma.auditLog.findFirst({
      where: {
        actorId: fx.waAUser,
        action: "access.denied",
        entityType: "Driver",
        entityId: fx.foreignDriver,
      },
    });
    expect(denial).not.toBeNull();
  });

  it("an actor without the fleet read gate (rider: driver.read_self only) is denied", async () => {
    const riderActor = await actorFor(fx.foreignDriverUser);
    expect(riderActor.permissions.has("driver.manage")).toBe(false);
    expect(riderActor.permissions.has("driver.assign")).toBe(false);
    await expect(
      driversSvc.getDriverProfile(riderActor, fx.homeDriver),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("a missing driver is a 404, not a scope denial", async () => {
    await expect(
      driversSvc.getDriverProfile(adminActor, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toThrow(/not found/i);
  });
});

describe("getDriverProfile — scope via current work", { timeout: 120_000 }, () => {
  it("a warehouse admin reads a foreign-homed driver with an active batch at their warehouse; the profile carries the batch counts", async () => {
    const profile = await driversSvc.getDriverProfile(waAActor, fx.batchDriver);
    expect(profile.homeWarehouse.id).toBe(fx.whB);
    expect(profile.currentBatch).not.toBeNull();
    expect(profile.currentBatch!.id).toBe(fx.workBatch);
    expect(profile.currentBatch!.warehouse.id).toBe(fx.whA);
    expect(profile.currentBatch!.status).toBe("IN_PROGRESS");
    expect(profile.currentBatch!.assignedCount).toBe(3);
    expect(profile.currentBatch!.deliveredCount).toBe(1);
    expect(profile.currentBatch!.remainingCount).toBe(2);
    expect(profile.recentBatches.map((b) => b.id)).toContain(fx.workBatch);
    expect(profile.currentTrip).toBeNull();
  });

  it("a warehouse admin reads a foreign-homed driver with an active trip originating at their warehouse; the profile carries the trip", async () => {
    const profile = await driversSvc.getDriverProfile(waAActor, fx.tripDriver);
    expect(profile.homeWarehouse.id).toBe(fx.whB);
    expect(profile.currentTrip).not.toBeNull();
    expect(profile.currentTrip!.id).toBe(fx.tripId);
    expect(profile.currentTrip!.tripNumber).toBe(tripNumber);
    expect(profile.currentTrip!.status).toBe("DISPATCHED");
    expect(profile.currentTrip!.origin.id).toBe(fx.whA);
    expect(profile.currentTrip!.destination.id).toBe(fx.whB);
    expect(profile.recentTrips.map((t) => t.id)).toContain(fx.tripId);
    expect(profile.currentBatch).toBeNull();
  });
});

describe("getDriverProfile — GPS snapshot gating", { timeout: 120_000 }, () => {
  it("the snapshot is present with operations.live_view", async () => {
    const profile = await driversSvc.getDriverProfile(adminActor, fx.homeDriver);
    expect("gps" in profile).toBe(true);
    expect(profile.gps).not.toBeNull();
    expect(profile.gps!.latitude).toBeCloseTo(27.71);
    expect(profile.gps!.longitude).toBeCloseTo(85.32);
    expect(profile.gps!.accuracyMeters).toBe(12);
    expect(profile.gps!.freshnessState).toBe("FRESH");
    expect(profile.gps!.trackingSessionId).toBe(fx.homeSession);
    expect(profile.gps!.trackingType).toBe("DELIVERY");
    expect(Number.isNaN(Date.parse(profile.gps!.lastReceivedAt))).toBe(false);
  });

  it("the gps key is absent entirely for the same actor without operations.live_view", async () => {
    const noLiveActor: Actor = {
      ...waAActor,
      permissions: new Set(
        [...waAActor.permissions].filter((p) => p !== "operations.live_view"),
      ),
    };
    expect(noLiveActor.permissions.has("driver.manage")).toBe(true);
    const profile = await driversSvc.getDriverProfile(noLiveActor, fx.homeDriver);
    expect(profile.id).toBe(fx.homeDriver);
    expect("gps" in profile).toBe(false);
    expect(profile.gps).toBeUndefined();
  });
});
