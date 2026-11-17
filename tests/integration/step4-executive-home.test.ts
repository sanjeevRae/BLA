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
const email = (label: string) => `s4-${label}-${RUN}@test.local`;
const ADMIN_NAME = `S4 Executive Admin ${RUN}`;

let prisma: PrismaClient;
let homeSvc: typeof import("@/server/services/home-dashboards");
let bookingsSvc: typeof import("@/server/services/bookings");
let actorLib: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

let adminId: string;
let waId: string;
let whA: string;
let whB: string;
let serviceBookingId: string;

let baseline: Awaited<ReturnType<typeof homeSvc.getExecutiveHome>>;
let after: Awaited<ReturnType<typeof homeSvc.getExecutiveHome>>;
let adminActor: Awaited<ReturnType<typeof actorFor>>;

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
      fullName: fullName ?? `S4 ${label}`,
      passwordHash: await hash("fixture-password", 10),
      status: "ACTIVE",
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role ${roleCode} not seeded in bla_test`);
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user.id;
}

function groupCount(
  home: Awaited<ReturnType<typeof homeSvc.getExecutiveHome>>,
  key: string,
): number {
  const group = home.attention.groups?.find((g) => g.key === key);
  if (!group) throw new Error(`attention group ${key} missing`);
  return group.count;
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  homeSvc = await import("@/server/services/home-dashboards");
  bookingsSvc = await import("@/server/services/bookings");
  actorLib = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");

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
        code: `S4A-${RUN}`,
        name: `S4 Warehouse A ${RUN}`,
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
        code: `S4B-${RUN}`,
        name: `S4 Warehouse B ${RUN}`,
        type: "REGIONAL",
        district: "Kaski",
        city: "Pokhara",
        province: "Gandaki",
        status: "ACTIVE",
      },
    })
  ).id;

  adminId = await makeUser("admin", "ADMIN", ADMIN_NAME);
  waId = await makeUser("wa", "WAREHOUSE_ADMIN");
  const waRole = await prisma.role.findUnique({ where: { code: "WAREHOUSE_ADMIN" } });
  await prisma.warehouseMembership.create({
    data: { userId: waId, warehouseId: whA, roleId: waRole!.id, isPrimary: true },
  });

  adminActor = await actorFor(adminId);

  // Baseline BEFORE this run's operational fixtures: the executive
  // figures are global and bla_test accumulates rows from other
  // suites, so planted-figure assertions are deltas against this
  // baseline (the phase6-admin-staff pattern), cross-checked against
  // direct prisma counts at assertion time.
  baseline = await homeSvc.getExecutiveHome(adminActor, "/admin");

  // --- A real service booking (produces the booking.create audit row
  // the activity feed must surface). Routed: the destination district
  // is served by whB, so the action is booking.create, not _unrouted.
  const district = `S4Dest District ${RUN}`;
  await prisma.serviceArea.upsert({
    where: { district_name: { district, name: `S4Dest Area ${RUN}` } },
    update: { servingWarehouseId: whB, isActive: true },
    create: {
      name: `S4Dest Area ${RUN}`,
      district,
      city: "Pokhara",
      province: "Gandaki",
      servingWarehouseId: whB,
    },
  });
  const serviceCode = `S4${RUN.slice(-8)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: `S4 Service ${RUN}` },
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
  const booking = await bookingsSvc.createBooking(adminActor, {
    sender: { name: "S4 Sender", phone: "9779811111111", email: null },
    recipient: {
      name: "S4 Recipient",
      phone: "9779822222222",
      addressLine: "Lakeside Street 1",
      city: "Pokhara",
      district,
      province: "Gandaki",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: whA },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "S4 parcel", quantity: 1, weightKg: 1.0 }],
  });
  serviceBookingId = booking.id;

  // --- Packages in known operational states (via prisma, hanging off
  // one planted order + shipment).
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-S4-${RUN}`,
      createdById: adminId,
      createdByRole: "ADMIN",
      senderName: "S4 Sender",
      senderPhone: "9779811111111",
      originWarehouseId: whA,
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-S4-${RUN}`,
      orderId: order.id,
      originWarehouseId: whA,
      destinationWarehouseId: whB,
      routeKind: "INTER_WAREHOUSE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(0),
    },
  });
  const plantedStatuses: [string, string][] = [
    ["WH", "RECEIVED_AT_ORIGIN"], // atWarehouses
    ["TR", "IN_TRANSIT"], // inTransit
    ["OFD", "OUT_FOR_DELIVERY"], // outForDelivery
    ["DEL", "DELIVERED"], // delivered
    ["AP", "BOOKED"], // awaitingPickup
    ["AR", "DELIVERY_ASSIGNED"], // assignedToRiders
    ["CAN", "CANCELLED"], // cancelled
    ["DFT", "DRAFT"], // total only
  ];
  for (const [label, status] of plantedStatuses) {
    await prisma.package.create({
      data: {
        trackingId: `BLA-S4-${label}-${RUN}`,
        shipmentId: shipment.id,
        orderId: order.id,
        recipientName: `S4 Recipient ${label}`,
        recipientPhone: "9779822222222",
        deliveryAddress: `S4 Address ${label}`,
        deliveryCity: "Kathmandu",
        deliveryDistrict: "Kathmandu",
        declaredWeightKg: "1.000",
        description: `S4 parcel ${label}`,
        operationalStatus: status,
        currentWarehouseId: whA,
      },
    });
  }

  // --- Open incidents in known categories (+ one RESOLVED that must
  // not count anywhere).
  const mkIncident = (suffix: string, category: string, status = "REPORTED") =>
    prisma.incident.create({
      data: {
        incidentNumber: `INC-S4-${RUN}-${suffix}`,
        category,
        severity: "HIGH",
        status,
        reporterId: adminId,
        warehouseId: whA,
        description: `S4 fixture ${suffix}`,
        ...(status === "RESOLVED"
          ? { resolution: "S4 resolved fixture", resolvedAt: new Date() }
          : {}),
      },
    });
  await mkIncident("MISS1", "MISSING_PACKAGE");
  await mkIncident("MISS2", "TRANSFER_SHORTAGE", "INVESTIGATING");
  await mkIncident("TD1", "TRANSFER_EXCESS");
  await mkIncident("TD2", "HANDOVER_DISCREPANCY");
  await mkIncident("TD3", "WRONG_PACKAGE_RECEIVED");
  await mkIncident("TD4", "WRONG_WAREHOUSE");
  await mkIncident("DLY1", "DELAYED_SHIPMENT");
  await mkIncident("DMG1", "DAMAGED_PACKAGE");
  await mkIncident("COD1", "COD_DISCREPANCY");
  await mkIncident("RES1", "MISSING_PACKAGE", "RESOLVED");

  // --- One overdue task.
  await prisma.task.create({
    data: {
      title: `S4 overdue task ${RUN}`,
      createdById: adminId,
      assigneeId: adminId,
      warehouseId: whA,
      status: "ASSIGNED",
      priority: "HIGH",
      dueAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  });

  after = await homeSvc.getExecutiveHome(adminActor, "/admin");
}, 120_000);

