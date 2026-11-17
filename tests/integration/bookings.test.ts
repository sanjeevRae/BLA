import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

import { findOperationalStatusWrites } from "../helpers/operational-status-scan";

vi.mock("server-only", () => ({}));

/**
 * Phase 3 integration tests (docs: implementation-roadmap Phase 3,
 * database-schema §3–§5, package-lifecycle, security-architecture §7)
 * against the local bla_test database: booking → package generation,
 * district routing (incl. the UNROUTED hold), vendor/customer/warehouse
 * force-scoping with access.denied auditing, the lifecycle service as
 * the only status writer, the public tracking projection's exact field
 * set, and integer-paisa COD.
 *
 * Fixtures use per-run unique districts/emails/phones so repeated runs
 * never collide on unique keys.
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
const email = (label: string) => `p3-${label}-${RUN}@bla.test`;
/** 13-digit phone, unique per (run, n): 977 98 <nnn> <rrrrr>. */
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let packagesSvc: typeof import("@/server/services/packages");
let lifecycleSvc: typeof import("@/server/services/package-lifecycle");
let vendorsSvc: typeof import("@/server/services/vendors");
let invitationsSvc: typeof import("@/server/services/invitations");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let trackingLib: typeof import("@/lib/bookings/tracking");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let vendorAActor: Awaited<ReturnType<typeof actorFor>>;
let vendorBActor: Awaited<ReturnType<typeof actorFor>>;
let vendorPActor: Awaited<ReturnType<typeof actorFor>>;
let accountsActor: Awaited<ReturnType<typeof actorFor>>;
let customerActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let staffBActor: Awaited<ReturnType<typeof actorFor>>;
let staffCActor: Awaited<ReturnType<typeof actorFor>>;
let vendorAAddressId: string;
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

