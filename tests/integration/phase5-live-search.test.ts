import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 5 (V2) — live-operations server-side search + payload
 * additions against bla_test.
 *
 * Mirrors the Phase 3 tracking fixtures: catalog roles/permissions
 * upserted the same way, per-run warehouses (a KTM warehouse and a
 * PKR warehouse), drivers with ACTIVE batch + trip tracking
 * sessions created directly in the DB (the freshness-fixture
 * pattern from Phase 3), and DriverCurrentLocation snapshots.
 *
 * Covers:
 *  - search composes with scope (never widens it);
 *  - global actor finds what a scoped actor cannot;
 *  - driver-name / trip-number / transfer-number / tracking-id /
 *    batch-id-prefix search;
 *  - search ∩ warehouseId filter;
 *  - new payload fields: transferId, batchDate, generatedAt,
 *    latestReceivedAt.
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
const email = (label: string) => `p5-${label}-${RUN}@bla.test`;

let prisma: import("@prisma/client").PrismaClient;
let liveOpsSvc: typeof import("@/server/services/live-operations");
let catalog: typeof import("@/lib/permissions/catalog");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let adminActor: Actor;
let waKtmActor: Actor;

let pkrTrackingId: string;
let ktmTrackingId: string;
let tripNumber: string;
let transferNumber: string;
let batchDateStr: string;
let pkrReceivedAt: Date;

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
  fullName?: string,
): Promise<string> {
  const { hash } = await import("bcryptjs");
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: fullName ?? `P5 ${label}`,
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
      licenseNumber: `LIC-P5-${label}-${RUN}`,
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
      batchDate: new Date(batchDateStr),
      kind: "DELIVERY",
      status: "OPEN",
      createdById: fx.adminUser,
    },
  });
}

