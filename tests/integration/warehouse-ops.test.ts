import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 4 integration tests (docs: implementation-roadmap Phase 4,
 * warehouse-workflow, inventory-and-custody, package-lifecycle §8)
 * against the local bla_test database: receiving (idempotent scans,
 * misroute observation, capacity gate), the one-open-record /
 * one-open-custody database invariants, inspection + damage
 * quarantine, sorting/storage movement chains, custody handovers
 * (happy path + disputed short count), warehouse deactivation
 * blockers, and the supplies ledger.
 *
 * Fixture warehouses are SHARED across runs (WH-ZP4 codes, find-or-
 * create) like the Phase 3 suite; users/vendors/bookings are per-run
 * unique so repeated runs never collide.
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
const RUN_NUM = String(Math.floor(Math.random() * 90000) + 10000);
const email = (label: string) => `p4-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let inventorySvc: typeof import("@/server/services/inventory");
let custodySvc: typeof import("@/server/services/custody");
let suppliesSvc: typeof import("@/server/services/supplies");
let warehousesSvc: typeof import("@/server/services/warehouses");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let staffA1Actor: Awaited<ReturnType<typeof actorFor>>;
let staffA2Actor: Awaited<ReturnType<typeof actorFor>>;
let staffBActor: Awaited<ReturnType<typeof actorFor>>;
let waTinyActor: Awaited<ReturnType<typeof actorFor>>;
let serviceCode: string;

/** Mirror of getActorContext (permissions.ts) incl. Phase 3 links. */
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
  const [vendorLink, customerProfile] = await Promise.all([
    prisma.vendorUser.findFirst({
      where: { userId: user.id, isActive: true, vendor: { isActive: true } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.customer.findUnique({ where: { userId: user.id } }),
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
    driverId: null,
    customerId: customerProfile?.id ?? null,
    landingPath: catalog.landingPathForRoles(roles as never[]),
  };
}

async function makeUser(label: string, roleCode: string): Promise<string> {
  const { hash } = await import("bcryptjs");
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `P4 ${label}`,
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

const ZONE_DEFS = [
  { code: "ZONE-REC", name: "Receiving", kind: "RECEIVING" },
  { code: "ZONE-INS", name: "Inspection", kind: "INSPECTION" },
  { code: "ZONE-STO", name: "Storage", kind: "STORAGE" },
  { code: "ZONE-DSP", name: "Dispatch", kind: "DISPATCH" },
  { code: "ZONE-DMG", name: "Damaged / Quarantine", kind: "DAMAGED" },
] as const;

/** Shared fixture warehouse with the five standard zones and one
 *  location per zone (two for storage), find-or-create throughout. */
async function ensureWarehouse(
  code: string,
  name: string,
  district: string,
): Promise<{ id: string; locations: Record<string, string> }> {
  const existing = await prisma.warehouse.findUnique({ where: { code } });
  const warehouse =
    existing ??
    (await prisma.warehouse.create({
      data: {
        code,
        name,
        type: "REGIONAL",
        status: "ACTIVE",
        district,
        city: name,
        province: "Bagmati",
        country: "Nepal",
      },
    }));
  if (warehouse.status !== "ACTIVE") {
    await prisma.warehouse.update({ where: { id: warehouse.id }, data: { status: "ACTIVE" } });
  }
  await prisma.serviceArea.upsert({
    where: { district_name: { district, name: `${name} Area (shared)` } },
    update: { servingWarehouseId: warehouse.id, isActive: true },
    create: {
      name: `${name} Area (shared)`,
      district,
      city: name,
      province: "Bagmati",
      servingWarehouseId: warehouse.id,
    },
  });
  const locations: Record<string, string> = {};
  for (const def of ZONE_DEFS) {
    const zone = await prisma.warehouseZone.upsert({
      where: { warehouseId_code: { warehouseId: warehouse.id, code: def.code } },
      update: { isActive: true },
      create: { warehouseId: warehouse.id, code: def.code, name: def.name, kind: def.kind },
    });
    const racks = def.kind === "STORAGE" ? ["R1", "R2"] : ["R1"];
    for (const rack of racks) {
      const fullCode = `${code}/${def.code}/${rack}`;
      const location =
        (await prisma.storageLocation.findUnique({ where: { fullCode } })) ??
        (await prisma.storageLocation.create({
          data: { zoneId: zone.id, rack, fullCode },
        }));
      if (rack === "R1") locations[def.kind] = location.id;
      if (def.kind === "STORAGE" && rack === "R2") locations.STORAGE2 = location.id;
    }
  }
  return { id: warehouse.id, locations };
}

/** Book one parcel (admin-created, auto-approved) and return it. */
async function bookOne(
  originWarehouseId: string,
  destDistrict: string,
): Promise<{ packageId: string; trackingId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId: fx.vendor,
    sender: { name: "P4 Sender", phone: phone(42), email: null },
    recipient: {
      name: "P4 Recipient",
      phone: phone(101),
      addressLine: "Some Street 1",
      city: "Town",
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
  bookingsSvc = await import("@/server/services/bookings");
  vendorsSvc = await import("@/server/services/vendors");
  inventorySvc = await import("@/server/services/inventory");
  custodySvc = await import("@/server/services/custody");
  suppliesSvc = await import("@/server/services/supplies");
  warehousesSvc = await import("@/server/services/warehouses");
  errors = await import("@/lib/errors");
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

  fx.adminUser = await makeUser("admin", "ADMIN");
  adminActor = await actorFor(fx.adminUser);

  fx.districtA = "P4Alpha District";
  fx.districtB = "P4Beta District";
  fx.districtTiny = "P4Tiny District";
  const a = await ensureWarehouse("WH-ZP4-01", "P4 Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locRecA = a.locations.RECEIVING;
  fx.locInsA = a.locations.INSPECTION;
  fx.locStoA = a.locations.STORAGE;
  fx.locStoA2 = a.locations.STORAGE2;
  fx.locDmgA = a.locations.DAMAGED;
  const b = await ensureWarehouse("WH-ZP4-02", "P4 Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;
  const tiny = await ensureWarehouse("WH-ZP4-03", "P4 Tiny (shared fixture)", fx.districtTiny);
  fx.whTiny = tiny.id;
  // Tiny's capacity is set relative to whatever earlier runs left in
  // stock, so the hard-limit assertions are deterministic every run.
  const tinyOccupancy = await prisma.inventoryRecord.count({
    where: { warehouseId: fx.whTiny, releasedAt: null },
  });
  await prisma.warehouse.update({
    where: { id: fx.whTiny },
    data: { capacityPackages: tinyOccupancy + 1 },
  });

  // Shipping service + catch-all tariff for this run.
  serviceCode = `P4STD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P4 Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
  });
  await prisma.pricingRule.create({
    data: {
      shippingServiceId: service.id,
      baseRatePaisa: BigInt(15000),
      perKgRatePaisa: BigInt(5000),
      volumetricDivisor: 5000,
      createdById: fx.adminUser,
    },
  });

  // One approved vendor for all bookings.
  const vendor = await vendorsSvc.createVendor(adminActor, {
    businessName: `P4 Vendor ${RUN}`,
    contactName: "P4 Contact",
    email: email("vendor"),
    phone: phone(11),
    billingPreference: "COD_OFFSET",
    creditLimitPaisa: null,
    registrationNumber: null,
  });
  await vendorsSvc.setVendorVerificationStatus(adminActor, vendor.id, {
    target: "UNDER_REVIEW",
    notes: null,
  });
  await vendorsSvc.setVendorVerificationStatus(adminActor, vendor.id, {
    target: "APPROVED",
    notes: null,
  });
  fx.vendor = vendor.id;

  // Warehouse people.
  fx.waA = await makeUser("waA", "WAREHOUSE_ADMIN");
  await addMembership(fx.waA, fx.whA, "WAREHOUSE_ADMIN");
  fx.staffA1 = await makeUser("staffA1", "WAREHOUSE_STAFF");
  await addMembership(fx.staffA1, fx.whA, "WAREHOUSE_STAFF");
  fx.staffA2 = await makeUser("staffA2", "WAREHOUSE_STAFF");
  await addMembership(fx.staffA2, fx.whA, "WAREHOUSE_STAFF");
  fx.waB = await makeUser("waB", "WAREHOUSE_ADMIN");
  await addMembership(fx.waB, fx.whB, "WAREHOUSE_ADMIN");
  fx.staffB = await makeUser("staffB", "WAREHOUSE_STAFF");
  await addMembership(fx.staffB, fx.whB, "WAREHOUSE_STAFF");
  fx.waTiny = await makeUser("waTiny", "WAREHOUSE_ADMIN");
  await addMembership(fx.waTiny, fx.whTiny, "WAREHOUSE_ADMIN");

  waAActor = await actorFor(fx.waA);
  staffA1Actor = await actorFor(fx.staffA1);
  staffA2Actor = await actorFor(fx.staffA2);
  staffBActor = await actorFor(fx.staffB);
  waTinyActor = await actorFor(fx.waTiny);
}, 180_000);

