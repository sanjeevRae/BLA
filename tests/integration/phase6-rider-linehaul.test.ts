import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 6 (V2) Slice E — rider + line-haul mobile homes, service
 * reads against bla_test:
 *  - getRiderHomeToday: today's summary counts (assigned /
 *    delivered / remaining), failed attempts that still need
 *    action (today + assignment still out with the rider), the
 *    current batch's next stop, and COD expected/collected —
 *    computed from rider A's planted batch only; rider B sees
 *    only their own figures;
 *  - listMyCustody: exactly the packages in the rider's open
 *    USER custody;
 *  - getRiderCodPosition: awaiting / verified figures match the
 *    planted collections + verified remittance;
 *  - getMyActiveTrip: only the driver's own active trip; a
 *    driver with only a completed trip gets null.
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
const email = (label: string) => `p6e-${label}-${RUN}@bla.test`;
const TODAY = new Date().toISOString().slice(0, 10);

let prisma: import("@prisma/client").PrismaClient;
let deliveriesSvc: typeof import("@/server/services/deliveries");
let custodySvc: typeof import("@/server/services/custody");
let codSvc: typeof import("@/server/services/cod-remittances");
let tripsSvc: typeof import("@/server/services/trips");
let catalog: typeof import("@/lib/permissions/catalog");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let riderAActor: Actor;
let riderBActor: Actor;
let linehaulActor: Actor;
let linehaul2Actor: Actor;
let linehaulDoneActor: Actor;

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
      fullName: `P6E ${label}`,
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
      licenseNumber: `LIC-P6E-${label}-${RUN}`,
      licenseExpiry: new Date("2028-01-01"),
    },
  });
  return driver.id;
}

async function makePackage(label: string, codPaisa: bigint) {
  return prisma.package.create({
    data: {
      trackingId: `BLA-P6E-${label}-${RUN}`,
      shipmentId: fx.shipmentId,
      orderId: fx.orderId,
      recipientName: `Recipient ${label}`,
      recipientPhone: "9779812345678",
      deliveryAddress: `Address ${label}`,
      deliveryCity: "Kathmandu",
      deliveryDistrict: "Kathmandu",
      declaredWeightKg: "1.000",
      description: `Parcel ${label}`,
      codAmountPaisa: codPaisa,
    },
  });
}

async function makeAssignment(
  packageId: string,
  driverId: string,
  batchId: string,
  status: string,
  routeSequence: number,
) {
  return prisma.deliveryAssignment.create({
    data: {
      packageId,
      driverId,
      batchId,
      kind: "DELIVERY",
      status,
      assignedById: fx.adminUser,
      routeSequence,
    },
  });
}

async function makeAttempt(
  assignmentId: string,
  packageId: string,
  result: string,
  failureReason: string,
) {
  return prisma.deliveryAttempt.create({
    data: {
      assignmentId,
      packageId,
      attemptNumber: 1,
      result,
      failureReason,
      nextAction: "REDELIVER",
      recordedById: fx.riderAUser,
    },
  });
}

