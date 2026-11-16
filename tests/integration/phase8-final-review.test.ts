import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Route-handler actor stub (phase8-api-validation pattern): only the
// NextAuth-backed resolver is replaced; services run for real.
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
 * V2 Phase 8 — FINAL INDEPENDENT SECURITY REVIEW.
 *
 * Written by a reviewer who built none of V2. Every assertion encodes
 * the SECURE expectation; a failing test is a proven finding.
 * Areas: 1 GPS stack · 2 Live Operations · 3 Admin surfaces ·
 * 4 Four-eyes invitations · 5 Phase 7 surfaces · 6 Phase 8 additions ·
 * 7 IDOR sweep on the new [id] routes (folded into areas 2/5).
 * Fixtures: direct-DB rows where the service gate is scope/status
 * (GPS/live-ops/returns/profile), real service chains where the
 * invariant is transactional (bulk booking, reassignments).
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
const email = (label: string) => `p8f-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);
const TODAY = new Date().toISOString().slice(0, 10);
const BOGUS_UUID = "00000000-0000-4000-8000-000000000000";
const PII_NAME = `PII-NAME-${RUN}`;
const PII_PHONE = phone(555);
const PII_ADDR = `PII-ADDR-${RUN} Secret Lane 99`;

let prisma: import("@prisma/client").PrismaClient;
let trackingSvc: typeof import("@/server/services/tracking");
let liveOpsSvc: typeof import("@/server/services/live-operations");
let usersSvc: typeof import("@/server/services/users");
let settingsSvc: typeof import("@/server/services/system-settings");
let auditSvc: typeof import("@/server/services/audit-log");
let invSvc: typeof import("@/server/services/invitations");
let warehousesSvc: typeof import("@/server/services/warehouses");
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let deliveriesSvc: typeof import("@/server/services/deliveries");
let incidentsSvc: typeof import("@/server/services/incidents");
let returnsSvc: typeof import("@/server/services/returns");
let driversSvc: typeof import("@/server/services/drivers");
let tripsSvc: typeof import("@/server/services/trips");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let tasksRoute: typeof import("@/app/api/tasks/route");
let handoversRoute: typeof import("@/app/api/operations/handovers/route");
let receiveRoute: typeof import("@/app/api/operations/receive/route");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let adminActor: Actor;
let sa1Actor: Actor;
let sa2Actor: Actor;
let waAActor: Actor;
let waBActor: Actor;
let waCActor: Actor;
let staffBActor: Actor;
let financeActor: Actor;
let supportActor: Actor;
let vendor1Actor: Actor;
let customerActor: Actor;
let serviceCode: string;
let vendorAddrA: string;

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
      fullName: `P8F ${label}`,
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
    data: { userId, warehouseId, roleId: role!.id, isPrimary: true, assignedById: fx.adminUser },
  });
}

let driverSeq = 0;
async function makeDriverUser(
  roleCode: "RIDER" | "LINEHAUL_DRIVER",
  homeWarehouseId: string,
  capabilities: string[],
): Promise<{ userId: string; driverId: string; actor: Actor }> {
  driverSeq += 1;
  const label = `drv${driverSeq}`;
  const userId = await makeUser(label, roleCode);
  const driver = await prisma.driver.create({
    data: {
      userId,
      homeWarehouseId,
      licenseNumber: `LIC-P8F-${label}-${RUN}`.toUpperCase(),
      licenseCategory: "B",
      licenseExpiry: new Date("2030-01-01"),
      capabilities: { create: capabilities.map((capability) => ({ capability })) },
    },
  });
  return { userId, driverId: driver.id, actor: await actorFor(userId) };
}

async function makeBatchRow(riderDriverId: string, warehouseId: string, status = "OPEN", kind = "DELIVERY") {
  return prisma.deliveryBatch.create({
    data: {
      riderId: riderDriverId,
      warehouseId,
      batchDate: new Date(TODAY),
      kind,
      status,
      createdById: fx.adminUser,
    },
  });
}

let pkgSeq = 0;
async function makePackageRow(overrides: Record<string, unknown> = {}) {
  pkgSeq += 1;
  return prisma.package.create({
    data: {
      trackingId: `BLA-P8F-${pkgSeq}-${RUN}`,
      shipmentId: fx.shipmentId,
      orderId: fx.orderId,
      recipientName: PII_NAME,
      recipientPhone: PII_PHONE,
      deliveryAddress: PII_ADDR,
      deliveryCity: "Kathmandu",
      deliveryDistrict: "Kathmandu",
      declaredWeightKg: "1.000",
      description: `Parcel P8F ${pkgSeq}`,
      ...overrides,
    },
  });
}

async function makeAssignmentRow(packageId: string, driverId: string, batchId: string, status = "PENDING") {
  return prisma.deliveryAssignment.create({
    data: {
      packageId,
      driverId,
      batchId,
      kind: "DELIVERY",
      status,
      assignedById: fx.adminUser,
    },
  });
}

let tripSeq = 0;
async function makeTripRow(driverId: string, originWh: string, destWh: string, status = "DISPATCHED") {
  tripSeq += 1;
  const vehicle = await prisma.vehicle.create({
    data: { registration: `P8F VEH ${RUN}-${tripSeq}`, type: "TRUCK", homeWarehouseId: originWh },
  });
  const transfer = await prisma.transfer.create({
    data: {
      transferNumber: `TRF-P8F-${RUN}-${tripSeq}`,
      originWarehouseId: originWh,
      destinationWarehouseId: destWh,
      status: "IN_TRANSIT",
      driverId,
      vehicleId: vehicle.id,
      createdById: fx.adminUser,
    },
  });
  const trip = await prisma.trip.create({
    data: {
      tripNumber: `TRP-P8F-${RUN}-${tripSeq}`,
      transferId: transfer.id,
      driverId,
      vehicleId: vehicle.id,
      status,
    },
  });
  await prisma.transfer.update({ where: { id: transfer.id }, data: { tripId: trip.id } });
  return { trip, transfer, vehicle };
}

const pingBody = (sessionId: string, sequenceId: number, overrides: Record<string, unknown> = {}) => ({
  trackingSessionId: sessionId,
  latitude: 27.7,
  longitude: 85.3,
  accuracyMeters: 12,
  recordedAt: new Date().toISOString(),
  sequenceId,
  ...overrides,
});

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
  usersSvc = await import("@/server/services/users");
  settingsSvc = await import("@/server/services/system-settings");
  auditSvc = await import("@/server/services/audit-log");
  invSvc = await import("@/server/services/invitations");
  warehousesSvc = await import("@/server/services/warehouses");
  bookingsSvc = await import("@/server/services/bookings");
  vendorsSvc = await import("@/server/services/vendors");
  deliveriesSvc = await import("@/server/services/deliveries");
  incidentsSvc = await import("@/server/services/incidents");
  returnsSvc = await import("@/server/services/returns");
  driversSvc = await import("@/server/services/drivers");
  tripsSvc = await import("@/server/services/trips");
  errors = await import("@/lib/errors");
  actorErrors = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");
  tasksRoute = await import("@/app/api/tasks/route");
  handoversRoute = await import("@/app/api/operations/handovers/route");
  receiveRoute = await import("@/app/api/operations/receive/route");

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
        where: { roleId_permissionId: { roleId: roleId.get(role.code)!, permissionId: permissionId.get(code)! } },
        update: {},
        create: { roleId: roleId.get(role.code)!, permissionId: permissionId.get(code)! },
      });
    }
  }

  fx.districtA = `P8F District A ${RUN}`;
  fx.districtB = `P8F District B ${RUN}`;
  fx.districtC = `P8F District C ${RUN}`;
  const mkWh = async (suffix: string, name: string, district: string) => {
    const wh = await prisma.warehouse.create({
      data: {
        code: `P8F${suffix}-${RUN}`.slice(0, 30),
        name,
        type: "REGIONAL",
        status: "ACTIVE",
        district,
        city: name,
        province: "Bagmati",
        country: "Nepal",
      },
    });
    await prisma.serviceArea.upsert({
      where: { district_name: { district, name: `${name} Area` } },
      update: { servingWarehouseId: wh.id, isActive: true },
      create: { name: `${name} Area`, district, city: name, province: "Bagmati", servingWarehouseId: wh.id },
    });
    return wh.id;
  };
  fx.whA = await mkWh("A", "P8F Alpha", fx.districtA);
  fx.whB = await mkWh("B", "P8F Beta", fx.districtB);
  fx.whC = await mkWh("C", "P8F Gamma", fx.districtC);

  fx.adminUser = await makeUser("admin", "ADMIN");
  adminActor = await actorFor(fx.adminUser);
  fx.sa1User = await makeUser("sa1", "SUPER_ADMIN");
  sa1Actor = await actorFor(fx.sa1User);
  fx.sa2User = await makeUser("sa2", "SUPER_ADMIN");
  sa2Actor = await actorFor(fx.sa2User);

  fx.waA = await makeUser("waA", "WAREHOUSE_ADMIN");
  await addMembership(fx.waA, fx.whA, "WAREHOUSE_ADMIN");
  fx.waB = await makeUser("waB", "WAREHOUSE_ADMIN");
  await addMembership(fx.waB, fx.whB, "WAREHOUSE_ADMIN");
  fx.waC = await makeUser("waC", "WAREHOUSE_ADMIN");
  await addMembership(fx.waC, fx.whC, "WAREHOUSE_ADMIN");
  waAActor = await actorFor(fx.waA);
  waBActor = await actorFor(fx.waB);
  waCActor = await actorFor(fx.waC);
  fx.staffB = await makeUser("staffB", "WAREHOUSE_STAFF");
  await addMembership(fx.staffB, fx.whB, "WAREHOUSE_STAFF");
  staffBActor = await actorFor(fx.staffB);
  financeActor = await actorFor(await makeUser("finance", "FINANCE"));
  supportActor = await actorFor(await makeUser("support", "SUPPORT"));
  fx.customerUser = await makeUser("customer", "CUSTOMER");
  await prisma.customer.create({
    data: { fullName: "P8F Customer", phone: phone(777), normalizedPhone: phone(777), userId: fx.customerUser },
  });
  customerActor = await actorFor(fx.customerUser);

  // Shared order/shipment for direct package fixtures.
  const service = await prisma.shippingService.create({
    data: { code: `P8FSVC${RUN.slice(-5)}`.toUpperCase(), name: "P8F Service" },
  });
  serviceCode = service.code;
  await prisma.pricingRule.create({
    data: {
      shippingServiceId: service.id,
      baseRatePaisa: BigInt(15000),
      perKgRatePaisa: BigInt(5000),
      volumetricDivisor: 5000,
      createdById: fx.adminUser,
    },
  });
  const order = await prisma.order.create({
    data: {
      orderNumber: `ORD-P8F-${RUN}`,
      createdById: fx.adminUser,
      createdByRole: "ADMIN",
      senderName: "P8F Sender",
      senderPhone: phone(42),
      destinationDistrict: "Kathmandu",
      paymentMethod: "CASH",
      pickupMethod: "WAREHOUSE_DROPOFF",
    },
  });
  fx.orderId = order.id;
  const shipment = await prisma.shipment.create({
    data: {
      shipmentNumber: `SHP-P8F-${RUN}`,
      orderId: order.id,
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
      routeKind: "INTER_WAREHOUSE",
      shippingServiceId: service.id,
      shippingChargePaisa: BigInt(0),
    },
  });
  fx.shipmentId = shipment.id;

  // Vendors for the bulk-booking probes.
  async function makeVendor(label: string) {
    const vendor = await vendorsSvc.createVendor(adminActor, {
      businessName: `P8F Vendor ${label} ${RUN}`,
      contactName: "P8F Contact",
      email: email(`vendor-${label}`),
      phone: phone(11),
      billingPreference: "COD_OFFSET",
      creditLimitPaisa: null,
      registrationNumber: null,
    });
    await vendorsSvc.setVendorVerificationStatus(adminActor, vendor.id, { target: "UNDER_REVIEW", notes: null });
    await vendorsSvc.setVendorVerificationStatus(adminActor, vendor.id, { target: "APPROVED", notes: null });
    const ownerUserId = await makeUser(`owner-${label}`, "VENDOR");
    await prisma.vendorUser.create({
      data: { userId: ownerUserId, vendorId: vendor.id, vendorRole: "OWNER", isActive: true, invitedById: fx.adminUser },
    });
    return { vendorId: vendor.id, ownerUserId };
  }
  const v1 = await makeVendor("one");
  fx.vendor1 = v1.vendorId;
  fx.vendor1Owner = v1.ownerUserId;
  const v2 = await makeVendor("two");
  fx.vendor2 = v2.vendorId;
  vendor1Actor = await actorFor(fx.vendor1Owner);
  const addr = await vendorsSvc.addVendorAddress(adminActor, fx.vendor1, {
    kind: "PICKUP",
    addressLine1: "Pickup Road 1",
    city: "P8F Alpha",
    district: fx.districtA,
    province: "Bagmati",
    approve: true,
  });
  vendorAddrA = addr.id;
}, 240_000);

// ===========================================================================
// 1 — GPS STACK
// ===========================================================================

describe("1 GPS — identity, lifecycle, ownership, supervisor scope", () => {
  it("ping for another driver is refused even with the body driverId spoofed to the owner; no ping written; denial audited", async () => {
    const owner = await makeDriverUser("RIDER", fx.whB, ["DELIVERY"]);
    const attacker = await makeDriverUser("RIDER", fx.whB, ["DELIVERY"]);
    const batch = await makeBatchRow(owner.driverId, fx.whB);
    const session = await trackingSvc.startTrackingSession(owner.actor, {
      deliveryBatchId: batch.id,
      permissionAcknowledged: true,
    });
    await expect(
      trackingSvc.postLocationPing(attacker.actor, pingBody(session.id, 1, { driverId: owner.driverId })),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    expect(await prisma.driverLocationPing.count({ where: { trackingSessionId: session.id } })).toBe(0);
    const denial = await prisma.auditLog.findFirst({
      where: { action: "access.denied", actorId: attacker.userId, entityId: session.id },
    });
    expect(denial).not.toBeNull();
    await trackingSvc.stopTrackingSession(owner.actor, session.id);
  });

  it("ping after session end is refused (Conflict) and writes nothing", async () => {
    const rider = await makeDriverUser("RIDER", fx.whB, ["DELIVERY"]);
    const batch = await makeBatchRow(rider.driverId, fx.whB);
    const session = await trackingSvc.startTrackingSession(rider.actor, {
      deliveryBatchId: batch.id,
      permissionAcknowledged: true,
    });
    await trackingSvc.stopTrackingSession(rider.actor, session.id);
    await expect(trackingSvc.postLocationPing(rider.actor, pingBody(session.id, 1))).rejects.toBeInstanceOf(
      errors.ConflictError,
    );
    expect(await prisma.driverLocationPing.count({ where: { trackingSessionId: session.id } })).toBe(0);
  });

  it("ping after the batch went terminal behind the session's back is refused (in-transaction re-check)", async () => {
    const rider = await makeDriverUser("RIDER", fx.whB, ["DELIVERY"]);
    const batch = await makeBatchRow(rider.driverId, fx.whB);
    const session = await trackingSvc.startTrackingSession(rider.actor, {
      deliveryBatchId: batch.id,
      permissionAcknowledged: true,
    });
    await prisma.deliveryBatch.update({ where: { id: batch.id }, data: { status: "COMPLETED" } });
    await expect(trackingSvc.postLocationPing(rider.actor, pingBody(session.id, 1))).rejects.toBeInstanceOf(
      errors.ConflictError,
    );
    expect(await prisma.driverLocationPing.count({ where: { trackingSessionId: session.id } })).toBe(0);
    await prisma.trackingSession.update({ where: { id: session.id }, data: { status: "ENDED", endedAt: new Date() } });
  });

  it("session start for a batch/trip the driver does not hold is refused + audited; no session created", async () => {
    const owner = await makeDriverUser("RIDER", fx.whB, ["DELIVERY"]);
    const intruder = await makeDriverUser("RIDER", fx.whB, ["DELIVERY"]);
    const batch = await makeBatchRow(owner.driverId, fx.whB);
    await expect(
      trackingSvc.startTrackingSession(intruder.actor, { deliveryBatchId: batch.id, permissionAcknowledged: true }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const { trip } = await makeTripRow(owner.driverId, fx.whA, fx.whB);
    await expect(
      trackingSvc.startTrackingSession(intruder.actor, { tripId: trip.id, permissionAcknowledged: true }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    expect(await prisma.trackingSession.count({ where: { driverId: intruder.driverId } })).toBe(0);
  });

  it("pause/resume/stop of another driver's session are all refused and the session survives ACTIVE", async () => {
    const owner = await makeDriverUser("RIDER", fx.whB, ["DELIVERY"]);
    const other = await makeDriverUser("RIDER", fx.whB, ["DELIVERY"]);
    const batch = await makeBatchRow(owner.driverId, fx.whB);
    const session = await trackingSvc.startTrackingSession(owner.actor, {
      deliveryBatchId: batch.id,
      permissionAcknowledged: true,
    });
    await expect(trackingSvc.pauseTrackingSession(other.actor, session.id)).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(trackingSvc.resumeTrackingSession(other.actor, session.id)).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(trackingSvc.stopTrackingSession(other.actor, session.id)).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const row = await prisma.trackingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.status).toBe("ACTIVE");
    await trackingSvc.stopTrackingSession(owner.actor, session.id);
  });

  it("supervisor stop scope: WA of an unrelated warehouse cannot stop a session; the session's WA can", async () => {
    const rider = await makeDriverUser("RIDER", fx.whB, ["DELIVERY"]);
    const batch = await makeBatchRow(rider.driverId, fx.whB);
    const session = await trackingSvc.startTrackingSession(rider.actor, {
      deliveryBatchId: batch.id,
      permissionAcknowledged: true,
    });
    await expect(trackingSvc.stopTrackingSession(waCActor, session.id)).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(trackingSvc.stopTrackingSession(waAActor, session.id)).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    let row = await prisma.trackingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.status).toBe("ACTIVE");
    const stopped = await trackingSvc.stopTrackingSession(waBActor, session.id);
    expect(stopped.status).toBe("ENDED");
    row = await prisma.trackingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.endReason).toBe("SUPERVISOR");
  });
});

// ===========================================================================
// 2 — LIVE OPERATIONS (+ 7 IDOR on the detail route)
// ===========================================================================

describe("2 Live Operations — scope cannot be widened, COD/PII gating, denied roles", () => {
  let sessionId = "";
  let codBatchId = "";
  let liveRider: Awaited<ReturnType<typeof makeDriverUser>>;
  const COD_PAISA = "9876500";

  beforeAll(async () => {
    liveRider = await makeDriverUser("RIDER", fx.whB, ["DELIVERY"]);
    const batch = await makeBatchRow(liveRider.driverId, fx.whB, "IN_PROGRESS");
    codBatchId = batch.id;
    const pkg = await makePackageRow({ currentWarehouseId: fx.whB, operationalStatus: "OUT_FOR_DELIVERY" });
    const assignment = await makeAssignmentRow(pkg.id, liveRider.driverId, batch.id, "COMPLETED");
    await prisma.deliveryCodCollection.create({
      data: {
        packageId: pkg.id,
        shipmentId: fx.shipmentId,
        assignmentId: assignment.id,
        batchId: batch.id,
        expectedPaisa: BigInt(COD_PAISA),
        collectedPaisa: BigInt(COD_PAISA),
        status: "MATCHED",
        collectedById: liveRider.userId,
      },
    });
    const session = await trackingSvc.startTrackingSession(liveRider.actor, {
      deliveryBatchId: batch.id,
      permissionAcknowledged: true,
    });
    sessionId = session.id;
    await trackingSvc.postLocationPing(liveRider.actor, pingBody(sessionId, 1));
    fx.liveSession = sessionId;
    fx.liveTrackingId = pkg.trackingId;
  });

  it("WA@A cannot widen scope via warehouseId filter or search: foreign session never appears", async () => {
    const byFilter = await liveOpsSvc.listLiveOperations(waAActor, { warehouseId: fx.whB });
    expect(byFilter.items.map((i) => i.trackingSessionId)).not.toContain(sessionId);
    expect(byFilter.total).toBe(0);
    const bySearch = await liveOpsSvc.listLiveOperations(waAActor, { search: fx.liveTrackingId });
    expect(bySearch.items.map((i) => i.trackingSessionId)).not.toContain(sessionId);
    const plain = await liveOpsSvc.listLiveOperations(waAActor, {});
    expect(plain.items.map((i) => i.trackingSessionId)).not.toContain(sessionId);
    // Control: WA@B does see it.
    const own = await liveOpsSvc.listLiveOperations(waBActor, {});
    expect(own.items.map((i) => i.trackingSessionId)).toContain(sessionId);
  });

  it("IDOR: WA@A substituting the foreign session id on detail is refused + audited, with no data returned", async () => {
    await expect(liveOpsSvc.getLiveOperationDetail(waAActor, sessionId)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    const denial = await prisma.auditLog.findFirst({
      where: { action: "access.denied", actorId: fx.waA, entityId: sessionId },
    });
    expect(denial).not.toBeNull();
  });

  it("roles without operations.live_view get nothing from list AND detail", async () => {
    const riderActor = liveRider.actor;
    for (const [label, actor] of [
      ["rider", riderActor],
      ["vendor", vendor1Actor],
      ["customer", customerActor],
      ["staff", staffBActor],
      ["finance", financeActor],
      ["support", supportActor],
    ] as const) {
      await expect(liveOpsSvc.listLiveOperations(actor, {}), label).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
      await expect(liveOpsSvc.getLiveOperationDetail(actor, sessionId), label).rejects.toBeInstanceOf(
        actorErrors.AuthorizationError,
      );
    }
  });

  it("COD field is ABSENT for a live_view holder without cod.read/finance.read, present for WA@B (cod.read) as control; no recipient PII in detail", async () => {
    const stripped: Actor = {
      ...waBActor,
      permissions: new Set([...waBActor.permissions].filter((p) => p !== "cod.read" && p !== "finance.read")),
    };
    expect(stripped.permissions.has("operations.live_view")).toBe(true);
    const detail = await liveOpsSvc.getLiveOperationDetail(stripped, sessionId);
    expect("codCollectedPaisa" in detail).toBe(false);
    expect(JSON.stringify(detail)).not.toContain(COD_PAISA);
    const list = await liveOpsSvc.listLiveOperations(stripped, {});
    const item = list.items.find((i) => i.trackingSessionId === sessionId);
    expect(item).toBeDefined();
    expect(item && "codCollectedPaisa" in item).toBe(false);

    const withCod = await liveOpsSvc.getLiveOperationDetail(waBActor, sessionId);
    expect(withCod.codCollectedPaisa).toBe(COD_PAISA);

    // PII: the package carries distinctive recipient name/phone/address.
    const json = JSON.stringify(withCod);
    expect(json).not.toContain(PII_NAME);
    expect(json).not.toContain(PII_PHONE);
    expect(json).not.toContain(PII_ADDR);
    expect(json).toContain(fx.liveTrackingId);
    void codBatchId;
  });
});

// ===========================================================================
// 3 — ADMIN SURFACES
// ===========================================================================

describe("3 Admin — Users & Roles escalation boundary, membership scope, Settings, Audit viewer", () => {
  it("setUserRoles: ADMIN and WA are refused (no role.manage); SA self-edit refused; SA granting SUPER_ADMIN succeeds (the documented boundary)", async () => {
    const targetId = await makeUser("target", "CUSTOMER");
    await expect(usersSvc.setUserRoles(adminActor, targetId, ["ADMIN"])).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(usersSvc.setUserRoles(waAActor, targetId, ["ADMIN"])).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // ADMIN cannot grant SUPER_ADMIN through this surface at all.
    await expect(usersSvc.setUserRoles(adminActor, targetId, ["SUPER_ADMIN"])).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    let target = await prisma.user.findUniqueOrThrow({
      where: { id: targetId },
      include: { roles: { include: { role: true } } },
    });
    expect(target.roles.map((r) => r.role.code)).toEqual(["CUSTOMER"]);

    await expect(usersSvc.setUserRoles(sa1Actor, fx.sa1User, ["ADMIN"])).rejects.toBeInstanceOf(errors.DomainValidationError);
    const granted = await usersSvc.setUserRoles(sa1Actor, targetId, ["SUPER_ADMIN"]);
    expect(granted.roles).toEqual(["SUPER_ADMIN"]);
    target = await prisma.user.findUniqueOrThrow({
      where: { id: targetId },
      include: { roles: { include: { role: true } } },
    });
    expect(target.roles.map((r) => r.role.code)).toEqual(["SUPER_ADMIN"]);
  });

  it("membership edits outside scope: WA@A cannot assign into B, cannot appoint a WA in own warehouse, CAN assign staff in own warehouse", async () => {
    const staffUserId = await makeUser("member-target", "WAREHOUSE_STAFF");
    const staffEmail = (await prisma.user.findUniqueOrThrow({ where: { id: staffUserId } })).email;
    await expect(
      warehousesSvc.assignMember(waAActor, fx.whB, { email: staffEmail, roleCode: "WAREHOUSE_STAFF" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      warehousesSvc.assignMember(waAActor, fx.whA, { email: staffEmail, roleCode: "WAREHOUSE_ADMIN" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    expect(
      await prisma.warehouseMembership.count({ where: { userId: staffUserId, revokedAt: null } }),
    ).toBe(0);
    const ok = await warehousesSvc.assignMember(waAActor, fx.whA, { email: staffEmail, roleCode: "WAREHOUSE_STAFF" });
    expect(ok.warehouseId ?? fx.whA).toBeTruthy();
    expect(
      await prisma.warehouseMembership.count({ where: { userId: staffUserId, warehouseId: fx.whA, revokedAt: null } }),
    ).toBe(1);
  });

  it("Settings writes by ADMIN / WA / FINANCE are refused; nothing is stored", async () => {
    const before = await prisma.systemSetting.findUnique({ where: { key: "auth.mfa_required_for_privileged" } });
    for (const actor of [adminActor, waAActor, financeActor]) {
      await expect(
        settingsSvc.updateSetting(actor, "auth.mfa_required_for_privileged", false),
      ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    }
    const after = await prisma.systemSetting.findUnique({ where: { key: "auth.mfa_required_for_privileged" } });
    expect(JSON.stringify(after?.value ?? null)).toBe(JSON.stringify(before?.value ?? null));
  });

  it("tracking.config bounds: SA patches below floors / above caps are rejected whole and the stored row is unchanged", async () => {
    const before = await prisma.systemSetting.findUnique({ where: { key: "tracking.config" } });
    const beforeJson = JSON.stringify(before?.value ?? null);
    await expect(
      settingsSvc.updateSetting(sa1Actor, "tracking.config", { minPingIntervalSeconds: 1 }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      settingsSvc.updateSetting(sa1Actor, "tracking.config", { retentionDays: 99999 }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      settingsSvc.updateSetting(sa1Actor, "tracking.config", { futureTimestampToleranceSeconds: 5 }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      settingsSvc.updateSetting(sa1Actor, "session.idle_timeout.staff_hours", 0),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      settingsSvc.updateSetting(sa1Actor, "session.idle_timeout.staff_hours", 169),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    const after = await prisma.systemSetting.findUnique({ where: { key: "tracking.config" } });
    expect(JSON.stringify(after?.value ?? null)).toBe(beforeJson);
  });

  it("Audit Logs viewer cannot be widened by filters: WA@A stays scoped under warehouseId / entityType / actorSearch filters", async () => {
    const marker = `F8PROBE-${RUN}`;
    await prisma.auditLog.create({
      data: { actorId: fx.waA, actorRole: "WAREHOUSE_ADMIN", action: "f8.probe", entityType: marker, entityId: "a-row", warehouseId: fx.whA },
    });
    await prisma.auditLog.create({
      data: { actorId: fx.waB, actorRole: "WAREHOUSE_ADMIN", action: "f8.probe", entityType: marker, entityId: "b-row", warehouseId: fx.whB },
    });
    const byType = await auditSvc.listAuditLogs(waAActor, { entityType: marker, pageSize: 50 });
    expect(byType.items.map((i) => i.entityId)).toEqual(["a-row"]);
    const byWarehouse = await auditSvc.listAuditLogs(waAActor, { entityType: marker, warehouseId: fx.whB, pageSize: 50 });
    expect(byWarehouse.total).toBe(0);
    const waBEmail = (await prisma.user.findUniqueOrThrow({ where: { id: fx.waB } })).email;
    const byActor = await auditSvc.listAuditLogs(waAActor, { entityType: marker, actorSearch: waBEmail, pageSize: 50 });
    expect(byActor.total).toBe(0);
    // Control: the global reader sees both.
    const global = await auditSvc.listAuditLogs(adminActor, { entityType: marker, pageSize: 50 });
    expect(global.total).toBe(2);
  });
});

// ===========================================================================
// 4 — FOUR-EYES INVITATIONS
// ===========================================================================

describe("4 Four-eyes invitations", () => {
  it("self-approval refused + audited; non-privileged approver refused; redemption before approval refused (generic)", async () => {
    const created = await invSvc.createInvitation(sa1Actor, { email: email("new-admin"), roleCode: "ADMIN" });
    expect(created.status).toBe("PENDING_APPROVAL");
    await expect(invSvc.approveInvitation(sa1Actor, created.invitationId)).rejects.toBeInstanceOf(errors.DomainValidationError);
    const denial = await prisma.auditLog.findFirst({
      where: { action: "access.denied", entityType: "UserInvitation", entityId: created.invitationId, actorId: fx.sa1User },
    });
    expect(denial).not.toBeNull();
    expect(JSON.stringify(denial?.after)).toContain("invitation_self_approval");
    await expect(invSvc.approveInvitation(waAActor, created.invitationId)).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(invSvc.approveInvitation(financeActor, created.invitationId)).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      invSvc.acceptInvitation({ token: created.token, fullName: "New Admin", password: "Fixture#2026" }),
    ).rejects.toThrow(invSvc.INVITATION_GENERIC_REFUSAL);
    const row = await prisma.userInvitation.findUniqueOrThrow({ where: { id: created.invitationId } });
    expect(row.status).toBe("PENDING_APPROVAL");
    fx.inv1 = created.invitationId;
    fx.inv1Token = created.token;
  });

  it("control: a second Super Admin approves, then redemption succeeds exactly once", async () => {
    const approved = await invSvc.approveInvitation(sa2Actor, fx.inv1);
    expect(approved.status).toBe("PENDING");
    const accepted = await invSvc.acceptInvitation({ token: fx.inv1Token, fullName: "New Admin", password: "Fixture#2026" });
    expect(accepted.roleCode).toBe("ADMIN");
    await expect(
      invSvc.acceptInvitation({ token: fx.inv1Token, fullName: "New Admin", password: "Fixture#2026" }),
    ).rejects.toThrow(invSvc.INVITATION_GENERIC_REFUSAL);
  });

  it("a rejected invitation cannot be redeemed", async () => {
    const created = await invSvc.createInvitation(sa1Actor, { email: email("rejected-admin"), roleCode: "ADMIN" });
    const rejected = await invSvc.rejectInvitation(sa2Actor, created.invitationId, "Not approved");
    expect(rejected.status).toBe("REJECTED");
    await expect(
      invSvc.acceptInvitation({ token: created.token, fullName: "Rejected Admin", password: "Fixture#2026" }),
    ).rejects.toThrow(invSvc.INVITATION_GENERIC_REFUSAL);
  });

  it("an invitation that expired while PENDING_APPROVAL cannot be approved; it flips to EXPIRED", async () => {
    const created = await invSvc.createInvitation(sa1Actor, { email: email("expired-admin"), roleCode: "ADMIN" });
    await prisma.userInvitation.update({
      where: { id: created.invitationId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await expect(invSvc.approveInvitation(sa2Actor, created.invitationId)).rejects.toBeInstanceOf(errors.DomainValidationError);
    const row = await prisma.userInvitation.findUniqueOrThrow({ where: { id: created.invitationId } });
    expect(row.status).toBe("EXPIRED");
    await expect(
      invSvc.acceptInvitation({ token: created.token, fullName: "Expired Admin", password: "Fixture#2026" }),
    ).rejects.toThrow(invSvc.INVITATION_GENERIC_REFUSAL);
  });
});

// ===========================================================================
// 5 — PHASE 7 SURFACES
// ===========================================================================

describe("5a incidents — driver scope (own work only)", () => {
  it("a driver cannot attach an incident to another driver's assignment/package, and cannot read the other's incident", async () => {
    const riderA = await makeDriverUser("RIDER", fx.whB, ["DELIVERY"]);
    const riderB = await makeDriverUser("RIDER", fx.whB, ["DELIVERY"]);
    const batchA = await makeBatchRow(riderA.driverId, fx.whB);
    const batchB = await makeBatchRow(riderB.driverId, fx.whB);
    const pkgA = await makePackageRow({ currentWarehouseId: fx.whB });
    const pkgB = await makePackageRow({ currentWarehouseId: fx.whB });
    const asgA = await makeAssignmentRow(pkgA.id, riderA.driverId, batchA.id);
    const asgB = await makeAssignmentRow(pkgB.id, riderB.driverId, batchB.id);
    const before = await prisma.incident.count({ where: { reporterId: riderA.userId } });
    await expect(
      incidentsSvc.createIncident(riderA.actor, {
        category: "DELIVERY_FAILURE",
        description: "Probe linking rider B assignment",
        deliveryAssignmentId: asgB.id,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      incidentsSvc.createIncident(riderA.actor, {
        category: "DAMAGED_PACKAGE",
        description: "Probe linking rider B package",
        packageId: pkgB.id,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    expect(await prisma.incident.count({ where: { reporterId: riderA.userId } })).toBe(before);

    const own = await incidentsSvc.createIncident(riderA.actor, {
      category: "DELIVERY_FAILURE",
      description: "Recipient gate locked, could not deliver",
      deliveryAssignmentId: asgA.id,
    });
    await expect(incidentsSvc.getIncident(riderB.actor, own.id)).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const listB = await incidentsSvc.listIncidents(riderB.actor, { pageSize: 100 });
    expect(listB.items.map((i) => i.id)).not.toContain(own.id);
  });
});

function vendorRow(vendorId: string, suffix: number, overrides: Record<string, unknown> = {}) {
  return {
    vendorId,
    sender: { name: "P8F Bulk Sender", phone: phone(42), email: null },
    recipient: {
      name: "P8F Bulk Recipient",
      phone: phone(suffix),
      addressLine: "Bulk Road 1",
      city: "Town",
      district: fx.districtB,
      province: "Bagmati",
    },
    pickup: { method: "RIDER_PICKUP" as const, vendorAddressId: vendorAddrA },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Box", quantity: 1, weightKg: 1 }],
    ...overrides,
  };
}
function staffRow(originWarehouseId: string, suffix: number) {
  return {
    sender: { name: "Walk-in Sender", phone: phone(44), email: null },
    recipient: {
      name: "P8F Staff Recipient",
      phone: phone(suffix),
      addressLine: "Main Road 1",
      city: "Town",
      district: fx.districtB,
      province: "Bagmati",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Parcel", quantity: 1, weightKg: 1 }],
  };
}

describe("5b bulk booking — cross-vendor + atomicity", () => {
  it("vendor A booking as vendor B in row 2 refuses the WHOLE bulk: zero orders written", async () => {
    const before = await prisma.order.count({ where: { createdById: fx.vendor1Owner } });
    const failure = await bookingsSvc
      .createBulkBookings(vendor1Actor, { orders: [vendorRow(fx.vendor1, 201), vendorRow(fx.vendor2, 202)] as never })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(actorErrors.AuthorizationError);
    expect((failure as Error).message).toContain("Row 2");
    expect(await prisma.order.count({ where: { createdById: fx.vendor1Owner } })).toBe(before);
  });

  it("in-transaction failure on row 2 (bogus warehouse) rolls back row 1 — no partial writes", async () => {
    const before = await prisma.order.count({ where: { createdById: fx.adminUser } });
    const failure = await bookingsSvc
      .createBulkBookings(adminActor, { orders: [staffRow(fx.whA, 211), staffRow(BOGUS_UUID, 212)] as never })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(errors.DomainValidationError);
    expect(await prisma.order.count({ where: { createdById: fx.adminUser } })).toBe(before);
  });
});

describe("5c batch reassignment custody + trip driver replacement", () => {
  it("reassignBatch: exactly one open custody (the new rider's); the old rider cannot act on the moved assignment", async () => {
    const oldRider = await makeDriverUser("RIDER", fx.whB, ["DELIVERY", "PICKUP"]);
    const newRider = await makeDriverUser("RIDER", fx.whB, ["DELIVERY", "PICKUP"]);
    const batch = await makeBatchRow(oldRider.driverId, fx.whB, "IN_PROGRESS");
    const pkg = await makePackageRow({ currentWarehouseId: fx.whB, operationalStatus: "OUT_FOR_DELIVERY" });
    const asg = await makeAssignmentRow(pkg.id, oldRider.driverId, batch.id, "IN_PROGRESS");
    await prisma.packageCustody.create({
      data: { packageId: pkg.id, custodianType: "USER", custodianUserId: oldRider.userId },
    });
    const result = await deliveriesSvc.reassignBatch(waBActor, batch.id, {
      riderUserId: newRider.userId,
      reason: "Old rider called in sick",
    });
    expect(result.assignments).toHaveLength(1);
    const open = await prisma.packageCustody.findMany({ where: { packageId: pkg.id, endedAt: null } });
    expect(open).toHaveLength(1);
    expect(open[0].custodianUserId).toBe(newRider.userId);
    const oldRow = await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: asg.id } });
    expect(oldRow.status).toBe("REASSIGNED");
    const newAsg = result.assignments[0];
    await expect(
      deliveriesSvc.confirmDelivery(oldRider.actor, newAsg.id, { receivedByName: "X", otpCode: "123456" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("replaceTripDriver en route: custody + trip move to the new driver; the old driver's session is ENDED (REASSIGNED) and pings fail", async () => {
    const oldDriver = await makeDriverUser("LINEHAUL_DRIVER", fx.whA, ["LINEHAUL"]);
    const newDriver = await makeDriverUser("LINEHAUL_DRIVER", fx.whA, ["LINEHAUL"]);
    const { trip, transfer } = await makeTripRow(oldDriver.driverId, fx.whA, fx.whB, "IN_TRANSIT");
    const pkg = await makePackageRow({ currentWarehouseId: fx.whA, operationalStatus: "IN_TRANSIT" });
    await prisma.transferItem.create({
      data: { transferId: transfer.id, packageId: pkg.id, itemStatus: "LOADED" },
    });
    await prisma.packageCustody.create({
      data: { packageId: pkg.id, custodianType: "USER", custodianUserId: oldDriver.userId },
    });
    await prisma.driver.update({ where: { id: oldDriver.driverId }, data: { availabilityStatus: "ON_TRIP", currentTripId: trip.id } });
    const session = await trackingSvc.startTrackingSession(oldDriver.actor, {
      tripId: trip.id,
      permissionAcknowledged: true,
    });
    const view = await tripsSvc.replaceTripDriver(waAActor, trip.id, {
      driverId: newDriver.driverId,
      reason: "Old driver reported fatigue",
    });
    expect(view.driverId).toBe(newDriver.driverId);
    const open = await prisma.packageCustody.findMany({ where: { packageId: pkg.id, endedAt: null } });
    expect(open).toHaveLength(1);
    expect(open[0].custodianUserId).toBe(newDriver.userId);
    const sessionRow = await prisma.trackingSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(sessionRow.status).toBe("ENDED");
    expect(sessionRow.endReason).toBe("REASSIGNED");
    await expect(trackingSvc.postLocationPing(oldDriver.actor, pingBody(session.id, 1))).rejects.toBeInstanceOf(
      errors.ConflictError,
    );
  });

  it("replaceTripDriver refuses a pre-departure trip", async () => {
    const oldDriver = await makeDriverUser("LINEHAUL_DRIVER", fx.whA, ["LINEHAUL"]);
    const newDriver = await makeDriverUser("LINEHAUL_DRIVER", fx.whA, ["LINEHAUL"]);
    const { trip } = await makeTripRow(oldDriver.driverId, fx.whA, fx.whB, "ASSIGNED");
    await expect(
      tripsSvc.replaceTripDriver(waAActor, trip.id, { driverId: newDriver.driverId, reason: "Too early swap" }),
    ).rejects.toThrow(/en route|depart/i);
    const row = await prisma.trip.findUniqueOrThrow({ where: { id: trip.id } });
    expect(row.driverId).toBe(oldDriver.driverId);
  });
});

describe("5d returns — inspect/complete scoped to the package's physical warehouse", () => {
  it("WA@A cannot inspect or complete a return whose package physically sits at B; WA@B inspects it (control)", async () => {
    const pkg = await makePackageRow({ currentWarehouseId: fx.whB, operationalStatus: "RECEIVED_AT_DESTINATION" });
    const ret = await prisma.returnRequest.create({
      data: {
        returnNumber: `RET-P8F-${RUN}`,
        packageId: pkg.id,
        shipmentId: fx.shipmentId,
        orderId: fx.orderId,
        warehouseId: fx.whA,
        destinationWarehouseId: fx.whB,
        reason: "RECIPIENT_REFUSED",
        status: "RECEIVED",
        requestedById: fx.adminUser,
        conditionAtInitiation: "GOOD",
      },
    });
    await expect(returnsSvc.inspectReturn(waAActor, ret.id, { condition: "GOOD" })).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    let row = await prisma.returnRequest.findUniqueOrThrow({ where: { id: ret.id } });
    expect(row.status).toBe("RECEIVED");
    const inspected = await returnsSvc.inspectReturn(waBActor, ret.id, { condition: "GOOD" });
    expect(inspected.status).toBe("INSPECTED");
    await expect(returnsSvc.completeReturn(waAActor, ret.id, {})).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    row = await prisma.returnRequest.findUniqueOrThrow({ where: { id: ret.id } });
    expect(row.status).toBe("INSPECTED");
  });
});

describe("5e POD evidence reuse (regression) + 5f driver profile scope/GPS gating", () => {
  it("the same evidence reference bound to a second package is refused inside the transaction; exactly one binding survives", async () => {
    const rider = await makeDriverUser("RIDER", fx.whB, ["DELIVERY"]);
    const batch = await makeBatchRow(rider.driverId, fx.whB, "IN_PROGRESS");
    const pkg1 = await makePackageRow();
    const pkg2 = await makePackageRow();
    const asg1 = await makeAssignmentRow(pkg1.id, rider.driverId, batch.id, "COMPLETED");
    const asg2 = await makeAssignmentRow(pkg2.id, rider.driverId, batch.id, "COMPLETED");
    const pod1 = await prisma.proofOfDelivery.create({
      data: { packageId: pkg1.id, assignmentId: asg1.id, deliveredAt: new Date(), recordedById: fx.adminUser },
    });
    const pod2 = await prisma.proofOfDelivery.create({
      data: { packageId: pkg2.id, assignmentId: asg2.id, deliveredAt: new Date(), recordedById: fx.adminUser },
    });
    const ref = `evidence://p8f-${RUN}-photo-1`;
    const hash = deliveriesSvc.hashEvidenceReference(ref);
    await prisma.$transaction((tx) =>
      deliveriesSvc.bindDeliveryEvidence(tx, {
        evidenceHash: hash,
        evidenceKind: "PHOTO",
        packageId: pkg1.id,
        assignmentId: asg1.id,
        proofOfDeliveryId: pod1.id,
        createdById: fx.adminUser,
      }),
    );
    await expect(
      prisma.$transaction((tx) =>
        deliveriesSvc.bindDeliveryEvidence(tx, {
          evidenceHash: hash,
          evidenceKind: "SIGNATURE",
          packageId: pkg2.id,
          assignmentId: asg2.id,
          proofOfDeliveryId: pod2.id,
          createdById: fx.adminUser,
        }),
      ),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    expect(await prisma.deliveryEvidenceBinding.count({ where: { evidenceHash: hash } })).toBe(1);
  });

  it("IDOR: WA@A reading a driver homed at B is denied + audited; gps key is absent without operations.live_view and present with it", async () => {
    const driverB = await makeDriverUser("RIDER", fx.whB, ["DELIVERY"]);
    await expect(driversSvc.getDriverProfile(waAActor, driverB.driverId)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    const denial = await prisma.auditLog.findFirst({
      where: { action: "access.denied", actorId: fx.waA, entityType: "Driver", entityId: driverB.driverId },
    });
    expect(denial).not.toBeNull();
    const noGpsActor: Actor = {
      ...waBActor,
      permissions: new Set([...waBActor.permissions].filter((p) => p !== "operations.live_view")),
    };
    const profile = await driversSvc.getDriverProfile(noGpsActor, driverB.driverId);
    expect("gps" in profile).toBe(false);
    const withGps = await driversSvc.getDriverProfile(waBActor, driverB.driverId);
    expect("gps" in withGps).toBe(true);
  });
});

