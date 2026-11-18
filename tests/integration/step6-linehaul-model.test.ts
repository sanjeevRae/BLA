import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Step 6 (V3) — Line-haul field home read model against bla_test:
 *  - driver A's model carries A's active trip only, A's recent
 *    trips only, and the destination of A's OWN trip (name/code +
 *    PRIMARY address);
 *  - ETA rule (revised 2026-11-18, Meena's decision): the planted
 *    trip HAS plannedDepartureAt / expectedArrivalAt values in the
 *    database; the model must carry the CURRENT trip's stored
 *    expectedArrivalAt verbatim, must never contain
 *    plannedDepartureAt anywhere, and a trip with no stored value
 *    (driver B) must surface expectedArrivalAt null;
 *  - driver B's model contains none of A's trip numbers;
 *  - a driver with no active trip gets activeTrip null AND
 *    destination null.
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
const email = (label: string) => `s6l-${label}-${RUN}@bla.test`;

let prisma: import("@prisma/client").PrismaClient;
let homeSvc: typeof import("@/server/services/home-dashboards");
let catalog: typeof import("@/lib/permissions/catalog");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let driverAActor: Actor;
let driverBActor: Actor;
let driverDoneActor: Actor;

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
      fullName: `S6L ${label}`,
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

async function makeDriver(userId: string, homeWarehouseId: string, label: string) {
  const driver = await prisma.driver.create({
    data: {
      userId,
      homeWarehouseId,
      licenseNumber: `LIC-S6L-${label}-${RUN}`,
      licenseExpiry: new Date("2028-01-01"),
    },
  });
  return driver.id;
}

async function makeTrip(
  driverId: string,
  vehicleId: string,
  status: string,
  suffix: string,
  extra: {
    actualDepartureAt?: Date;
    actualArrivalAt?: Date;
    plannedDepartureAt?: Date;
    expectedArrivalAt?: Date;
  } = {},
) {
  const transfer = await prisma.transfer.create({
    data: {
      transferNumber: `TRF-S6L-${suffix}-${RUN}`,
      originWarehouseId: fx.w1,
      destinationWarehouseId: fx.w2,
      status: "IN_TRANSIT",
      driverId,
      vehicleId,
      createdById: fx.adminUser,
    },
  });
  const trip = await prisma.trip.create({
    data: {
      tripNumber: `TRP-S6L-${suffix}-${RUN}`,
      transferId: transfer.id,
      driverId,
      vehicleId,
      status,
      ...extra,
    },
  });
  await prisma.transfer.update({ where: { id: transfer.id }, data: { tripId: trip.id } });
  return { tripId: trip.id, transferId: transfer.id, tripNumber: trip.tripNumber };
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
  homeSvc = await import("@/server/services/home-dashboards");
  catalog = await import("@/lib/permissions/catalog");

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
    data: { code: `S6LA-${RUN}`, name: `S6L Origin ${RUN}`, district: "Kathmandu", city: "Kathmandu", province: "Bagmati" },
  });
  const w2 = await prisma.warehouse.create({
    data: {
      code: `S6LB-${RUN}`,
      name: `S6L Destination ${RUN}`,
      district: "Lalitpur",
      city: "Lalitpur",
      province: "Bagmati",
      contactPhone: "977015550000",
    },
  });
  fx.w1 = w1.id;
  fx.w2 = w2.id;
  fx.w2Code = w2.code;
  fx.w2Name = w2.name;
  // BILLING planted first: the model must still pick the PRIMARY
  // address (warehouses.ts toView rule).
  await prisma.warehouseAddress.create({
    data: {
      warehouseId: w2.id,
      kind: "BILLING",
      addressLine1: `Billing annex ${RUN}`,
      city: "Lalitpur",
      district: "Lalitpur",
      province: "Bagmati",
    },
  });
  await prisma.warehouseAddress.create({
    data: {
      warehouseId: w2.id,
      kind: "PRIMARY",
      addressLine1: `Destination Road ${RUN}`,
      addressLine2: "Gate B",
      city: "Lalitpur",
      district: "Lalitpur",
      province: "Bagmati",
    },
  });

  fx.adminUser = await makeUser("admin", "ADMIN");
  const userA = await makeUser("drivera", "LINEHAUL_DRIVER");
  fx.driverA = await makeDriver(userA, fx.w1, "DA");
  driverAActor = await actorFor(userA);
  const userB = await makeUser("driverb", "LINEHAUL_DRIVER");
  fx.driverB = await makeDriver(userB, fx.w1, "DB");
  driverBActor = await actorFor(userB);
  const userDone = await makeUser("driverdone", "LINEHAUL_DRIVER");
  fx.driverDone = await makeDriver(userDone, fx.w1, "DD");
  driverDoneActor = await actorFor(userDone);

  const vehicle = await prisma.vehicle.create({
    data: { registration: `VEH-S6L-${RUN}`, type: "TRUCK", homeWarehouseId: fx.w1 },
  });

  // Order / shipment / packages for A's active transfer load.
  const service = await prisma.shippingService.create({
    data: { code: `S6LSVC-${RUN}`, name: `S6L Service ${RUN}` },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-S6L-${RUN}`,
      createdById: fx.adminUser,
      createdByRole: "ADMIN",
      senderName: "S6L Sender",
      senderPhone: "9779811111111",
      destinationDistrict: "Lalitpur",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-S6L-${RUN}`,
      orderId: order.id,
      originWarehouseId: fx.w1,
      destinationWarehouseId: fx.w2,
      routeKind: "LAST_MILE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(0),
    },
  });
  async function makePackage(label: string) {
    return prisma.package.create({
      data: {
        trackingId: `BLA-S6L-${label}-${RUN}`,
        shipmentId: shipment.id,
        orderId: order.id,
        recipientName: `Recipient ${label}`,
        recipientPhone: "9779800000200",
        deliveryAddress: `Address ${label}`,
        deliveryCity: "Lalitpur",
        deliveryDistrict: "Lalitpur",
        declaredWeightKg: "2.000",
        description: `Parcel ${label}`,
        codAmountPaisa: BigInt(0),
        operationalStatus: "IN_TRANSIT",
      },
    });
  }

  // --- Driver A: active IN_TRANSIT trip (with ETA values planted
  //     in the DB — the model must carry expectedArrivalAt for the
  //     current trip and drop plannedDepartureAt), plus a completed
  //     one.
  const active = await makeTrip(fx.driverA, vehicle.id, "IN_TRANSIT", "ACT", {
    actualDepartureAt: new Date("2026-11-17T02:00:00.000Z"),
    plannedDepartureAt: new Date("2026-11-17T01:30:00.000Z"),
    expectedArrivalAt: new Date("2026-11-17T09:45:00.000Z"),
  });
  fx.tripA = active.tripId;
  fx.tripANumber = active.tripNumber;

  const pkg1 = await makePackage("P1");
  const pkg2 = await makePackage("P2");
  await prisma.transferItem.create({
    data: { transferId: active.transferId, packageId: pkg1.id, itemStatus: "LOADED" },
  });
  await prisma.transferItem.create({
    data: { transferId: active.transferId, packageId: pkg2.id, itemStatus: "IN_TRANSIT" },
  });
  fx.trackingP1 = pkg1.trackingId;
  fx.trackingP2 = pkg2.trackingId;

  await prisma.tripStop.create({
    data: {
      tripId: active.tripId,
      sequence: 1,
      label: `Checkpoint Alpha ${RUN}`,
      passedAt: new Date("2026-11-17T03:00:00.000Z"),
      recordedById: userA,
    },
  });
  await prisma.tripStop.create({
    data: {
      tripId: active.tripId,
      sequence: 2,
      label: `Checkpoint Beta ${RUN}`,
      recordedById: userA,
    },
  });

  const doneA = await makeTrip(fx.driverA, vehicle.id, "COMPLETED", "OLD", {
    actualDepartureAt: new Date("2026-11-15T02:00:00.000Z"),
    actualArrivalAt: new Date("2026-11-15T08:00:00.000Z"),
  });
  fx.tripAOldNumber = doneA.tripNumber;

  // --- Driver B: own active trip ----------------------------------
  const activeB = await makeTrip(fx.driverB, vehicle.id, "DISPATCHED", "OTH", {
    actualDepartureAt: new Date("2026-11-17T04:00:00.000Z"),
  });
  fx.tripBNumber = activeB.tripNumber;

  // --- Driver Done: only a completed trip --------------------------
  await makeTrip(fx.driverDone, vehicle.id, "COMPLETED", "DON", {
    actualDepartureAt: new Date("2026-11-14T02:00:00.000Z"),
    actualArrivalAt: new Date("2026-11-14T07:00:00.000Z"),
  });
}, 60_000);