afterAll(async () => {
  // The suite pattern (phase6-admin-staff etc.): bla_test fixtures are
  // append-only history — audit rows are trigger-protected and other
  // suites assert global deltas against their own baselines — so
  // cleanup is disconnect only; every fixture above is RUN-suffixed.
  await prisma.$disconnect();
});

describe("Step 4 executive home — KPIs and package buckets", () => {
  it("snapshot totals equal direct prisma counts", async () => {
    // Fresh read, compared against prisma truth read immediately
    // after — the tightest window available on the shared bla_test.
    const fresh = await homeSvc.getExecutiveHome(adminActor, "/admin");
    expect(fresh.today).toBe(baseline.today);
    expect(fresh.kpis.totalBookings).toBe(await prisma.order.count({}));
    expect(fresh.kpis.totalPackages).toBe(await prisma.package.count({}));
    const groups = await prisma.package.groupBy({
      by: ["operationalStatus"],
      _count: { _all: true },
    });
    const direct = homeSvc.bucketPackageStates(
      groups.map((g) => ({ status: g.operationalStatus, count: g._count._all })),
    );
    expect(fresh.kpis.buckets).toEqual(direct);
    expect(fresh.kpis.buckets.total).toBe(fresh.kpis.totalPackages);
  });

  it("planted orders and packages move the KPIs by at least the planted amounts", () => {
    // bla_test is shared by every suite running in parallel, and
    // several plant global fixtures (orders "today", packages,
    // incidents) on their own schedules — so before/after deltas on
    // GLOBAL aggregates can legitimately exceed this suite's own
    // plantings. Exact arithmetic is proven by the unit tests
    // (bucketPackageStates / dayDelta) and by the snapshot test
    // above (home output == direct prisma truth); this test proves
    // the planted fixtures are actually reflected in the read model.
    // One service booking + one prisma order; one service package
    // (BOOKED) + eight planted packages.
    expect(after.kpis.totalBookings - baseline.kpis.totalBookings).toBeGreaterThanOrEqual(2);
    expect(after.kpis.totalPackages! - baseline.kpis.totalPackages!).toBeGreaterThanOrEqual(9);
    expect(after.kpis.bookingsLast30Days - baseline.kpis.bookingsLast30Days).toBeGreaterThanOrEqual(2);
    const b = after.kpis.buckets;
    const a = baseline.kpis.buckets;
    expect(b.atWarehouses - a.atWarehouses).toBeGreaterThanOrEqual(1);
    expect(b.inTransit - a.inTransit).toBeGreaterThanOrEqual(1);
    expect(b.outForDelivery - a.outForDelivery).toBeGreaterThanOrEqual(1);
    expect(b.delivered - a.delivered).toBeGreaterThanOrEqual(1);
    // Planted BOOKED package + the service booking's BOOKED package.
    expect(b.awaitingPickup - a.awaitingPickup).toBeGreaterThanOrEqual(2);
    expect(b.assignedToRiders - a.assignedToRiders).toBeGreaterThanOrEqual(1);
    expect(b.cancelled - a.cancelled).toBeGreaterThanOrEqual(1);
    expect(b.total - a.total).toBeGreaterThanOrEqual(9);
    // Both planted orders were created today.
    expect(after.kpis.bookingsDelta).not.toBeNull();
    expect(
      after.kpis.bookingsDelta!.today - baseline.kpis.bookingsDelta!.today,
    ).toBeGreaterThanOrEqual(2);
    // The delta is wired to the real series (internal consistency).
    const todayRow = after.analytics.dailySeries.find((d) => d.date === after.today);
    expect(after.kpis.bookingsDelta!.today).toBe(todayRow?.bookings ?? 0);
  });
});

