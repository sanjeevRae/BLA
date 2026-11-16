import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 7 integration tests — vendor bulk booking
 * (createBulkBookings in src/server/services/bookings.ts) against the
 * local bla_test database:
 *  (i)   a 3-row bulk succeeds atomically; tracking IDs are unique and
 *        a bulk row charges EXACTLY what the same input charges as a
 *        single booking (shared pricing path);
 *  (ii)  one schema-invalid row aborts the whole bulk with a
 *        "Row N:" error and ZERO orders created;
 *  (iii) a vendor bulk-booking for another vendor's org is refused,
 *        nothing created;
 *  (iv)  51 rows (and 0 rows) are refused;
 *  (v)   a warehouse-scoped actor with one out-of-scope origin row
 *        loses the WHOLE bulk, nothing created;
 *  (vi)  an in-transaction failure on a later row rolls back the
 *        earlier rows too (single-transaction semantics).
 *
 * Fixture style mirrors tests/integration/bookings.test.ts: per-run
 * unique districts/emails/phones, shared find-or-create warehouses
 * whose codes sort last (WH-ZP7B-*).
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
const email = (label: string) => `p7b-${label}-${RUN}@bla.test`;
const phone = (n: number) => `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let trackingLib: typeof import("@/lib/bookings/tracking");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let vendorAActor: Awaited<ReturnType<typeof actorFor>>;
let scopedActor: Awaited<ReturnType<typeof actorFor>>;
let vendorAAddressId: string;
let serviceCode: string;

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
      fullName: `P7B ${label}`,
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

async function makeWarehouse(label: string, code: string, district: string): Promise<string> {
  const existing = await prisma.warehouse.findUnique({ where: { code } });
  const warehouse =
    existing ??
    (await prisma.warehouse.create({
      data: {
        code,
        name: `P7B ${label} (shared fixture)`,
        type: "REGIONAL",
        status: "ACTIVE",
        district,
        city: label,
        province: "Bagmati",
        country: "Nepal",
      },
    }));
  await prisma.serviceArea.upsert({
    where: { district_name: { district, name: `${label} Area P7B (shared)` } },
    update: { servingWarehouseId: warehouse.id, isActive: true },
    create: {
      name: `${label} Area P7B (shared)`,
      district,
      city: label,
      province: "Bagmati",
      servingWarehouseId: warehouse.id,
    },
  });
  return warehouse.id;
}

async function makeVendor(
  label: string,
): Promise<{ vendorId: string; ownerId: string }> {
  const view = await vendorsSvc.createVendor(adminActor, {
    businessName: `P7B ${label} ${RUN}`,
    contactName: `${label} Contact`,
    email: email(label),
    phone: phone(label.length * 7 + 11),
    billingPreference: "COD_OFFSET",
    creditLimitPaisa: null,
    registrationNumber: null,
  });
  await vendorsSvc.setVendorVerificationStatus(adminActor, view.id, {
    target: "UNDER_REVIEW",
    notes: null,
  });
  await vendorsSvc.setVendorVerificationStatus(adminActor, view.id, {
    target: "APPROVED",
    notes: null,
  });
  const ownerId = await makeUser(`${label}-owner`, "VENDOR");
  await prisma.vendorUser.create({
    data: {
      vendorId: view.id,
      userId: ownerId,
      vendorRole: "OWNER",
      invitedById: fx.adminUser,
    },
  });
  return { vendorId: view.id, ownerId };
}

/** One vendor bulk row: rider pickup from vendor A's approved address,
 *  delivered into district B. Mirrors the single-booking vendor flow. */
function vendorRow(overrides: Record<string, unknown> = {}) {
  return {
    recipient: {
      name: "Bulk Recipient",
      phone: phone(101),
      addressLine: "Lakeside 6",
      city: "Beta",
      district: fx.districtB,
      province: "Gandaki",
    },
    pickup: { method: "RIDER_PICKUP" as const, vendorAddressId: vendorAAddressId },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Box of goods", quantity: 1, weightKg: 1.2 }],
    ...overrides,
  };
}

/** One staff bulk row: walk-in sender, warehouse drop-off. */
function staffRow(originWarehouseId: string, phoneSuffix: number) {
  return {
    sender: { name: "Walk-in Sender", phone: phone(42), email: null },
    recipient: {
      name: "Staff Recipient",
      phone: phone(phoneSuffix),
      addressLine: "Main Road 1",
      city: "Beta",
      district: fx.districtB,
      province: "Gandaki",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Parcel", quantity: 1, weightKg: 1 }],
  };
}

const orderCountFor = (createdById: string) =>
  prisma.order.count({ where: { createdById } });

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
  errors = await import("@/lib/errors");
  actorErrors = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");
  trackingLib = await import("@/lib/bookings/tracking");

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

  fx.districtA = "P7BAlpha District";
  fx.districtB = "P7BBeta District";
  fx.whA = await makeWarehouse("P7BAlpha", "WH-ZP7B-01", fx.districtA);
  fx.whB = await makeWarehouse("P7BBeta", "WH-ZP7B-02", fx.districtB);

  serviceCode = `P7B${RUN.slice(-6)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "Standard P7B (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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

  const a = await makeVendor("vendorA");
  fx.vendorA = a.vendorId;
  fx.vendorAOwner = a.ownerId;
  const b = await makeVendor("vendorB");
  fx.vendorB = b.vendorId;

  const address = await vendorsSvc.addVendorAddress(adminActor, fx.vendorA, {
    kind: "PICKUP",
    addressLine1: "Industrial Road 1",
    city: "P7BAlpha",
    district: fx.districtA,
    province: "Bagmati",
    approve: true,
  });
  vendorAAddressId = address.id;
  vendorAActor = await actorFor(fx.vendorAOwner);

  // Warehouse-scoped actor: WAREHOUSE_ADMIN (holds booking.create, no
  // booking.read_all) with membership in warehouse A only.
  fx.scopedUser = await makeUser("scoped-wa", "WAREHOUSE_ADMIN");
  const waRole = await prisma.role.findUnique({ where: { code: "WAREHOUSE_ADMIN" } });
  await prisma.warehouseMembership.create({
    data: {
      userId: fx.scopedUser,
      warehouseId: fx.whA,
      roleId: waRole!.id,
      isPrimary: true,
      assignedById: fx.adminUser,
    },
  });
  scopedActor = await actorFor(fx.scopedUser);
  expect(scopedActor.warehouseIds).toEqual([fx.whA]);
  expect(scopedActor.permissions.has("booking.create")).toBe(true);
  expect(scopedActor.permissions.has("booking.read_all")).toBe(false);
}, 180_000);

