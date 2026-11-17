import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

// `server-only` throws outside a React Server Component environment; the
// services under test are server-only code, so stub the marker module.
vi.mock("server-only", () => ({}));

// Point the app at bla_test BEFORE the service layer is imported (same
// pattern as warehouses.test.ts). Refuse to run anywhere else.
function readDevDatabaseUrl(): string {
  for (const file of [".env.local", "prisma/.env"]) {
    try {
      const text = readFileSync(path.resolve(process.cwd(), file), "utf8");
      const match = text.match(/^DATABASE_URL=(.+)$/m);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    } catch {
      // try the next file
    }
  }
  throw new Error("DATABASE_URL not found in .env.local or prisma/.env");
}

const devUrl = readDevDatabaseUrl();
if (new URL(devUrl).pathname !== "/bla_dev") {
  throw new Error(
    "Integration tests require DATABASE_URL to target bla_dev (it is rewritten to bla_test).",
  );
}
const marker = "/bla_dev";
const idx = devUrl.lastIndexOf(marker);
process.env.DATABASE_URL =
  devUrl.slice(0, idx) + "/bla_test" + devUrl.slice(idx + marker.length);

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const email = (label: string) => `s5-${label}-${RUN}@test.local`;
const phone = (n: number) => `9779800${String(200000 + n).slice(0, 6)}`;

let prisma: PrismaClient;
let homeSvc: typeof import("@/server/services/warehouse-home");
let inventorySvc: typeof import("@/server/services/inventory");
let bookingsSvc: typeof import("@/server/services/bookings");
let actorLib: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let reportsDomain: typeof import("@/lib/reports/domain");

let adminId: string;
let waAId: string;
let waBId: string;
let waBothId: string;
let whA: string;
let whB: string;
let whC: string;
let codeA: string;
let codeB: string;
let districtA: string;
let districtB: string;
let serviceCode: string;
let driverAName: string;

let trackingA: string[] = [];
let trackingB1: string;
let outABId: string;
let inBAId: string;
let closedABId: string;
let pkrOutId: string;
let pkrInId: string;

/** Build an ActorContext exactly the way getActorContext does. */
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
    vendorId: null,
    vendorRole: null,
    driverId: null,
    customerId: null,
    landingPath: catalog.landingPathForRoles(roles as never[]),
  };
}

