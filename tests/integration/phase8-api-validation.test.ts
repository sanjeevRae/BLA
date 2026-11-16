import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Route handlers under test resolve their actor through
// "@/lib/auth/permissions" (NextAuth-backed). Stub ONLY that resolver
// (the invitation-security.test.ts pattern): the real actor module
// (errors, requireAccessGranted) is kept, services run for real
// against bla_test, and mockState.actor = null simulates an
// expired / invalid session cookie (getActorContext → null → 401).
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
 * Phase 8 (V2) — API request-validation & failure behaviour, at the
 * ROUTE-HANDLER level (the Phase 3 / Phase 7 suites drive services
 * directly; this suite drives the actual POST/GET handlers with
 * real Request objects so status codes are the evidence):
 *  1. malformed JSON → 400, never 500 (tracking ping/session,
 *     bulk booking, single booking, incident report);
 *  2. wrong types / out-of-range GPS values → 400, no ping row;
 *  3. missing required fields → 400;
 *  4. oversized payloads → 400, no partial write;
 *  5. duplicate GPS ping replay at the API level → 200 deduplicated;
 *  6. duplicate bulk submission (documents the absence of an
 *     idempotency key — see report finding) + double-approve guard;
 *  7. no session (expired/invalid cookie) → 401, never 500;
 *  8. warehouse membership revoked → next rebuilt actor is refused
 *     on a scoped V2 read (service level; the getActorContext path
 *     itself is covered by phase2-adversarial "membership
 *     revocation immediacy");
 *  9. freshness never upgrades itself: repeated live-operations
 *     reads of a stale snapshot stay STALE and write nothing.
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
const email = (label: string) => `p8v-${label}-${RUN}@bla.test`;
const phone = (n: number) => `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);

let prisma: import("@prisma/client").PrismaClient;
let trackingSvc: typeof import("@/server/services/tracking");
let liveOpsSvc: typeof import("@/server/services/live-operations");
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let errors: typeof import("@/lib/errors");
let catalog: typeof import("@/lib/permissions/catalog");
let locationRoute: typeof import("@/app/api/tracking/location/route");
let sessionStartRoute: typeof import("@/app/api/tracking/session/start/route");
let bulkRoute: typeof import("@/app/api/bookings/bulk/route");
let bookingsRoute: typeof import("@/app/api/bookings/route");
let incidentsRoute: typeof import("@/app/api/incidents/route");
let liveOpsRoute: typeof import("@/app/api/live-operations/route");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let adminActor: Actor;
let riderActor: Actor;
let vendorActor: Actor;
let vendorAddressId: string;
let serviceCode: string;

/** Mirror of getActorContext (permissions.ts) incl. driver/vendor links. */
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
      fullName: `P8V ${label}`,
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

function postJson(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const pingBody = (overrides: Record<string, unknown> = {}) => ({
  trackingSessionId: fx.session,
  latitude: 27.7,
  longitude: 85.3,
  accuracyMeters: 12,
  recordedAt: new Date().toISOString(),
  sequenceId: 500,
  ...overrides,
});

function vendorRow(overrides: Record<string, unknown> = {}) {
  return {
    recipient: {
      name: "P8V Recipient",
      phone: phone(101),
      addressLine: "Lakeside 6",
      city: "Beta",
      district: fx.districtB,
      province: "Gandaki",
    },
    pickup: { method: "RIDER_PICKUP" as const, vendorAddressId },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Box of goods", quantity: 1, weightKg: 1.2 }],
    ...overrides,
  };
}

const pingCount = () =>
  prisma.driverLocationPing.count({ where: { trackingSessionId: fx.session } });
const vendorOrderCount = () =>
  prisma.order.count({ where: { createdById: fx.vendorOwner } });

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
  trackingSvc = await import("@/server/services/tracking");
  liveOpsSvc = await import("@/server/services/live-operations");
  bookingsSvc = await import("@/server/services/bookings");
  vendorsSvc = await import("@/server/services/vendors");
  errors = await import("@/lib/errors");
  catalog = await import("@/lib/permissions/catalog");
  locationRoute = await import("@/app/api/tracking/location/route");
  sessionStartRoute = await import("@/app/api/tracking/session/start/route");
  bulkRoute = await import("@/app/api/bookings/bulk/route");
  bookingsRoute = await import("@/app/api/bookings/route");
  incidentsRoute = await import("@/app/api/incidents/route");
  liveOpsRoute = await import("@/app/api/live-operations/route");

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

  // Warehouses + service areas (bulk-booking routing fixtures).
  fx.districtA = `P8VAlpha District ${RUN}`;
  fx.districtB = `P8VBeta District ${RUN}`;
  const w1 = await prisma.warehouse.create({
    data: { code: `P8A-${RUN}`, name: `P8V Alpha ${RUN}`, district: fx.districtA, city: "Alpha", province: "Bagmati" },
  });
  const w2 = await prisma.warehouse.create({
    data: { code: `P8B-${RUN}`, name: `P8V Beta ${RUN}`, district: fx.districtB, city: "Beta", province: "Gandaki" },
  });
  fx.w1 = w1.id;
  fx.w2 = w2.id;
  for (const [district, name, warehouseId] of [
    [fx.districtA, "Alpha Area P8V", fx.w1],
    [fx.districtB, "Beta Area P8V", fx.w2],
  ] as const) {
    await prisma.serviceArea.create({
      data: { name: `${name} ${RUN}`, district, city: name.includes("Alpha") ? "Alpha" : "Beta", province: "Bagmati", servingWarehouseId: warehouseId },
    });
  }

  fx.adminUser = await makeUser("admin", "ADMIN");
  adminActor = await actorFor(fx.adminUser);

  // Shipping service + tariff for bulk rows.
  serviceCode = `P8V${RUN.slice(-6)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "Standard P8V (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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

  // Rider + batch + a live tracking session for the ping routes.
  const riderUser = await makeUser("rider", "RIDER");
  const driver = await prisma.driver.create({
    data: {
      userId: riderUser,
      homeWarehouseId: fx.w1,
      licenseNumber: `LIC-P8V-${RUN}`,
      licenseExpiry: new Date("2028-01-01"),
    },
  });
  fx.riderDriver = driver.id;
  riderActor = await actorFor(riderUser);
  const batch = await prisma.deliveryBatch.create({
    data: {
      riderId: fx.riderDriver,
      warehouseId: fx.w1,
      batchDate: new Date(new Date().toISOString().slice(0, 10)),
      kind: "DELIVERY",
      status: "OPEN",
      createdById: fx.adminUser,
    },
  });
  fx.batch = batch.id;
  const session = await trackingSvc.startTrackingSession(riderActor, {
    deliveryBatchId: fx.batch,
    permissionAcknowledged: true,
  });
  fx.session = session.id;

  // Approved vendor + owner + approved pickup address (bulk rows,
  // duplicate-submit and double-approve fixtures).
  const vendor = await vendorsSvc.createVendor(adminActor, {
    businessName: `P8V Vendor ${RUN}`,
    contactName: "P8V Contact",
    email: email("vendor"),
    phone: phone(11),
    billingPreference: "COD_OFFSET",
    creditLimitPaisa: null,
    registrationNumber: null,
  });
  fx.vendor = vendor.id;
  await vendorsSvc.setVendorVerificationStatus(adminActor, vendor.id, { target: "UNDER_REVIEW", notes: null });
  await vendorsSvc.setVendorVerificationStatus(adminActor, vendor.id, { target: "APPROVED", notes: null });
  fx.vendorOwner = await makeUser("vendor-owner", "VENDOR");
  await prisma.vendorUser.create({
    data: { vendorId: vendor.id, userId: fx.vendorOwner, vendorRole: "OWNER", invitedById: fx.adminUser },
  });
  const address = await vendorsSvc.addVendorAddress(adminActor, vendor.id, {
    kind: "PICKUP",
    addressLine1: "Industrial Road 1",
    city: "Alpha",
    district: fx.districtA,
    province: "Bagmati",
    approve: true,
  });
  vendorAddressId = address.id;
  vendorActor = await actorFor(fx.vendorOwner);
}, 180_000);