async function makePackage(shipmentId: string, orderId: string, label: string, trackingId: string) {
  return prisma.package.create({
    data: {
      trackingId,
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

async function makeSessionAndSnapshot(opts: {
  driverId: string;
  deliveryBatchId?: string;
  tripId?: string;
  trackingType: string;
  originWarehouseId: string;
  destinationWarehouseId?: string;
  receivedAt: Date;
}) {
  const session = await prisma.trackingSession.create({
    data: {
      driverId: opts.driverId,
      deliveryBatchId: opts.deliveryBatchId ?? null,
      tripId: opts.tripId ?? null,
      trackingType: opts.trackingType,
      originWarehouseId: opts.originWarehouseId,
      destinationWarehouseId: opts.destinationWarehouseId ?? null,
      status: "ACTIVE",
      startReason: "DRIVER",
      permissionAcknowledgedAt: new Date(),
    },
  });
  await prisma.driverCurrentLocation.create({
    data: {
      driverId: opts.driverId,
      trackingSessionId: session.id,
      latitude: 27.7,
      longitude: 85.3,
      accuracyMeters: 10,
      lastRecordedAt: opts.receivedAt,
      lastReceivedAt: opts.receivedAt,
      freshnessState: "FRESH",
      activeBatchId: opts.deliveryBatchId ?? null,
      activeTripId: opts.tripId ?? null,
    },
  });
  return session.id;
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
  liveOpsSvc = await import("@/server/services/live-operations");
  catalog = await import("@/lib/permissions/catalog");

  // Permission catalog into bla_test (same upserts as Phase 3 / seed).
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

  // Warehouses: KTM and PKR for this run (unique codes per run,
  // same convention as Phase 3's P3A/P3B warehouses).
  const wKtm = await prisma.warehouse.create({
    data: { code: `P5K-${RUN}`, name: `P5 KTM ${RUN}`, district: "Kathmandu", city: "Kathmandu", province: "Bagmati" },
  });
  const wPkr = await prisma.warehouse.create({
    data: { code: `P5P-${RUN}`, name: `P5 PKR ${RUN}`, district: "Kaski", city: "Pokhara", province: "Gandaki" },
  });
  fx.wKtm = wKtm.id;
  fx.wPkr = wPkr.id;

  // Actors: global admin + KTM-only warehouse admin.
  fx.adminUser = await makeUser("admin", "ADMIN");
  adminActor = await actorFor(fx.adminUser);

  const waKtmUser = await makeUser("waktm", "WAREHOUSE_ADMIN");
  await addMembership(waKtmUser, fx.wKtm, "WAREHOUSE_ADMIN");
  waKtmActor = await actorFor(waKtmUser);

  // Drivers with distinctive, RUN-unique names for name search.
  const riderKtmUser = await makeUser("riderktm", "RIDER", `SearchAlpha-${RUN} Driver`);
  fx.riderKtmDriver = await makeDriver(riderKtmUser, fx.wKtm, "RK");
  const riderPkrUser = await makeUser("riderpkr", "RIDER", `SearchBeta-${RUN} Driver`);
  fx.riderPkrDriver = await makeDriver(riderPkrUser, fx.wPkr, "RP");
  const linehaulUser = await makeUser("linehaul", "LINEHAUL_DRIVER", `SearchGamma-${RUN} Driver`);
  fx.linehaulDriver = await makeDriver(linehaulUser, fx.wKtm, "LH");

  // Order / shipment / packages.
  batchDateStr = new Date().toISOString().slice(0, 10);
  const service = await prisma.shippingService.create({
    data: { code: `P5SVC-${RUN}`, name: `P5 Service ${RUN}` },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-P5-${RUN}`,
      createdById: fx.adminUser,
      createdByRole: "ADMIN",
      senderName: "P5 Sender",
      senderPhone: "9779811111111",
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  fx.orderId = order.id;
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-P5-${RUN}`,
      orderId: order.id,
      originWarehouseId: fx.wKtm,
      destinationWarehouseId: fx.wPkr,
      routeKind: "INTER_WAREHOUSE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(0),
    },
  });
  fx.shipmentId = shipment.id;

  ktmTrackingId = `BLA-P5-KTM-${RUN}`;
  pkrTrackingId = `BLA-P5-PKR-${RUN}`;
  const tripTrackingId = `BLA-P5-TRIP-${RUN}`;

  // KTM batch movement (rider KTM @ KTM).
  const batchKtm = await makeBatch(fx.riderKtmDriver, fx.wKtm);
  fx.batchKtm = batchKtm.id;
  const pkgKtm = await makePackage(fx.shipmentId, fx.orderId, "11", ktmTrackingId);
  await prisma.deliveryAssignment.create({
    data: {
      packageId: pkgKtm.id,
      driverId: fx.riderKtmDriver,
      batchId: fx.batchKtm,
      kind: "DELIVERY",
      status: "IN_PROGRESS",
      assignedById: fx.adminUser,
    },
  });

  // PKR batch movement (rider PKR @ PKR) — invisible to KTM admin.
  const batchPkr = await makeBatch(fx.riderPkrDriver, fx.wPkr);
  fx.batchPkr = batchPkr.id;
  const pkgPkr = await makePackage(fx.shipmentId, fx.orderId, "22", pkrTrackingId);
  await prisma.deliveryAssignment.create({
    data: {
      packageId: pkgPkr.id,
      driverId: fx.riderPkrDriver,
      batchId: fx.batchPkr,
      kind: "DELIVERY",
      status: "IN_PROGRESS",
      assignedById: fx.adminUser,
    },
  });

  // Trip movement: transfer KTM -> PKR with one manifested package.
  tripNumber = `TRP-P5-${RUN}`;
  transferNumber = `TRF-P5-${RUN}`;
  const vehicle = await prisma.vehicle.create({
    data: { registration: `VEH-P5-${RUN}`, type: "TRUCK", homeWarehouseId: fx.wKtm },
  });
  const transfer = await prisma.transfer.create({
    data: {
      transferNumber,
      originWarehouseId: fx.wKtm,
      destinationWarehouseId: fx.wPkr,
      status: "IN_TRANSIT",
      driverId: fx.linehaulDriver,
      vehicleId: vehicle.id,
      createdById: fx.adminUser,
    },
  });
  fx.transferId = transfer.id;
  const trip = await prisma.trip.create({
    data: {
      tripNumber,
      transferId: transfer.id,
      driverId: fx.linehaulDriver,
      vehicleId: vehicle.id,
      status: "DISPATCHED",
    },
  });
  await prisma.transfer.update({ where: { id: transfer.id }, data: { tripId: trip.id } });
  fx.tripId = trip.id;
  const pkgTrip = await makePackage(fx.shipmentId, fx.orderId, "33", tripTrackingId);
  fx.tripTrackingId = tripTrackingId;
  await prisma.transferItem.create({
    data: { transferId: transfer.id, packageId: pkgTrip.id, itemStatus: "IN_TRANSIT" },
  });

  // ACTIVE sessions + snapshots (Phase 3 freshness-fixture pattern).
  const now = Date.now();
  fx.sessionKtm = await makeSessionAndSnapshot({
    driverId: fx.riderKtmDriver,
    deliveryBatchId: fx.batchKtm,
    trackingType: "DELIVERY",
    originWarehouseId: fx.wKtm,
    receivedAt: new Date(now - 300_000),
  });
  pkrReceivedAt = new Date(now - 60_000);
  fx.sessionPkr = await makeSessionAndSnapshot({
    driverId: fx.riderPkrDriver,
    deliveryBatchId: fx.batchPkr,
    trackingType: "DELIVERY",
    originWarehouseId: fx.wPkr,
    receivedAt: pkrReceivedAt,
  });
  fx.sessionTrip = await makeSessionAndSnapshot({
    driverId: fx.linehaulDriver,
    tripId: fx.tripId,
    trackingType: "LINEHAUL",
    originWarehouseId: fx.wKtm,
    destinationWarehouseId: fx.wPkr,
    receivedAt: new Date(now - 120_000),
  });
});

describe("Phase 5 live search — scope composition", () => {
  it("a Warehouse Admin of KTM searching a PKR package tracking ID gets an empty result", async () => {
    const result = await liveOpsSvc.listLiveOperations(waKtmActor, {
      search: pkrTrackingId,
    });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
    // Same check with a lower-cased query (insensitive path).
    const lower = await liveOpsSvc.listLiveOperations(waKtmActor, {
      search: pkrTrackingId.toLowerCase(),
    });
    expect(lower.items).toHaveLength(0);
    expect(lower.total).toBe(0);
  });

  it("a global actor searching that same tracking ID finds the movement", async () => {
    const result = await liveOpsSvc.listLiveOperations(adminActor, {
      search: pkrTrackingId.toLowerCase(),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].trackingSessionId).toBe(fx.sessionPkr);
    expect(result.items[0].deliveryBatchId).toBe(fx.batchPkr);
  });

  it("search combined with a warehouseId filter intersects (match in the other warehouse → empty)", async () => {
    const wrongWarehouse = await liveOpsSvc.listLiveOperations(adminActor, {
      search: pkrTrackingId,
      warehouseId: fx.wKtm,
    });
    expect(wrongWarehouse.items).toHaveLength(0);
    expect(wrongWarehouse.total).toBe(0);

    const rightWarehouse = await liveOpsSvc.listLiveOperations(adminActor, {
      search: pkrTrackingId,
      warehouseId: fx.wPkr,
    });
    expect(rightWarehouse.items).toHaveLength(1);
    expect(rightWarehouse.items[0].trackingSessionId).toBe(fx.sessionPkr);
  });
});

describe("Phase 5 live search — match fields", () => {
  it("driver-name search (partial, different case) narrows to matching movements only", async () => {
    const result = await liveOpsSvc.listLiveOperations(adminActor, {
      search: `searchalpha-${RUN}`.toLowerCase(),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].trackingSessionId).toBe(fx.sessionKtm);
    expect(result.items[0].driverName).toBe(`SearchAlpha-${RUN} Driver`);
  });

  it("trip-number search finds the line-haul movement (and transfer number matches too)", async () => {
    const byTrip = await liveOpsSvc.listLiveOperations(adminActor, {
      search: tripNumber.toLowerCase(),
    });
    expect(byTrip.items).toHaveLength(1);
    expect(byTrip.items[0].trackingSessionId).toBe(fx.sessionTrip);
    expect(byTrip.items[0].tripNumber).toBe(tripNumber);

    const byTransfer = await liveOpsSvc.listLiveOperations(adminActor, {
      search: transferNumber.toLowerCase(),
    });
    expect(byTransfer.items).toHaveLength(1);
    expect(byTransfer.items[0].trackingSessionId).toBe(fx.sessionTrip);
  });

  it("package tracking ID on a trip's transfer items is searchable", async () => {
    const result = await liveOpsSvc.listLiveOperations(adminActor, {
      search: fx.tripTrackingId.toLowerCase(),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].trackingSessionId).toBe(fx.sessionTrip);
  });

  it("delivery batch id prefix search finds the batch movement", async () => {
    const prefix = fx.batchPkr.slice(0, 8);
    const result = await liveOpsSvc.listLiveOperations(adminActor, {
      search: prefix,
    });
    expect(
      result.items.some((i) => i.trackingSessionId === fx.sessionPkr),
    ).toBe(true);
    for (const item of result.items) {
      expect(item.deliveryBatchId?.startsWith(prefix)).toBe(true);
    }
  });
});

describe("Phase 5 live search — payload additions", () => {
  it("exposes transferId, batchDate, generatedAt and latestReceivedAt", async () => {
    const batchResult = await liveOpsSvc.listLiveOperations(adminActor, {
      search: pkrTrackingId,
    });
    expect(batchResult.items).toHaveLength(1);
    const batchItem = batchResult.items[0];
    expect(batchItem.transferId).toBeNull();
    expect(batchItem.batchDate).toBe(batchDateStr);
    expect(batchItem.batchDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(typeof batchResult.generatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(batchResult.generatedAt))).toBe(false);
    expect(Math.abs(Date.now() - Date.parse(batchResult.generatedAt))).toBeLessThan(60_000);
    expect(batchResult.latestReceivedAt).toBe(pkrReceivedAt.toISOString());

    const tripResult = await liveOpsSvc.listLiveOperations(adminActor, {
      search: tripNumber,
    });
    expect(tripResult.items).toHaveLength(1);
    const tripItem = tripResult.items[0];
    expect(tripItem.transferId).toBe(fx.transferId);
    expect(tripItem.batchDate).toBeNull();
    expect(typeof tripResult.generatedAt).toBe("string");
    expect(tripResult.latestReceivedAt).toBeTruthy();

    // Detail view carries the same additive fields via the item.
    const detail = await liveOpsSvc.getLiveOperationDetail(adminActor, fx.sessionTrip);
    expect(detail.transferId).toBe(fx.transferId);
    expect(detail.batchDate).toBeNull();
  });

  it("latestReceivedAt is null and generatedAt present when a search matches nothing", async () => {
    const result = await liveOpsSvc.listLiveOperations(adminActor, {
      search: `no-such-thing-${RUN}`,
    });
    expect(result.items).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.latestReceivedAt).toBeNull();
    expect(typeof result.generatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
  });
});
