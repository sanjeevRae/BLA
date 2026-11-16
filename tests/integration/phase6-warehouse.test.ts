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
const email = (label: string) => `p6wh-${label}-${RUN}@test.local`;
const phone = (n: number) => `9779800${String(100000 + n).slice(0, 6)}`;

let prisma: PrismaClient;
let homeSvc: typeof import("@/server/services/warehouse-home");
let inventorySvc: typeof import("@/server/services/inventory");
let driversSvc: typeof import("@/server/services/drivers");
let bookingsSvc: typeof import("@/server/services/bookings");
let actorLib: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let reportsDomain: typeof import("@/lib/reports/domain");

let adminId: string;
let waAId: string;
let waBId: string;
let whA: string;
let whB: string;
let districtA: string;
let districtB: string;
let serviceCode: string;
let riderA1DriverId: string;

/** All 90 legal warehouse-code pairs ("10".."99"), shuffled. */
function candidatePairs(): string[] {
  const all = Array.from({ length: 90 }, (_, i) => String(i + 10));
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all;
}

function isUniqueViolation(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "P2002";
}

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

async function makeUser(label: string, roleCode: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `P6 ${label}`,
      passwordHash: await hash("fixture-password", 10),
      status: "ACTIVE",
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role ${roleCode} not seeded in bla_test`);
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user.id;
}

async function addMembership(
  userId: string,
  warehouseId: string,
  roleCode: "WAREHOUSE_ADMIN" | "WAREHOUSE_STAFF",
): Promise<void> {
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  await prisma.warehouseMembership.create({
    data: { userId, warehouseId, roleId: role!.id, isPrimary: true },
  });
}

async function makeDriver(
  label: string,
  homeWarehouseId: string,
  availabilityStatus: string,
): Promise<string> {
  const userId = await makeUser(label, "RIDER");
  const driver = await prisma.driver.create({
    data: {
      userId,
      homeWarehouseId,
      licenseNumber: `LIC-P6-${label}-${RUN}`,
      licenseExpiry: new Date("2030-01-01T00:00:00.000Z"),
      employmentStatus: "ACTIVE",
      availabilityStatus,
      capabilities: { create: [{ capability: "DELIVERY" }] },
    },
  });
  return driver.id;
}

async function bookOne(
  admin: Awaited<ReturnType<typeof actorFor>>,
  originWarehouseId: string,
  destDistrict: string,
  destCity: string,
): Promise<{ packageId: string; trackingId: string }> {
  const booking = await bookingsSvc.createBooking(admin, {
    sender: { name: "P6 Sender", phone: phone(42), email: null },
    recipient: {
      name: "P6 Recipient",
      phone: phone(101),
      addressLine: "Some Street 1",
      city: destCity,
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
  driversSvc = await import("@/server/services/drivers");
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

  adminId = await makeUser("admin", "ADMIN");
  waAId = await makeUser("wa-a", "WAREHOUSE_ADMIN");
  waBId = await makeUser("wa-b", "WAREHOUSE_ADMIN");
  const admin = await actorFor(adminId);

  // Fresh warehouses per run (distinct counts are only assertable on
  // warehouses no other run has touched).
  districtA = `P6 District A ${RUN}`;
  districtB = `P6 District B ${RUN}`;
  const mkWarehouse = (code: string, name: string) =>
    prisma.warehouse.create({
      data: {
        code,
        name,
        type: "REGIONAL",
        district: "Kathmandu",
        city: "Kathmandu",
        province: "Bagmati",
        status: "ACTIVE",
      },
    });
  for (const candidate of candidatePairs()) {
    try {
      whA = (await mkWarehouse(`WH-PWA-${candidate}`, "P6 Warehouse A")).id;
      whB = (await mkWarehouse(`WH-PWB-${candidate}`, "P6 Warehouse B")).id;
      break;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      whA = "";
      whB = "";
    }
  }
  if (!whA || !whB) throw new Error("no fresh warehouse code pair available");
  // Fix districts on the created rows (mkWarehouse used the code's city).
  await prisma.warehouse.update({ where: { id: whA }, data: { district: districtA } });
  await prisma.warehouse.update({ where: { id: whB }, data: { district: districtB } });
  for (const [district, warehouseId, name] of [
    [districtA, whA, "P6 Area A"],
    [districtB, whB, "P6 Area B"],
  ] as const) {
    await prisma.serviceArea.create({
      data: { name, district, city: "Kathmandu", province: "Bagmati", servingWarehouseId: warehouseId },
    });
  }

  await addMembership(waAId, whA, "WAREHOUSE_ADMIN");
  await addMembership(waBId, whB, "WAREHOUSE_ADMIN");
  const waA = await actorFor(waAId);

  // Shipping service + catch-all tariff for this run.
  serviceCode = `P6STD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P6 Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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

  // --- Inventory at A: 3 received today; one stays RECEIVED_AT_ORIGIN,
  // one moves to INSPECTION_PENDING, one goes all the way to
  // READY_FOR_DISPATCH. At B: 1 received. ---
  const zoneA = await prisma.warehouseZone.create({
    data: { warehouseId: whA, code: "ZONE-STO", name: "Storage", kind: "STORAGE" },
  });
  const whArow = await prisma.warehouse.findUnique({ where: { id: whA } });
  const locA = await prisma.storageLocation.create({
    data: { zoneId: zoneA.id, rack: "R1", fullCode: `${whArow!.code}/ZONE-STO/RACK-01` },
  });

  const a1 = await bookOne(admin, whA, districtB, "Kathmandu");
  const a2 = await bookOne(admin, whA, districtB, "Kathmandu");
  const a3 = await bookOne(admin, whA, districtB, "Kathmandu");
  for (const p of [a1, a2, a3]) {
    await inventorySvc.receivePackage(waA, {
      warehouseId: whA,
      trackingId: p.trackingId,
      source: "WEB",
    });
  }
  await inventorySvc.moveToInspection(waA, a2.packageId);
  await inventorySvc.moveToInspection(waA, a3.packageId);
  await inventorySvc.startInspection(waA, a3.packageId);
  await inventorySvc.recordInspection(waA, { packageId: a3.packageId, condition: "GOOD", actualWeightKg: 1 });
  await inventorySvc.putAwayPackage(waA, a3.packageId, locA.id);
  await inventorySvc.markReadyForDispatch(waA, a3.packageId);

  const b1 = await bookOne(admin, whB, districtA, "Kathmandu");
  const waB = await actorFor(waBId);
  await inventorySvc.receivePackage(waB, {
    warehouseId: whB,
    trackingId: b1.trackingId,
    source: "WEB",
  });

  // --- Incidents: A has 2 open + 1 resolved; B has 1 open. ---
  const mkIncident = (n: number, warehouseId: string, status: string) =>
    prisma.incident.create({
      data: {
        incidentNumber: `INC-P6-${RUN}-${n}`,
        category: "DAMAGED_PACKAGE",
        severity: "HIGH",
        status,
        description: `P6 fixture incident ${n}`,
        reporterId: adminId,
        warehouseId,
        // Incident_resolution_shape_chk: RESOLVED/CLOSED rows must carry
        // a resolution + resolvedAt; open rows must not carry resolvedAt.
        ...(status === "RESOLVED" || status === "CLOSED"
          ? { resolution: "Fixture resolution", resolvedAt: new Date() }
          : {}),
      },
    });
  await mkIncident(1, whA, "REPORTED");
  await mkIncident(2, whA, "INVESTIGATING");
  await mkIncident(3, whA, "RESOLVED");
  await mkIncident(4, whB, "REPORTED");

  // --- Tasks: A has 2 overdue + 1 future; B has 1 overdue. ---
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const mkTask = (title: string, warehouseId: string, assigneeId: string, dueAt: Date, status: string) =>
    prisma.task.create({
      data: { title, createdById: adminId, assigneeId, warehouseId, status, dueAt, priority: "NORMAL" },
    });
  await mkTask("P6 overdue A1", whA, waAId, yesterday, "ASSIGNED");
  await mkTask("P6 overdue A2", whA, waAId, yesterday, "IN_PROGRESS");
  await mkTask("P6 future A", whA, waAId, tomorrow, "ASSIGNED");
  await mkTask("P6 overdue B1", whB, waBId, yesterday, "ASSIGNED");

  // --- Transfers: B→A IN_TRANSIT (incoming for A); A→B DRAFT
  // (outgoing for A); B→A RECONCILIATION_PENDING with a MISSING item
  // (discrepancy at A). ---
  const mkTransfer = (n: number, origin: string, dest: string, status: string) =>
    prisma.transfer.create({
      data: {
        transferNumber: `TRF-P6-${RUN}-${n}`,
        originWarehouseId: origin,
        destinationWarehouseId: dest,
        status,
        createdById: adminId,
      },
    });
  await mkTransfer(1, whB, whA, "IN_TRANSIT");
  await mkTransfer(2, whA, whB, "DRAFT");
  const discrepancy = await mkTransfer(3, whB, whA, "RECONCILIATION_PENDING");
  const stray = await bookOne(admin, whB, districtA, "Kathmandu");
  await prisma.transferItem.create({
    data: { transferId: discrepancy.id, packageId: stray.packageId, itemStatus: "MISSING", expectedCondition: "GOOD" },
  });

  // --- Drivers / riders: A has 2 AVAILABLE + 1 busy; B has 1 AVAILABLE. ---
  riderA1DriverId = await makeDriver("rider-a1", whA, "AVAILABLE");
  await makeDriver("rider-a2", whA, "AVAILABLE");
  await makeDriver("rider-a3", whA, "ON_DELIVERY");
  const riderB1DriverId = await makeDriver("rider-b1", whB, "AVAILABLE");

  // --- Delivery batches today (Kathmandu): A — 3 assignments
  // (1 delivered, 1 out, 1 pending); B — 1 pending. Plus a stale
  // batch at A dated yesterday that must not count. ---
  const today = reportsDomain.kathmanduToday();
  const batchDate = new Date(`${today}T00:00:00.000Z`);
  const yesterdayDate = new Date(batchDate.getTime() - 24 * 60 * 60 * 1000);
  const mkBatch = (warehouseId: string, riderId: string, date: Date, status: string) =>
    prisma.deliveryBatch.create({
      data: { riderId, warehouseId, batchDate: date, kind: "DELIVERY", status, createdById: adminId },
    });
  const batchA = await mkBatch(whA, riderA1DriverId, batchDate, "IN_PROGRESS");
  const batchB = await mkBatch(whB, riderB1DriverId, batchDate, "OPEN");
  await mkBatch(whA, riderA1DriverId, yesterdayDate, "COMPLETED");
  const mkAssignment = (batchId: string, driverId: string, packageId: string, status: string) =>
    prisma.deliveryAssignment.create({
      data: { packageId, driverId, batchId, kind: "DELIVERY", status, assignedById: adminId },
    });
  const ap1 = await bookOne(admin, whA, districtA, "Kathmandu");
  const ap2 = await bookOne(admin, whA, districtA, "Kathmandu");
  const ap3 = await bookOne(admin, whA, districtA, "Kathmandu");
  await mkAssignment(batchA.id, riderA1DriverId, ap1.packageId, "COMPLETED");
  await mkAssignment(batchA.id, riderA1DriverId, ap2.packageId, "IN_PROGRESS");
  await mkAssignment(batchA.id, riderA1DriverId, ap3.packageId, "PENDING");
  const bp1 = await bookOne(admin, whB, districtB, "Kathmandu");
  await mkAssignment(batchB.id, riderB1DriverId, bp1.packageId, "PENDING");
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("warehouse home summary scoping (Phase 6)", () => {
  it("returns only warehouse A's numbers for A's admin", async () => {
    const waA = await actorFor(waAId);
    const home = await homeSvc.getWarehouseHomeSummary(waA, whA);
    expect(home.warehouseId).toBe(whA);
    expect(home.metrics.receivedToday).toBe(3);
    expect(home.metrics.packagesAtWarehouse).toBe(3);
    expect(home.metrics.awaitingInspection).toBe(2);
    expect(home.metrics.readyForDispatch).toBe(1);
    expect(home.metrics.incomingTransfers).toBe(1);
    expect(home.metrics.outgoingTransfers).toBe(1);
    expect(home.needsAttention.openIncidents).toBe(2);
    expect(home.needsAttention.discrepancyTransfers).toBe(1);
    expect(home.needsAttention.discrepancyItems).toBe(1);
    expect(home.needsAttention.overdueTasks).toBe(2);
    expect(home.deliveriesToday).toEqual({ batches: 1, assigned: 3, delivered: 1, remaining: 2 });
    expect(home.availableRiders).toBe(2);
    expect(home.recentMovements.length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it("returns only warehouse B's (different) numbers for B's admin", async () => {
    const waB = await actorFor(waBId);
    const home = await homeSvc.getWarehouseHomeSummary(waB, whB);
    expect(home.metrics.receivedToday).toBe(1);
    expect(home.metrics.packagesAtWarehouse).toBe(1);
    expect(home.metrics.awaitingInspection).toBe(1);
    expect(home.metrics.readyForDispatch).toBe(0);
    expect(home.metrics.incomingTransfers).toBe(0);
    expect(home.metrics.outgoingTransfers).toBe(2);
    expect(home.needsAttention.openIncidents).toBe(1);
    expect(home.needsAttention.discrepancyTransfers).toBe(0);
    expect(home.needsAttention.overdueTasks).toBe(1);
    expect(home.deliveriesToday).toEqual({ batches: 1, assigned: 1, delivered: 0, remaining: 1 });
    expect(home.availableRiders).toBe(1);
  }, 30_000);

  it("denies a Warehouse Admin the other warehouse's home summary (audited 403)", async () => {
    const waA = await actorFor(waAId);
    await expect(homeSvc.getWarehouseHomeSummary(waA, whB)).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
  }, 30_000);
});

describe("warehouse fleet surface (audit M-4)", () => {
  it("listDrivers for WA A returns only drivers homed at A", async () => {
    const waA = await actorFor(waAId);
    const { items, total } = await driversSvc.listDrivers(waA, { pageSize: 100 });
    expect(total).toBe(3);
    expect(items.every((d) => d.homeWarehouseId === whA)).toBe(true);
    expect(items.some((d) => d.homeWarehouseId === whB)).toBe(false);
  }, 30_000);
});

describe("warehouse booking creation origin scope (audit M-5)", () => {
  it("WA creates a drop-off booking at their OWN warehouse", async () => {
    const waA = await actorFor(waAId);
    const booking = await bookingsSvc.createBooking(waA, {
      sender: { name: "P6 Walk-in", phone: phone(77), email: null },
      recipient: {
        name: "P6 Recipient",
        phone: phone(78),
        addressLine: "Some Street 9",
        city: "Kathmandu",
        district: districtB,
        province: "Bagmati",
      },
      pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: whA },
      shippingServiceCode: serviceCode,
      paymentMethod: "CASH" as const,
      codAmountPaisa: "0",
      items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
    });
    expect(booking.originWarehouseId).toBe(whA);
  }, 30_000);

  it("WA is rejected creating a drop-off booking at ANOTHER warehouse", async () => {
    const waA = await actorFor(waAId);
    await expect(
      bookingsSvc.createBooking(waA, {
        sender: { name: "P6 Walk-in", phone: phone(79), email: null },
        recipient: {
          name: "P6 Recipient",
          phone: phone(80),
          addressLine: "Some Street 9",
          city: "Kathmandu",
          district: districtB,
          province: "Bagmati",
        },
        pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: whB },
        shippingServiceCode: serviceCode,
        paymentMethod: "CASH" as const,
        codAmountPaisa: "0",
        items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
      }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);
});
