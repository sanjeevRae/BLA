import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Step 6 (V3) — Rider field home read model against bla_test:
 *  - rider A's model contains exactly A's batches/jobs (tracking-ID
 *    set equality) and none of rider B's tracking IDs or recipient
 *    phones (serialised scan, both directions);
 *  - summary counts equal the planted truth, including `failed`
 *    summed from the batch counts;
 *  - COD expected/collected equal getRiderHomeToday's own outputs
 *    and awaiting/verified equal getRiderCodPosition's outputs for
 *    the same fixture (the services are called directly and
 *    compared — the model cannot drift from the COD pages);
 *  - a delivered-with-collection job carries codCollectedPaisa;
 *  - tasks: open tasks only (a CLOSED task is not open work).
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
const email = (label: string) => `s6r-${label}-${RUN}@bla.test`;
const TODAY = new Date().toISOString().slice(0, 10);

let prisma: import("@prisma/client").PrismaClient;
let homeSvc: typeof import("@/server/services/home-dashboards");
let deliveriesSvc: typeof import("@/server/services/deliveries");
let codSvc: typeof import("@/server/services/cod-remittances");
let catalog: typeof import("@/lib/permissions/catalog");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let riderAActor: Actor;
let riderBActor: Actor;

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
      fullName: `S6R ${label}`,
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
      licenseNumber: `LIC-S6R-${label}-${RUN}`,
      licenseExpiry: new Date("2028-01-01"),
    },
  });
  return driver.id;
}

