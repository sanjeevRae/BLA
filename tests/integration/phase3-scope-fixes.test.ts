import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// A controllable NextAuth session so the REAL getActorContext
// (@/lib/auth/permissions) can run in tests — the P3-4 assertions are
// about exactly that resolver, so a mirror would prove nothing.
const authState = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/auth", () => ({
  auth: async () =>
    authState.userId ? { user: { id: authState.userId } } : null,
}));

/**
 * Phase 3 security-review fix tests (P3-1, P3-4, P3-9) against the
 * local bla_test database.
 *
 * P3-1: listBookings/listPackages built their Prisma filter by
 * spreading the actor scope and the search clause into one object;
 * for customer/warehouse actors the scope IS an OR clause, so the
 * search OR overwrote it and the tenant filter vanished (a warehouse
 * actor with zero in-scope orders could read every booking/package
 * in the system, incl. recipient phone/address/COD). These tests
 * call both lists WITH a search term as warehouse and customer
 * actors and assert out-of-scope rows stay hidden — and that
 * in-scope rows are still found.
 *
 * Fixtures use per-run unique emails/phones and the shared
 * find-or-create WH-ZP3-* warehouses (see bookings.test.ts).
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
const RUN_NUM = String(Math.floor(Math.random() * 90000) + 10000); // 5 digits
const email = (label: string) => `p3fix-${label}-${RUN}@bla.test`;
/** 13-digit phone, unique per (run, n): 977 98 <nnn> <rrrrr>. */
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let packagesSvc: typeof import("@/server/services/packages");
let vendorsSvc: typeof import("@/server/services/vendors");
let invitationsSvc: typeof import("@/server/services/invitations");
let permissionsLib: typeof import("@/lib/auth/permissions");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let staffEmptyActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let customerActor: Awaited<ReturnType<typeof actorFor>>;
let serviceCode: string;
let booking1Id: string;
let booking1OrderNumber: string;
let booking1TrackingId: string;
let booking2Id: string;

/** Mirror of getActorContext (permissions.ts) incl. the P3-4 rule:
 *  the vendor link resolves only for APPROVED, active vendors. */
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
      where: {
        userId: user.id,
        isActive: true,
        vendor: { isActive: true, verificationStatus: "APPROVED" },
      },
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
      fullName: `P3Fix ${label}`,
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

/** Shared find-or-create fixture warehouses (see bookings.test.ts). */
async function makeWarehouse(label: string, code: string, district: string): Promise<string> {
  const existing = await prisma.warehouse.findUnique({ where: { code } });
  const warehouse =
    existing ??
    (await prisma.warehouse.create({
      data: {
        code,
        name: `P3Fix ${label} (shared fixture)`,
        type: "REGIONAL",
        status: "ACTIVE",
        district,
        city: label,
        province: "Bagmati",
        country: "Nepal",
      },
    }));
  await prisma.serviceArea.upsert({
    where: { district_name: { district, name: `${label} Area (shared)` } },
    update: { servingWarehouseId: warehouse.id, isActive: true },
    create: {
      name: `${label} Area (shared)`,
      district,
      city: label,
      province: "Bagmati",
      servingWarehouseId: warehouse.id,
    },
  });
  return warehouse.id;
}

async function makeStaff(label: string, warehouseId: string): Promise<string> {
  const userId = await makeUser(label, "WAREHOUSE_STAFF");
  const staffRole = await prisma.role.findUnique({ where: { code: "WAREHOUSE_STAFF" } });
  await prisma.warehouseMembership.create({
    data: {
      userId,
      warehouseId,
      roleId: staffRole!.id,
      isPrimary: true,
      assignedById: fx.adminUser,
    },
  });
  return userId;
}