async function makeTrip(
  driverId: string,
  vehicleId: string,
  status: string,
  suffix: string,
) {
  const transfer = await prisma.transfer.create({
    data: {
      transferNumber: `TRF-P6E-${suffix}-${RUN}`,
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
      tripNumber: `TRP-P6E-${suffix}-${RUN}`,
      transferId: transfer.id,
      driverId,
      vehicleId,
      status,
    },
  });
  await prisma.transfer.update({ where: { id: transfer.id }, data: { tripId: trip.id } });
  return trip.id;
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
  deliveriesSvc = await import("@/server/services/deliveries");
  custodySvc = await import("@/server/services/custody");
  codSvc = await import("@/server/services/cod-remittances");
  tripsSvc = await import("@/server/services/trips");
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
    data: { code: `P6A-${RUN}`, name: `P6E Alpha ${RUN}`, district: "Kathmandu", city: "Kathmandu", province: "Bagmati" },
  });
  const w2 = await prisma.warehouse.create({
    data: { code: `P6B-${RUN}`, name: `P6E Beta ${RUN}`, district: "Lalitpur", city: "Lalitpur", province: "Bagmati" },
  });
  fx.w1 = w1.id;
  fx.w2 = w2.id;

  fx.adminUser = await makeUser("admin", "ADMIN");

  fx.riderAUser = await makeUser("ridera", "RIDER");
  fx.riderADriver = await makeDriver(fx.riderAUser, fx.w1, "RA");
  riderAActor = await actorFor(fx.riderAUser);

  const riderBUser = await makeUser("riderb", "RIDER");
  fx.riderBDriver = await makeDriver(riderBUser, fx.w2, "RB");
  riderBActor = await actorFor(riderBUser);

  const linehaulUser = await makeUser("linehaul", "LINEHAUL_DRIVER");
  fx.linehaulDriver = await makeDriver(linehaulUser, fx.w1, "LH");
  linehaulActor = await actorFor(linehaulUser);
  const linehaul2User = await makeUser("linehaul2", "LINEHAUL_DRIVER");
  fx.linehaul2Driver = await makeDriver(linehaul2User, fx.w1, "L2");
  linehaul2Actor = await actorFor(linehaul2User);
  const linehaulDoneUser = await makeUser("linehauldone", "LINEHAUL_DRIVER");
  fx.linehaulDoneDriver = await makeDriver(linehaulDoneUser, fx.w1, "LD");
  linehaulDoneActor = await actorFor(linehaulDoneUser);

  // Order / shipment shared by the planted packages.
  const service = await prisma.shippingService.create({
    data: { code: `P6ESVC-${RUN}`, name: `P6E Service ${RUN}` },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-P6E-${RUN}`,
      createdById: fx.adminUser,
      createdByRole: "ADMIN",
      senderName: "P6E Sender",
      senderPhone: "9779811111111",
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  fx.orderId = order.id;
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-P6E-${RUN}`,
      orderId: order.id,
      originWarehouseId: fx.w1,
      destinationWarehouseId: fx.w1,
      routeKind: "LAST_MILE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(0),
    },
  });
  fx.shipmentId = shipment.id;

  // --- Rider A's batch today -------------------------------------
  // A1 COMPLETED cod 100000, collected 100000 (awaiting remittance)
  // A2 IN_PROGRESS cod 50000, failed attempt today, in A's custody
  // A3 IN_PROGRESS cod 0, failed attempt today, in A's custody
  // A4 PENDING cod 20000, still warehouse-custodied
  // A5 COMPLETED cod 30000, collected 30000 on a VERIFIED remittance;
  //    a failed attempt today on this completed assignment is
  //    history, NOT an action item.
  const batchA = await prisma.deliveryBatch.create({
    data: {
      riderId: fx.riderADriver,
      warehouseId: fx.w1,
      batchDate: new Date(TODAY),
      kind: "DELIVERY",
      status: "IN_PROGRESS",
      createdById: fx.adminUser,
    },
  });
  fx.batchA = batchA.id;

  const pkgA1 = await makePackage("A1", BigInt(100000));
  const pkgA2 = await makePackage("A2", BigInt(50000));
  const pkgA3 = await makePackage("A3", BigInt(0));
  const pkgA4 = await makePackage("A4", BigInt(20000));
  const pkgA5 = await makePackage("A5", BigInt(30000));
  fx.pkgA1 = pkgA1.id;
  fx.pkgA2 = pkgA2.id;
  fx.pkgA3 = pkgA3.id;
  fx.trackingA2 = pkgA2.trackingId;
  fx.trackingA3 = pkgA3.trackingId;

  const asgA1 = await makeAssignment(pkgA1.id, fx.riderADriver, fx.batchA, "COMPLETED", 1);
  const asgA2 = await makeAssignment(pkgA2.id, fx.riderADriver, fx.batchA, "IN_PROGRESS", 2);
  const asgA3 = await makeAssignment(pkgA3.id, fx.riderADriver, fx.batchA, "IN_PROGRESS", 3);
  await makeAssignment(pkgA4.id, fx.riderADriver, fx.batchA, "PENDING", 4);
  const asgA5 = await makeAssignment(pkgA5.id, fx.riderADriver, fx.batchA, "COMPLETED", 5);

  await makeAttempt(asgA2.id, pkgA2.id, "RECIPIENT_UNAVAILABLE", "Recipient not at home");
  await makeAttempt(asgA3.id, pkgA3.id, "PHONE_UNREACHABLE", "Phone switched off");
  await makeAttempt(asgA5.id, pkgA5.id, "RECIPIENT_UNAVAILABLE", "Not at home earlier");

  // Custody: A2 + A3 open with rider A; A1's custody already ended
  // (delivered); A4 still warehouse-custodied.
  await prisma.packageCustody.create({
    data: { packageId: pkgA2.id, custodianType: "USER", custodianUserId: fx.riderAUser },
  });
  await prisma.packageCustody.create({
    data: { packageId: pkgA3.id, custodianType: "USER", custodianUserId: fx.riderAUser },
  });
  await prisma.packageCustody.create({
    data: {
      packageId: pkgA1.id,
      custodianType: "USER",
      custodianUserId: fx.riderAUser,
      endedAt: new Date(),
    },
  });
  await prisma.packageCustody.create({
    data: { packageId: pkgA4.id, custodianType: "WAREHOUSE", warehouseId: fx.w1 },
  });

  // COD: A1 collected, no remittance yet; A5 collected + verified.
  const collA1 = await prisma.deliveryCodCollection.create({
    data: {
      packageId: pkgA1.id,
      shipmentId: fx.shipmentId,
      assignmentId: asgA1.id,
      batchId: fx.batchA,
      expectedPaisa: BigInt(100000),
      collectedPaisa: BigInt(100000),
      status: "MATCHED",
      collectedById: fx.riderAUser,
    },
  });
  fx.collA1 = collA1.id;
  const collA5 = await prisma.deliveryCodCollection.create({
    data: {
      packageId: pkgA5.id,
      shipmentId: fx.shipmentId,
      assignmentId: asgA5.id,
      batchId: fx.batchA,
      expectedPaisa: BigInt(30000),
      collectedPaisa: BigInt(30000),
      status: "MATCHED",
      collectedById: fx.riderAUser,
    },
  });
  const remittance = await prisma.codRemittance.create({
    data: {
      remittanceNumber: `RMT-P6E-${RUN}`,
      driverId: fx.riderADriver,
      submittedById: fx.riderAUser,
      warehouseId: fx.w1,
      declaredAmountPaisa: BigInt(30000),
      countedAmountPaisa: BigInt(30000),
      status: "VERIFIED",
    },
  });
  await prisma.codRemittanceLine.create({
    data: {
      remittanceId: remittance.id,
      codCollectionId: collA5.id,
      expectedPaisa: BigInt(30000),
      collectedPaisa: BigInt(30000),
      verifiedPaisa: BigInt(30000),
    },
  });

  // --- Rider B: own small batch today, nothing else --------------
  const batchB = await prisma.deliveryBatch.create({
    data: {
      riderId: fx.riderBDriver,
      warehouseId: fx.w2,
      batchDate: new Date(TODAY),
      kind: "DELIVERY",
      status: "OPEN",
      createdById: fx.adminUser,
    },
  });
  const pkgB1 = await makePackage("B1", BigInt(0));
  await makeAssignment(pkgB1.id, fx.riderBDriver, batchB.id, "PENDING", 1);

  // --- Line-haul trips --------------------------------------------
  const vehicle = await prisma.vehicle.create({
    data: { registration: `VEH-P6E-${RUN}`, type: "TRUCK", homeWarehouseId: fx.w1 },
  });
  fx.tripActive = await makeTrip(fx.linehaulDriver, vehicle.id, "IN_TRANSIT", "ACT");
  fx.tripDone = await makeTrip(fx.linehaulDriver, vehicle.id, "COMPLETED", "OLD");
  fx.tripOther = await makeTrip(fx.linehaul2Driver, vehicle.id, "DISPATCHED", "OTH");
  fx.tripOnlyDone = await makeTrip(fx.linehaulDoneDriver, vehicle.id, "COMPLETED", "DON");
}, 60_000);

