import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 4 security-review fix tests (P4-1/P4-2/P4-3) against the
 * local bla_test database:
 *  - P4-1: two lines of one handover batch confirmed CONCURRENTLY
 *    must still complete the batch with a count matching its lines
 *    (the batch row is locked + re-read inside the confirm
 *    transaction and completion is derived from line states).
 *  - P4-2: a handover out of a USER's custody can be initiated only
 *    by that custodian, a Warehouse Admin of the warehouse, or an
 *    unscoped actor — anyone else is denied + audited.
 *  - P4-3: a package with a PENDING line in an open batch cannot be
 *    promised into a second open batch.
 *
 * Fixture warehouses are SHARED across runs (WH-ZP4-04/05, find-or-
 * create, the WH-ZP4 pattern — distinct codes from the Phase 4
 * suite's WH-ZP4-01/02/03 so the suites never contend); users,
 * vendors and bookings are per-run unique.
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
const email = (label: string) => `p4fix-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let inventorySvc: typeof import("@/server/services/inventory");
let custodySvc: typeof import("@/server/services/custody");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let staffA1Actor: Awaited<ReturnType<typeof actorFor>>;
let staffA2Actor: Awaited<ReturnType<typeof actorFor>>;
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
      fullName: `P4Fix ${label}`,
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
 *  location per zone, find-or-create throughout. */
async function ensureWarehouse(
  code: string,
  name: string,
  district: string,
): Promise<{ id: string }> {
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
  for (const def of ZONE_DEFS) {
    const zone = await prisma.warehouseZone.upsert({
      where: { warehouseId_code: { warehouseId: warehouse.id, code: def.code } },
      update: { isActive: true },
      create: { warehouseId: warehouse.id, code: def.code, name: def.name, kind: def.kind },
    });
    const fullCode = `${code}/${def.code}/R1`;
    const location = await prisma.storageLocation.findUnique({ where: { fullCode } });
    if (!location) {
      await prisma.storageLocation.create({
        data: { zoneId: zone.id, rack: "R1", fullCode },
      });
    }
  }
  return { id: warehouse.id };
}

/** Book one parcel (admin-created, auto-approved) and return it. */
async function bookOne(
  originWarehouseId: string,
  destDistrict: string,
): Promise<{ packageId: string; trackingId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId: fx.vendor,
    sender: { name: "P4Fix Sender", phone: phone(42), email: null },
    recipient: {
      name: "P4Fix Recipient",
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

/** Book a parcel and receive it at warehouse A (WAREHOUSE custody). */
async function receivedOne(): Promise<{ packageId: string; trackingId: string }> {
  const booked = await bookOne(fx.whA, fx.districtB);
  await inventorySvc.receivePackage(staffA1Actor, {
    warehouseId: fx.whA,
    trackingId: booked.trackingId,
  });
  return booked;
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

  fx.districtA = "P4FixAlpha District";
  fx.districtB = "P4FixBeta District";
  const a = await ensureWarehouse("WH-ZP4-04", "P4Fix Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  const b = await ensureWarehouse("WH-ZP4-05", "P4Fix Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;

  // Shipping service + catch-all tariff for this run.
  serviceCode = `P4FSTD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P4Fix Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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
    businessName: `P4Fix Vendor ${RUN}`,
    contactName: "P4Fix Contact",
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

  // Warehouse people at A.
  fx.waA = await makeUser("waA", "WAREHOUSE_ADMIN");
  await addMembership(fx.waA, fx.whA, "WAREHOUSE_ADMIN");
  fx.staffA1 = await makeUser("staffA1", "WAREHOUSE_STAFF");
  await addMembership(fx.staffA1, fx.whA, "WAREHOUSE_STAFF");
  fx.staffA2 = await makeUser("staffA2", "WAREHOUSE_STAFF");
  await addMembership(fx.staffA2, fx.whA, "WAREHOUSE_STAFF");

  waAActor = await actorFor(fx.waA);
  staffA1Actor = await actorFor(fx.staffA1);
  staffA2Actor = await actorFor(fx.staffA2);
}, 180_000);