async function makePackage(label: string, codPaisa: bigint, phone: string) {
  return prisma.package.create({
    data: {
      trackingId: `BLA-S6R-${label}-${RUN}`,
      shipmentId: fx.shipmentId,
      orderId: fx.orderId,
      recipientName: `Recipient ${label} ${RUN}`,
      recipientPhone: phone,
      deliveryAddress: `Address ${label}`,
      deliveryCity: "Kathmandu",
      deliveryDistrict: "Kathmandu",
      declaredWeightKg: "1.000",
      description: `Parcel ${label}`,
      codAmountPaisa: codPaisa,
      operationalStatus: "OUT_FOR_DELIVERY",
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
  deliveriesSvc = await import("@/server/services/deliveries");
  codSvc = await import("@/server/services/cod-remittances");
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
    data: { code: `S6A-${RUN}`, name: `S6R Alpha ${RUN}`, district: "Kathmandu", city: "Kathmandu", province: "Bagmati" },
  });
  const w2 = await prisma.warehouse.create({
    data: { code: `S6B-${RUN}`, name: `S6R Beta ${RUN}`, district: "Lalitpur", city: "Lalitpur", province: "Bagmati" },
  });
  fx.w1 = w1.id;
  fx.w2 = w2.id;
  fx.w1Code = w1.code;

  fx.adminUser = await makeUser("admin", "ADMIN");
  fx.riderAUser = await makeUser("ridera", "RIDER");
  fx.riderADriver = await makeDriver(fx.riderAUser, fx.w1, "RA");
  riderAActor = await actorFor(fx.riderAUser);
  const riderBUser = await makeUser("riderb", "RIDER");
  fx.riderBDriver = await makeDriver(riderBUser, fx.w2, "RB");
  riderBActor = await actorFor(riderBUser);

  const service = await prisma.shippingService.create({
    data: { code: `S6RSVC-${RUN}`, name: `S6R Service ${RUN}` },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-S6R-${RUN}`,
      createdById: fx.adminUser,
      createdByRole: "ADMIN",
      senderName: "S6R Sender",
      senderPhone: "9779811111111",
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  fx.orderId = order.id;
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-S6R-${RUN}`,
      orderId: order.id,
      originWarehouseId: fx.w1,
      destinationWarehouseId: fx.w1,
      routeKind: "LAST_MILE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(0),
    },
  });
  fx.shipmentId = shipment.id;

  // --- Rider A, batch today --------------------------------------
  // A1 COMPLETED cod 100000, collected 100000 (awaiting remittance)
  // A2 IN_PROGRESS cod 50000 (next stop), in A's custody
  // A3 PENDING cod 20000
  // A4 FAILED cod 0 (drives summary.failed via the batch counts)
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

  const pkgA1 = await makePackage("A1", BigInt(100000), "9779800000101");
  const pkgA2 = await makePackage("A2", BigInt(50000), "9779800000102");
  const pkgA3 = await makePackage("A3", BigInt(20000), "9779800000103");
  const pkgA4 = await makePackage("A4", BigInt(0), "9779800000104");
  fx.trackingA = [pkgA1.trackingId, pkgA2.trackingId, pkgA3.trackingId, pkgA4.trackingId].join(",");
  fx.trackingA1 = pkgA1.trackingId;
  fx.trackingA2 = pkgA2.trackingId;

  const asgA1 = await makeAssignment(pkgA1.id, fx.riderADriver, fx.batchA, "COMPLETED", 1);
  await makeAssignment(pkgA2.id, fx.riderADriver, fx.batchA, "IN_PROGRESS", 2);
  await makeAssignment(pkgA3.id, fx.riderADriver, fx.batchA, "PENDING", 3);
  await makeAssignment(pkgA4.id, fx.riderADriver, fx.batchA, "FAILED", 4);
  fx.asgA1 = asgA1.id;

  await prisma.deliveryCodCollection.create({
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

  await prisma.packageCustody.create({
    data: { packageId: pkgA2.id, custodianType: "USER", custodianUserId: fx.riderAUser },
  });

  // Tasks: one open (ASSIGNED), one CLOSED — only the open one counts.
  await prisma.task.create({
    data: {
      title: `S6R open task ${RUN}`,
      createdById: fx.adminUser,
      assigneeId: fx.riderAUser,
      status: "ASSIGNED",
      priority: "HIGH",
    },
  });
  await prisma.task.create({
    data: {
      title: `S6R closed task ${RUN}`,
      createdById: fx.adminUser,
      assigneeId: fx.riderAUser,
      status: "CLOSED",
      priority: "LOW",
    },
  });

  // --- Rider B: own batch, own phone ------------------------------
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
  const pkgB1 = await makePackage("B1", BigInt(70000), "9779800000199");
  await makeAssignment(pkgB1.id, fx.riderBDriver, batchB.id, "PENDING", 1);
  fx.trackingB1 = pkgB1.trackingId;
  fx.phoneB1 = "9779800000199";
}, 60_000);

describe("Step 6 — rider field home model", () => {
  it("contains exactly rider A's batches and jobs", async () => {
    const model = await homeSvc.getRiderFieldHome(riderAActor, TODAY);
    expect(model.date).toBe(TODAY);
    expect(model.riderName).toBe(riderAActor.fullName);
    expect(model.batches.map((b) => b.id)).toEqual([fx.batchA]);
    expect(model.batches[0].warehouseCode).toBe(fx.w1Code);
    const trackingIds = model.batches.flatMap((b) => b.jobs.map((j) => j.trackingId)).sort();
    expect(trackingIds).toEqual(fx.trackingA.split(",").sort());
    expect(model.currentBatchId).toBe(fx.batchA);
  });

  it("summary counts equal the planted truth", async () => {
    const model = await homeSvc.getRiderFieldHome(riderAActor, TODAY);
    expect(model.summary).toEqual({ assigned: 4, delivered: 1, remaining: 2, failed: 1 });
    expect(model.batches[0].counts).toEqual({
      total: 4,
      pending: 1,
      inProgress: 1,
      completed: 1,
      failed: 1,
      cancelled: 0,
      reassigned: 0,
    });
  });

  it("marks the next stop and carries the collection on the delivered job", async () => {
    const model = await homeSvc.getRiderFieldHome(riderAActor, TODAY);
    const jobs = model.batches[0].jobs;
    const next = jobs.filter((j) => j.isNext);
    expect(next).toHaveLength(1);
    expect(next[0].trackingId).toBe(fx.trackingA2);
    const delivered = jobs.find((j) => j.trackingId === fx.trackingA1);
    expect(delivered?.status).toBe("COMPLETED");
    expect(delivered?.codDuePaisa).toBe("100000");
    expect(delivered?.codCollectedPaisa).toBe("100000");
    expect(delivered?.codStatus).toBe("MATCHED");
  });

  it("COD figures equal the underlying services' outputs for the same fixture", async () => {
    const model = await homeSvc.getRiderFieldHome(riderAActor, TODAY);
    const home = await deliveriesSvc.getRiderHomeToday(riderAActor, TODAY);
    const position = await codSvc.getRiderCodPosition(riderAActor);
    expect(model.cod.expectedPaisa).toBe(home.codExpectedPaisa);
    expect(model.cod.collectedPaisa).toBe(home.codCollectedPaisa);
    expect(model.cod.expectedPaisa).toBe("150000");
    expect(model.cod.collectedPaisa).toBe("100000");
    expect(model.cod.remainingPaisa).toBe("50000");
    expect(model.cod.awaitingRemittancePaisa).toBe(position.awaitingRemittanceTotalPaisa);
    expect(model.cod.verifiedRemittedPaisa).toBe(position.verifiedRemittedPaisa);
    expect(model.cod.awaitingRemittancePaisa).toBe("100000");
    expect(model.cod.verifiedRemittedPaisa).toBe("0");
  });

  it("custody and open tasks are the rider's own", async () => {
    const model = await homeSvc.getRiderFieldHome(riderAActor, TODAY);
    expect(model.custody.map((c) => c.trackingId)).toEqual([fx.trackingA2]);
    expect(model.openTaskCount).toBe(1);
    expect(model.tasks).toHaveLength(1);
    expect(model.tasks[0].title).toContain("open task");
  });

  it("rider B's model contains none of rider A's tracking IDs or phones", async () => {
    const modelB = await homeSvc.getRiderFieldHome(riderBActor, TODAY);
    expect(modelB.batches.flatMap((b) => b.jobs.map((j) => j.trackingId))).toEqual([
      fx.trackingB1,
    ]);
    const serialisedB = JSON.stringify(modelB);
    for (const trackingId of fx.trackingA.split(",")) {
      expect(serialisedB).not.toContain(trackingId);
    }
    expect(serialisedB).not.toContain("9779800000101");

    const modelA = await homeSvc.getRiderFieldHome(riderAActor, TODAY);
    const serialisedA = JSON.stringify(modelA);
    expect(serialisedA).not.toContain(fx.trackingB1);
    expect(serialisedA).not.toContain(fx.phoneB1);
  });
});