describe("Phase 6E — rider home today read", () => {
  it("reports rider A's planted counts exactly", async () => {
    const home = await deliveriesSvc.getRiderHomeToday(riderAActor, TODAY);
    expect(home.assigned).toBe(5);
    expect(home.delivered).toBe(2);
    expect(home.remaining).toBe(3);
    expect(home.codExpectedPaisa).toBe("180000");
    expect(home.codCollectedPaisa).toBe("130000");

    // Cross-check against the pre-existing day summary.
    const summary = await deliveriesSvc.getRiderDaySummary(riderAActor, TODAY);
    expect(summary.assigned).toBe(5);
    expect(summary.delivered).toBe(2);
    expect(summary.outForDelivery).toBe(2);
  });

  it("lists only today's failed attempts that still need action, with reasons", async () => {
    const home = await deliveriesSvc.getRiderHomeToday(riderAActor, TODAY);
    expect(home.failedAttemptsNeedingAction).toBe(2);
    const trackingIds = home.failedAttempts.map((a) => a.trackingId).sort();
    expect(trackingIds).toEqual([fx.trackingA2, fx.trackingA3].sort());
    const a2 = home.failedAttempts.find((a) => a.trackingId === fx.trackingA2);
    expect(a2?.result).toBe("RECIPIENT_UNAVAILABLE");
    expect(a2?.failureReason).toBe("Recipient not at home");
    expect(a2?.batchId).toBe(fx.batchA);
    expect(a2?.codExpectedPaisa).toBe("50000");
  });

  it("surfaces the current batch with its next stop", async () => {
    const home = await deliveriesSvc.getRiderHomeToday(riderAActor, TODAY);
    expect(home.currentBatch?.batch.id).toBe(fx.batchA);
    // Route sequence 2 is the first non-terminal assignment (seq 1
    // is COMPLETED).
    expect(home.currentBatch?.nextStop?.trackingId).toBe(fx.trackingA2);
    expect(home.currentBatch?.nextStop?.codExpectedPaisa).toBe("50000");
  });

  it("rider B sees only their own figures (zero where they have none)", async () => {
    const home = await deliveriesSvc.getRiderHomeToday(riderBActor, TODAY);
    expect(home.assigned).toBe(1);
    expect(home.delivered).toBe(0);
    expect(home.remaining).toBe(1);
    expect(home.failedAttemptsNeedingAction).toBe(0);
    expect(home.failedAttempts).toEqual([]);
    expect(home.codCollectedPaisa).toBe("0");
  });
});