async function makeUser(label: string, roleCode: string, fullName?: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: fullName ?? `S5 ${label}`,
      passwordHash: await hash("fixture-password", 10),
      status: "ACTIVE",
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role ${roleCode} not seeded in bla_test`);
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user.id;
}

async function addMembership(userId: string, warehouseId: string): Promise<void> {
  const role = await prisma.role.findUnique({ where: { code: "WAREHOUSE_ADMIN" } });
  await prisma.warehouseMembership.create({
    data: { userId, warehouseId, roleId: role!.id, isPrimary: true },
  });
}

async function bookOne(
  admin: Awaited<ReturnType<typeof actorFor>>,
  originWarehouseId: string,
  destDistrict: string,
): Promise<{ packageId: string; trackingId: string }> {
  const booking = await bookingsSvc.createBooking(admin, {
    sender: { name: "S5 Sender", phone: phone(42), email: null },
    recipient: {
      name: "S5 Recipient",
      phone: phone(101),
      addressLine: "Some Street 1",
      city: "Kathmandu",
      district: destDistrict,
      province: "Bagmati",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
  });
  const pkg = booking.shipments[0].packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId };
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  homeSvc = await import("@/server/services/warehouse-home");
  inventorySvc = await import("@/server/services/inventory");
  bookingsSvc = await import("@/server/services/bookings");
  actorLib = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");
  reportsDomain = await import("@/lib/reports/domain");

  // Role/permission catalog must exist in bla_test (idempotent upserts).
  const permissionIdByCode = new Map<string, string>();
  for (const permission of catalog.PERMISSIONS) {
    const row = await prisma.permission.upsert({
      where: { code: permission.code },
      update: { name: permission.name, module: permission.module },
      create: { code: permission.code, name: permission.name, module: permission.module },
    });
    permissionIdByCode.set(permission.code, row.id);
  }
  for (const roleDef of catalog.ROLES) {
    const role = await prisma.role.upsert({
      where: { code: roleDef.code },
      update: { name: roleDef.name },
      create: { code: roleDef.code, name: roleDef.name },
    });
    for (const code of catalog.ROLE_PERMISSIONS[roleDef.code]) {
      const permissionId = permissionIdByCode.get(code);
      if (!permissionId) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
  }

  codeA = `S5A-${RUN}`;
  codeB = `S5B-${RUN}`;
  const codeC = `S5C-${RUN}`;
  districtA = `S5 District A ${RUN}`;
  districtB = `S5 District B ${RUN}`;
  const mkWarehouse = (code: string, name: string, district: string, city: string) =>
    prisma.warehouse.create({
      data: {
        code,
        name,
        type: "REGIONAL",
        district,
        city,
        province: "Bagmati",
        status: "ACTIVE",
      },
    });
  whA = (await mkWarehouse(codeA, `S5 KTM ${RUN}`, districtA, "Kathmandu")).id;
  whB = (await mkWarehouse(codeB, `S5 PKR ${RUN}`, districtB, "Pokhara")).id;
  whC = (await mkWarehouse(codeC, `S5 Other ${RUN}`, `S5 District C ${RUN}`, "Butwal")).id;
  for (const [district, warehouseId, name] of [
    [districtA, whA, "S5 Area A"],
    [districtB, whB, "S5 Area B"],
  ] as const) {
    await prisma.serviceArea.create({
      data: { name, district, city: "Kathmandu", province: "Bagmati", servingWarehouseId: warehouseId },
    });
  }

  adminId = await makeUser("admin", "ADMIN");
  waAId = await makeUser("wa-a", "WAREHOUSE_ADMIN");
  waBId = await makeUser("wa-b", "WAREHOUSE_ADMIN");
  waBothId = await makeUser("wa-both", "WAREHOUSE_ADMIN");
  await addMembership(waAId, whA);
  await addMembership(waBId, whB);
  await addMembership(waBothId, whA);
  await addMembership(waBothId, whB);
  const admin = await actorFor(adminId);
  const waA = await actorFor(waAId);
  const waB = await actorFor(waBId);

  serviceCode = `S5STD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "S5 Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
  });
  await prisma.pricingRule.create({
    data: {
      shippingServiceId: service.id,
      baseRatePaisa: BigInt(15000),
      perKgRatePaisa: BigInt(5000),
      volumetricDivisor: 5000,
      createdById: adminId,
    },
  });

  // --- Inventory at A: 4 received today — RECEIVED_AT_ORIGIN,
  // INSPECTION_PENDING, READY_FOR_DISPATCH, READY_FOR_DELIVERY. ---
  const zoneA = await prisma.warehouseZone.create({
    data: { warehouseId: whA, code: "ZONE-STO", name: "Storage", kind: "STORAGE" },
  });
  const locA = await prisma.storageLocation.create({
    data: { zoneId: zoneA.id, rack: "R1", fullCode: `${codeA}/ZONE-STO/RACK-01` },
  });
  const a1 = await bookOne(admin, whA, districtB);
  const a2 = await bookOne(admin, whA, districtB);
  const a3 = await bookOne(admin, whA, districtB);
  const a4 = await bookOne(admin, whA, districtB);
  trackingA = [a1.trackingId, a2.trackingId, a3.trackingId, a4.trackingId];
  for (const p of [a1, a2, a3, a4]) {
    await inventorySvc.receivePackage(waA, {
      warehouseId: whA,
      trackingId: p.trackingId,
      source: "WEB",
    });
  }
  await inventorySvc.moveToInspection(waA, a2.packageId);
  for (const p of [a3, a4]) {
    await inventorySvc.moveToInspection(waA, p.packageId);
    await inventorySvc.startInspection(waA, p.packageId);
    await inventorySvc.recordInspection(waA, {
      packageId: p.packageId,
      condition: "GOOD",
      actualWeightKg: 1,
    });
    await inventorySvc.putAwayPackage(waA, p.packageId, locA.id);
  }
  await inventorySvc.markReadyForDispatch(waA, a3.packageId);
  // No service transition stocks a package as READY_FOR_DELIVERY
  // without a rider batch; plant the status directly (fixture state,
  // the same way Step 4 planted package statuses).
  await prisma.package.update({
    where: { id: a4.packageId },
    data: { operationalStatus: "READY_FOR_DELIVERY" },
  });

  // --- Inventory at B: 1 received, stays RECEIVED_AT_ORIGIN. ---
  const b1 = await bookOne(admin, whB, districtA);
  trackingB1 = b1.trackingId;
  await inventorySvc.receivePackage(waB, {
    warehouseId: whB,
    trackingId: b1.trackingId,
    source: "WEB",
  });

  // --- Driver homed at A (available rider + batch rider). ---
  driverAName = `S5 Rider A ${RUN}`;
  const riderUserId = await makeUser("rider-a", "RIDER", driverAName);
  const driverA = await prisma.driver.create({
    data: {
      userId: riderUserId,
      homeWarehouseId: whA,
      licenseNumber: `LIC-S5-${RUN}`,
      licenseExpiry: new Date("2030-01-01T00:00:00.000Z"),
      employmentStatus: "ACTIVE",
      availabilityStatus: "AVAILABLE",
      capabilities: { create: [{ capability: "DELIVERY" }] },
    },
  });

  // --- Transfers (planted rows; items reference real packages). ---
  const now = new Date();
  const mkTransfer = (
    suffix: string,
    originWarehouseId: string,
    destinationWarehouseId: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) =>
    prisma.transfer.create({
      data: {
        transferNumber: `TRF-S5-${RUN}-${suffix}`,
        originWarehouseId,
        destinationWarehouseId,
        status,
        createdById: adminId,
        ...extra,
      },
    });
  const outAB = await mkTransfer("OUT", whA, whB, "IN_TRANSIT", {
    driverId: driverA.id,
    dispatchedAt: now,
  });
  outABId = outAB.id;
  await prisma.transferItem.createMany({
    data: [
      { transferId: outAB.id, packageId: a1.packageId, itemStatus: "EXPECTED" },
      { transferId: outAB.id, packageId: a2.packageId, itemStatus: "EXPECTED" },
    ],
  });
  const inBA = await mkTransfer("IN", whB, whA, "DISPATCHED", { dispatchedAt: now });
  inBAId = inBA.id;
  await prisma.transferItem.create({
    data: {
      transferId: inBA.id,
      packageId: b1.packageId,
      itemStatus: "RECEIVED",
      receivedAt: now,
      receivedById: waAId,
    },
  });
  const closedAB = await mkTransfer("CLS", whA, whB, "CLOSED");
  closedABId = closedAB.id;
  await prisma.transferItem.create({
    data: { transferId: closedAB.id, packageId: a3.packageId, itemStatus: "RECEIVED" },
  });
  const pkrOut = await mkTransfer("PKO", whB, whC, "IN_TRANSIT", { dispatchedAt: now });
  pkrOutId = pkrOut.id;
  const pkrIn = await mkTransfer("PKI", whC, whB, "ARRIVED", { dispatchedAt: now });
  pkrInId = pkrIn.id;
  // A package may sit on only one open transfer (DB trigger), so the
  // PKR-incoming item is its own planted package, homed at C.
  const orderC = await prisma.order.create({
    data: {
      orderNumber: `ORD-S5C-${RUN}`,
      createdById: adminId,
      createdByRole: "ADMIN",
      senderName: "S5 Sender",
      senderPhone: phone(43),
      originWarehouseId: whC,
      destinationDistrict: districtB,
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  const shipmentC = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-S5C-${RUN}`,
      orderId: orderC.id,
      originWarehouseId: whC,
      destinationWarehouseId: whB,
      routeKind: "INTER_WAREHOUSE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(0),
    },
  });
  const pkgC = await prisma.package.create({
    data: {
      trackingId: `BLA-S5-C1-${RUN}`,
      shipmentId: shipmentC.id,
      orderId: orderC.id,
      recipientName: "S5 Recipient C1",
      recipientPhone: phone(102),
      deliveryAddress: "S5 Address C1",
      deliveryCity: "Pokhara",
      deliveryDistrict: districtB,
      declaredWeightKg: "1.000",
      description: "S5 parcel C1",
      operationalStatus: "IN_TRANSIT",
      currentWarehouseId: whC,
    },
  });
  await prisma.transferItem.create({
    data: { transferId: pkrIn.id, packageId: pkgC.id, itemStatus: "RECEIVED" },
  });

  // --- Incidents: one open at each of A and B. ---
  const mkIncident = (suffix: string, warehouseId: string) =>
    prisma.incident.create({
      data: {
        incidentNumber: `INC-S5-${RUN}-${suffix}`,
        category: "DAMAGED_PACKAGE",
        severity: "HIGH",
        status: "REPORTED",
        reporterId: adminId,
        warehouseId,
        description: `S5 fixture ${suffix}`,
      },
    });
  await mkIncident("A", whA);
  await mkIncident("B", whB);

  // --- Tasks: A gets due-today (midday Kathmandu, so the span
  // membership is run-time independent), overdue (yesterday), future
  // and closed fixtures; B gets one due-today. ---
  const today = reportsDomain.kathmanduToday();
  const span = reportsDomain.resolveReportRange(today, today);
  const midday = new Date(span.fromUtc.getTime() + 12 * 60 * 60 * 1000);
  const yesterday = new Date(span.fromUtc.getTime() - 60 * 60 * 1000);
  const mkTask = (
    title: string,
    warehouseId: string,
    assigneeId: string,
    dueAt: Date,
    status = "ASSIGNED",
    priority = "HIGH",
  ) =>
    prisma.task.create({
      data: { title, createdById: adminId, assigneeId, warehouseId, status, priority, dueAt },
    });
  await mkTask(`S5 A due today ${RUN}`, whA, waAId, midday);
  await mkTask(`S5 A overdue ${RUN}`, whA, waAId, yesterday, "ASSIGNED", "URGENT");
  await mkTask(`S5 A future ${RUN}`, whA, waAId, new Date(span.toUtc.getTime() + 24 * 60 * 60 * 1000));
  await mkTask(`S5 A closed ${RUN}`, whA, waAId, midday, "CLOSED");
  await mkTask(`S5 B due today ${RUN}`, whB, waBId, midday);

  // --- Deliveries at A: today's batch, 3 assignments (1 completed
  // with a POD, 1 pending, 1 in progress with a failed attempt). ---
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-S5-${RUN}`,
      createdById: adminId,
      createdByRole: "ADMIN",
      senderName: "S5 Sender",
      senderPhone: phone(42),
      originWarehouseId: whA,
      destinationDistrict: districtA,
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-S5-${RUN}`,
      orderId: order.id,
      originWarehouseId: whA,
      destinationWarehouseId: whA,
      routeKind: "LAST_MILE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(0),
    },
  });
  const mkDeliveryPackage = (label: string) =>
    prisma.package.create({
      data: {
        trackingId: `BLA-S5-${label}-${RUN}`,
        shipmentId: shipment.id,
        orderId: order.id,
        recipientName: `S5 Recipient ${label}`,
        recipientPhone: phone(101),
        deliveryAddress: `S5 Address ${label}`,
        deliveryCity: "Kathmandu",
        deliveryDistrict: districtA,
        declaredWeightKg: "1.000",
        description: `S5 parcel ${label}`,
        operationalStatus: "OUT_FOR_DELIVERY",
        currentWarehouseId: whA,
      },
    });
  const d1 = await mkDeliveryPackage("D1");
  const d2 = await mkDeliveryPackage("D2");
  const d3 = await mkDeliveryPackage("D3");
  const batch = await prisma.deliveryBatch.create({
    data: {
      riderId: driverA.id,
      warehouseId: whA,
      batchDate: new Date(`${today}T00:00:00.000Z`),
      status: "OPEN",
      createdById: adminId,
    },
  });
  const mkAssignment = (packageId: string, status: string, extra: Record<string, unknown> = {}) =>
    prisma.deliveryAssignment.create({
      data: {
        packageId,
        driverId: driverA.id,
        batchId: batch.id,
        status,
        assignedById: adminId,
        ...extra,
      },
    });
  const asg1 = await mkAssignment(d1.id, "COMPLETED", { completedAt: now });
  await mkAssignment(d2.id, "PENDING");
  const asg3 = await mkAssignment(d3.id, "IN_PROGRESS");
  await prisma.proofOfDelivery.create({
    data: { packageId: d1.id, assignmentId: asg1.id, deliveredAt: now, recordedById: adminId },
  });
  await prisma.deliveryAttempt.create({
    data: {
      assignmentId: asg3.id,
      packageId: d3.id,
      attemptNumber: 1,
      attemptedAt: now,
      result: "RECIPIENT_UNAVAILABLE",
      recordedById: waAId,
    },
  });
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Step 5 warehouse console — KTM scope (WA of warehouse A only)", () => {
  it("KPIs match the planted fixtures exactly", async () => {
    const waA = await actorFor(waAId);
    const data = await homeSvc.getWarehouseConsole(waA, [whA]);
    expect(data.warehouseIds).toEqual([whA]);
    expect(data.kpis.receivedToday).toBe(4);
    expect(data.kpis.awaitingInspection).toBe(2);
    expect(data.kpis.readyForDispatch).toBe(1);
    expect(data.kpis.inventoryItems).toBe(4);
    expect(data.kpis.incomingTransfers).toBe(1);
    expect(data.kpis.outgoingTransfers).toBe(1);
    expect(data.kpis.pendingDeliveries).toBe(2);
    expect(data.kpis.deliveriesAssignedToday).toBe(3);
    expect(data.kpis.deliveriesDeliveredToday).toBe(1);
    expect(data.kpis.failedDeliveriesToday).toBe(1);
    expect(data.kpis.openIncidents).toBe(1);
    expect(data.kpis.tasksDueToday).toBe(1);
    expect(data.kpis.overdueTasks).toBeGreaterThanOrEqual(1);
    expect(data.kpis.availableRiders).toBe(1);
  });

  it("today's operations come from the daily report, scoped to A", async () => {
    const waA = await actorFor(waAId);
    const data = await homeSvc.getWarehouseConsole(waA, [whA]);
    expect(data.todaysOps).not.toBeNull();
    expect(data.todaysOps!.received).toBe(4);
    expect(data.todaysOps!.dispatchedPackages).toBe(2);
    expect(data.todaysOps!.transfersDispatched).toBe(1);
    expect(data.todaysOps!.delivered).toBe(1);
    expect(data.todaysOps!.failedAttempts).toBe(1);
  });

  it("awaiting-action groups match the queues", async () => {
    const waA = await actorFor(waAId);
    const data = await homeSvc.getWarehouseConsole(waA, [whA]);
    expect(data.awaitingAction.inspection).toBe(2);
    expect(data.awaitingAction.dispatch).toBe(1);
    expect(data.awaitingAction.deliveryAssignment).toBe(1);
    expect(data.awaitingAction.failedToday).toBe(1);
  });

  it("transfer tables split by direction and exclude closed + PKR-only rows", async () => {
    const waA = await actorFor(waAId);
    const data = await homeSvc.getWarehouseConsole(waA, [whA]);
    expect(data.transfers.incoming.map((t) => t.id)).toEqual([inBAId]);
    expect(data.transfers.outgoing.map((t) => t.id)).toEqual([outABId]);
    const incoming = data.transfers.incoming[0];
    expect(incoming.otherWarehouseCode).toBe(codeB);
    expect(incoming.expectedPackages).toBe(1);
    expect(incoming.receivedPackages).toBe(1);
    const outgoing = data.transfers.outgoing[0];
    expect(outgoing.otherWarehouseCode).toBe(codeB);
    expect(outgoing.expectedPackages).toBe(2);
    expect(outgoing.receivedPackages).toBe(0);
    expect(outgoing.driverName).toBe(driverAName);
    const allIds = [...data.transfers.incoming, ...data.transfers.outgoing].map((t) => t.id);
    expect(allIds).not.toContain(closedABId);
    expect(allIds).not.toContain(pkrOutId);
    expect(allIds).not.toContain(pkrInId);
  });

  it("task list holds only A's overdue + due-today open tasks", async () => {
    const waA = await actorFor(waAId);
    const data = await homeSvc.getWarehouseConsole(waA, [whA]);
    const titles = data.tasks.map((t) => t.title);
    expect(titles).toEqual([`S5 A overdue ${RUN}`, `S5 A due today ${RUN}`]);
    expect(data.tasks[0].overdue).toBe(true);
    expect(data.tasks[1].dueToday).toBe(true);
    expect(data.tasks.every((t) => t.warehouseCode === codeA)).toBe(true);
  });

  it("recent movements are all A packages — zero PKR records leak in", async () => {
    const waA = await actorFor(waAId);
    const data = await homeSvc.getWarehouseConsole(waA, [whA]);
    expect(data.recentMovements.length).toBeGreaterThan(0);
    for (const m of data.recentMovements) {
      expect(trackingA).toContain(m.trackingId);
      expect(m.warehouseCode).toBe(codeA);
    }
    expect(data.recentMovements.map((m) => m.trackingId)).not.toContain(trackingB1);
  });
});

describe("Step 5 warehouse console — PKR scope (WA of warehouse B only)", () => {
  it("contains zero KTM-only counts and records", async () => {
    const waB = await actorFor(waBId);
    const data = await homeSvc.getWarehouseConsole(waB, [whB]);
    expect(data.kpis.receivedToday).toBe(1);
    expect(data.kpis.awaitingInspection).toBe(1);
    expect(data.kpis.readyForDispatch).toBe(0);
    expect(data.kpis.inventoryItems).toBe(1);
    expect(data.kpis.openIncidents).toBe(1);
    expect(data.kpis.tasksDueToday).toBe(1);
    expect(data.kpis.incomingTransfers).toBe(2);
    expect(data.kpis.outgoingTransfers).toBe(2);
    expect(data.kpis.pendingDeliveries).toBe(0);
    expect(data.todaysOps!.received).toBe(1);
    expect(data.todaysOps!.delivered).toBe(0);
    expect(data.todaysOps!.failedAttempts).toBe(0);
    // Transfer tables: B sees its own ends of the shared transfers
    // plus the PKR-only pair — never the A→B closed row as an open
    // item, and the KTM console's direction split is mirrored.
    expect(data.transfers.incoming.map((t) => t.id).sort()).toEqual(
      [outABId, pkrInId].sort(),
    );
    expect(data.transfers.outgoing.map((t) => t.id).sort()).toEqual(
      [inBAId, pkrOutId].sort(),
    );
    expect(data.tasks.map((t) => t.title)).toEqual([`S5 B due today ${RUN}`]);
    expect(data.recentMovements.length).toBeGreaterThan(0);
    for (const m of data.recentMovements) {
      expect(m.trackingId).toBe(trackingB1);
      expect(m.warehouseCode).toBe(codeB);
    }
  });
});

describe("Step 5 warehouse console — requested-scope narrowing + guard", () => {
  it("a both-warehouses WA narrowed to A reads exactly the A figures", async () => {
    const waBoth = await actorFor(waBothId);
    const narrowed = await homeSvc.getWarehouseConsole(waBoth, [whA]);
    expect(narrowed.kpis.receivedToday).toBe(4);
    expect(narrowed.kpis.inventoryItems).toBe(4);
    expect(narrowed.kpis.tasksDueToday).toBe(1);
    expect(narrowed.transfers.incoming.map((t) => t.id)).toEqual([inBAId]);

    const all = await homeSvc.getWarehouseConsole(waBoth, [whA, whB]);
    expect(all.kpis.receivedToday).toBe(5);
    expect(all.kpis.inventoryItems).toBe(5);
    expect(all.kpis.tasksDueToday).toBe(2);
    expect(all.kpis.openIncidents).toBe(2);
  });

  it("an out-of-scope warehouse id is refused, alone or mixed", async () => {
    const waA = await actorFor(waAId);
    await expect(homeSvc.getWarehouseConsole(waA, [whB])).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
    await expect(homeSvc.getWarehouseConsole(waA, [whA, whB])).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
    await expect(homeSvc.getWarehouseConsole(waA, [whC])).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
  });

  it("an empty scope reads as an honest zero console", async () => {
    const waA = await actorFor(waAId);
    const data = await homeSvc.getWarehouseConsole(waA, []);
    expect(data.kpis.receivedToday).toBe(0);
    expect(data.transfers.incoming).toEqual([]);
    expect(data.tasks).toEqual([]);
  });
});