// ---------------------------------------------------------------------------

describe("createBulkBookings", () => {
  it("(i) creates 3 orders atomically with unique tracking IDs and single-booking-identical charges", async () => {
    const rowOne = vendorRow({
      codAmountPaisa: "5000",
      recipient: {
        name: "Bulk One",
        phone: phone(201),
        addressLine: "Lakeside 6",
        city: "Beta",
        district: fx.districtB,
        province: "Gandaki",
      },
    });
    // The identical input as a single booking — the pricing proof.
    const single = await bookingsSvc.createBooking(
      vendorAActor,
      structuredClone(rowOne) as never,
    );

    const rows = [
      rowOne,
      vendorRow({
        recipient: {
          name: "Bulk Two",
          phone: phone(202),
          addressLine: "Bazaar 3",
          city: "Beta",
          district: fx.districtB,
          province: "Gandaki",
        },
        items: [
          { description: "Crates", quantity: 2, weightKg: 1.5 },
          { description: "Sacks", quantity: 1, weightKg: 0.5 },
        ],
      }),
      vendorRow({
        recipient: {
          name: "Bulk Three",
          phone: phone(203),
          addressLine: "Hill 9",
          city: "Beta",
          district: fx.districtB,
          province: "Gandaki",
        },
        codAmountPaisa: "10001",
        items: [{ description: "Fragile box", quantity: 3, weightKg: 0.8 }],
      }),
    ];
    const before = await orderCountFor(fx.vendorAOwner);
    const created = await bookingsSvc.createBulkBookings(vendorAActor, { orders: rows as never });
    expect(created).toHaveLength(3);
    expect(await orderCountFor(fx.vendorAOwner)).toBe(before + 3);

    // Vendor submissions land in the approval queue, like single ones.
    for (const booking of created) {
      expect(booking.vendorId).toBe(fx.vendorA);
      expect(booking.approvalStatus).toBe("PENDING");
      expect(booking.orderNumber).toMatch(/^ORD-\d+$/);
    }
    expect(new Set(created.map((b) => b.orderNumber)).size).toBe(3);

    const trackingIds = created.flatMap((b) =>
      b.shipments.flatMap((s) => s.packages.map((p) => p.trackingId)),
    );
    expect(trackingIds).toHaveLength(1 + 3 + 3);
    expect(new Set(trackingIds).size).toBe(trackingIds.length);
    for (const id of trackingIds) expect(trackingLib.isValidTrackingId(id)).toBe(true);

    // Pricing proof: bulk row 1 == the single booking of the same input.
    const bulkFirst = created[0];
    expect(bulkFirst.shipments[0].shippingChargePaisa).toBe(
      single.shipments[0].shippingChargePaisa,
    );
    expect(bulkFirst.shipments[0].codAmountPaisa).toBe(single.shipments[0].codAmountPaisa);
    expect(bulkFirst.shipments[0].packages.map((p) => p.codAmountPaisa)).toEqual(
      single.shipments[0].packages.map((p) => p.codAmountPaisa),
    );
    // And the charge is the tariff's: base 15000 + 5000 × 1.2 kg.
    expect(bulkFirst.shipments[0].shippingChargePaisa).toBe("21000");

    // The rows really persisted (orders + packages in the DB).
    const persisted = await prisma.order.findMany({
      where: { id: { in: created.map((b) => b.id) } },
      include: { shipments: { include: { packages: true } } },
    });
    expect(persisted).toHaveLength(3);
    expect(persisted.flatMap((o) => o.shipments.flatMap((s) => s.packages))).toHaveLength(7);
  });

  it("(ii) one invalid row aborts the whole bulk, names the row, and creates ZERO orders", async () => {
    const rows = [
      vendorRow({ recipient: { name: "Good One", phone: phone(301), addressLine: "A 1", city: "Beta", district: fx.districtB, province: "Gandaki" } }),
      // Row 2: recipient phone too short for the booking schema (min 7).
      vendorRow({ recipient: { name: "Bad Phone", phone: "123", addressLine: "A 2", city: "Beta", district: fx.districtB, province: "Gandaki" } }),
      vendorRow({ recipient: { name: "Good Three", phone: phone(303), addressLine: "A 3", city: "Beta", district: fx.districtB, province: "Gandaki" } }),
    ];
    const beforeOrders = await orderCountFor(fx.vendorAOwner);
    const beforePackages = await prisma.package.count({
      where: { order: { createdById: fx.vendorAOwner } },
    });
    const failure = await bookingsSvc
      .createBulkBookings(vendorAActor, { orders: rows as never })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(errors.DomainValidationError);
    expect((failure as Error).message).toContain("Row 2");
    expect(await orderCountFor(fx.vendorAOwner)).toBe(beforeOrders);
    expect(
      await prisma.package.count({ where: { order: { createdById: fx.vendorAOwner } } }),
    ).toBe(beforePackages);
  });

  it("(iii) a vendor cannot bulk-book for another vendor's organisation", async () => {
    const rows = [
      vendorRow(),
      vendorRow({ vendorId: fx.vendorB }),
    ];
    const before = await orderCountFor(fx.vendorAOwner);
    const failure = await bookingsSvc
      .createBulkBookings(vendorAActor, { orders: rows as never })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(actorErrors.AuthorizationError);
    expect((failure as Error).message).toContain("Row 2");
    expect((failure as Error).message).toContain("own organisation");
    expect(await orderCountFor(fx.vendorAOwner)).toBe(before);
    const denied = await prisma.auditLog.findFirst({
      where: {
        action: "access.denied",
        actorId: fx.vendorAOwner,
        entityType: "Order",
      },
      orderBy: { createdAt: "desc" },
    });
    expect(denied).not.toBeNull();
  });

  it("(iv) refuses 51 rows and refuses an empty submission", async () => {
    const rows51 = Array.from({ length: 51 }, (_, i) =>
      vendorRow({
        recipient: {
          name: `Bulk ${i}`,
          phone: phone(400 + i),
          addressLine: "A 1",
          city: "Beta",
          district: fx.districtB,
          province: "Gandaki",
        },
      }),
    );
    const before = await orderCountFor(fx.vendorAOwner);
    const failure = await bookingsSvc
      .createBulkBookings(vendorAActor, { orders: rows51 as never })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(errors.DomainValidationError);
    expect((failure as Error).message).toContain("50");
    expect(await orderCountFor(fx.vendorAOwner)).toBe(before);

    await expect(
      bookingsSvc.createBulkBookings(vendorAActor, { orders: [] as never }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    expect(await orderCountFor(fx.vendorAOwner)).toBe(before);
  });

  it("(v) a warehouse-scoped actor with one out-of-scope origin row loses the whole bulk", async () => {
    const rows = [staffRow(fx.whA, 501), staffRow(fx.whB, 502)];
    const before = await orderCountFor(fx.scopedUser);
    const failure = await bookingsSvc
      .createBulkBookings(scopedActor, { orders: rows as never })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(actorErrors.AuthorizationError);
    expect((failure as Error).message).toContain("Row 2");
    expect(await orderCountFor(fx.scopedUser)).toBe(before);
  });

  it("(vi) an in-transaction failure on a later row rolls back earlier rows", async () => {
    // Row 2's drop-off warehouse does not exist: it passes every
    // pre-transaction check for the unscoped admin and fails only
    // INSIDE the transaction — row 1 must roll back with it.
    const rows = [
      staffRow(fx.whA, 601),
      staffRow("00000000-0000-4000-8000-000000000000", 602),
    ];
    const before = await orderCountFor(fx.adminUser);
    const failure = await bookingsSvc
      .createBulkBookings(adminActor, { orders: rows as never })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(errors.DomainValidationError);
    expect((failure as Error).message).toContain("Row 2");
    expect(await orderCountFor(fx.adminUser)).toBe(before);
  });
});