// ---------------------------------------------------------------------------

describe("receiving", () => {
  it("receives a booked package: transition + inventory + custody + movement commit together", async () => {
    const { packageId, trackingId } = await bookOne(fx.whA, fx.districtB);
    const result = await inventorySvc.receivePackage(staffA1Actor, {
      warehouseId: fx.whA,
      trackingId,
      idempotencyKey: `p4-recv-${RUN}-1`,
      source: "SCANNER",
    });
    expect(result.alreadyReceived).toBe(false);
    expect(result.misrouted).toBe(false);
    expect(result.package.operationalStatus).toBe("RECEIVED_AT_ORIGIN");

    const record = await prisma.inventoryRecord.findFirst({
      where: { packageId, releasedAt: null },
    });
    expect(record?.warehouseId).toBe(fx.whA);
    expect(record?.storageLocationId).toBe(fx.locRecA);
    expect(record?.id).toBe(result.inventoryRecordId);

    const custody = await prisma.packageCustody.findFirst({
      where: { packageId, endedAt: null },
    });
    expect(custody?.custodianType).toBe("WAREHOUSE");
    expect(custody?.warehouseId).toBe(fx.whA);

    const movements = await prisma.inventoryMovement.findMany({ where: { packageId } });
    expect(movements.map((m) => m.type)).toEqual(["RECEIVING"]);

    const event = await prisma.trackingEvent.findUnique({
      where: { idempotencyKey: `p4-recv-${RUN}-1` },
    });
    expect(event?.eventType).toBe("RECEIVED_AT_ORIGIN");
    expect(event?.source).toBe("SCANNER");
    expect(record?.receivingEventId).toBe(event?.id);
  });

  it("duplicate scan with the same key returns the existing result and writes nothing new", async () => {
    const { packageId, trackingId } = await bookOne(fx.whA, fx.districtB);
    const key = `p4-recv-${RUN}-dup`;
    const first = await inventorySvc.receivePackage(staffA1Actor, {
      warehouseId: fx.whA,
      trackingId,
      idempotencyKey: key,
    });
    const eventsBefore = await prisma.trackingEvent.count({ where: { packageId } });

    const second = await inventorySvc.receivePackage(staffA2Actor, {
      warehouseId: fx.whA,
      trackingId,
      idempotencyKey: key,
    });
    expect(second.alreadyReceived).toBe(true);
    expect(second.inventoryRecordId).toBe(first.inventoryRecordId);
    expect(await prisma.inventoryRecord.count({ where: { packageId } })).toBe(1);
    expect(await prisma.trackingEvent.count({ where: { packageId } })).toBe(eventsBefore);
  });

  it("duplicate scan with a NEW key still returns the existing record (open-record guard)", async () => {
    const { packageId, trackingId } = await bookOne(fx.whA, fx.districtB);
    await inventorySvc.receivePackage(staffA1Actor, {
      warehouseId: fx.whA,
      trackingId,
      idempotencyKey: `p4-recv-${RUN}-nk1`,
    });
    const again = await inventorySvc.receivePackage(staffA1Actor, {
      warehouseId: fx.whA,
      trackingId,
      idempotencyKey: `p4-recv-${RUN}-nk2`,
    });
    expect(again.alreadyReceived).toBe(true);
    expect(await prisma.inventoryRecord.count({ where: { packageId } })).toBe(1);
    const receiveEvents = await prisma.trackingEvent.count({
      where: { packageId, eventType: "RECEIVED_AT_ORIGIN" },
    });
    expect(receiveEvents).toBe(1);
  });

  it("rejects reusing one scan key for a different package", async () => {
    const one = await bookOne(fx.whA, fx.districtB);
    const two = await bookOne(fx.whA, fx.districtB);
    const key = `p4-recv-${RUN}-shared`;
    await inventorySvc.receivePackage(staffA1Actor, {
      warehouseId: fx.whA,
      trackingId: one.trackingId,
      idempotencyKey: key,
    });
    await expect(
      inventorySvc.receivePackage(staffA1Actor, {
        warehouseId: fx.whA,
        trackingId: two.trackingId,
        idempotencyKey: key,
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  });

  it("rejects an unknown tracking ID and audits the scan", async () => {
    await expect(
      inventorySvc.receivePackage(staffA1Actor, {
        warehouseId: fx.whA,
        trackingId: `BLA-000000000-${RUN.slice(-2)}`,
      }),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    const audit = await prisma.auditLog.findFirst({
      where: { actorId: fx.staffA1, action: "package.scan_unknown", warehouseId: fx.whA },
    });
    expect(audit).not.toBeNull();
  });

  it("denies cross-warehouse receiving (staff of B at warehouse A) and audits access.denied", async () => {
    const { trackingId } = await bookOne(fx.whA, fx.districtB);
    await expect(
      inventorySvc.receivePackage(staffBActor, { warehouseId: fx.whA, trackingId }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const audit = await prisma.auditLog.findFirst({
      where: { actorId: fx.staffB, action: "access.denied", warehouseId: fx.whA },
    });
    expect(audit).not.toBeNull();
  });

  it("denies receiving a package already stocked at another warehouse, with audit", async () => {
    const { packageId, trackingId } = await bookOne(fx.whA, fx.districtB);
    await inventorySvc.receivePackage(staffA1Actor, { warehouseId: fx.whA, trackingId });
    await expect(
      inventorySvc.receivePackage(staffBActor, { warehouseId: fx.whB, trackingId }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    const audit = await prisma.auditLog.findFirst({
      where: {
        actorId: fx.staffB,
        action: "access.denied",
        entityId: packageId,
        warehouseId: fx.whB,
      },
    });
    expect(audit).not.toBeNull();
  });

  it("records a misrouted arrival as an exception — never silently stocked", async () => {
    const { packageId, trackingId } = await bookOne(fx.whA, fx.districtB);
    const result = await inventorySvc.receivePackage(staffBActor, {
      warehouseId: fx.whB,
      trackingId,
    });
    expect(result.misrouted).toBe(true);
    expect(result.inventoryRecordId).toBeNull();
    expect(await prisma.inventoryRecord.count({ where: { packageId } })).toBe(0);
    expect(await prisma.packageCustody.count({ where: { packageId } })).toBe(0);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.exceptionStatus).toBe("MISROUTED");
    expect(pkg.operationalStatus).toBe("BOOKED");
    const event = await prisma.trackingEvent.findFirst({
      where: { packageId, eventType: "EXCEPTION_RAISED", warehouseId: fx.whB },
    });
    expect(event).not.toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { actorId: fx.staffB, action: "package.misrouted_arrival", entityId: packageId },
    });
    expect(audit).not.toBeNull();

    // The parcel can still be received properly at its origin.
    const proper = await inventorySvc.receivePackage(staffA1Actor, {
      warehouseId: fx.whA,
      trackingId,
    });
    expect(proper.alreadyReceived).toBe(false);
    expect(proper.package.operationalStatus).toBe("RECEIVED_AT_ORIGIN");
  });
});

describe("database invariants", () => {
  it("a package can never hold two open inventory records (partial unique index)", async () => {
    const { packageId, trackingId } = await bookOne(fx.whA, fx.districtB);
    const result = await inventorySvc.receivePackage(staffA1Actor, {
      warehouseId: fx.whA,
      trackingId,
    });
    const record = await prisma.inventoryRecord.findUniqueOrThrow({
      where: { id: result.inventoryRecordId! },
    });
    await expect(
      prisma.inventoryRecord.create({
        data: {
          packageId,
          warehouseId: fx.whA,
          receivingEventId: record.receivingEventId,
          receivedById: fx.staffA1,
        },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.inventoryRecord.count({ where: { packageId, releasedAt: null } }),
    ).toBe(1);
  });

  it("a package can never hold two open custodies (partial unique index)", async () => {
    const { packageId, trackingId } = await bookOne(fx.whA, fx.districtB);
    await inventorySvc.receivePackage(staffA1Actor, { warehouseId: fx.whA, trackingId });
    await expect(
      prisma.packageCustody.create({
        data: { packageId, custodianType: "WAREHOUSE", warehouseId: fx.whA },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.packageCustody.count({ where: { packageId, endedAt: null } }),
    ).toBe(1);
  });

  it("the custody shape CHECK rejects custodian fields that do not match the type", async () => {
    const { packageId, trackingId } = await bookOne(fx.whA, fx.districtB);
    await inventorySvc.receivePackage(staffA1Actor, { warehouseId: fx.whA, trackingId });
    // USER custody must name a user and must NOT name a warehouse.
    await expect(
      prisma.packageCustody.create({
        data: {
          packageId,
          custodianType: "USER",
          warehouseId: fx.whA,
          endedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe("inspection, sorting and storage", () => {
  it("runs the full chain receive → inspection → put-away → move → ready, with the movement chain to prove it", async () => {
    const { packageId, trackingId } = await bookOne(fx.whA, fx.districtB);
    await inventorySvc.receivePackage(staffA1Actor, { warehouseId: fx.whA, trackingId });

    const toInspection = await inventorySvc.moveToInspection(staffA1Actor, packageId);
    expect(toInspection.operationalStatus).toBe("INSPECTION_PENDING");
    let record = await prisma.inventoryRecord.findFirst({
      where: { packageId, releasedAt: null },
    });
    expect(record?.storageLocationId).toBe(fx.locInsA);

    const started = await inventorySvc.startInspection(staffA1Actor, packageId);
    expect(started.operationalStatus).toBe("PROCESSING");

    const inspected = await inventorySvc.recordInspection(staffA1Actor, {
      packageId,
      condition: "GOOD",
      actualWeightKg: 2.5,
      lengthCm: 30,
      widthCm: 20,
      heightCm: 10,
    });
    expect(inspected.condition).toBe("GOOD");
    const pkgRow = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(Number(pkgRow.actualWeightKg)).toBe(2.5);
    // Volumetric = 30×20×10 / 5000 = 1.2 kg; billable = max(2.5, 1.2).
    expect(Number(pkgRow.volumetricWeightKg)).toBeCloseTo(1.2, 3);
    expect(Number(pkgRow.billableWeightKg)).toBe(2.5);
    expect(pkgRow.weightMeasuredById).toBe(fx.staffA1);
    expect(pkgRow.weightMeasuredAt).not.toBeNull();

    const putAway = await inventorySvc.putAwayPackage(staffA1Actor, packageId, fx.locStoA);
    expect(putAway.package.operationalStatus).toBe("SORTED");
    expect(putAway.movementType).toBe("PUT_AWAY");
    record = await prisma.inventoryRecord.findFirst({
      where: { packageId, releasedAt: null },
    });
    expect(record?.storageLocationId).toBe(fx.locStoA);

    const moved = await inventorySvc.moveInternal(staffA1Actor, {
      packageId,
      toLocationId: fx.locStoA2,
      reason: "Re-slotting",
    });
    expect(moved.type).toBe("INTERNAL_MOVE");
    expect(moved.fromLocationCode).toContain("ZONE-STO/R1");
    expect(moved.toLocationCode).toContain("ZONE-STO/R2");

    const ready = await inventorySvc.markReadyForDispatch(staffA1Actor, packageId);
    expect(ready.operationalStatus).toBe("READY_FOR_DISPATCH");

    const movements = await prisma.inventoryMovement.findMany({
      where: { packageId },
      orderBy: { createdAt: "asc" },
    });
    expect(movements.map((m) => m.type)).toEqual([
      "RECEIVING",
      "INTERNAL_MOVE",
      "PUT_AWAY",
      "INTERNAL_MOVE",
    ]);
  });

  it("damage at inspection sets condition + exception and quarantines the parcel until cleared", async () => {
    const { packageId, trackingId } = await bookOne(fx.whA, fx.districtB);
    await inventorySvc.receivePackage(staffA1Actor, { warehouseId: fx.whA, trackingId });
    await inventorySvc.moveToInspection(staffA1Actor, packageId);
    await inventorySvc.startInspection(staffA1Actor, packageId);

    const damaged = await inventorySvc.recordInspection(staffA1Actor, {
      packageId,
      condition: "DAMAGED",
      notes: "Corner crushed, contents exposed",
    });
    expect(damaged.condition).toBe("DAMAGED");
    expect(damaged.exceptionStatus).toBe("DAMAGED");
    const record = await prisma.inventoryRecord.findFirst({
      where: { packageId, releasedAt: null },
    });
    expect(record?.storageLocationId).toBe(fx.locDmgA);
    const quarantine = await prisma.inventoryMovement.findFirst({
      where: { packageId, type: "DAMAGE_QUARANTINE" },
    });
    expect(quarantine?.toLocationId).toBe(fx.locDmgA);

    // A damaged parcel cannot be sorted into storage…
    await expect(
      inventorySvc.putAwayPackage(staffA1Actor, packageId, fx.locStoA),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    // …nor moved out of quarantine while the exception stands.
    await expect(
      inventorySvc.moveInternal(staffA1Actor, {
        packageId,
        toLocationId: fx.locStoA,
        reason: "Trying to skip quarantine",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);

    // Re-inspection as GOOD clears the exception and frees the parcel.
    const cleared = await inventorySvc.recordInspection(staffA1Actor, {
      packageId,
      condition: "GOOD",
      notes: "Repacked; contents intact",
    });
    expect(cleared.condition).toBe("GOOD");
    expect(cleared.exceptionStatus).toBe("NONE");
    const putAway = await inventorySvc.putAwayPackage(staffA1Actor, packageId, fx.locStoA);
    expect(putAway.package.operationalStatus).toBe("SORTED");
  });

  it("denies inspection of a package stocked at another warehouse (P3-7b scope)", async () => {
    const { packageId, trackingId } = await bookOne(fx.whA, fx.districtB);
    await inventorySvc.receivePackage(staffA1Actor, { warehouseId: fx.whA, trackingId });
    await expect(
      inventorySvc.moveToInspection(staffBActor, packageId),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const audit = await prisma.auditLog.findFirst({
      where: { actorId: fx.staffB, action: "access.denied", entityId: packageId },
    });
    expect(audit).not.toBeNull();
  });
});

describe("custody handovers", () => {
  async function receivedPair(): Promise<[string, string]> {
    const one = await bookOne(fx.whA, fx.districtB);
    const two = await bookOne(fx.whA, fx.districtB);
    await inventorySvc.receivePackage(staffA1Actor, {
      warehouseId: fx.whA,
      trackingId: one.trackingId,
    });
    await inventorySvc.receivePackage(staffA1Actor, {
      warehouseId: fx.whA,
      trackingId: two.trackingId,
    });
    return [one.packageId, two.packageId];
  }

  it("happy path: warehouse → staff A → staff B, custody rows closing and opening per confirm", async () => {
    const [p1, p2] = await receivedPair();
    const batch = await custodySvc.initiateHandover(waAActor, {
      packageIds: [p1, p2],
      toCustodianType: "USER",
      toUserId: fx.staffA1,
    });
    expect(batch.status).toBe("PENDING");
    expect(batch.expectedCount).toBe(2);

    // Custody does not move on initiation — only on confirmation.
    let open = await prisma.packageCustody.findFirst({
      where: { packageId: p1, endedAt: null },
    });
    expect(open?.custodianType).toBe("WAREHOUSE");

    const after1 = await custodySvc.confirmHandoverPackage(staffA1Actor, {
      batchId: batch.id,
      packageId: p1,
    });
    expect(after1.status).toBe("PARTIALLY_CONFIRMED");
    open = await prisma.packageCustody.findFirst({
      where: { packageId: p1, endedAt: null },
    });
    expect(open?.custodianType).toBe("USER");
    expect(open?.custodianUserId).toBe(fx.staffA1);
    expect(open?.handoverId).not.toBeNull();
    const closed = await prisma.packageCustody.findFirst({
      where: { packageId: p1, custodianType: "WAREHOUSE", endedAt: { not: null } },
    });
    expect(closed).not.toBeNull();

    const done = await custodySvc.confirmHandoverPackage(staffA1Actor, {
      batchId: batch.id,
      packageId: p2,
    });
    expect(done.status).toBe("CONFIRMED");
    expect(done.confirmedCount).toBe(2);
    expect(done.confirmedAt).not.toBeNull();
    const transfers = await prisma.trackingEvent.count({
      where: { packageId: p1, eventType: "CUSTODY_TRANSFERRED" },
    });
    expect(transfers).toBe(1);

    // Staff A hands one parcel on to staff B.
    const batch2 = await custodySvc.initiateHandover(staffA1Actor, {
      packageIds: [p1],
      toCustodianType: "USER",
      toUserId: fx.staffA2,
    });
    const done2 = await custodySvc.confirmHandoverPackage(staffA2Actor, {
      batchId: batch2.id,
      packageId: p1,
    });
    expect(done2.status).toBe("CONFIRMED");
    open = await prisma.packageCustody.findFirst({
      where: { packageId: p1, endedAt: null },
    });
    expect(open?.custodianUserId).toBe(fx.staffA2);
  });

  it("only the receiver can confirm a user-bound handover", async () => {
    const [p1] = await receivedPair();
    const batch = await custodySvc.initiateHandover(waAActor, {
      packageIds: [p1],
      toCustodianType: "USER",
      toUserId: fx.staffA1,
    });
    await expect(
      custodySvc.confirmHandoverPackage(staffA2Actor, {
        batchId: batch.id,
        packageId: p1,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const open = await prisma.packageCustody.findFirst({
      where: { packageId: p1, endedAt: null },
    });
    expect(open?.custodianType).toBe("WAREHOUSE");
  });

  it("a short count cannot be silently closed: batch goes DISPUTED, line MISSING, custody stays with the giver", async () => {
    const [p1, p2] = await receivedPair();
    const batch = await custodySvc.initiateHandover(waAActor, {
      packageIds: [p1, p2],
      toCustodianType: "USER",
      toUserId: fx.staffA1,
    });
    await custodySvc.confirmHandoverPackage(staffA1Actor, {
      batchId: batch.id,
      packageId: p1,
    });
    const closed = await custodySvc.closeHandoverBatch(waAActor, batch.id);
    expect(closed.status).toBe("DISPUTED");
    expect(closed.confirmedCount).toBe(1);
    const missingLine = closed.lines.find((l) => l.packageId === p2);
    expect(missingLine?.status).toBe("MISSING");

    // The missing parcel's custody never moved.
    const open = await prisma.packageCustody.findFirst({
      where: { packageId: p2, endedAt: null },
    });
    expect(open?.custodianType).toBe("WAREHOUSE");
    expect(open?.warehouseId).toBe(fx.whA);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "custody.handover_disputed", entityId: batch.id },
    });
    expect(audit).not.toBeNull();
    const event = await prisma.trackingEvent.findFirst({
      where: { packageId: p2, eventType: "EXCEPTION_RAISED" },
    });
    expect(event).not.toBeNull();

    // And a disputed batch accepts no late confirmations.
    await expect(
      custodySvc.confirmHandoverPackage(staffA1Actor, {
        batchId: batch.id,
        packageId: p2,
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  });
});

describe("capacity", () => {
  it("occupancy counts open inventory records only", async () => {
    const before = await inventorySvc.getWarehouseOpsSummary(staffBActor, fx.whB);
    const { packageId, trackingId } = await bookOne(fx.whB, fx.districtB);
    await inventorySvc.receivePackage(staffBActor, { warehouseId: fx.whB, trackingId });
    const during = await inventorySvc.getWarehouseOpsSummary(staffBActor, fx.whB);
    expect(during.openPackages).toBe(before.openPackages + 1);

    // Releasing the record (as a Phase 5/6 outflow will) frees capacity.
    await prisma.inventoryRecord.updateMany({
      where: { packageId, releasedAt: null },
      data: {
        releasedAt: new Date(),
        releasedById: fx.staffB,
        releaseReason: "TRANSFER",
      },
    });
    const after = await inventorySvc.getWarehouseOpsSummary(staffBActor, fx.whB);
    expect(after.openPackages).toBe(before.openPackages);
  });

  it("blocks receiving at the hard capacity limit; an unscoped override with a reason succeeds and is audited", async () => {
    const first = await bookOne(fx.whTiny, fx.districtTiny);
    const received = await inventorySvc.receivePackage(waTinyActor, {
      warehouseId: fx.whTiny,
      trackingId: first.trackingId,
    });
    expect(received.alreadyReceived).toBe(false);

    const second = await bookOne(fx.whTiny, fx.districtTiny);
    await expect(
      inventorySvc.receivePackage(waTinyActor, {
        warehouseId: fx.whTiny,
        trackingId: second.trackingId,
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);

    const overridden = await inventorySvc.receivePackage(adminActor, {
      warehouseId: fx.whTiny,
      trackingId: second.trackingId,
      capacityOverrideReason: "Overflow cage opened for the festival rush",
    });
    expect(overridden.capacityOverrideUsed).toBe(true);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "warehouse.capacity_override", entityId: fx.whTiny },
    });
    expect(audit).not.toBeNull();
  });
});

describe("supplies", () => {
  it("maintains the before/after ledger chain and rejects over-issue", async () => {
    const sku = `BOX-${RUN.slice(-6)}`.toUpperCase();
    const item = await suppliesSvc.createStockItem(staffA1Actor, {
      warehouseId: fx.whA,
      sku,
      name: "Cardboard box (medium)",
      unit: "PCS",
      reorderLevel: 80,
      initialQuantity: 100,
    });
    expect(item.quantityOnHand).toBe(100);
    expect(item.lowStock).toBe(false);

    const issued = await suppliesSvc.recordStockMovement(staffA1Actor, {
      stockItemId: item.id,
      type: "ISSUE",
      quantity: 30,
      reason: "Packing station",
    });
    expect(issued.item.quantityOnHand).toBe(70);
    expect(issued.movement.quantityBefore).toBe(100);
    expect(issued.movement.quantityAfter).toBe(70);
    expect(issued.movement.quantityDelta).toBe(-30);

    await expect(
      suppliesSvc.recordStockMovement(staffA1Actor, {
        stockItemId: item.id,
        type: "ISSUE",
        quantity: 71,
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    const afterFailed = await suppliesSvc.listStockItems(staffA1Actor, {
      warehouseId: fx.whA,
      search: sku,
    });
    expect(afterFailed.items[0].quantityOnHand).toBe(70);

    await suppliesSvc.recordStockMovement(staffA1Actor, {
      stockItemId: item.id,
      type: "ADJUSTMENT",
      quantity: -5,
      reason: "Damaged in storage",
    });
    const topped = await suppliesSvc.recordStockMovement(staffA1Actor, {
      stockItemId: item.id,
      type: "PURCHASE",
      quantity: 10,
    });
    expect(topped.item.quantityOnHand).toBe(75);
    expect(topped.item.lowStock).toBe(true); // 75 <= reorder level 80

    const ledger = await suppliesSvc.listStockMovements(staffA1Actor, item.id, {
      pageSize: 10,
    });
    const chronological = [...ledger.items].reverse();
    expect(chronological.map((m) => m.quantityDelta)).toEqual([100, -30, -5, 10]);
    for (let i = 1; i < chronological.length; i++) {
      expect(chronological[i].quantityBefore).toBe(chronological[i - 1].quantityAfter);
    }
  });

  it("rejects a duplicate SKU in the same warehouse", async () => {
    const sku = `TAPE-${RUN.slice(-6)}`.toUpperCase();
    await suppliesSvc.createStockItem(staffA1Actor, {
      warehouseId: fx.whA,
      sku,
      name: "Packing tape",
      unit: "ROLL",
    });
    await expect(
      suppliesSvc.createStockItem(staffA1Actor, {
        warehouseId: fx.whA,
        sku,
        name: "Packing tape (duplicate)",
        unit: "ROLL",
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  });

  it("denies supplies changes at a warehouse outside the actor's scope", async () => {
    await expect(
      suppliesSvc.createStockItem(staffBActor, {
        warehouseId: fx.whA,
        sku: `X-${RUN.slice(-6)}`.toUpperCase(),
        name: "Out of scope item",
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });
});

describe("warehouse deactivation blockers (Phase 2 review wiring)", () => {
  it("blocks deactivation while parcels are in stock, and allows it once released", async () => {
    const blockersA = await warehousesSvc.collectDeactivationBlockers(fx.whA);
    expect(blockersA.length).toBeGreaterThan(0);
    expect(blockersA.join(" ")).toContain("in stock");

    const { trackingId } = await bookOne(fx.whB, fx.districtB);
    await inventorySvc.receivePackage(staffBActor, { warehouseId: fx.whB, trackingId });
    await expect(
      warehousesSvc.setWarehouseStatus(adminActor, fx.whB, "INACTIVE"),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);

    // Release everything Beta holds (fixture-level outflow).
    await prisma.inventoryRecord.updateMany({
      where: { warehouseId: fx.whB, releasedAt: null },
      data: {
        releasedAt: new Date(),
        releasedById: fx.adminUser,
        releaseReason: "TRANSFER",
      },
    });
    await prisma.packageCustody.updateMany({
      where: { warehouseId: fx.whB, custodianType: "WAREHOUSE", endedAt: null },
      data: { endedAt: new Date() },
    });
    expect(await warehousesSvc.collectDeactivationBlockers(fx.whB)).toEqual([]);

    const deactivated = await warehousesSvc.setWarehouseStatus(adminActor, fx.whB, "INACTIVE");
    expect(deactivated.status).toBe("INACTIVE");
    const reactivated = await warehousesSvc.setWarehouseStatus(adminActor, fx.whB, "ACTIVE");
    expect(reactivated.status).toBe("ACTIVE");
  });
});