// ===========================================================================
// 6 — PHASE 8 ADDITIONS
// ===========================================================================

describe("6 Phase 8 — kind gate, maintenance not exposed over HTTP, malformed JSON = 400", () => {
  it("createDeliveryBatch kind gate: pickup-only actor refused DELIVERY, delivery-only actor refused PICKUP, no batch rows written on refusals", async () => {
    const rider = await makeDriverUser("RIDER", fx.whB, ["DELIVERY", "PICKUP"]);
    const pickupOnly: Actor = { ...waBActor, permissions: new Set(["pickup.assign"]) };
    const deliveryOnly: Actor = { ...waBActor, permissions: new Set(["delivery.assign"]) };
    const before = await prisma.deliveryBatch.count({ where: { warehouseId: fx.whB, createdById: fx.waB } });
    await expect(
      deliveriesSvc.createDeliveryBatch(pickupOnly, { warehouseId: fx.whB, riderUserId: rider.userId, batchDate: TODAY, kind: "DELIVERY" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      deliveriesSvc.createDeliveryBatch(deliveryOnly, { warehouseId: fx.whB, riderUserId: rider.userId, batchDate: TODAY, kind: "PICKUP" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    expect(await prisma.deliveryBatch.count({ where: { warehouseId: fx.whB, createdById: fx.waB } })).toBe(before);
    const ok = await deliveriesSvc.createDeliveryBatch(pickupOnly, {
      warehouseId: fx.whB,
      riderUserId: rider.userId,
      batchDate: TODAY,
      kind: "PICKUP",
    });
    expect(ok.kind).toBe("PICKUP");
  });

  it("no HTTP route exposes the tracking maintenance functions", () => {
    const apiRoot = join(process.cwd(), "src/app/api");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(apiRoot);
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toContain("runTrackingMaintenance");
      expect(text, file).not.toContain("expireAbandonedTrackingSessions");
      expect(text, file).not.toContain("pruneExpiredLocationPings");
      expect(text, file).not.toContain("tracking-maintenance");
    }
  });

  it("malformed JSON on swept routes answers 400, not 500 (tasks, handovers, operations/receive)", async () => {
    mockState.actor = adminActor;
    const malformed = () =>
      new Request("http://test.invalid/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ this is not json",
      });
    const tasksRes = await tasksRoute.POST(malformed());
    expect(tasksRes.status).toBe(400);
    const handoversRes = await handoversRoute.POST(malformed());
    expect(handoversRes.status).toBe(400);
    const receiveRes = await receiveRoute.POST(malformed());
    expect(receiveRes.status).toBe(400);
    mockState.actor = null;
  });
});
