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
const email = (label: string) => `p6bd-${label}-${RUN}@test.local`;

let prisma: PrismaClient;
let homeSvc: typeof import("@/server/services/home-dashboards");
let catalog: typeof import("@/lib/permissions/catalog");
let reportsDomain: typeof import("@/lib/reports/domain");

let adminId: string;
let staffAId: string;
let staffNoneId: string;
let whA: string;
let whB: string;
let shipmentId: string;
let orderTodayId: string;

let baseline: Awaited<ReturnType<typeof homeSvc.getAdminHome>>;
let after: Awaited<ReturnType<typeof homeSvc.getAdminHome>>;
let staffWork: Awaited<ReturnType<typeof homeSvc.getStaffMyWork>>;
let staffNoneWork: Awaited<ReturnType<typeof homeSvc.getStaffMyWork>>;

const INCIDENT_CRITICAL_NUMBER = `INC-P6-${RUN}-1`;

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
  const driverProfile = await prisma.driver.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });
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
    driverId: driverProfile?.id ?? null,
    customerId: null,
    landingPath: catalog.landingPathForRoles(roles as never[]),
  };
}

async function makeUser(label: string, roleCode: string, fullName?: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: fullName ?? `P6 ${label}`,
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
  userId: string,
  homeWarehouseId: string,
  label: string,
  availabilityStatus = "AVAILABLE",
): Promise<string> {
  const driver = await prisma.driver.create({
    data: {
      userId,
      homeWarehouseId,
      licenseNumber: `LIC-P6-${label}-${RUN}`,
      licenseExpiry: new Date("2028-01-01"),
      availabilityStatus,
      employmentStatus: "ACTIVE",
    },
  });
  return driver.id;
}

async function makePackage(opts: {
  label: string;
  warehouseId: string | null;
  status: string;
  inInventory?: boolean;
}): Promise<string> {
  const pkg = await prisma.package.create({
    data: {
      trackingId: `BLA-P6-${opts.label}-${RUN}`,
      shipmentId,
      orderId: orderTodayId,
      recipientName: `Recipient ${opts.label}`,
      recipientPhone: "9779800000000",
      deliveryAddress: `Address ${opts.label}`,
      deliveryCity: "Kathmandu",
      deliveryDistrict: "Kathmandu",
      declaredWeightKg: "1.000",
      description: `Parcel ${opts.label}`,
      operationalStatus: opts.status,
      currentWarehouseId: opts.warehouseId,
    },
  });
  if (opts.inInventory && opts.warehouseId) {
    const event = await prisma.trackingEvent.create({
      data: {
        packageId: pkg.id,
        shipmentId,
        orderId: orderTodayId,
        subjectType: "PACKAGE",
        eventType: "RECEIVED",
        actorId: adminId,
        warehouseId: opts.warehouseId,
      },
    });
    await prisma.inventoryRecord.create({
      data: {
        packageId: pkg.id,
        warehouseId: opts.warehouseId,
        receivingEventId: event.id,
        receivedById: staffAId,
      },
    });
  }
  return pkg.id;
}