// ---------------------------------------------------------------------------
// 1. Malformed JSON → 400, never 500
// ---------------------------------------------------------------------------

describe("Phase 8 API — malformed JSON bodies", () => {
  it("tracking location POST with unparseable JSON → 400, no ping written", async () => {
    mockState.actor = riderActor;
    const before = await pingCount();
    const res = await locationRoute.POST(
      postJson("http://localhost/api/tracking/location", "{not json"),
    );
    expect(res.status).toBe(400);
    expect(await pingCount()).toBe(before);
  });

  it("tracking session start POST with unparseable JSON → 400", async () => {
    mockState.actor = riderActor;
    const res = await sessionStartRoute.POST(
      postJson("http://localhost/api/tracking/session/start", '{"deliveryBatchId":'),
    );
    expect(res.status).toBe(400);
  });

  it("bulk booking POST with unparseable JSON → 400, no orders written", async () => {
    mockState.actor = vendorActor;
    const before = await vendorOrderCount();
    const res = await bulkRoute.POST(
      postJson("http://localhost/api/bookings/bulk", "{oops") as never,
    );
    expect(res.status).toBe(400);
    expect(await vendorOrderCount()).toBe(before);
  });

  it("single booking POST with unparseable JSON → 400, no orders written", async () => {
    mockState.actor = vendorActor;
    const before = await vendorOrderCount();
    const res = await bookingsRoute.POST(
      postJson("http://localhost/api/bookings", "not-json-at-all") as never,
    );
    expect(res.status).toBe(400);
    expect(await vendorOrderCount()).toBe(before);
  });

  it("incident report POST with unparseable JSON → 400, no incident written", async () => {
    mockState.actor = adminActor;
    const before = await prisma.incident.count({ where: { reporterId: fx.adminUser } });
    const res = await incidentsRoute.POST(
      postJson("http://localhost/api/incidents", "{{{"),
    );
    expect(res.status).toBe(400);
    expect(await prisma.incident.count({ where: { reporterId: fx.adminUser } })).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 5 (run early: it owns the session's first accepted ping). Duplicate
// ping replay at the API level.
// ---------------------------------------------------------------------------

describe("Phase 8 API — duplicate GPS ping replay", () => {
  it("replaying the same (session, sequenceId) returns 200 deduplicated and writes no second row", async () => {
    mockState.actor = riderActor;
    const body = pingBody({ sequenceId: 500 });
    const first = await locationRoute.POST(
      postJson("http://localhost/api/tracking/location", body),
    );
    expect(first.status).toBe(200);
    expect((await first.json()).deduplicated).toBe(false);
    expect(await pingCount()).toBe(1);

    // The replay is refused nothing and creates nothing: the
    // duplicate-sequence check runs before the rate-limit gate, so
    // an immediate retry is an idempotent 200, not a 429.
    const replay = await locationRoute.POST(
      postJson("http://localhost/api/tracking/location", body),
    );
    expect(replay.status).toBe(200);
    expect((await replay.json()).deduplicated).toBe(true);
    expect(await pingCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. Wrong types / out-of-range / missing fields → 400, no write
// ---------------------------------------------------------------------------

describe("Phase 8 API — ping payload validation", () => {
  it("rejects wrong types and out-of-range values with 400 and no DB write", async () => {
    mockState.actor = riderActor;
    const before = await pingCount();
    const cases: Record<string, unknown>[] = [
      { latitude: "27.7" }, // latitude as string
      { longitude: "85.3" }, // longitude as string
      { accuracyMeters: "12" }, // accuracy as string
      { sequenceId: "501" }, // sequence as string
      { latitude: 91 }, // latitude out of range
      { latitude: -90.5 },
      { longitude: 181 }, // longitude out of range
      { longitude: -181 },
      { accuracyMeters: -5 }, // negative accuracy
      { accuracyMeters: 0 }, // zero accuracy
      { accuracyMeters: 999_999 }, // beyond the configured maximum
      { recordedAt: "not-a-date" }, // unparseable timestamp
      { recordedAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() }, // future
    ];
    for (const overrides of cases) {
      const res = await locationRoute.POST(
        postJson(
          "http://localhost/api/tracking/location",
          pingBody({ sequenceId: 600, ...overrides }),
        ),
      );
      expect(res.status, JSON.stringify(overrides)).toBe(400);
    }
    expect(await pingCount()).toBe(before);
  });

  it("rejects missing required fields with 400 and no DB write", async () => {
    mockState.actor = riderActor;
    const before = await pingCount();
    // Only the session id: latitude/longitude/accuracy/recordedAt/
    // sequenceId are all required by the ping schema.
    const res = await locationRoute.POST(
      postJson("http://localhost/api/tracking/location", {
        trackingSessionId: fx.session,
      }),
    );
    expect(res.status).toBe(400);
    const empty = await locationRoute.POST(
      postJson("http://localhost/api/tracking/location", {}),
    );
    expect(empty.status).toBe(400);
    expect(await pingCount()).toBe(before);
  });

  it("session start without the permission acknowledgement → 400", async () => {
    mockState.actor = riderActor;
    const res = await sessionStartRoute.POST(
      postJson("http://localhost/api/tracking/session/start", {
        deliveryBatchId: fx.batch,
      }),
    );
    expect(res.status).toBe(400);
  });

  it("bulk booking with a row missing its recipient → 400, zero orders", async () => {
    mockState.actor = vendorActor;
    const before = await vendorOrderCount();
    const broken = vendorRow();
    delete (broken as { recipient?: unknown }).recipient;
    const res = await bulkRoute.POST(
      postJson("http://localhost/api/bookings/bulk", { orders: [broken] }) as never,
    );
    expect(res.status).toBe(400);
    expect(await vendorOrderCount()).toBe(before);
  });

  it("incident report missing category/description → 400", async () => {
    mockState.actor = adminActor;
    const res = await incidentsRoute.POST(
      postJson("http://localhost/api/incidents", { description: "something broke" }),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 4. Oversized payloads → rejected, no partial write
// ---------------------------------------------------------------------------

describe("Phase 8 API — oversized payloads", () => {
  it("bulk booking with 51 rows → 400 and zero orders created", async () => {
    mockState.actor = vendorActor;
    const before = await vendorOrderCount();
    const rows = Array.from({ length: 51 }, (_, i) =>
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
    const res = await bulkRoute.POST(
      postJson("http://localhost/api/bookings/bulk", { orders: rows }) as never,
    );
    expect(res.status).toBe(400);
    expect(await vendorOrderCount()).toBe(before);
  });

  it("bulk booking with an absurdly long string field → 400, zero orders", async () => {
    mockState.actor = vendorActor;
    const before = await vendorOrderCount();
    const row = vendorRow({
      recipient: {
        name: "x".repeat(5000),
        phone: phone(777),
        addressLine: "A 1",
        city: "Beta",
        district: fx.districtB,
        province: "Gandaki",
      },
    });
    const res = await bulkRoute.POST(
      postJson("http://localhost/api/bookings/bulk", { orders: [row] }) as never,
    );
    expect(res.status).toBe(400);
    expect(await vendorOrderCount()).toBe(before);
  });

  it("incident report with an absurdly long description → 400, no incident", async () => {
    mockState.actor = adminActor;
    const before = await prisma.incident.count({ where: { reporterId: fx.adminUser } });
    const res = await incidentsRoute.POST(
      postJson("http://localhost/api/incidents", {
        category: "DAMAGED_PACKAGE",
        description: "d".repeat(100_000),
      }),
    );
    expect(res.status).toBe(400);
    expect(await prisma.incident.count({ where: { reporterId: fx.adminUser } })).toBe(before);
  });

  it("ping with a sequenceId beyond the int4 column → 400, no write", async () => {
    mockState.actor = riderActor;
    const before = await pingCount();
    const res = await locationRoute.POST(
      postJson(
        "http://localhost/api/tracking/location",
        pingBody({ sequenceId: 2 ** 40 }),
      ),
    );
    expect(res.status).toBe(400);
    expect(await pingCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 6. Duplicate bulk submission + double-approve
// ---------------------------------------------------------------------------

describe("Phase 8 API — duplicate create / approve", () => {
  it("FINDING (documented behaviour): the same bulk payload submitted twice creates two distinct bookings — no idempotency key exists", async () => {
    mockState.actor = vendorActor;
    const payload = { orders: [vendorRow()] };
    const before = await vendorOrderCount();

    const first = await bulkRoute.POST(
      postJson("http://localhost/api/bookings/bulk", payload) as never,
    );
    expect(first.status).toBe(201);
    const second = await bulkRoute.POST(
      postJson("http://localhost/api/bookings/bulk", payload) as never,
    );
    expect(second.status).toBe(201);

    expect(await vendorOrderCount()).toBe(before + 2);
    const firstId = (await first.json()).bookings[0].id;
    const secondId = (await second.json()).bookings[0].id;
    expect(secondId).not.toBe(firstId);
    fx.pendingBooking = firstId;
  });

  it("double-approve of the same booking is refused with a conflict (state guard)", async () => {
    const approved = await bookingsSvc.approveBooking(adminActor, fx.pendingBooking);
    expect(approved.approvalStatus).toBe("APPROVED");
    await expect(
      bookingsSvc.approveBooking(adminActor, fx.pendingBooking),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    const row = await prisma.order.findUnique({ where: { id: fx.pendingBooking } });
    expect(row?.approvalStatus).toBe("APPROVED");
  });
});

// ---------------------------------------------------------------------------
// 7. No session (expired / invalid cookie) → 401, never 500
// ---------------------------------------------------------------------------

describe("Phase 8 API — unauthenticated requests", () => {
  it("every V2 route answers 401 when getActorContext resolves null", async () => {
    mockState.actor = null;
    try {
      const ping = await locationRoute.POST(
        postJson("http://localhost/api/tracking/location", pingBody()),
      );
      expect(ping.status).toBe(401);

      const start = await sessionStartRoute.POST(
        postJson("http://localhost/api/tracking/session/start", {
          deliveryBatchId: fx.batch,
          permissionAcknowledged: true,
        }),
      );
      expect(start.status).toBe(401);

      const bulk = await bulkRoute.POST(
        postJson("http://localhost/api/bookings/bulk", { orders: [vendorRow()] }) as never,
      );
      expect(bulk.status).toBe(401);

      const incident = await incidentsRoute.POST(
        postJson("http://localhost/api/incidents", {
          category: "DAMAGED_PACKAGE",
          description: "unauthenticated attempt",
        }),
      );
      expect(incident.status).toBe(401);

      const board = await liveOpsRoute.GET(
        new Request("http://localhost/api/live-operations"),
      );
      expect(board.status).toBe(401);
    } finally {
      mockState.actor = adminActor;
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Freshness never upgrades itself
// ---------------------------------------------------------------------------

describe("Phase 8 API — freshness is read-time only", () => {
  it("repeated live-operations reads of a stale snapshot stay STALE and write nothing", async () => {
    // Fixture: an ACTIVE session whose snapshot last received a ping
    // 20 minutes ago. The stored freshnessState deliberately says
    // FRESH — the read path must compute from the receive clock,
    // never trust or "repair" the stored value.
    const user = await makeUser("stale-rider", "RIDER");
    const driver = await prisma.driver.create({
      data: {
        userId: user,
        homeWarehouseId: fx.w1,
        licenseNumber: `LIC-P8S-${RUN}`,
        licenseExpiry: new Date("2028-01-01"),
      },
    });
    const batch = await prisma.deliveryBatch.create({
      data: {
        riderId: driver.id,
        warehouseId: fx.w1,
        batchDate: new Date(new Date().toISOString().slice(0, 10)),
        kind: "DELIVERY",
        status: "OPEN",
        createdById: fx.adminUser,
      },
    });
    const session = await prisma.trackingSession.create({
      data: {
        driverId: driver.id,
        deliveryBatchId: batch.id,
        trackingType: "DELIVERY",
        originWarehouseId: fx.w1,
        status: "ACTIVE",
        startReason: "DRIVER",
        permissionAcknowledgedAt: new Date(),
      },
    });
    const receivedAt = new Date(Date.now() - 1200 * 1000);
    await prisma.driverCurrentLocation.create({
      data: {
        driverId: driver.id,
        trackingSessionId: session.id,
        latitude: 27.7,
        longitude: 85.3,
        accuracyMeters: 10,
        lastRecordedAt: receivedAt,
        lastReceivedAt: receivedAt,
        freshnessState: "FRESH",
        activeBatchId: batch.id,
      },
    });

    mockState.actor = adminActor;
    for (let read = 0; read < 2; read++) {
      const { items } = await liveOpsSvc.listLiveOperations(adminActor, {});
      const item = items.find((i) => i.trackingSessionId === session.id);
      expect(item?.freshnessState).toBe("STALE");
    }
    // No read wrote anything back: the snapshot row is untouched
    // and no ping materialised to "refresh" it.
    const snapshot = await prisma.driverCurrentLocation.findUnique({
      where: { driverId: driver.id },
    });
    expect(snapshot?.lastReceivedAt.toISOString()).toBe(receivedAt.toISOString());
    expect(snapshot?.freshnessState).toBe("FRESH"); // stored value as-is
    expect(
      await prisma.driverLocationPing.count({ where: { trackingSessionId: session.id } }),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Membership revoked mid-session → refused on the NEXT request
// (the real getActorContext rebuild is covered by
// phase2-adversarial.test.ts "membership revocation immediacy";
// this re-verifies the consequence on a V2 scoped read.)
// ---------------------------------------------------------------------------

describe("Phase 8 API — membership revoked mid-session", () => {
  it("a warehouse admin whose membership is revoked no longer sees the warehouse's live operations", async () => {
    const waUser = await makeUser("revoked-wa", "WAREHOUSE_ADMIN");
    await addMembership(waUser, fx.w1, "WAREHOUSE_ADMIN");
    const before = await actorFor(waUser);
    expect(before.warehouseIds).toContain(fx.w1);
    const visibleBefore = await liveOpsSvc.listLiveOperations(before, {});
    expect(
      visibleBefore.items.some((i) => i.trackingSessionId === fx.session),
    ).toBe(true);

    await prisma.warehouseMembership.updateMany({
      where: { userId: waUser, warehouseId: fx.w1, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // The NEXT request rebuilds the actor from current DB state:
    // the warehouse is gone from scope and the session with it.
    const after = await actorFor(waUser);
    expect(after.warehouseIds).toEqual([]);
    const visibleAfter = await liveOpsSvc.listLiveOperations(after, {});
    expect(
      visibleAfter.items.some((i) => i.trackingSessionId === fx.session),
    ).toBe(false);
    await expect(
      liveOpsSvc.getLiveOperationDetail(after, fx.session),
    ).rejects.toThrow();
  });
});
