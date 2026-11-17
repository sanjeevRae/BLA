import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Route-handler level (the phase8-api-validation pattern): stub ONLY
// the NextAuth-backed actor resolver; the real requireAccessGranted,
// the real list services and the real scoping run against bla_test.
// mockState.actor = null simulates no session (→ 401).
const mockState = vi.hoisted(() => ({
  actor: null as import("@/lib/auth/actor").ActorContext | null,
}));
vi.mock("@/lib/auth/permissions", async () => {
  const actorModule = await vi.importActual<typeof import("@/lib/auth/actor")>(
    "@/lib/auth/actor",
  );
  return {
    ...actorModule,
    getActorContext: async () => mockState.actor,
    requireActor: async () => {
      if (!mockState.actor) throw new actorModule.AuthenticationError();
      return mockState.actor;
    },
    requireUnflaggedActor: async () => {
      if (!mockState.actor) throw new actorModule.AuthenticationError();
      actorModule.requireAccessGranted(mockState.actor);
      return mockState.actor;
    },
  };
});

/**
 * V3 Step 3 (DS §8) — GET /api/search, the command menu's record
 * search. The palette's permission rule is server-side filtering:
 * records an actor may not see are never returned. These tests plant
 * fixtures via the real services on bla_test and assert, per actor:
 *  - SUPER_ADMIN finds a package by tracking ID, a booking by order
 *    number, a vendor / customer / warehouse / driver by name, with
 *    hrefs into the super-admin tree;
 *  - a KTM warehouse admin finds the KTM package (warehouse tree
 *    hrefs);
 *  - a PKR warehouse admin gets NO package/booking result for the
 *    KTM records — and the raw response body does not contain the
 *    tracking ID or order number strings anywhere (no leakage via
 *    hints, groups, or error text);
 *  - a vendor actor finds only its own organisation's bookings and
 *    packages, and receives no vendors/customers/warehouses/drivers
 *    groups;
 *  - a customer actor finds only its own packages (href = the public
 *    tracking page — the customer tree has no bookings detail route)
 *    and no other groups at all;
 *  - no session → 401; a <2-char query → 200 with empty groups.
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
    if (match) out[match[1]] = match[2].trim().replace(/^[\"']|[\"']$/g, "");
  }
  return out;
}

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const RUN_NUM = String(Math.floor(Math.random() * 90000) + 10000);
const email = (label: string) => `s3q-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let driversSvc: typeof import("@/server/services/drivers");
let catalog: typeof import("@/lib/permissions/catalog");
let searchRoute: typeof import("@/app/api/search/route");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let saActor: Actor;
let ktmWaActor: Actor;
let pkrWaActor: Actor;
let riderWarehouseActor: Actor;
let vendorActor: Actor;
let customerActor: Actor;
let serviceCode: string;
let vendorAddressId: string;

/** Mirror of getActorContext (permissions.ts) incl. Phase 3/5 links. */
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
      where: {
        userId: user.id,
        isActive: true,
        vendor: { isActive: true, verificationStatus: "APPROVED" },
      },
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