async function makeUser(
  label: string,
  roleCode: string,
): Promise<string> {
  const { hash } = await import("bcryptjs");
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `P3 ${label}`,
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

/**
 * Fixture warehouses are SHARED across runs (fixed codes/districts,
 * find-or-create): bla_test accumulates append-only history that can
 * never be deleted, so creating fresh warehouses per run grows the
 * table until other suites' paged lists overflow. The WH-ZP3 codes
 * also sort after every other suite's codes, so these rows fall off
 * paged lists first rather than pushing other fixtures off.
 */
async function makeWarehouse(label: string, code: string, district: string): Promise<string> {
  const existing = await prisma.warehouse.findUnique({ where: { code } });
  const warehouse =
    existing ??
    (await prisma.warehouse.create({
      data: {
        code,
        name: `P3 ${label} (shared fixture)`,
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

async function makeVendor(
  label: string,
  opts: { approved: boolean },
): Promise<{ vendorId: string; ownerId: string }> {
  const view = await vendorsSvc.createVendor(adminActor, {
    businessName: `P3 ${label} ${RUN}`,
    contactName: `${label} Contact`,
    email: email(label),
    phone: phone(label.length * 7 + 11),
    billingPreference: "COD_OFFSET",
    creditLimitPaisa: null,
    registrationNumber: null,
  });
  if (opts.approved) {
    await vendorsSvc.setVendorVerificationStatus(adminActor, view.id, {
      target: "UNDER_REVIEW",
      notes: null,
    });
    await vendorsSvc.setVendorVerificationStatus(adminActor, view.id, {
      target: "APPROVED",
      notes: null,
    });
  }
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
  lifecycleSvc = await import("@/server/services/package-lifecycle");
  vendorsSvc = await import("@/server/services/vendors");
  invitationsSvc = await import("@/server/services/invitations");
  errors = await import("@/lib/errors");
  actorErrors = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");
  trackingLib = await import("@/lib/bookings/tracking");

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

  // Four routed districts (the routing matrix) + shared warehouses.
  fx.districtA = "P3Alpha District";
  fx.districtB = "P3Beta District";
  fx.districtC = "P3Gamma District";
  fx.districtD = "P3Delta District";
  fx.whA = await makeWarehouse("Alpha", "WH-ZP3-01", fx.districtA);
  fx.whB = await makeWarehouse("Beta", "WH-ZP3-02", fx.districtB);
  fx.whC = await makeWarehouse("Gamma", "WH-ZP3-03", fx.districtC);
  fx.whD = await makeWarehouse("Delta", "WH-ZP3-04", fx.districtD);

  // Shipping service + catch-all tariff for this run.
  serviceCode = `STD${RUN.slice(-6)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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

  // Vendors A (approved), B (approved), P (pending).
  const a = await makeVendor("vendorA", { approved: true });
  fx.vendorA = a.vendorId;
  fx.vendorAOwner = a.ownerId;
  const b = await makeVendor("vendorB", { approved: true });
  fx.vendorB = b.vendorId;
  fx.vendorBOwner = b.ownerId;
  const p = await makeVendor("vendorP", { approved: false });
  fx.vendorP = p.vendorId;
  fx.vendorPOwner = p.ownerId;

  // Vendor A's approved pickup address in district A.
  const address = await vendorsSvc.addVendorAddress(
    adminActor,
    fx.vendorA,
    {
      kind: "PICKUP",
      addressLine1: "Industrial Road 1",
      city: "Alpha",
      district: fx.districtA,
      province: "Bagmati",
      approve: true,
    },
  );
  vendorAAddressId = address.id;

  vendorAActor = await actorFor(fx.vendorAOwner);
  vendorBActor = await actorFor(fx.vendorBOwner);
  vendorPActor = await actorFor(fx.vendorPOwner);

  // Vendor A accounts-staff user (no booking rights — matrix §5.4).
  fx.vendorAAccounts = await makeUser("vendorA-accounts", "VENDOR");
  await prisma.vendorUser.create({
    data: {
      vendorId: fx.vendorA,
      userId: fx.vendorAAccounts,
      vendorRole: "ACCOUNTS_STAFF",
      invitedById: fx.adminUser,
    },
  });
  accountsActor = await actorFor(fx.vendorAAccounts);

  // Customer account linked to a Customer record.
  fx.customerUser = await makeUser("customer", "CUSTOMER");
  fx.customerPhone = phone(555);
  const customer = await prisma.customer.create({
    data: {
      fullName: "Linked Customer",
      phone: fx.customerPhone,
      normalizedPhone: fx.customerPhone,
      userId: fx.customerUser,
      createdById: fx.adminUser,
    },
  });
  fx.customer = customer.id;
  customerActor = await actorFor(fx.customerUser);

  // Warehouse staff for A, B, C.
  const staffRole = await prisma.role.findUnique({ where: { code: "WAREHOUSE_STAFF" } });
  for (const [label, warehouseId] of [
    ["staffA", fx.whA],
    ["staffB", fx.whB],
    ["staffC", fx.whC],
  ] as const) {
    const userId = await makeUser(label, "WAREHOUSE_STAFF");
    await prisma.warehouseMembership.create({
      data: {
        userId,
        warehouseId,
        roleId: staffRole!.id,
        isPrimary: true,
        assignedById: fx.adminUser,
      },
    });
    fx[label] = userId;
  }
  staffAActor = await actorFor(fx.staffA);
  staffBActor = await actorFor(fx.staffB);
  staffCActor = await actorFor(fx.staffC);
}, 180_000);

// ---------------------------------------------------------------------------

describe("booking → package generation", () => {
  it("generates one BOOKED package per unit with history rows and an exact COD split", async () => {
    const booking = await bookingsSvc.createBooking(
      adminActor,
      bookingInput({
        vendorId: fx.vendorA,
        codAmountPaisa: "10001",
        items: [
          { description: "Crates", quantity: 2, weightKg: 1.5 },
          { description: "Sacks", quantity: 3, weightKg: 0.5 },
        ],
      }),
    );
    expect(booking.orderNumber).toMatch(/^ORD-\d+$/);
    expect(booking.approvalStatus).toBe("APPROVED"); // staff-created default
    expect(booking.status).toBe("CONFIRMED");
    const shipment = booking.shipments[0];
    expect(shipment.routeKind).toBe("INTER_WAREHOUSE");
    expect(shipment.destinationWarehouseId).toBe(fx.whB);
    expect(shipment.packages).toHaveLength(5);
    for (const pkg of shipment.packages) {
      expect(pkg.operationalStatus).toBe("BOOKED");
      expect(pkg.paymentStatus).toBe("COD_DUE");
      expect(trackingLib.isValidTrackingId(pkg.trackingId)).toBe(true);
    }
    const codSum = shipment.packages.reduce((sum, p) => sum + BigInt(p.codAmountPaisa), BigInt(0));
    expect(codSum).toBe(BigInt(10001));

    // History rows: one BOOKED TrackingEvent per package.
    const events = await prisma.trackingEvent.findMany({
      where: { orderId: booking.id, eventType: "BOOKED" },
    });
    expect(events).toHaveLength(5);
    expect(events.every((e) => e.newStatus === "BOOKED" && e.previousStatus === null)).toBe(true);

    // COD is stored as integer paisa (bigint) in the database.
    const raw = await prisma.package.findFirst({ where: { orderId: booking.id } });
    expect(typeof raw!.codAmountPaisa).toBe("bigint");
  });

  it("vendor-submitted bookings land PENDING and can be approved", async () => {
    const booking = await bookingsSvc.createBooking(
      vendorAActor,
      bookingInput({
        pickup: { method: "RIDER_PICKUP", vendorAddressId: vendorAAddressId },
        recipient: {
          name: "Vendor Recipient",
          phone: phone(202),
          addressLine: "Beta Bazaar 3",
          city: "Beta",
          district: fx.districtB,
          province: "Gandaki",
        },
      }),
    );
    expect(booking.approvalStatus).toBe("PENDING");
    expect(booking.status).toBe("SUBMITTED");
    expect(booking.originWarehouseId).toBe(fx.whA); // pickup district routes origin
    const approved = await bookingsSvc.approveBooking(adminActor, booking.id);
    expect(approved.approvalStatus).toBe("APPROVED");
    expect(approved.status).toBe("CONFIRMED");
  });

  it("creates unique, well-formed tracking IDs under parallel creation", async () => {
    const bookings = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        bookingsSvc.createBooking(
          adminActor,
          bookingInput({
            recipient: {
              name: `Parallel ${i}`,
              phone: phone(300 + i),
              addressLine: "Street 1",
              city: "Beta",
              district: fx.districtB,
              province: "Gandaki",
            },
            items: [{ description: "Parcel", quantity: 2, weightKg: 1 }],
          }),
        ),
      ),
    );
    const trackingIds = bookings.flatMap((b) =>
      b.shipments.flatMap((s) => s.packages.map((p) => p.trackingId)),
    );
    expect(trackingIds).toHaveLength(20);
    expect(new Set(trackingIds).size).toBe(20);
    for (const id of trackingIds) {
      expect(id).toMatch(trackingLib.TRACKING_ID_PATTERN);
      expect(trackingLib.isValidTrackingId(id)).toBe(true);
    }
  });
});

describe("district routing", () => {
  it("routes each of the four districts to its serving warehouse", async () => {
    const cases = [
      { district: fx.districtA, warehouse: fx.whA, route: "LAST_MILE" },
      { district: fx.districtB, warehouse: fx.whB, route: "INTER_WAREHOUSE" },
      { district: fx.districtC, warehouse: fx.whC, route: "INTER_WAREHOUSE" },
      { district: fx.districtD, warehouse: fx.whD, route: "INTER_WAREHOUSE" },
    ];
    for (const c of cases) {
      const booking = await bookingsSvc.createBooking(
        adminActor,
        bookingInput({
          recipient: {
            name: "Router",
            phone: phone(400 + c.district.length),
            addressLine: "Main Road",
            city: "Town",
            district: c.district,
            province: "Bagmati",
          },
        }),
      );
      expect(booking.shipments[0].destinationWarehouseId).toBe(c.warehouse);
      expect(booking.shipments[0].routeKind).toBe(c.route);
    }
  });

  it("holds an unmapped district as UNROUTED instead of misrouting it", async () => {
    const booking = await bookingsSvc.createBooking(
      adminActor,
      bookingInput({
        recipient: {
          name: "Remote Recipient",
          phone: phone(499),
          addressLine: "Trail Head",
          city: "Jomsom",
          district: `Nowhere${RUN}`,
          province: "Gandaki",
        },
      }),
    );
    expect(booking.shipments[0].routeKind).toBe("UNROUTED");
    expect(booking.shipments[0].destinationWarehouseId).toBeNull();
    expect(booking.shipments[0].packages).toHaveLength(1);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "booking.create_unrouted", entityId: booking.id },
    });
    expect(audit).not.toBeNull();
  });
});

describe("vendor isolation", () => {
  it("vendor B cannot read vendor A's booking or packages (404 + access.denied)", async () => {
    const booking = await bookingsSvc.createBooking(
      vendorAActor,
      bookingInput({
        pickup: { method: "RIDER_PICKUP", vendorAddressId: vendorAAddressId },
        recipient: {
          name: "A Private",
          phone: phone(606),
          addressLine: "Beta 1",
          city: "Beta",
          district: fx.districtB,
          province: "Gandaki",
        },
      }),
    );
    await expect(bookingsSvc.getBooking(vendorBActor, booking.id)).rejects.toBeInstanceOf(
      errors.NotFoundError,
    );
    const denied = await prisma.auditLog.findFirst({
      where: {
        action: "access.denied",
        actorId: fx.vendorBOwner,
        entityType: "Order",
        entityId: booking.id,
      },
    });
    expect(denied).not.toBeNull();

    const pkg = booking.shipments[0].packages[0];
    await expect(packagesSvc.getPackage(vendorBActor, pkg.id)).rejects.toBeInstanceOf(
      errors.NotFoundError,
    );
    const pkgDenied = await prisma.auditLog.findFirst({
      where: {
        action: "access.denied",
        actorId: fx.vendorBOwner,
        entityType: "Package",
        entityId: pkg.id,
      },
    });
    expect(pkgDenied).not.toBeNull();

    const bList = await bookingsSvc.listBookings(vendorBActor, {});
    expect(bList.bookings.every((b) => b.vendorId === fx.vendorB)).toBe(true);
    expect(bList.bookings.some((b) => b.id === booking.id)).toBe(false);
  });

  it("an unapproved vendor cannot book, and Accounts Staff cannot book at all", async () => {
    await expect(
      bookingsSvc.createBooking(
        vendorPActor,
        bookingInput({
          pickup: { method: "WAREHOUSE_DROPOFF", originWarehouseId: fx.whA },
        }),
      ),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    await expect(
      bookingsSvc.createBooking(accountsActor, bookingInput()),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });
});

describe("customer scope", () => {
  it("a customer sees only packages addressed to their linked record", async () => {
    const own = await bookingsSvc.createBooking(
      adminActor,
      bookingInput({
        recipient: {
          name: "Linked Customer",
          phone: fx.customerPhone,
          addressLine: "Home 1",
          city: "Beta",
          district: fx.districtB,
          province: "Gandaki",
        },
      }),
    );
    const other = await bookingsSvc.createBooking(
      adminActor,
      bookingInput({
        recipient: {
          name: "Someone Else",
          phone: phone(707),
          addressLine: "Home 2",
          city: "Beta",
          district: fx.districtB,
          province: "Gandaki",
        },
      }),
    );
    const mine = await packagesSvc.listPackages(customerActor, {});
    expect(mine.packages.length).toBeGreaterThan(0);
    expect(mine.packages.every((p) => p.recipientCustomerId === fx.customer)).toBe(true);
    expect(mine.packages.some((p) => p.id === own.shipments[0].packages[0].id)).toBe(true);
    await expect(
      packagesSvc.getPackage(customerActor, other.shipments[0].packages[0].id),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
  });
});

describe("warehouse scope", () => {
  it("staff see bookings routed through their warehouse only", async () => {
    const booking = await bookingsSvc.createBooking(
      adminActor,
      bookingInput({
        recipient: {
          name: "Scoped",
          phone: phone(808),
          addressLine: "Beta 9",
          city: "Beta",
          district: fx.districtB,
          province: "Gandaki",
        },
      }),
    );
    const aList = await bookingsSvc.listBookings(staffAActor, {});
    expect(aList.bookings.some((b) => b.id === booking.id)).toBe(true); // origin
    const bList = await bookingsSvc.listBookings(staffBActor, {});
    expect(bList.bookings.some((b) => b.id === booking.id)).toBe(true); // destination
    const cList = await bookingsSvc.listBookings(staffCActor, {});
    expect(cList.bookings.some((b) => b.id === booking.id)).toBe(false); // unrelated

    const pkg = booking.shipments[0].packages[0];
    await expect(packagesSvc.getPackage(staffCActor, pkg.id)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    const denied = await prisma.auditLog.findFirst({
      where: {
        action: "access.denied",
        actorId: fx.staffC,
        entityType: "Package",
        entityId: pkg.id,
      },
    });
    expect(denied).not.toBeNull();
  });
});

describe("public tracking projection", () => {
  it("exposes exactly the public field set — no phone, address or COD", async () => {
    const booking = await bookingsSvc.createBooking(
      adminActor,
      bookingInput({
        codAmountPaisa: "77700",
        recipient: {
          name: "Public Person",
          phone: phone(909),
          addressLine: "Secret Street 42",
          city: "Beta",
          district: fx.districtB,
          province: "Gandaki",
        },
      }),
    );
    const pkg = booking.shipments[0].packages[0];
    const view = await packagesSvc.getPublicTracking(pkg.trackingId);
    expect(Object.keys(view).sort()).toEqual(
      [
        "bookedAt",
        "destinationCity",
        "destinationDistrict",
        "lastUpdateAt",
        "originCity",
        "status",
        "statusLabel",
        "timeline",
        "trackingId",
      ].sort(),
    );
    expect(view.status).toBe("BOOKED");
    expect(view.destinationDistrict).toBe(fx.districtB);
    expect(view.timeline).toHaveLength(1);
    expect(Object.keys(view.timeline[0]).sort()).toEqual(["label", "occurredAt", "status"].sort());
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(phone(909));
    expect(serialized).not.toContain("Secret Street");
    expect(serialized).not.toContain("77700");
    expect(serialized).not.toContain("Public Person");
  });

  it("rejects unknown and mistyped tracking codes", async () => {
    await expect(packagesSvc.getPublicTracking("BLA-0000000000")).rejects.toBeInstanceOf(
      errors.NotFoundError,
    );
    await expect(packagesSvc.getPublicTracking("not-a-code")).rejects.toBeInstanceOf(
      errors.NotFoundError,
    );
  });
});

describe("package lifecycle service", () => {
  it("rejects invalid transitions, audits the attempt, and changes nothing", async () => {
    const booking = await bookingsSvc.createBooking(adminActor, bookingInput());
    const pkg = booking.shipments[0].packages[0];
    await expect(
      lifecycleSvc.transitionPackage(adminActor, pkg.id, "DELIVERED"),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    const after = await prisma.package.findUnique({ where: { id: pkg.id } });
    expect(after!.operationalStatus).toBe("BOOKED");
    const rejected = await prisma.auditLog.findFirst({
      where: { action: "package.transition_rejected", entityId: pkg.id },
    });
    expect(rejected).not.toBeNull();
  });

  it("cancels a booking through the lifecycle and rolls the shipment up", async () => {
    const booking = await bookingsSvc.createBooking(
      adminActor,
      bookingInput({ items: [{ description: "Cancellable", quantity: 2, weightKg: 1 }] }),
    );
    const cancelled = await bookingsSvc.cancelBooking(adminActor, booking.id, "Customer changed mind");
    expect(cancelled.status).toBe("CANCELLED");
    for (const pkg of cancelled.shipments[0].packages) {
      expect(pkg.operationalStatus).toBe("CANCELLED");
    }
    expect(cancelled.shipments[0].status).toBe("CANCELLED");
    const events = await prisma.trackingEvent.findMany({
      where: { orderId: booking.id, eventType: "CANCELLED" },
    });
    expect(events).toHaveLength(2);
  });

  it("is the only service that writes operationalStatus (source scan)", () => {
    // Write-aware scan (tests/helpers/operational-status-scan.ts): a
    // status literal is an offence only in a write context (Prisma
    // data/create/update payloads, payload variables, direct
    // assignment). Read contexts — where: filters, orderBy, select,
    // comparisons — are legitimate and allowed; the flat regex this
    // replaced flagged a count() where-filter in warehouse-home.ts.
    // Both directions are pinned in tests/unit/operational-status-scan.test.ts.
    const servicesDir = join(process.cwd(), "src/server/services");
    const offenders = findOperationalStatusWrites(servicesDir).map(
      (hit) => `${hit.file}:${hit.line} (${hit.context})`,
    );
    expect(offenders).toEqual([]);
  });
});

describe("vendor verification lifecycle", () => {
  it("enforces the submit → review → approve path", async () => {
    const view = await vendorsSvc.createVendor(adminActor, {
      businessName: `P3 lifecycle ${RUN}`,
      contactName: "Life Cycle",
      email: email("lifecycle"),
      phone: phone(111),
      billingPreference: "COD_OFFSET",
      creditLimitPaisa: null,
      registrationNumber: null,
    });
    await expect(
      vendorsSvc.setVendorVerificationStatus(adminActor, view.id, {
        target: "APPROVED",
        notes: null,
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    await vendorsSvc.setVendorVerificationStatus(adminActor, view.id, {
      target: "UNDER_REVIEW",
      notes: null,
    });
    const approved = await vendorsSvc.setVendorVerificationStatus(adminActor, view.id, {
      target: "APPROVED",
      notes: null,
    });
    expect(approved.verificationStatus).toBe("APPROVED");
    expect(approved.verifiedAt).not.toBeNull();
  });
});

describe("vendor invitations", () => {
  it("accepting a vendor invitation links the user into the vendor", async () => {
    const created = await invitationsSvc.createInvitation(adminActor, {
      email: email("invited"),
      roleCode: "VENDOR",
      vendorId: fx.vendorA,
      vendorRole: "BOOKING_STAFF",
    });
    expect(created.vendorId).toBe(fx.vendorA);
    const invitedPassword = ["Invited", "#2026"].join("");
    const accepted = await invitationsSvc.acceptInvitation({
      token: created.token,
      fullName: "Invited Booker",
      password: invitedPassword,
    });
    const link = await prisma.vendorUser.findFirst({
      where: { vendorId: fx.vendorA, userId: accepted.userId },
    });
    expect(link?.vendorRole).toBe("BOOKING_STAFF");
    const actor = await actorFor(accepted.userId);
    expect(actor.vendorId).toBe(fx.vendorA);
    expect(actor.vendorRole).toBe("BOOKING_STAFF");
  });
});