async function makeSessionAndSnapshot(opts: {
  driverId: string;
  deliveryBatchId?: string;
  tripId?: string;
  trackingType: string;
  receivedAt: Date | null;
}): Promise<void> {
  const session = await prisma.trackingSession.create({
    data: {
      driverId: opts.driverId,
      deliveryBatchId: opts.deliveryBatchId ?? null,
      tripId: opts.tripId ?? null,
      trackingType: opts.trackingType,
      originWarehouseId: whA,
      destinationWarehouseId: whB,
      status: "ACTIVE",
      startReason: "DRIVER",
      permissionAcknowledgedAt: new Date(),
    },
  });
  if (opts.receivedAt) {
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
  }
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  homeSvc = await import("@/server/services/home-dashboards");
  catalog = await import("@/lib/permissions/catalog");
  reportsDomain = await import("@/lib/reports/domain");

  // Role/permission catalog must exist in bla_test (idempotent upserts,
  // same as prisma/seed.ts).
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

  whA = (
    await prisma.warehouse.create({
      data: {
        code: `P6A-${RUN}`,
        name: `P6 Warehouse A ${RUN}`,
        type: "REGIONAL",
        district: "Kathmandu",
        city: "Kathmandu",
        province: "Bagmati",
        status: "ACTIVE",
      },
    })
  ).id;
  whB = (
    await prisma.warehouse.create({
      data: {
        code: `P6B-${RUN}`,
        name: `P6 Warehouse B ${RUN}`,
        type: "REGIONAL",
        district: "Kaski",
        city: "Pokhara",
        province: "Gandaki",
        status: "ACTIVE",
      },
    })
  ).id;

  adminId = await makeUser("admin", "ADMIN");
  staffAId = await makeUser("staff-a", "WAREHOUSE_STAFF");
  staffNoneId = await makeUser("staff-none", "WAREHOUSE_STAFF");
  await addMembership(staffAId, whA, "WAREHOUSE_STAFF");

  // Drivers for the live-operations fixtures + the active-driver count.
  const freshUser = await makeUser("drv-fresh", "RIDER", `P6Fresh-${RUN}`);
  const freshDriver = await makeDriver(freshUser, whA, "FR");
  const delayedUser = await makeUser("drv-delayed", "RIDER", `P6Delayed-${RUN}`);
  const delayedDriver = await makeDriver(delayedUser, whA, "DL");
  const staleUser = await makeUser("drv-stale", "LINEHAUL_DRIVER", `P6Stale-${RUN}`);
  const staleDriver = await makeDriver(staleUser, whA, "ST");
  const offlineUser = await makeUser("drv-offline", "RIDER", `P6Offline-${RUN}`);
  const offlineDriver = await makeDriver(offlineUser, whA, "OF");

  const adminActor = await actorFor(adminId);

  // Baseline BEFORE any operational fixture exists for this run: the
  // admin figures are global, and bla_test accumulates rows from other
  // suites, so admin assertions are deltas against this baseline.
  baseline = await homeSvc.getAdminHome(adminActor);

  // The fresh driver goes ON_DELIVERY only after the baseline, so the
  // active-driver delta measures exactly this one driver.
  await prisma.driver.update({
    where: { id: freshDriver },
    data: { availabilityStatus: "ON_DELIVERY" },
  });

  // --- Operational fixtures -------------------------------------------
  const today = reportsDomain.kathmanduToday();
  const todayStart = reportsDomain.kathmanduDayStartUtc(today);
  const todayInstant = new Date(todayStart.getTime() + 2 * 60 * 60 * 1000);
  const yesterdayInstant = new Date(todayStart.getTime() - 2 * 60 * 60 * 1000);

  const service = await prisma.shippingService.create({
    data: { code: `P6SVC-${RUN}`, name: `P6 Service ${RUN}` },
  });
  const mkOrder = (label: string, createdAt: Date) =>
    prisma.order.create({
      data: {
        orderNumber: `ORD-P6-${label}-${RUN}`,
        createdById: adminId,
        createdByRole: "ADMIN",
        senderName: "P6 Sender",
        senderPhone: "9779811111111",
        originWarehouseId: whA,
        destinationDistrict: "Kathmandu",
        paymentMethod: "CASH",
        pickupMethod: "WAREHOUSE_DROPOFF",
        createdAt,
      },
    });
  const orderToday1 = await mkOrder("T1", todayInstant);
  orderTodayId = orderToday1.id;
  await mkOrder("T2", todayInstant);
  await mkOrder("Y1", yesterdayInstant);

  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-P6-${RUN}`,
      orderId: orderToday1.id,
      originWarehouseId: whA,
      destinationWarehouseId: whB,
      routeKind: "INTER_WAREHOUSE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(0),
    },
  });
  shipmentId = shipment.id;

  // Awaiting pickup: BOOKED + PICKUP_ASSIGNED count; DELIVERED does not.
  await makePackage({ label: "AP1", warehouseId: null, status: "BOOKED" });
  await makePackage({ label: "AP2", warehouseId: null, status: "PICKUP_ASSIGNED" });
  await makePackage({ label: "AP3", warehouseId: null, status: "DELIVERED" });

  // Staff queue inventory — whA (staffA's warehouse).
  await makePackage({ label: "QA1", warehouseId: whA, status: "RECEIVED_AT_ORIGIN", inInventory: true });
  await makePackage({ label: "QA2", warehouseId: whA, status: "INSPECTION_PENDING", inInventory: true });
  await makePackage({ label: "QA3", warehouseId: whA, status: "PROCESSING", inInventory: true });
  await makePackage({ label: "QA4", warehouseId: whA, status: "SORTED", inInventory: true });
  // Staff queue inventory — whB (NOT staffA's warehouse; must be excluded).
  await makePackage({ label: "QB1", warehouseId: whB, status: "INSPECTION_PENDING", inInventory: true });
  await makePackage({ label: "QB2", warehouseId: whB, status: "PROCESSING", inInventory: true });

  // Transfers: outgoing (A→B in transit), incoming (B→A arrived),
  // preparing (A→B), closed (excluded from active).
  const mkTransfer = (label: string, origin: string, dest: string, status: string) =>
    prisma.transfer.create({
      data: {
        transferNumber: `TRF-P6-${label}-${RUN}`,
        originWarehouseId: origin,
        destinationWarehouseId: dest,
        status,
        createdById: adminId,
      },
    });
  await mkTransfer("OUT", whA, whB, "IN_TRANSIT");
  await mkTransfer("IN", whB, whA, "ARRIVED");
  await mkTransfer("PREP", whA, whB, "PREPARING");
  await mkTransfer("DONE", whA, whB, "CLOSED");

  // Incidents: CRITICAL open (today), HIGH open (yesterday — open is a
  // snapshot, not day-scoped), LOW resolved (not open).
  await prisma.incident.create({
    data: {
      incidentNumber: INCIDENT_CRITICAL_NUMBER,
      category: "MISSING_PACKAGE",
      severity: "CRITICAL",
      status: "REPORTED",
      reporterId: adminId,
      warehouseId: whA,
      description: "P6 critical fixture",
      createdAt: todayInstant,
    },
  });
  await prisma.incident.create({
    data: {
      incidentNumber: `INC-P6-${RUN}-2`,
      category: "DAMAGED_PACKAGE",
      severity: "HIGH",
      status: "INVESTIGATING",
      reporterId: adminId,
      warehouseId: whA,
      description: "P6 high fixture",
      createdAt: yesterdayInstant,
    },
  });
  await prisma.incident.create({
    data: {
      incidentNumber: `INC-P6-${RUN}-3`,
      category: "DUPLICATE_SCAN",
      severity: "LOW",
      status: "RESOLVED",
      reporterId: adminId,
      description: "P6 resolved fixture",
      resolution: "P6 resolved fixture resolution",
      resolvedAt: todayInstant,
      createdAt: todayInstant,
    },
  });

  // Tasks: two for staffA (one overdue), one for admin (not staffA's).
  await prisma.task.create({
    data: {
      title: `P6 overdue task ${RUN}`,
      createdById: adminId,
      assigneeId: staffAId,
      warehouseId: whA,
      status: "ASSIGNED",
      priority: "HIGH",
      dueAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });
  await prisma.task.create({
    data: {
      title: `P6 current task ${RUN}`,
      createdById: adminId,
      assigneeId: staffAId,
      warehouseId: whA,
      status: "IN_PROGRESS",
      priority: "NORMAL",
      dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  });
  await prisma.task.create({
    data: {
      title: `P6 other task ${RUN}`,
      createdById: adminId,
      assigneeId: adminId,
      status: "ASSIGNED",
      priority: "NORMAL",
    },
  });

  // COD: one remittance awaiting verification (driver = freshDriver).
  await prisma.codRemittance.create({
    data: {
      remittanceNumber: `REM-P6-${RUN}`,
      driverId: freshDriver,
      submittedById: freshUser,
      declaredAmountPaisa: BigInt(50000),
      status: "SUBMITTED",
      method: "CASH",
    },
  });

  // Live operations: FRESH delivery, DELAYED pickup, STALE line-haul,
  // OFFLINE delivery (session with no snapshot at all).
  const now = Date.now();
  const mkBatch = (riderId: string) =>
    prisma.deliveryBatch.create({
      data: {
        riderId,
        warehouseId: whA,
        batchDate: new Date(),
        kind: "DELIVERY",
        status: "OPEN",
        createdById: adminId,
      },
    });
  const batchFresh = await mkBatch(freshDriver);
  const batchDelayed = await mkBatch(delayedDriver);
  const batchOffline = await mkBatch(offlineDriver);
  await makeSessionAndSnapshot({
    driverId: freshDriver,
    deliveryBatchId: batchFresh.id,
    trackingType: "DELIVERY",
    receivedAt: new Date(now - 60_000),
  });
  await makeSessionAndSnapshot({
    driverId: delayedDriver,
    deliveryBatchId: batchDelayed.id,
    trackingType: "PICKUP",
    receivedAt: new Date(now - 10 * 60_000),
  });
  // The stale LINEHAUL session needs a real trip (the assignment
  // shape CHECK requires tripId for LINEHAUL). Its transfer is
  // RECONCILED so it cannot disturb the pipeline deltas above.
  const staleVehicle = await prisma.vehicle.create({
    data: { registration: `VEH-P6-${RUN}`, type: "TRUCK", homeWarehouseId: whA },
  });
  const staleTransfer = await prisma.transfer.create({
    data: {
      transferNumber: `TRF-P6-STALE-${RUN}`,
      originWarehouseId: whA,
      destinationWarehouseId: whB,
      status: "RECONCILED",
      driverId: staleDriver,
      vehicleId: staleVehicle.id,
      createdById: adminId,
    },
  });
  const staleTrip = await prisma.trip.create({
    data: {
      tripNumber: `TRP-P6-${RUN}`,
      transferId: staleTransfer.id,
      driverId: staleDriver,
      vehicleId: staleVehicle.id,
      status: "IN_TRANSIT",
    },
  });
  await prisma.transfer.update({
    where: { id: staleTransfer.id },
    data: { tripId: staleTrip.id },
  });
  await makeSessionAndSnapshot({
    driverId: staleDriver,
    tripId: staleTrip.id,
    trackingType: "LINEHAUL",
    receivedAt: new Date(now - 60 * 60_000),
  });
  await makeSessionAndSnapshot({
    driverId: offlineDriver,
    deliveryBatchId: batchOffline.id,
    trackingType: "DELIVERY",
    receivedAt: null,
  });

  after = await homeSvc.getAdminHome(adminActor);
  staffWork = await homeSvc.getStaffMyWork(await actorFor(staffAId));
  staffNoneWork = await homeSvc.getStaffMyWork(await actorFor(staffNoneId));
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Phase 6 admin home — metric accuracy", () => {
  it("counts only today's bookings (today vs yesterday fixtures)", () => {
    expect(after.today).toBe(reportsDomain.kathmanduToday());
    expect(after.metrics.bookingsToday - baseline.metrics.bookingsToday).toBe(2);
    expect(after.currentOps.bookingsToday - baseline.currentOps.bookingsToday).toBe(2);
    // No delivery fixtures were planted for today.
    expect(after.currentOps.deliveredToday - baseline.currentOps.deliveredToday).toBe(0);
    expect(after.needsAttention.failedDeliveriesToday - baseline.needsAttention.failedDeliveriesToday).toBe(0);
  });

  it("splits the transfer pipeline by direction and stage", () => {
    expect(after.currentOps.outgoingTransfers - baseline.currentOps.outgoingTransfers).toBe(1);
    expect(after.currentOps.incomingTransfers - baseline.currentOps.incomingTransfers).toBe(1);
    expect(after.currentOps.preparingTransfers - baseline.currentOps.preparingTransfers).toBe(1);
    // IN_TRANSIT + ARRIVED + PREPARING are active; CLOSED is not.
    expect(after.metrics.activeTransfers - baseline.metrics.activeTransfers).toBe(3);
  });

  it("counts awaiting-pickup packages and drivers on assignment", () => {
    expect(after.currentOps.awaitingPickup - baseline.currentOps.awaitingPickup).toBe(2);
    // Only the FRESH fixture driver is ON_DELIVERY; the other three
    // fixture drivers stay AVAILABLE.
    expect(after.metrics.activeDrivers - baseline.metrics.activeDrivers).toBe(1);
    expect(after.currentOps.activeDrivers - baseline.currentOps.activeDrivers).toBe(1);
  });

  it("counts open incidents by severity, resolved excluded", () => {
    expect(after.metrics.openIncidents - baseline.metrics.openIncidents).toBe(2);
    expect(
      after.needsAttention.incidentsBySeverity.CRITICAL -
        baseline.needsAttention.incidentsBySeverity.CRITICAL,
    ).toBe(1);
    expect(
      after.needsAttention.incidentsBySeverity.HIGH -
        baseline.needsAttention.incidentsBySeverity.HIGH,
    ).toBe(1);
    expect(
      after.needsAttention.incidentsBySeverity.LOW -
        baseline.needsAttention.incidentsBySeverity.LOW,
    ).toBe(0);
    expect(
      after.needsAttention.topOpenIncidents.some(
        (i) => i.incidentNumber === INCIDENT_CRITICAL_NUMBER,
      ),
    ).toBe(true);
  });

  it("counts COD awaiting verification and overdue tasks", () => {
    expect(after.metrics.pendingCod - baseline.metrics.pendingCod).toBe(1);
    expect(after.needsAttention.codDiscrepancies - baseline.needsAttention.codDiscrepancies).toBe(0);
    expect(after.needsAttention.overdueTasks - baseline.needsAttention.overdueTasks).toBe(1);
  });
});

describe("Phase 6 admin home — live-operations summary", () => {
  it("buckets planted sessions by type and freshness", () => {
    const b = baseline.live!;
    const a = after.live!;
    expect(a.activeMovements - b.activeMovements).toBe(4);
    expect(a.byType.deliveries - b.byType.deliveries).toBe(2);
    expect(a.byType.pickups - b.byType.pickups).toBe(1);
    expect(a.byType.transfers - b.byType.transfers).toBe(1);
    expect(a.byFreshness.fresh - b.byFreshness.fresh).toBe(1);
    expect(a.byFreshness.delayed - b.byFreshness.delayed).toBe(1);
    expect(a.byFreshness.stale - b.byFreshness.stale).toBe(1);
    expect(a.byFreshness.offline - b.byFreshness.offline).toBe(1);
  });

  it("summarizeLiveOperations excludes ended sessions and orders stalest first", () => {
    const item = (over: Record<string, unknown>) =>
      ({
        trackingSessionId: "s",
        driverId: "d",
        driverName: "Driver",
        trackingType: "DELIVERY",
        sessionStatus: "ACTIVE",
        tripId: null,
        tripNumber: null,
        transferId: null,
        deliveryBatchId: null,
        batchKind: null,
        batchDate: null,
        origin: { warehouseId: "w", code: "WH-A", name: "A" },
        destination: null,
        vehicleRegistration: null,
        packageCount: 0,
        deliveredCount: null,
        remainingCount: null,
        location: null,
        freshnessState: "OFFLINE",
        ...over,
      }) as never;
    const summary = homeSvc.summarizeLiveOperations(
      [
        item({ trackingSessionId: "ended", sessionStatus: "ENDED", freshnessState: "FRESH" }),
        item({
          trackingSessionId: "fresh",
          driverName: "Fresh Driver",
          freshnessState: "FRESH",
          location: {
            latitude: 1,
            longitude: 2,
            accuracyMeters: 5,
            lastRecordedAt: "2026-11-16T10:00:00.000Z",
            lastReceivedAt: "2026-11-16T10:00:00.000Z",
          },
        }),
        item({ trackingSessionId: "never", driverName: "Never Driver" }),
      ],
      "2026-11-16T10:05:00.000Z",
    );
    expect(summary.activeMovements).toBe(2);
    expect(summary.byFreshness.fresh).toBe(1);
    expect(summary.byFreshness.offline).toBe(1);
    // Never-reported sorts before the fresh one.
    expect(summary.stalest.map((s) => s.trackingSessionId)).toEqual(["never", "fresh"]);
    expect(summary.stalest[0].lastReceivedAt).toBeNull();
  });
});

describe("Phase 6 staff My Work home", () => {
  it("scopes queue counts to the staff member's own warehouse only", () => {
    expect(staffWork.hasWarehouse).toBe(true);
    expect(staffWork.warehouses.map((w) => w.id)).toEqual([whA]);
    expect(staffWork.perWarehouse).toHaveLength(1);
    // whA fixtures: RECEIVED_AT_ORIGIN + INSPECTION_PENDING awaiting
    // inspection; PROCESSING in inspection; SORTED in dispatch prep.
    // whB's INSPECTION_PENDING + PROCESSING must NOT appear.
    expect(staffWork.totals.awaitingInspection).toBe(2);
    expect(staffWork.totals.inInspection).toBe(1);
    expect(staffWork.totals.dispatchPrep).toBe(1);
    expect(staffWork.totals.openPackages).toBe(4);
    // Only the B→A ARRIVED transfer is inbound to whA.
    expect(staffWork.totals.arrivalsInbound).toBe(1);
    expect(staffWork.perWarehouse[0].warehouseId).toBe(whA);
    expect(staffWork.perWarehouse[0].awaitingInspection).toBe(2);
  });

  it("lists only the staff member's own tasks, with the overdue flag", () => {
    expect(staffWork.myTasksTotal).toBe(2);
    expect(staffWork.myOverdueTasks).toBe(1);
    const titles = staffWork.myTasks.map((t) => t.title);
    expect(titles.some((t) => t.includes("overdue task"))).toBe(true);
    expect(titles.some((t) => t.includes("current task"))).toBe(true);
    expect(titles.some((t) => t.includes("other task"))).toBe(false);
    expect(staffWork.myTasks.find((t) => t.title.includes("overdue"))?.overdue).toBe(true);
  });

  it("returns an honest empty home for staff with no warehouse membership", () => {
    expect(staffNoneWork.hasWarehouse).toBe(false);
    expect(staffNoneWork.warehouses).toEqual([]);
    expect(staffNoneWork.perWarehouse).toEqual([]);
    expect(staffNoneWork.totals).toEqual({
      awaitingInspection: 0,
      inInspection: 0,
      dispatchPrep: 0,
      arrivalsInbound: 0,
      openPackages: 0,
      damagedPackages: 0,
      pendingHandovers: 0,
    });
    expect(staffNoneWork.myTasksTotal).toBe(0);
  });
});