describe("Step 4 executive home — attention groups", () => {
  it("groups equal direct prisma open-incident counts", async () => {
    expect(after.attention.groups).not.toBeNull();
    const openIn = (categories: string[]) =>
      prisma.incident.count({
        where: {
          category: { in: categories },
          status: {
            in: [
              "REPORTED",
              "ACKNOWLEDGED",
              "ASSIGNED",
              "INVESTIGATING",
              "AWAITING_INFORMATION",
              "ESCALATED",
              "RESOLUTION_PROPOSED",
              "RESOLUTION_APPROVED",
            ],
          },
        },
      });
    expect(groupCount(after, "missing")).toBe(
      await openIn(["MISSING_PACKAGE", "TRANSFER_SHORTAGE"]),
    );
    expect(groupCount(after, "transferDiscrepancies")).toBe(
      await openIn([
        "TRANSFER_EXCESS",
        "HANDOVER_DISCREPANCY",
        "WRONG_PACKAGE_RECEIVED",
        "WRONG_WAREHOUSE",
      ]),
    );
    expect(groupCount(after, "delayed")).toBe(await openIn(["DELAYED_SHIPMENT"]));
    expect(groupCount(after, "damaged")).toBe(await openIn(["DAMAGED_PACKAGE"]));
    const codDirect =
      (await openIn(["COD_DISCREPANCY"])) +
      (await prisma.codRemittance.count({ where: { status: "DISCREPANCY" } }));
    expect(groupCount(after, "codMismatches")).toBe(codDirect);
    const labels = Object.fromEntries(
      after.attention.groups!.map((g) => [g.key, g.label]),
    );
    expect(labels).toEqual({
      missing: "Missing packages",
      transferDiscrepancies: "Transfer discrepancies",
      delayed: "Delayed deliveries",
      damaged: "Damaged packages",
      codMismatches: "COD mismatches",
    });
  });

  it("planted incidents and the overdue task move attention by at least the planted amounts", () => {
    // Same shared-database reasoning as the KPI delta test: exact
    // group counts are asserted against direct prisma truth in the
    // test above; here the plantings must be reflected.
    expect(groupCount(after, "missing") - groupCount(baseline, "missing")).toBeGreaterThanOrEqual(2);
    expect(
      groupCount(after, "transferDiscrepancies") -
        groupCount(baseline, "transferDiscrepancies"),
    ).toBeGreaterThanOrEqual(4);
    expect(groupCount(after, "delayed") - groupCount(baseline, "delayed")).toBeGreaterThanOrEqual(1);
    expect(groupCount(after, "damaged") - groupCount(baseline, "damaged")).toBeGreaterThanOrEqual(1);
    expect(
      groupCount(after, "codMismatches") - groupCount(baseline, "codMismatches"),
    ).toBeGreaterThanOrEqual(1);
    // Nine open planted incidents (the RESOLVED one never counts).
    expect(after.attention.openIncidents - baseline.attention.openIncidents).toBeGreaterThanOrEqual(9);
    expect(after.kpis.openExceptions - baseline.kpis.openExceptions).toBeGreaterThanOrEqual(9);
    expect(after.attention.overdueTasks - baseline.attention.overdueTasks).toBeGreaterThanOrEqual(1);
    expect(after.attention.allClear).toBe(false);
  });
});

describe("Step 4 executive home — activity and gates", () => {
  it("surfaces the real booking.create audit row with its bookings href", () => {
    const item = after.activity.find((a) => a.href === `/admin/bookings/${serviceBookingId}`);
    expect(item).toBeDefined();
    expect(item!.label).toBe("New booking created");
    expect(item!.actorName).toBe(ADMIN_NAME);
  });

  it("refuses a warehouse-scoped actor at the top-level gate", async () => {
    const waActor = await actorFor(waId);
    await expect(homeSvc.getExecutiveHome(waActor, "/warehouse")).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
  });
});
