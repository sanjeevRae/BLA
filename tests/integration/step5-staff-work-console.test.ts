import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

// `server-only` throws outside a React Server Component environment; the
// services under test are server-only code, so stub the marker module.
vi.mock("server-only", () => ({}));

// Point the app at bla_test BEFORE the service layer is imported (same
// pattern as step4-executive-home.test.ts). Refuse to run anywhere else.
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
const KTM_CODE = `S5KTM-${RUN}`;
const PKR_CODE = `S5PKR-${RUN}`;
/**
 * Finance vocabulary, matched on camelCase/snake word SEGMENTS so the
 * innocent key `warehouseCode` (segment "code") never trips it while a
 * real leak like `codAmountPaisa` (segments cod/amount/paisa) does.
 */
const FINANCE_SEGMENTS = new Set([
  "cod",
  "revenue",
  "payable",
  "amount",
  "paisa",
  "invoice",
  "price",
  "fee",
  "money",
  "charge",
  "charges",
  "balance",
]);

function keySegments(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .split(" ");
}

let prisma: PrismaClient;
let homeSvc: typeof import("@/server/services/home-dashboards");
let catalog: typeof import("@/lib/permissions/catalog");
let reportsDomain: typeof import("@/lib/reports/domain");

let adminId: string;
let staffKtmId: string;
let staffNoneId: string;
let whKtm: string;
let whPkr: string;
let orderId: string;
let shipmentId: string;