describe("Step 6 — line-haul field home model", () => {
  it("carries driver A's own active trip with its load, stops and packages", async () => {
    const model = await homeSvc.getLinehaulFieldHome(driverAActor);
    expect(model.driverName).toBe(driverAActor.fullName);
    expect(model.profile?.homeWarehouseCode).toBe(`S6LA-${RUN}`);
    expect(model.activeTrip?.id).toBe(fx.tripA);
    expect(model.activeTrip?.tripNumber).toBe(fx.tripANumber);
    expect(model.activeTrip?.status).toBe("IN_TRANSIT");
    expect(model.activeTrip?.departedAt).toBe("2026-11-17T02:00:00.000Z");
    expect(model.activeTrip?.arrivedAt).toBeNull();
    expect(model.activeTrip?.loadedCount).toBe(2);
    expect(model.activeTrip?.expectedCount).toBe(2);
    expect(model.activeTrip?.loadByStatus).toEqual([
      { status: "LOADED", count: 1 },
      { status: "IN_TRANSIT", count: 1 },
    ]);
    expect(model.activeTrip?.packages.map((p) => p.trackingId).sort()).toEqual(
      [fx.trackingP1, fx.trackingP2].sort(),
    );
    expect(model.activeTrip?.stops).toHaveLength(2);
    expect(model.activeTrip?.stops[0].label).toContain("Checkpoint Alpha");
    expect(model.activeTrip?.stops[0].passedAt).toBe("2026-11-17T03:00:00.000Z");
    expect(model.activeTrip?.stops[1].passedAt).toBeNull();
  });

  it("destination is A's trip destination warehouse with its PRIMARY address", async () => {
    const model = await homeSvc.getLinehaulFieldHome(driverAActor);
    expect(model.destination?.name).toBe(fx.w2Name);
    expect(model.destination?.code).toBe(fx.w2Code);
    expect(model.destination?.addressLine1).toBe(`Destination Road ${RUN}`);
    expect(model.destination?.addressLine2).toBe("Gate B");
    expect(model.destination?.contactPhone).toBe("977015550000");
  });

  it("recent trips and activity are A's only, newest activity first", async () => {
    const model = await homeSvc.getLinehaulFieldHome(driverAActor);
    expect(model.recentTrips.map((t) => t.tripNumber)).toEqual([fx.tripAOldNumber]);
    expect(model.recentActivity.length).toBeGreaterThan(0);
    expect(model.recentActivity[0].label).toContain("Checkpoint Alpha");
    expect(model.recentActivity[0].label).toContain(fx.tripANumber);
    const labels = model.recentActivity.map((a) => a.label).join("\n");
    expect(labels).toContain(`Departed S6LA-${RUN} → S6LB-${RUN}`);
    expect(labels).toContain(`Arrived S6LB-${RUN}`);
    expect(labels).not.toContain(fx.tripBNumber);
  });

  it("carries the current trip's stored expectedArrivalAt; plannedDepartureAt stays out", async () => {
    const model = await homeSvc.getLinehaulFieldHome(driverAActor);
    // The stored value passes through verbatim — not computed,
    // not shifted, not dropped (2026-11-18 spec change).
    expect(model.activeTrip?.expectedArrivalAt).toBe("2026-11-17T09:45:00.000Z");
    const serialised = JSON.stringify(model);
    expect(serialised).not.toContain("plannedDeparture");
    expect(serialised).not.toContain("2026-11-17T01:30:00.000Z");
  });

  it("driver B's model is B's own — none of A's trip numbers", async () => {
    const model = await homeSvc.getLinehaulFieldHome(driverBActor);
    expect(model.activeTrip?.tripNumber).toBe(fx.tripBNumber);
    // B's trip has no stored expected arrival: null stays null.
    expect(model.activeTrip?.expectedArrivalAt).toBeNull();
    const serialised = JSON.stringify(model);
    expect(serialised).not.toContain(fx.tripANumber);
    expect(serialised).not.toContain(fx.tripAOldNumber);
  });

  it("a driver with no active trip gets activeTrip null and destination null", async () => {
    const model = await homeSvc.getLinehaulFieldHome(driverDoneActor);
    expect(model.activeTrip).toBeNull();
    expect(model.destination).toBeNull();
    expect(model.recentTrips).toHaveLength(1);
  });
});