async function makeApprovedVendor(
  label: string,
): Promise<{ vendorId: string; ownerId: string }> {
  const view = await vendorsSvc.createVendor(adminActor, {
    businessName: `P3Fix ${label} ${RUN}`,
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

function bookingInput(overrides: Record<string, unknown> = {}) {
  return {
    sender: { name: "Walk-in Sender", phone: phone(42), email: null },
    recipient: {
      name: "Recipient One",
      phone: phone(101),
      addressLine: "Lakeside 6",
      city: "Pokhara",
      district: fx.districtB,
      province: "Gandaki",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: fx.whA },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Box of goods", quantity: 1, weightKg: 1.2 }],
    ...overrides,
  };
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
  packagesSvc = await import("@/server/services/packages");
  vendorsSvc = await import("@/server/services/vendors");
  invitationsSvc = await import("@/server/services/invitations");
  permissionsLib = await import("@/lib/auth/permissions");
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

  fx.districtA = "P3Alpha District";
  fx.districtB = "P3Beta District";
  fx.districtEmpty = "P3Fix Empty District";
  fx.whA = await makeWarehouse("Alpha", "WH-ZP3-01", fx.districtA);
  fx.whB = await makeWarehouse("Beta", "WH-ZP3-02", fx.districtB);
  // A warehouse no booking in any suite is ever routed through: its
  // staff actor has exactly zero in-scope orders/packages.
  fx.whEmpty = await makeWarehouse("Empty", "WH-ZP3-05", fx.districtEmpty);

  serviceCode = `STF${RUN.slice(-6)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "Standard (p3fix test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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

  const a = await makeApprovedVendor("vendorA");
  fx.vendorA = a.vendorId;
  fx.vendorAOwner = a.ownerId;

  // Booking 1: vendor A, origin WH-ZP3-01 → Beta district. Its order
  // number matches search "ORD" and its tracking IDs match "BLA" —
  // exactly the rows the P3-1 leak exposed to out-of-scope actors.
  const booking1 = await bookingsSvc.createBooking(
    adminActor,
    bookingInput({ vendorId: fx.vendorA }),
  );
  booking1Id = booking1.id;
  booking1OrderNumber = booking1.orderNumber;
  const booking1Packages = booking1.shipments.flatMap((s) => s.packages);
  expect(booking1Packages.length).toBeGreaterThan(0);
  booking1TrackingId = booking1Packages[0].trackingId;

  // Customer account + linked Customer record.
  fx.customerUser = await makeUser("customer", "CUSTOMER");
  fx.customerPhone = phone(555);
  const customer = await prisma.customer.create({
    data: {
      fullName: "P3Fix Linked Customer",
      phone: fx.customerPhone,
      normalizedPhone: fx.customerPhone,
      userId: fx.customerUser,
      createdById: fx.adminUser,
    },
  });
  fx.customer = customer.id;
  customerActor = await actorFor(fx.customerUser);

  // Booking 2: addressed to the linked customer (recipient phone
  // match) — the one booking the customer actor may see.
  const booking2 = await bookingsSvc.createBooking(
    adminActor,
    bookingInput({
      vendorId: fx.vendorA,
      recipient: {
        name: "Linked Customer",
        phone: fx.customerPhone,
        addressLine: "Beta Bazaar 3",
        city: "Beta",
        district: fx.districtB,
        province: "Gandaki",
      },
    }),
  );
  booking2Id = booking2.id;

  staffEmptyActor = await actorFor(await makeStaff("staffEmpty", fx.whEmpty));
  staffAActor = await actorFor(await makeStaff("staffA", fx.whA));
}, 180_000);

// ---------------------------------------------------------------------------
// P3-1 — the reviewer's proof, re-run: a warehouse actor whose scope
// contains zero orders must get zero rows even when the search term
// matches every order/package in the database.
// ---------------------------------------------------------------------------

describe("P3-1: list scope survives a search term", () => {
  it("warehouse actor with zero in-scope orders gets 0 bookings for search 'ORD'", async () => {
    const result = await bookingsSvc.listBookings(staffEmptyActor, { search: "ORD" });
    expect(result.meta.total).toBe(0);
    expect(result.bookings).toHaveLength(0);
  });

  it("warehouse actor with zero in-scope packages gets 0 packages for search 'BLA'", async () => {
    const result = await packagesSvc.listPackages(staffEmptyActor, { search: "BLA" });
    expect(result.meta.total).toBe(0);
    expect(result.packages).toHaveLength(0);
  });

  it("in-scope warehouse rows are still found with a search term", async () => {
    // Search by this booking's unique identifiers: suites run in
    // parallel against one database, so a broad term's first page is
    // not deterministic — a unique term is.
    const bookings = await bookingsSvc.listBookings(staffAActor, {
      search: booking1OrderNumber,
    });
    expect(bookings.bookings.map((b) => b.id)).toContain(booking1Id);
    const packages = await packagesSvc.listPackages(staffAActor, {
      search: booking1TrackingId,
    });
    expect(packages.packages.map((p) => p.trackingId)).toContain(booking1TrackingId);
  });

  it("customer actor with a search term sees only their own bookings", async () => {
    const result = await bookingsSvc.listBookings(customerActor, { search: "ORD" });
    const ids = result.bookings.map((b) => b.id);
    expect(ids).toContain(booking2Id);
    expect(ids).not.toContain(booking1Id);
    expect(result.meta.total).toBe(1);
  });

  it("customer actor with a search term sees only their own packages", async () => {
    const result = await packagesSvc.listPackages(customerActor, { search: "BLA" });
    expect(result.packages.length).toBeGreaterThan(0);
    expect(
      result.packages.every((p) => p.recipientCustomerId === fx.customer),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P3-4 — suspension / deactivation revokes vendor portal access.
// ---------------------------------------------------------------------------

describe("P3-4: leaving APPROVED revokes vendor portal access", () => {
  it("suspension deletes sessions and the real getActorContext resolves vendorId null", async () => {
    const { vendorId, ownerId } = await makeApprovedVendor("vendorS");
    await prisma.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: ownerId,
        expires: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    authState.userId = ownerId;
    const before = await permissionsLib.getActorContext();
    expect(before?.vendorId).toBe(vendorId);
    expect(before?.vendorRole).toBe("OWNER");

    await vendorsSvc.setVendorVerificationStatus(adminActor, vendorId, {
      target: "SUSPENDED",
      notes: null,
    });

    const sessions = await prisma.session.count({ where: { userId: ownerId } });
    expect(sessions).toBe(0);

    // The login itself survives (user still ACTIVE with the VENDOR
    // role) — only the vendor portal context is gone.
    const after = await permissionsLib.getActorContext();
    expect(after).not.toBeNull();
    expect(after?.roles).toContain("VENDOR");
    expect(after?.vendorId).toBeNull();
    expect(after?.vendorRole).toBeNull();
    authState.userId = null;
  });

  it("updateVendor isActive=false deletes the vendor users' sessions", async () => {
    const { vendorId, ownerId } = await makeApprovedVendor("vendorD");
    await prisma.session.create({
      data: {
        sessionToken: randomUUID(),
        userId: ownerId,
        expires: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    await vendorsSvc.updateVendor(adminActor, vendorId, { isActive: false });

    const sessions = await prisma.session.count({ where: { userId: ownerId } });
    expect(sessions).toBe(0);

    authState.userId = ownerId;
    const ctx = await permissionsLib.getActorContext();
    expect(ctx?.vendorId).toBeNull();
    authState.userId = null;
  });
});

// ---------------------------------------------------------------------------
// P3-9 — an unspecified vendorRole defaults to BOOKING_STAFF.
// ---------------------------------------------------------------------------

describe("P3-9: invitation vendorRole defaults to BOOKING_STAFF", () => {
  it("invitation without vendorRole links the invitee as BOOKING_STAFF on acceptance", async () => {
    const inviteeEmail = email("invited-default");
    const created = await invitationsSvc.createInvitation(adminActor, {
      email: inviteeEmail,
      roleCode: "VENDOR",
      vendorId: fx.vendorA,
      // vendorRole deliberately omitted — OWNER must be explicit.
    });
    const invitation = await prisma.userInvitation.findUnique({
      where: { id: created.invitationId },
    });
    expect(invitation?.vendorRole).toBe("BOOKING_STAFF");

    const accepted = await invitationsSvc.acceptInvitation({
      token: created.token,
      fullName: "Invited Default",
      password: "Invited#2026",
    });
    const link = await prisma.vendorUser.findFirst({
      where: { vendorId: fx.vendorA, userId: accepted.userId },
    });
    expect(link?.vendorRole).toBe("BOOKING_STAFF");
  });
});