let consoleKtm: Awaited<ReturnType<typeof homeSvc.getStaffWorkConsole>>;
let workKtm: Awaited<ReturnType<typeof homeSvc.getStaffMyWork>>;
let consoleNone: Awaited<ReturnType<typeof homeSvc.getStaffWorkConsole>>;

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
      fullName: `S5 ${label} ${RUN}`,
      passwordHash: await hash("fixture-password", 10),
      status: "ACTIVE",
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role ${roleCode} not seeded in bla_test`);
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user.id;
}

async function makePackage(opts: {
  label: string;
  warehouseId: string;
  status: string;
}): Promise<string> {
  const pkg = await prisma.package.create({
    data: {
      trackingId: `BLA-S5-${opts.label}-${RUN}`,
      shipmentId,
      orderId,
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
  const event = await prisma.trackingEvent.create({
    data: {
      packageId: pkg.id,
      shipmentId,
      orderId,
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
      receivedById: staffKtmId,
    },
  });
  return pkg.id;
}

/** Recursively collect every object key in the model. */
function allKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      into.push(key);
      allKeys(nested, into);
    }
  }
  return into;
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  homeSvc = await import("@/server/services/home-dashboards");
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

  whKtm = (
    await prisma.warehouse.create({
      data: {
        code: KTM_CODE,
        name: `S5 Kathmandu ${RUN}`,
        type: "REGIONAL",
        district: "Kathmandu",
        city: "Kathmandu",
        province: "Bagmati",
        status: "ACTIVE",
      },
    })
  ).id;
  whPkr = (
    await prisma.warehouse.create({
      data: {
        code: PKR_CODE,
        name: `S5 Pokhara ${RUN}`,
        type: "REGIONAL",
        district: "Kaski",
        city: "Pokhara",
        province: "Gandaki",
        status: "ACTIVE",
      },
    })
  ).id;

  adminId = await makeUser("admin", "ADMIN");
  staffKtmId = await makeUser("staff-ktm", "WAREHOUSE_STAFF");
  staffNoneId = await makeUser("staff-none", "WAREHOUSE_STAFF");
  const staffRole = await prisma.role.findUnique({ where: { code: "WAREHOUSE_STAFF" } });
  // The scope fixture: staff-ktm is a member of KTM ONLY — never PKR.
  await prisma.warehouseMembership.create({
    data: { userId: staffKtmId, warehouseId: whKtm, roleId: staffRole!.id, isPrimary: true },
  });

  const service = await prisma.shippingService.create({
    data: { code: `S5SVC-${RUN}`, name: `S5 Service ${RUN}` },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-S5-${RUN}`,
      createdById: adminId,
      createdByRole: "ADMIN",
      senderName: "S5 Sender",
      senderPhone: "9779811111111",
      originWarehouseId: whKtm,
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  orderId = order.id;
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-S5-${RUN}`,
      orderId,
      originWarehouseId: whKtm,
      destinationWarehouseId: whPkr,
      routeKind: "INTER_WAREHOUSE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(0),
    },
  });
  shipmentId = shipment.id;

  // Queue inventory at KTM (staff-ktm's warehouse): awaiting inspection
  // = RECEIVED_AT_ORIGIN + INSPECTION_PENDING = 2, in inspection = 1,
  // dispatch prep = SORTED = 1. All four records are received TODAY.
  const qa1 = await makePackage({ label: "QA1", warehouseId: whKtm, status: "RECEIVED_AT_ORIGIN" });
  await makePackage({ label: "QA2", warehouseId: whKtm, status: "INSPECTION_PENDING" });
  await makePackage({ label: "QA3", warehouseId: whKtm, status: "PROCESSING" });
  await makePackage({ label: "QA4", warehouseId: whKtm, status: "SORTED" });
  // Queue inventory at PKR (NOT a member warehouse — must never leak).
  const qb1 = await makePackage({ label: "QB1", warehouseId: whPkr, status: "INSPECTION_PENDING" });
  await makePackage({ label: "QB2", warehouseId: whPkr, status: "PROCESSING" });

  // Movements: two at KTM (older RECEIVING, newer PUT_AWAY), one at PKR.
  const now = Date.now();
  await prisma.inventoryMovement.create({
    data: {
      packageId: qa1,
      type: "RECEIVING",
      toWarehouseId: whKtm,
      actorId: staffKtmId,
      createdAt: new Date(now - 30 * 60 * 1000),
    },
  });
  await prisma.inventoryMovement.create({
    data: {
      packageId: qa1,
      type: "PUT_AWAY",
      fromWarehouseId: whKtm,
      toWarehouseId: whKtm,
      actorId: staffKtmId,
      createdAt: new Date(now - 5 * 60 * 1000),
    },
  });
  await prisma.inventoryMovement.create({
    data: {
      packageId: qb1,
      type: "RECEIVING",
      toWarehouseId: whPkr,
      actorId: staffKtmId,
      createdAt: new Date(now - 1 * 60 * 1000),
    },
  });

  // Transfers: one arriving at KTM (counts), one arriving at PKR (not).
  const mkTransfer = (label: string, origin: string, dest: string, status: string) =>
    prisma.transfer.create({
      data: {
        transferNumber: `TRF-S5-${label}-${RUN}`,
        originWarehouseId: origin,
        destinationWarehouseId: dest,
        status,
        createdById: adminId,
      },
    });
  await mkTransfer("IN-KTM", whPkr, whKtm, "ARRIVED");
  await mkTransfer("IN-PKR", whKtm, whPkr, "ARRIVED");

  // Tasks for staff-ktm, planted in dueAt order (overdue → soon →
  // later): the task service's mine order is dueAt asc, so the
  // console must surface exactly this sequence, un-resorted.
  const mkTask = (title: string, assigneeId: string, dueAt: Date, priority = "NORMAL") =>
    prisma.task.create({
      data: {
        title,
        createdById: adminId,
        assigneeId,
        warehouseId: whKtm,
        status: "ASSIGNED",
        priority,
        dueAt,
      },
    });
  await mkTask(`S5 overdue task ${RUN}`, staffKtmId, new Date(now - 2 * 60 * 60 * 1000), "HIGH");
  await mkTask(`S5 soon task ${RUN}`, staffKtmId, new Date(now + 2 * 60 * 60 * 1000));
  await mkTask(`S5 later task ${RUN}`, staffKtmId, new Date(now + 48 * 60 * 60 * 1000));
  // Another user's task — never staff-ktm's.
  await mkTask(`S5 other task ${RUN}`, adminId, new Date(now + 1 * 60 * 60 * 1000));
  // A task for the no-warehouse staff member (tasks show regardless).
  await mkTask(`S5 none task ${RUN}`, staffNoneId, new Date(now + 3 * 60 * 60 * 1000));

  const staffKtmActor = await actorFor(staffKtmId);
  workKtm = await homeSvc.getStaffMyWork(staffKtmActor);
  consoleKtm = await homeSvc.getStaffWorkConsole(staffKtmActor);
  consoleNone = await homeSvc.getStaffWorkConsole(await actorFor(staffNoneId));
}, 120_000);

afterAll(async () => {
  // bla_test fixtures are append-only history (suite pattern); cleanup
  // is disconnect only — every fixture above is RUN-suffixed.
  await prisma.$disconnect();
});

describe("Step 5 staff work console — read-model shape (no finance)", () => {
  it("contains no finance keys anywhere in the composed model", () => {
    const keys = allKeys(consoleKtm);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      const leaked = keySegments(key).filter((s) => FINANCE_SEGMENTS.has(s));
      expect(leaked, `finance key leaked: ${key}`).toEqual([]);
    }
    // Serialised scan as a second net: no finance field names or
    // currency vocabulary anywhere in the model (keys + values).
    const serialised = JSON.stringify(consoleKtm);
    expect(serialised).not.toMatch(
      /paisa|revenue|payable|codAmount|codCollected|codRemittance/i,
    );
    expect(serialised).not.toContain("NPR");
  });

  it("carries exactly the console fields (tasks are field-mapped, not raw TaskViews)", () => {
    expect(Object.keys(consoleKtm).sort()).toEqual(
      [
        "hasWarehouse",
        "warehouses",
        "myTasks",
        "myTasksTotal",
        "myOverdueTasks",
        "perWarehouse",
        "totals",
        "receivedToday",
        "recentActivity",
      ].sort(),
    );
    for (const task of consoleKtm.myTasks) {
      expect(Object.keys(task).sort()).toEqual(
        ["dueAt", "id", "overdue", "priority", "status", "title"].sort(),
      );
    }
  });
});

describe("Step 5 staff work console — task queue order and overdue", () => {
  it("preserves the task service's order verbatim (no re-sort)", () => {
    expect(consoleKtm.myTasks.map((t) => t.id)).toEqual(
      workKtm.myTasks.map((t) => t.id),
    );
    expect(consoleKtm.myTasks.map((t) => t.title)).toEqual([
      `S5 overdue task ${RUN}`,
      `S5 soon task ${RUN}`,
      `S5 later task ${RUN}`,
    ]);
    expect(consoleKtm.myTasksTotal).toBe(3);
  });

  it("flags the overdue task and counts it", () => {
    expect(consoleKtm.myOverdueTasks).toBe(1);
    expect(consoleKtm.myTasks[0].overdue).toBe(true);
    expect(consoleKtm.myTasks[1].overdue).toBe(false);
    expect(consoleKtm.myTasks[2].overdue).toBe(false);
  });
});

describe("Step 5 staff work console — warehouse scope (KTM only, no PKR)", () => {
  it("queues cover only the member warehouse", () => {
    expect(consoleKtm.hasWarehouse).toBe(true);
    expect(consoleKtm.warehouses.map((w) => w.id)).toEqual([whKtm]);
    expect(consoleKtm.perWarehouse).toHaveLength(1);
    expect(consoleKtm.perWarehouse[0].warehouseCode).toBe(KTM_CODE);
    expect(consoleKtm.totals).toEqual({
      awaitingInspection: 2,
      inInspection: 1,
      dispatchPrep: 1,
      arrivalsInbound: 1,
      openPackages: 4,
      damagedPackages: 0,
      pendingHandovers: 0,
    });
    const serialised = JSON.stringify(consoleKtm);
    expect(serialised).not.toContain(PKR_CODE);
    expect(serialised).not.toContain(`BLA-S5-QB1-${RUN}`);
    expect(serialised).not.toContain(`BLA-S5-QB2-${RUN}`);
  });

  it("receivedToday equals the direct KTM inventory count for today", async () => {
    const today = reportsDomain.kathmanduToday();
    const range = reportsDomain.resolveReportRange(today, today);
    const direct = await prisma.inventoryRecord.count({
      where: {
        warehouseId: whKtm,
        receivedAt: { gte: range.fromUtc, lt: range.toUtc },
      },
    });
    expect(direct).toBe(4);
    expect(consoleKtm.receivedToday).toBe(direct);
  });

  it("recent activity is the KTM movement feed only, newest first", () => {
    expect(consoleKtm.recentActivity.map((a) => a.type)).toEqual([
      "PUT_AWAY",
      "RECEIVING",
    ]);
    for (const item of consoleKtm.recentActivity) {
      expect(item.warehouseCode).toBe(KTM_CODE);
      expect(item.trackingId).toBe(`BLA-S5-QA1-${RUN}`);
    }
  });
});

describe("Step 5 staff work console — no-warehouse staff", () => {
  it("keeps tasks, empties queues, and nulls the today figure", () => {
    expect(consoleNone.hasWarehouse).toBe(false);
    expect(consoleNone.warehouses).toEqual([]);
    expect(consoleNone.perWarehouse).toEqual([]);
    expect(consoleNone.myTasksTotal).toBe(1);
    expect(consoleNone.myTasks[0].title).toBe(`S5 none task ${RUN}`);
    expect(consoleNone.receivedToday).toBeNull();
    expect(consoleNone.recentActivity).toEqual([]);
  });
});