describe("Phase 6E — rider custody read", () => {
  it("contains exactly the packages in rider A's open custody", async () => {
    const custody = await custodySvc.listMyCustody(riderAActor);
    expect(custody.map((c) => c.trackingId).sort()).toEqual(
      [fx.trackingA2, fx.trackingA3].sort(),
    );
    expect(custody.every((c) => c.custodianUserId === fx.riderAUser)).toBe(true);
  });

  it("rider B's custody is empty — none of rider A's packages leak", async () => {
    const custody = await custodySvc.listMyCustody(riderBActor);
    expect(custody).toEqual([]);
  });
});

describe("Phase 6E — rider COD position", () => {
  it("matches the planted collections and the verified remittance", async () => {
    const position = await codSvc.getRiderCodPosition(riderAActor);
    expect(position.awaitingRemittanceTotalPaisa).toBe("100000");
    expect(position.awaitingRemittance.map((a) => a.packageId)).toEqual([fx.pkgA1]);
    expect(position.verifiedRemittedPaisa).toBe("30000");
    expect(position.inOpenRemittancePaisa).toBe("0");
  });

  it("rider B has a zero COD position", async () => {
    const position = await codSvc.getRiderCodPosition(riderBActor);
    expect(position.awaitingRemittanceTotalPaisa).toBe("0");
    expect(position.verifiedRemittedPaisa).toBe("0");
    expect(position.awaitingRemittance).toEqual([]);
  });
});

describe("Phase 6E — line-haul current trip read", () => {
  it("returns only the driver's own active trip", async () => {
    const active = await tripsSvc.getMyActiveTrip(linehaulActor);
    expect(active?.id).toBe(fx.tripActive);
    expect(active?.status).toBe("IN_TRANSIT");

    const other = await tripsSvc.getMyActiveTrip(linehaul2Actor);
    expect(other?.id).toBe(fx.tripOther);
  });

  it("a driver whose only trip is completed has no active trip", async () => {
    const active = await tripsSvc.getMyActiveTrip(linehaulDoneActor);
    expect(active).toBeNull();
  });
});