// ---------------------------------------------------------------------------

describe("P4-1 — concurrent confirms cannot corrupt the batch count", () => {
  it("two lines confirmed concurrently complete the batch with confirmedCount 2 (3 attempts)", async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const one = await receivedOne();
      const two = await receivedOne();
      const batch = await custodySvc.initiateHandover(waAActor, {
        packageIds: [one.packageId, two.packageId],
        toCustodianType: "USER",
        toUserId: fx.staffA1,
      });
      expect(batch.status).toBe("PENDING");

      // The regression scenario: both confirms in flight at once,
      // as when a receiver scans two parcels in quick succession.
      await Promise.all([
        custodySvc.confirmHandoverPackage(staffA1Actor, {
          batchId: batch.id,
          packageId: one.packageId,
        }),
        custodySvc.confirmHandoverPackage(staffA1Actor, {
          batchId: batch.id,
          packageId: two.packageId,
        }),
      ]);

      const row = await prisma.handoverBatch.findUniqueOrThrow({
        where: { id: batch.id },
      });
      expect(row.status).toBe("CONFIRMED");
      expect(row.confirmedCount).toBe(2);
      expect(row.confirmedAt).not.toBeNull();

      const view = await custodySvc.getHandoverBatch(waAActor, batch.id);
      expect(view.status).toBe("CONFIRMED");
      expect(view.confirmedCount).toBe(2);
      expect(view.lines.every((l) => l.status === "CONFIRMED")).toBe(true);

      // Custody really moved for both packages.
      for (const p of [one.packageId, two.packageId]) {
        const open = await prisma.packageCustody.findFirst({
          where: { packageId: p, endedAt: null },
        });
        expect(open?.custodianType).toBe("USER");
        expect(open?.custodianUserId).toBe(fx.staffA1);
      }
    }
  }, 180_000);
});