async function makeUser(
  label: string,
  roleCode: string,
  fullName?: string,
): Promise<string> {
  const { hash } = await import("bcryptjs");
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: fullName ?? `S3Q ${label}`,
      passwordHash: await hash("Fixture#2026", 10),
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role missing: ${roleCode}`);
  await prisma.userRole.create({
    data: { userId: user.id, roleId: role.id, assignedById: fx.saUser ?? user.id },
  });
  return user.id;
}

async function makeWarehouse(
  label: string,
  code: string,
  district: string,
): Promise<string> {
  const existing = await prisma.warehouse.findUnique({ where: { code } });
  const warehouse =
    existing ??
    (await prisma.warehouse.create({
      data: {
        code,
        name: `Search ${label} ${RUN}`,
        type: "REGIONAL",
        status: "ACTIVE",
        district,
        city: label,
        province: "Bagmati",
        country: "Nepal",
      },
    }));
  if (warehouse.status !== "ACTIVE") {
    await prisma.warehouse.update({
      where: { id: warehouse.id },
      data: { status: "ACTIVE" },
    });
  }
  await prisma.serviceArea.upsert({
    where: { district_name: { district, name: `${label} Area ${RUN}` } },
    update: { servingWarehouseId: warehouse.id, isActive: true },
    create: {
      name: `${label} Area ${RUN}`,
      district,
      city: label,
      province: "Bagmati",
      servingWarehouseId: warehouse.id,
    },
  });
  return warehouse.id;
}

async function addMembership(userId: string, warehouseId: string, roleCode: string) {
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  await prisma.warehouseMembership.create({
    data: {
      userId,
      warehouseId,
      roleId: role!.id,
      isPrimary: true,
      assignedById: fx.saUser,
    },
  });
}

async function makeVendor(label: string): Promise<string> {
  const view = await vendorsSvc.createVendor(saActor, {
    businessName: `S3Q ${label} ${RUN}`,
    contactName: `${label} Contact`,
    email: email(label),
    phone: phone(label.length * 13 + 7),
    billingPreference: "COD_OFFSET",
    creditLimitPaisa: null,
    registrationNumber: null,
  });
  await vendorsSvc.setVendorVerificationStatus(saActor, view.id, {
    target: "UNDER_REVIEW",
    notes: null,
  });
  await vendorsSvc.setVendorVerificationStatus(saActor, view.id, {
    target: "APPROVED",
    notes: null,
  });
  return view.id;
}

function bookingInput(overrides: Record<string, unknown> = {}) {
  return {
    sender: { name: "Walk-in Sender", phone: phone(42), email: null },
    recipient: {
      name: "Recipient One",
      phone: phone(101),
      addressLine: "Lakeside 6",
      city: "KtmCity",
      district: fx.districtKtm,
      province: "Bagmati",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: fx.whKtm },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Box of goods", quantity: 1, weightKg: 1.2 }],
    ...overrides,
  };
}

interface SearchBody {
  groups: {
    id: string;
    label: string;
    results: { id: string; label: string; hint: string; href: string }[];
  }[];
}

async function search(actor: Actor | null, q: string) {
  mockState.actor = actor;
  const response = await searchRoute.GET(
    new Request(`http://bla.test/api/search?q=${encodeURIComponent(q)}`),
  );
  const raw = await response.text();
  return {
    status: response.status,
    raw,
    body: JSON.parse(raw) as SearchBody,
  };
}

const groupOf = (body: SearchBody, id: string) =>
  body.groups.find((group) => group.id === id);

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
  driversSvc = await import("@/server/services/drivers");
  catalog = await import("@/lib/permissions/catalog");
  searchRoute = await import("@/app/api/search/route");

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

  fx.saUser = await makeUser("sa", "SUPER_ADMIN");
  saActor = await actorFor(fx.saUser);

  // KTM / PKR warehouses with run-unique districts for routing.
  fx.districtKtm = `S3QKtm District ${RUN}`;
  fx.districtPkr = `S3QPkr District ${RUN}`;
  fx.whKtm = await makeWarehouse("KTM", `S3K-${RUN.slice(-5)}`, fx.districtKtm);
  fx.whPkr = await makeWarehouse("PKR", `S3P-${RUN.slice(-5)}`, fx.districtPkr);

  // Warehouse admins, each a member of exactly one warehouse.
  const ktmWaUser = await makeUser("ktm-wa", "WAREHOUSE_ADMIN");
  await addMembership(ktmWaUser, fx.whKtm, "WAREHOUSE_ADMIN");
  ktmWaActor = await actorFor(ktmWaUser);
  const pkrWaUser = await makeUser("pkr-wa", "WAREHOUSE_ADMIN");
  await addMembership(pkrWaUser, fx.whPkr, "WAREHOUSE_ADMIN");
  pkrWaActor = await actorFor(pkrWaUser);

  // F1 fixture: RIDER-primary actor who ALSO holds a warehouse
  // membership at KTM — the combination that previously inherited
  // full warehouse package scope through the search gate.
  const riderWhUser = await makeUser("rider-wh", "RIDER");
  await addMembership(riderWhUser, fx.whKtm, "WAREHOUSE_STAFF");
  riderWarehouseActor = await actorFor(riderWhUser);

  // Shipping service + catch-all tariff for this run.
  serviceCode = `S3Q${RUN.slice(-6)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "Standard (search test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
  });
  await prisma.pricingRule.create({
    data: {
      shippingServiceId: service.id,
      baseRatePaisa: BigInt(15000),
      perKgRatePaisa: BigInt(5000),
      volumetricDivisor: 5000,
      createdById: fx.saUser,
    },
  });

  // Vendors: A (the searching vendor) and Other (owns the KTM booking).
  fx.vendorA = await makeVendor("VendorA");
  fx.vendorOther = await makeVendor("VendorOther");
  const vendorOwner = await makeUser("vendorA-owner", "VENDOR");
  await prisma.vendorUser.create({
    data: {
      vendorId: fx.vendorA,
      userId: vendorOwner,
      vendorRole: "OWNER",
      invitedById: fx.saUser,
    },
  });
  const address = await vendorsSvc.addVendorAddress(saActor, fx.vendorA, {
    kind: "PICKUP",
    addressLine1: "Industrial Road 1",
    city: "KtmCity",
    district: fx.districtKtm,
    province: "Bagmati",
    approve: true,
  });
  vendorAddressId = address.id;
  vendorActor = await actorFor(vendorOwner);

  // Customer account linked to a Customer record.
  const customerUser = await makeUser("customer", "CUSTOMER");
  fx.customerPhone = phone(555);
  const customer = await prisma.customer.create({
    data: {
      fullName: `S3Q Customer ${RUN}`,
      phone: fx.customerPhone,
      normalizedPhone: fx.customerPhone,
      userId: customerUser,
      createdById: fx.saUser,
    },
  });
  fx.customer = customer.id;
  fx.customerName = customer.fullName;
  customerActor = await actorFor(customerUser);

  // A driver homed at KTM, findable by name.
  const driverUser = await makeUser("driver", "RIDER", `S3Q Driver ${RUN}`);
  fx.driverName = `S3Q Driver ${RUN}`;
  await driversSvc.createDriverProfile(saActor, {
    userId: driverUser,
    homeWarehouseId: fx.whKtm,
    licenseNumber: `LIC-S3Q-${RUN}`,
    licenseCategory: "A",
    licenseExpiry: "2030-01-01",
    capabilities: ["DELIVERY", "PICKUP"] as never,
  });

  // KTM booking: SA-created for VendorOther, dropped off at KTM,
  // recipient district served by KTM itself (LAST_MILE) — so the
  // PKR warehouse scope (origin / destination / current warehouse)
  // never touches it.
  const ktmBooking = await bookingsSvc.createBooking(
    saActor,
    bookingInput({ vendorId: fx.vendorOther }),
  );
  fx.ktmBooking = ktmBooking.id;
  fx.ktmOrder = ktmBooking.orderNumber;
  fx.ktmTracking = ktmBooking.shipments[0].packages[0].trackingId;

  // Vendor A's own booking (rider pickup from its KTM address,
  // recipient in the PKR district).
  const vendorBooking = await bookingsSvc.createBooking(
    vendorActor,
    bookingInput({
      pickup: { method: "RIDER_PICKUP" as const, vendorAddressId },
      recipient: {
        name: "Vendor Recipient",
        phone: phone(202),
        addressLine: "Lakeside 9",
        city: "PkrCity",
        district: fx.districtPkr,
        province: "Gandaki",
      },
    }),
  );
  fx.vendorBooking = vendorBooking.id;
  fx.vendorOrder = vendorBooking.orderNumber;
  fx.vendorTracking = vendorBooking.shipments[0].packages[0].trackingId;

  // The customer's own booking: recipient phone matches the linked
  // Customer record, so its packages carry recipientCustomerId.
  const customerBooking = await bookingsSvc.createBooking(
    saActor,
    bookingInput({
      recipient: {
        name: fx.customerName,
        phone: fx.customerPhone,
        addressLine: "Home 1",
        city: "PkrCity",
        district: fx.districtPkr,
        province: "Gandaki",
      },
    }),
  );
  fx.customerTracking = customerBooking.shipments[0].packages[0].trackingId;
}, 180_000);

describe("GET /api/search — access gate", () => {
  it("returns 401 with no session", async () => {
    const { status } = await search(null, "BLA");
    expect(status).toBe(401);
  });

  it("returns 200 with empty groups for a <2-char query", async () => {
    const { status, body } = await search(saActor, "b");
    expect(status).toBe(200);
    expect(body.groups).toEqual([]);
  });
});

describe("GET /api/search — SUPER_ADMIN", () => {
  it("finds a package by tracking ID with a super-admin booking href", async () => {
    const { status, body } = await search(saActor, fx.ktmTracking);
    expect(status).toBe(200);
    const packages = groupOf(body, "packages");
    expect(packages).toBeDefined();
    const hit = packages!.results.find((r) => r.label === fx.ktmTracking);
    expect(hit).toBeDefined();
    expect(hit!.href).toBe(`/super-admin/bookings/${fx.ktmBooking}`);
  });

  it("finds a booking by order number", async () => {
    const { body } = await search(saActor, fx.ktmOrder);
    const bookings = groupOf(body, "bookings");
    expect(bookings).toBeDefined();
    const hit = bookings!.results.find((r) => r.label === fx.ktmOrder);
    expect(hit).toBeDefined();
    expect(hit!.href).toBe(`/super-admin/bookings/${fx.ktmBooking}`);
  });

  it("finds a vendor by business name", async () => {
    const { body } = await search(saActor, `VendorA ${RUN}`);
    const vendors = groupOf(body, "vendors");
    expect(vendors).toBeDefined();
    const hit = vendors!.results.find((r) => r.id === fx.vendorA);
    expect(hit).toBeDefined();
    expect(hit!.href).toBe(`/super-admin/vendors/${fx.vendorA}`);
  });

  it("finds a customer, a warehouse and a driver by name", async () => {
    const byCustomer = await search(saActor, `Customer ${RUN}`);
    const customers = groupOf(byCustomer.body, "customers");
    expect(customers!.results.some((r) => r.id === fx.customer)).toBe(true);
    expect(
      customers!.results.find((r) => r.id === fx.customer)!.href,
    ).toBe(`/super-admin/customers/${fx.customer}`);

    const byWarehouse = await search(saActor, `Search KTM ${RUN}`);
    const warehouses = groupOf(byWarehouse.body, "warehouses");
    expect(warehouses!.results.some((r) => r.id === fx.whKtm)).toBe(true);
    expect(
      warehouses!.results.find((r) => r.id === fx.whKtm)!.href,
    ).toBe(`/super-admin/warehouses/${fx.whKtm}`);

    const byDriver = await search(saActor, `Driver ${RUN}`);
    const drivers = groupOf(byDriver.body, "drivers");
    expect(drivers).toBeDefined();
    expect(drivers!.results.some((r) => r.label === fx.driverName)).toBe(true);
    expect(drivers!.results[0].href).toMatch(/^\/super-admin\/drivers\//);
  });
});

describe("GET /api/search — warehouse scope", () => {
  it("KTM warehouse admin finds the KTM package and booking", async () => {
    const byTracking = await search(ktmWaActor, fx.ktmTracking);
    const packages = groupOf(byTracking.body, "packages");
    expect(packages).toBeDefined();
    const hit = packages!.results.find((r) => r.label === fx.ktmTracking);
    expect(hit).toBeDefined();
    expect(hit!.href).toBe(`/warehouse/bookings/${fx.ktmBooking}`);

    const byOrder = await search(ktmWaActor, fx.ktmOrder);
    const bookings = groupOf(byOrder.body, "bookings");
    expect(bookings!.results.some((r) => r.label === fx.ktmOrder)).toBe(true);
  });

  it("PKR warehouse admin gets NO KTM package/booking — and the raw body never contains their identifiers", async () => {
    const byTracking = await search(pkrWaActor, fx.ktmTracking);
    expect(byTracking.status).toBe(200);
    expect(byTracking.raw).not.toContain(fx.ktmTracking);
    expect(groupOf(byTracking.body, "packages")).toBeUndefined();
    expect(groupOf(byTracking.body, "bookings")).toBeUndefined();

    const byOrder = await search(pkrWaActor, fx.ktmOrder);
    expect(byOrder.status).toBe(200);
    expect(byOrder.raw).not.toContain(fx.ktmOrder);
    expect(byOrder.raw).not.toContain(fx.ktmTracking);
    expect(groupOf(byOrder.body, "bookings")).toBeUndefined();
    expect(groupOf(byOrder.body, "packages")).toBeUndefined();
  });
});

describe("GET /api/search — vendor scope", () => {
  it("finds only its own organisation's booking and package", async () => {
    const byOrder = await search(vendorActor, fx.vendorOrder);
    const bookings = groupOf(byOrder.body, "bookings");
    expect(bookings).toBeDefined();
    expect(bookings!.results.map((r) => r.label)).toEqual([fx.vendorOrder]);
    expect(bookings!.results[0].href).toBe(`/vendor/bookings/${fx.vendorBooking}`);

    const byTracking = await search(vendorActor, fx.vendorTracking);
    const packages = groupOf(byTracking.body, "packages");
    expect(packages!.results.map((r) => r.label)).toEqual([fx.vendorTracking]);
    expect(packages!.results[0].href).toBe(`/vendor/bookings/${fx.vendorBooking}`);
  });

  it("never receives another vendor's booking, nor the directory groups", async () => {
    const other = await search(vendorActor, fx.ktmOrder);
    expect(other.raw).not.toContain(fx.ktmOrder);
    expect(other.raw).not.toContain(fx.ktmTracking);
    expect(other.body.groups).toEqual([]);

    const byName = await search(vendorActor, `VendorOther ${RUN}`);
    expect(byName.body.groups.map((g) => g.id)).not.toContain("vendors");
    expect(byName.body.groups.map((g) => g.id)).not.toContain("customers");
    expect(byName.body.groups.map((g) => g.id)).not.toContain("warehouses");
    expect(byName.body.groups.map((g) => g.id)).not.toContain("drivers");
  });
});

describe("GET /api/search — driver-primary warehouse exclusion (F1)", () => {
  it("RIDER-primary actor with a KTM warehouse membership gets NO packages group and no leakage", async () => {
    expect(riderWarehouseActor.primaryRole).toBe("RIDER");
    expect(riderWarehouseActor.warehouseIds).toContain(fx.whKtm);
    expect(riderWarehouseActor.permissions.has("package.read_all")).toBe(false);
    expect(riderWarehouseActor.vendorId).toBeNull();
    expect(riderWarehouseActor.customerId).toBeNull();

    const byRecipient = await search(riderWarehouseActor, "Recipient One");
    expect(byRecipient.status).toBe(200);
    expect(groupOf(byRecipient.body, "packages")).toBeUndefined();
    expect(byRecipient.raw).not.toContain(fx.ktmTracking);
    expect(byRecipient.raw).not.toContain("Recipient One");
  });

  it("tracking-ID query for the same rider actor also returns nothing (no existence oracle)", async () => {
    const byTracking = await search(riderWarehouseActor, fx.ktmTracking);
    expect(byTracking.status).toBe(200);
    expect(byTracking.raw).not.toContain(fx.ktmTracking);
    expect(byTracking.raw).not.toContain("Recipient One");
    expect(groupOf(byTracking.body, "packages")).toBeUndefined();
    expect(byTracking.body.groups).toEqual([]);
  });

  it("positive control: warehouse actor at the same warehouse still finds the package", async () => {
    const byTracking = await search(ktmWaActor, fx.ktmTracking);
    expect(byTracking.status).toBe(200);
    const packages = groupOf(byTracking.body, "packages");
    expect(packages).toBeDefined();
    expect(packages!.results.some((r) => r.label === fx.ktmTracking)).toBe(true);
  });
});

describe("GET /api/search — LIKE wildcard stripping (F2)", () => {
  it('SUPER_ADMIN q="%%" returns zero results and never leaks the planted tracking ID', async () => {
    const { status, raw, body } = await search(saActor, "%%");
    expect(status).toBe(200);
    expect(body.groups).toEqual([]);
    expect(raw).not.toContain(fx.ktmTracking);
  });

  it('SUPER_ADMIN q="%_" returns zero results and never leaks the planted tracking ID', async () => {
    const { status, raw, body } = await search(saActor, "%_");
    expect(status).toBe(200);
    expect(body.groups).toEqual([]);
    expect(raw).not.toContain(fx.ktmTracking);
  });

  it('SUPER_ADMIN q="a%" returns zero results and never leaks the planted tracking ID', async () => {
    const { status, raw, body } = await search(saActor, "a%");
    expect(status).toBe(200);
    expect(body.groups).toEqual([]);
    expect(raw).not.toContain(fx.ktmTracking);
  });

  it("legitimate partial searches still find the record (tracking prefix + recipient fragment)", async () => {
    const prefix = fx.ktmTracking.slice(0, 8);
    const byPrefix = await search(saActor, prefix);
    const packagesByPrefix = groupOf(byPrefix.body, "packages");
    expect(packagesByPrefix).toBeDefined();
    expect(packagesByPrefix!.results.some((r) => r.label === fx.ktmTracking)).toBe(true);

    const byRecipient = await search(saActor, "Recipient");
    const packagesByRecipient = groupOf(byRecipient.body, "packages");
    expect(packagesByRecipient).toBeDefined();
    expect(
      packagesByRecipient!.results.some((r) => r.label === fx.ktmTracking),
    ).toBe(true);
  });
});

describe("GET /api/search — customer scope", () => {
  it("finds its own package via the public tracking href, and only the packages group", async () => {
    const { status, body } = await search(customerActor, fx.customerTracking);
    expect(status).toBe(200);
    expect(body.groups.map((g) => g.id)).toEqual(["packages"]);
    const hit = body.groups[0].results.find((r) => r.label === fx.customerTracking);
    expect(hit).toBeDefined();
    expect(hit!.href).toBe(`/track/${fx.customerTracking}`);
  });

  it("gets no vendors/customers/warehouses/drivers groups and no one else's package", async () => {
    const byVendorName = await search(customerActor, `VendorA ${RUN}`);
    expect(byVendorName.body.groups).toEqual([]);

    const othersPackage = await search(customerActor, fx.ktmTracking);
    expect(othersPackage.raw).not.toContain(fx.ktmTracking);
    expect(othersPackage.body.groups).toEqual([]);
  });
});