describe("P4-2 — initiation out of a user's custody", () => {
  it("a non-custodian member is denied + audited; the custodian and a Warehouse Admin can initiate", async () => {
    const pkg = await receivedOne();

    // Warehouse → staffA2 (initiation out of WAREHOUSE custody stays
    // open to warehouse members).
    const b1 = await custodySvc.initiateHandover(waAActor, {
      packageIds: [pkg.packageId],
      toCustodianType: "USER",
      toUserId: fx.staffA2,
    });
    await custodySvc.confirmHandoverPackage(staffA2Actor, {
      batchId: b1.id,
      packageId: pkg.packageId,
    });
    // Custody is now staffA2's.

    // staffA1 — not the custodian, not a Warehouse Admin — tries to
    // initiate a handover out of staffA2's custody to themselves.
    await expect(
      custodySvc.initiateHandover(staffA1Actor, {
        packageIds: [pkg.packageId],
        toCustodianType: "USER",
        toUserId: fx.staffA1,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    // The denial is audited with the specific reason.
    const denial = await prisma.auditLog.findFirst({
      where: {
        action: "access.denied",
        actorId: fx.staffA1,
        entityType: "CustodyHandover",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(denial).not.toBeNull();
    expect((denial!.after as { reason?: string } | null)?.reason).toBe(
      "handover_initiate_not_custodian",
    );

    // Custody did not move and the failed attempt left no open line.
    const openAfterDenial = await prisma.packageCustody.findFirst({
      where: { packageId: pkg.packageId, endedAt: null },
    });
    expect(openAfterDenial?.custodianUserId).toBe(fx.staffA2);
    const strayLines = await prisma.custodyHandover.count({
      where: { packageId: pkg.packageId, status: "PENDING" },
    });
    expect(strayLines).toBe(0);

    // The custodian themselves can initiate.
    const b2 = await custodySvc.initiateHandover(staffA2Actor, {
      packageIds: [pkg.packageId],
      toCustodianType: "USER",
      toUserId: fx.staffA1,
    });
    expect(b2.status).toBe("PENDING");
    await custodySvc.confirmHandoverPackage(staffA1Actor, {
      batchId: b2.id,
      packageId: pkg.packageId,
    });
    // Custody is now staffA1's.

    // A Warehouse Admin of the warehouse can initiate out of
    // staffA1's custody.
    const b3 = await custodySvc.initiateHandover(waAActor, {
      packageIds: [pkg.packageId],
      toCustodianType: "WAREHOUSE",
      toWarehouseId: fx.whA,
    });
    expect(b3.status).toBe("PENDING");
    expect(b3.fromCustodianType).toBe("USER");
    await custodySvc.confirmHandoverPackage(staffA1Actor, {
      batchId: b3.id,
      packageId: pkg.packageId,
    });
    const back = await prisma.packageCustody.findFirst({
      where: { packageId: pkg.packageId, endedAt: null },
    });
    expect(back?.custodianType).toBe("WAREHOUSE");
    expect(back?.warehouseId).toBe(fx.whA);
  }, 180_000);
});

describe("P4-3 — a package can sit in only one open batch", () => {
  it("a second open batch for the same package is rejected (naming the package); initiation succeeds after the first batch completes", async () => {
    const pkg = await receivedOne();
    const batch1 = await custodySvc.initiateHandover(waAActor, {
      packageIds: [pkg.packageId],
      toCustodianType: "USER",
      toUserId: fx.staffA1,
    });
    expect(batch1.status).toBe("PENDING");

    const err = await custodySvc
      .initiateHandover(waAActor, {
        packageIds: [pkg.packageId],
        toCustodianType: "USER",
        toUserId: fx.staffA2,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(errors.ConflictError);
    expect((err as Error).message).toContain(pkg.trackingId);

    // No second batch/line was created by the rejected attempt.
    const openLines = await prisma.custodyHandover.count({
      where: { packageId: pkg.packageId, status: "PENDING" },
    });
    expect(openLines).toBe(1);

    // Complete the first batch; the package (now in staffA1's
    // custody, its line CONFIRMED) can be promised again — initiated
    // here by the Warehouse Admin, which P4-2 permits.
    await custodySvc.confirmHandoverPackage(staffA1Actor, {
      batchId: batch1.id,
      packageId: pkg.packageId,
    });
    const batch2 = await custodySvc.initiateHandover(waAActor, {
      packageIds: [pkg.packageId],
      toCustodianType: "USER",
      toUserId: fx.staffA2,
    });
    expect(batch2.status).toBe("PENDING");
    expect(batch2.fromCustodianType).toBe("USER");
  }, 180_000);

  it("a PENDING line in a PARTIALLY_CONFIRMED batch also blocks a second batch", async () => {
    const one = await receivedOne();
    const two = await receivedOne();
    const batch = await custodySvc.initiateHandover(waAActor, {
      packageIds: [one.packageId, two.packageId],
      toCustodianType: "USER",
      toUserId: fx.staffA1,
    });
    await custodySvc.confirmHandoverPackage(staffA1Actor, {
      batchId: batch.id,
      packageId: one.packageId,
    });
    const mid = await prisma.handoverBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect(mid.status).toBe("PARTIALLY_CONFIRMED");
    expect(mid.confirmedCount).toBe(1);

    // The still-pending package cannot be promised elsewhere.
    await expect(
      custodySvc.initiateHandover(waAActor, {
        packageIds: [two.packageId],
        toCustodianType: "USER",
        toUserId: fx.staffA2,
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);

    // The confirmed package's line is no longer PENDING, so it can
    // move on — initiated by its custodian (staffA1).
    const next = await custodySvc.initiateHandover(staffA1Actor, {
      packageIds: [one.packageId],
      toCustodianType: "USER",
      toUserId: fx.staffA2,
    });
    expect(next.status).toBe("PENDING");
  }, 180_000);
});
