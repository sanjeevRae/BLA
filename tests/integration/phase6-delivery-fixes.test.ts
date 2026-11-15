import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 6 security-review fix batch regressions (P6-R1…P6-R7 +
 * the OTP bcrypt-cost alignment). Each test re-runs the reviewer's
 * attack against the fixed services:
 *
 *  - P6-R2: concurrent wrong OTPs must count atomically and lock
 *    at the threshold (the reviewer left the counter at 1 with 6
 *    parallel guesses); a regeneration racing a delivery must not
 *    desynchronise the POD hash (lock-held deterministic queue).
 *  - P6-R3: cancel-after-pickup (the reviewer's lock-held PoC)
 *    must refuse, and closeBatch must refuse a batch whose package
 *    is physically out even if a CANCELLED assignment row claims
 *    otherwise.
 *  - P6-R4: scan-back must not receive a REQUESTED return;
 *    authorisation stays possible and effective afterwards.
 *  - P6-R5: concurrent approve + reject of one return yields
 *    exactly one outcome.
 *  - P6-R6: the detailed-tracking lockout must not extend itself;
 *    unknown codes write no audit row; malformed codes write
 *    nothing; success clears prior failures.
 *  - P6-R7: scan-back of an OUT_FOR_DELIVERY package needs a
 *    Warehouse Admin + a reason, and records the displaced rider.
 *  - P6-R1 (interim): OTP regeneration is restricted to the
 *    assigned rider / batch-warehouse WA / unscoped actors.
 *
 * Fixtures mirror tests/integration/deliveries.test.ts but use
 * their own shared warehouses (WH-ZP6F-*) and districts so the two
 * suites never interfere; users/vendors/bookings are per-run
 * unique.
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
const email = (label: string) => `p6f-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);
const RECIPIENT_PHONE = phone(101);
const TODAY = new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let inventorySvc: typeof import("@/server/services/inventory");
let transfersSvc: typeof import("@/server/services/transfers");
let tripsSvc: typeof import("@/server/services/trips");
let driversSvc: typeof import("@/server/services/drivers");
let vehiclesSvc: typeof import("@/server/services/vehicles");
let deliveriesSvc: typeof import("@/server/services/deliveries");
let returnsSvc: typeof import("@/server/services/returns");
let packagesSvc: typeof import("@/server/services/packages");
let otpLib: typeof import("@/lib/deliveries/otp");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let trackingLib: typeof import("@/lib/bookings/tracking");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
let staffBActor: Awaited<ReturnType<typeof actorFor>>;
let waStaffBActor: Awaited<ReturnType<typeof actorFor>>;
let linehaulActor: Awaited<ReturnType<typeof actorFor>>;
let riderAActor: Awaited<ReturnType<typeof actorFor>>;
let riderBActor: Awaited<ReturnType<typeof actorFor>>;
let serviceCode: string;

/** Mirror of getActorContext (permissions.ts) incl. the driver link. */
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
      fullName: `P6F ${label}`,
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
  { code: "ZONE-RET", name: "Returns", kind: "RETURNS" },
] as const;

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
    const location =
      (await prisma.storageLocation.findUnique({
        where: { fullCode: `${code}/${def.code}/R1` },
      })) ??
      (await prisma.storageLocation.create({
        data: { zoneId: zone.id, rack: "R1", fullCode: `${code}/${def.code}/R1` },
      }));
    locations[def.kind] = location.id;
  }
  return { id: warehouse.id, locations };
}

async function bookOne(
  codAmountPaisa = "0",
): Promise<{ packageId: string; trackingId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId: fx.vendor,
    sender: { name: "P6F Sender", phone: phone(42), email: null },
    recipient: {
      name: "P6F Recipient",
      phone: RECIPIENT_PHONE,
      addressLine: "Lakeside Street 1",
      city: "Town",
      district: fx.districtB,
      province: "Bagmati",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: fx.whA },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa,
    items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
  });
  const pkg = booking.shipments[0].packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId };
}

/** Full chain: book at A → receive/inspect/put-away/ready at A →
 *  transfer A→B → destination receive → RECEIVED_AT_DESTINATION at B. */
async function atDestination(
  codAmountPaisa = "0",
): Promise<{ packageId: string; trackingId: string }> {
  const { packageId, trackingId } = await bookOne(codAmountPaisa);
  await inventorySvc.receivePackage(staffAActor, { warehouseId: fx.whA, trackingId });
  await inventorySvc.moveToInspection(staffAActor, packageId);
  await inventorySvc.startInspection(staffAActor, packageId);
  await inventorySvc.recordInspection(staffAActor, {
    packageId,
    condition: "GOOD",
    actualWeightKg: 2,
  });
  await inventorySvc.putAwayPackage(staffAActor, packageId, fx.locStoA);
  await inventorySvc.markReadyForDispatch(staffAActor, packageId);

  const transfer = await transfersSvc.createTransfer(waAActor, {
    originWarehouseId: fx.whA,
    destinationWarehouseId: fx.whB,
  });
  const added = await transfersSvc.addTransferItems(waAActor, transfer.id, [packageId]);
  expect(added.rejected).toEqual([]);
  await transfersSvc.generateManifest(waAActor, transfer.id);
  const crewed = await transfersSvc.assignTransferCrew(waAActor, {
    transferId: transfer.id,
    driverId: fx.linehaulProfile,
    vehicleId: fx.vehicle,
  });
  const loaded = await transfersSvc.loadTransferPackage(waAActor, transfer.id, {
    trackingId,
    idempotencyKey: `p6f-load-${RUN}-${trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(linehaulActor, tripId);
  await tripsSvc.arriveTrip(linehaulActor, tripId);
  const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
    trackingId,
    idempotencyKey: `p6f-unload-${RUN}-${trackingId}`,
  });
  expect(scan.kind).toBe("RECEIVED_SCAN");
  await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
    packageId,
    condition: "GOOD",
  });
  await transfersSvc.finishReceiving(waBActor, transfer.id);
  await transfersSvc.reconcileTransfer(waBActor, transfer.id);
  await transfersSvc.closeTransfer(waBActor, transfer.id);
  const pkg = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
  expect(pkg.operationalStatus).toBe("RECEIVED_AT_DESTINATION");
  expect(pkg.currentWarehouseId).toBe(fx.whB);
  return { packageId, trackingId };
}

async function makeBatch(riderUserId: string) {
  return deliveriesSvc.createDeliveryBatch(waBActor, {
    warehouseId: fx.whB,
    riderUserId,
    batchDate: TODAY,
    kind: "DELIVERY",
  });
}

/** Batch + assign + pickup; returns the assignment and its one-time OTP. */
async function outForDelivery(codAmountPaisa = "0") {
  const parcel = await atDestination(codAmountPaisa);
  const batch = await makeBatch(fx.riderAUser);
  const added = await deliveriesSvc.addBatchPackages(waBActor, batch.id, {
    packageIds: [parcel.packageId],
  });
  expect(added.rejected).toEqual([]);
  expect(added.added).toHaveLength(1);
  const pickup = await deliveriesSvc.confirmPickup(riderAActor, batch.id, {
    trackingIds: [parcel.trackingId],
  });
  expect(pickup.failed).toEqual([]);
  expect(pickup.taken).toHaveLength(1);
  return {
    ...parcel,
    batch,
    assignment: added.added[0],
    otp: await recipientOtp(pickup.taken[0].assignmentId),
  };
}

const wrongOtpFor = (real: string) => (real === "000000" ? "111111" : "000000");

/**
 * Phase 8 (P6-R1 closure): pickup/regenerate responses no longer
 * carry the delivery code — tests obtain it the way a recipient
 * would, from the recipient-addressed DELIVERY_OTP notification.
 */
async function recipientOtp(assignmentId: string): Promise<string> {
  const note = await prisma.notification.findFirst({
    where: {
      category: "DELIVERY_OTP",
      channel: "TRACKING",
      entityType: "DeliveryAssignment",
      entityId: assignmentId,
    },
    orderBy: { createdAt: "desc" },
  });
  const payload = note?.payload as { otpCode?: string } | null;
  if (!payload?.otpCode) throw new Error(`No recipient OTP notification for ${assignmentId}`);
  return payload.otpCode;
}

/**
 * Hold the Package row lock from a separate transaction so service
 * calls queue behind it in start order (the reviewer's PoC
 * technique): start call A, let it reach the lock queue, start
 * call B, then release — A commits first, B observes A's committed
 * state. Deterministic, no reliance on wall-clock races between
 * the two service calls themselves.
 */
async function holdPackageLock(packageId: string) {
  let release!: () => void;
  let signalLocked!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const isLocked = new Promise<void>((r) => (signalLocked = r));
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "app"."Package" WHERE "id" = ${packageId} FOR UPDATE`;
      signalLocked();
      await gate;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  await isLocked;
  return { release: () => release(), done };
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
  transfersSvc = await import("@/server/services/transfers");
  tripsSvc = await import("@/server/services/trips");
  driversSvc = await import("@/server/services/drivers");
  vehiclesSvc = await import("@/server/services/vehicles");
  deliveriesSvc = await import("@/server/services/deliveries");
  returnsSvc = await import("@/server/services/returns");
  packagesSvc = await import("@/server/services/packages");
  otpLib = await import("@/lib/deliveries/otp");
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

  fx.districtA = "P6F Alpha District";
  fx.districtB = "P6F Beta District";
  const a = await ensureWarehouse("WH-ZP6F-01", "P6F Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  const b = await ensureWarehouse("WH-ZP6F-02", "P6F Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;

  serviceCode = `P6FSTD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P6F Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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

  const vendor = await vendorsSvc.createVendor(adminActor, {
    businessName: `P6F Vendor ${RUN}`,
    contactName: "P6F Contact",
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
  fx.vendorOwnerUser = await makeUser("vendorOwner", "VENDOR");
  await prisma.vendorUser.create({
    data: {
      userId: fx.vendorOwnerUser,
      vendorId: fx.vendor,
      vendorRole: "OWNER",
      isActive: true,
      invitedById: fx.adminUser,
    },
  });

  fx.waA = await makeUser("waA", "WAREHOUSE_ADMIN");
  await addMembership(fx.waA, fx.whA, "WAREHOUSE_ADMIN");
  fx.staffA = await makeUser("staffA", "WAREHOUSE_STAFF");
  await addMembership(fx.staffA, fx.whA, "WAREHOUSE_STAFF");
  fx.waB = await makeUser("waB", "WAREHOUSE_ADMIN");
  await addMembership(fx.waB, fx.whB, "WAREHOUSE_ADMIN");
  fx.staffB = await makeUser("staffB", "WAREHOUSE_STAFF");
  await addMembership(fx.staffB, fx.whB, "WAREHOUSE_STAFF");
  // The P2-4 shape: a GLOBAL Warehouse Admin role (which carries
  // delivery.confirm) but only a WAREHOUSE_STAFF membership at B.
  // Presence-based scope let this actor mint delivery codes before
  // the fix; the membership-ROLE check must refuse.
  fx.waStaffB = await makeUser("waStaffB", "WAREHOUSE_ADMIN");
  await addMembership(fx.waStaffB, fx.whB, "WAREHOUSE_STAFF");
  waAActor = await actorFor(fx.waA);
  staffAActor = await actorFor(fx.staffA);
  waBActor = await actorFor(fx.waB);
  staffBActor = await actorFor(fx.staffB);
  waStaffBActor = await actorFor(fx.waStaffB);

  // Line-haul driver + vehicle for the A→B leg.
  fx.linehaulUser = await makeUser("linehaul", "LINEHAUL_DRIVER");
  const linehaul = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.linehaulUser,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P6F-LH-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.linehaulProfile = linehaul.id;
  linehaulActor = await actorFor(fx.linehaulUser);
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P6F TRK ${RUN.slice(-6)}`.toUpperCase(),
    type: "TRUCK",
    capacityKg: 5000,
    homeWarehouseId: fx.whA,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  fx.vehicle = vehicle.id;

  // Two last-mile riders homed at the destination warehouse B.
  for (const label of ["riderA", "riderB"] as const) {
    const userId = await makeUser(label, "RIDER");
    const profile = await driversSvc.createDriverProfile(adminActor, {
      userId,
      homeWarehouseId: fx.whB,
      licenseNumber: `LIC-P6F-${label}-${RUN}`.toUpperCase(),
      licenseCategory: "B",
      licenseExpiry: "2030-01-01",
      capabilities: ["DELIVERY", "PICKUP"],
    });
    fx[`${label}User`] = userId;
    fx[`${label}Profile`] = profile.id;
  }
  riderAActor = await actorFor(fx.riderAUser);
  riderBActor = await actorFor(fx.riderBUser);
  expect(riderAActor.driverId).toBe(fx.riderAProfile);
}, 240_000);

// ---------------------------------------------------------------------------

describe("P6-R2: OTP failure counting is atomic under concurrency", () => {
  it("parallel wrong codes end at the true count with the lock set at the threshold", async () => {
    const { assignment, otp, batch } = await outForDelivery();
    const wrong = wrongOtpFor(otp);

    // The OTP hash now uses the house-standard bcrypt cost 12.
    const row0 = await prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(row0.otpCodeHash).toMatch(/^\$2[aby]\$12\$/);

    // OTP_MAX_FAILURES is 3: four parallel wrong codes must count
    // 1, 2, 3 (locking at 3) — the fourth is refused as locked
    // without counting. The vulnerable code let every parallel
    // caller read the same snapshot and write back 1.
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
          receivedByName: "P6F Recipient",
          otpCode: wrong,
        }),
      ),
    );
    expect(results.every((r) => r.status === "rejected")).toBe(true);

    const row = await prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(row.otpFailedAttempts).toBe(3);
    expect(row.otpLockedAt).not.toBeNull();
    const otpFailureAudits = await prisma.auditLog.count({
      where: { action: "delivery.otp_failed", entityId: assignment.id },
    });
    expect(otpFailureAudits).toBe(3);
    // No partial delivery artefacts from the failed attempts.
    expect(
      await prisma.proofOfDelivery.count({ where: { packageId: row.packageId } }),
    ).toBe(0);

    // Even the CORRECT code is refused while locked.
    await expect(
      deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
        receivedByName: "P6F Recipient",
        otpCode: otp,
      }),
    ).rejects.toThrow(/locked/);

    // Recovery still works: regenerate, deliver, close.
    await deliveriesSvc.regenerateOtp(riderAActor, assignment.id);
    await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P6F Recipient",
      otpCode: await recipientOtp(assignment.id),
    });
    await deliveriesSvc.closeBatch(riderAActor, batch.id);
  }, 120_000);

  it("a regeneration racing a delivery cannot desynchronise the POD hash", async () => {
    const { packageId, assignment, otp, batch } = await outForDelivery();
    const hold = await holdPackageLock(packageId);
    // Queue the delivery first (it blocks on the package lock),
    // then the regeneration. On the fixed code the regeneration
    // serialises behind the delivery and then refuses (assignment
    // COMPLETED). On the vulnerable code the regeneration was a
    // bare update — it landed mid-delivery and the POD was written
    // against the already-replaced snapshot hash.
    const deliverPromise = deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P6F Recipient",
      otpCode: otp,
    });
    await sleep(500);
    const regenPromise = deliveriesSvc.regenerateOtp(riderAActor, assignment.id);
    await sleep(1_500);
    hold.release();
    await hold.done;
    const [deliverRes, regenRes] = await Promise.allSettled([deliverPromise, regenPromise]);

    expect(deliverRes.status).toBe("fulfilled");
    expect(regenRes.status).toBe("rejected");
    if (regenRes.status === "rejected") {
      expect(regenRes.reason).toBeInstanceOf(errors.ConflictError);
    }
    const pod = await prisma.proofOfDelivery.findFirst({ where: { packageId } });
    expect(pod).not.toBeNull();
    // The POD's stored hash is exactly the hash of the code that
    // was verified — no desync.
    expect(await otpLib.verifyOtpCode(otp, pod!.otpCodeHash!)).toBe(true);
    await deliveriesSvc.closeBatch(riderAActor, batch.id);
  }, 120_000);
});

describe("P6-R3: cancel paths re-validate inside the transaction", () => {
  it("cancel-after-pickup refuses and the batch cannot close while the package is out", async () => {
    const parcel = await atDestination();
    const batch = await makeBatch(fx.riderAUser);
    const added = await deliveriesSvc.addBatchPackages(waBActor, batch.id, {
      packageIds: [parcel.packageId],
    });
    expect(added.added).toHaveLength(1);
    const assignmentId = added.added[0].id;

    // The reviewer's deterministic sequence: hold the Package row
    // lock, queue pickup then cancel, release. Pickup commits
    // first; the cancel must observe IN_PROGRESS in-transaction
    // and refuse (the vulnerable code cancelled on its stale
    // PENDING snapshot, stranding the parcel).
    const hold = await holdPackageLock(parcel.packageId);
    const pickupPromise = deliveriesSvc.confirmPickup(riderAActor, batch.id, {
      trackingIds: [parcel.trackingId],
    });
    await sleep(2_000); // pickup reaches the lock queue (OTP hash ~0.6s)
    const cancelPromise = deliveriesSvc.cancelAssignment(waBActor, assignmentId, {
      reason: "Dispatcher changed the plan",
    });
    await sleep(500);
    hold.release();
    await hold.done;
    const [pickupRes, cancelRes] = await Promise.allSettled([pickupPromise, cancelPromise]);

    expect(pickupRes.status).toBe("fulfilled");
    if (pickupRes.status === "fulfilled") {
      expect(pickupRes.value.taken).toHaveLength(1);
    }
    expect(cancelRes.status).toBe("rejected");
    if (cancelRes.status === "rejected") {
      expect(cancelRes.reason).toBeInstanceOf(errors.ConflictError);
    }

    const assignmentRow = await prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: assignmentId },
    });
    expect(assignmentRow.status).toBe("IN_PROGRESS");
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
    expect(pkg.operationalStatus).toBe("OUT_FOR_DELIVERY");
    const custody = await prisma.packageCustody.findFirst({
      where: { packageId: parcel.packageId, endedAt: null },
    });
    expect(custody?.custodianType).toBe("USER");
    expect(custody?.custodianUserId).toBe(fx.riderAUser);

    // And the batch cannot be closed COMPLETED over the out parcel.
    await expect(deliveriesSvc.closeBatch(waBActor, batch.id)).rejects.toThrow(
      /unaccounted/,
    );

    // Finish cleanly: deliver with the pickup OTP, then close.
    if (pickupRes.status === "fulfilled") {
      await deliveriesSvc.confirmDelivery(riderAActor, assignmentId, {
        receivedByName: "P6F Recipient",
        otpCode: await recipientOtp(assignmentId),
      });
    }
    const closed = await deliveriesSvc.closeBatch(waBActor, batch.id);
    expect(closed.batch.status).toBe("COMPLETED");
    expect(closed.delivered).toBe(1);
  }, 120_000);

  it("closeBatch refuses a CANCELLED assignment whose package is still out (corrupt-state guard)", async () => {
    const { packageId, assignment, batch, otp } = await outForDelivery();
    // Reproduce the reviewer's end-state directly: an assignment
    // row claiming CANCELLED while the package is physically out
    // with the rider. Even if such a row ever exists, the batch
    // must not close over it.
    await prisma.deliveryAssignment.update({
      where: { id: assignment.id },
      data: { status: "CANCELLED" },
    });
    await expect(deliveriesSvc.closeBatch(waBActor, batch.id)).rejects.toThrow(
      /unaccounted/,
    );
    // Restore the truthful state and finish cleanly.
    await prisma.deliveryAssignment.update({
      where: { id: assignment.id },
      data: { status: "IN_PROGRESS" },
    });
    await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P6F Recipient",
      otpCode: otp,
    });
    const closed = await deliveriesSvc.closeBatch(waBActor, batch.id);
    expect(closed.batch.status).toBe("COMPLETED");
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.operationalStatus).toBe("DELIVERED");
  }, 120_000);
});

describe("P6-R4: scan-back cannot receive an unauthorised return", () => {
  it("refuses while REQUESTED, then works after WA authorisation", async () => {
    const { packageId, trackingId, assignment, batch } = await outForDelivery();
    const res = await deliveriesSvc.recordDeliveryAttempt(riderAActor, assignment.id, {
      result: "REFUSED",
      notes: "Recipient refused the parcel at the door",
    });
    expect(res.returnRequest).not.toBeNull();
    const ret = await prisma.returnRequest.findFirstOrThrow({ where: { packageId } });
    expect(ret.status).toBe("REQUESTED");

    // The scan must be refused: receiving the parcel back may not
    // substitute for the WA's authorisation + charge decision.
    await expect(
      deliveriesSvc.scanBackPackage(staffBActor, {
        warehouseId: fx.whB,
        trackingId,
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    await expect(
      deliveriesSvc.scanBackPackage(staffBActor, {
        warehouseId: fx.whB,
        trackingId,
      }),
    ).rejects.toThrow(/REQUESTED/);
    const stillRequested = await prisma.returnRequest.findUniqueOrThrow({
      where: { id: ret.id },
    });
    expect(stillRequested.status).toBe("REQUESTED");
    expect(stillRequested.authorisedById).toBeNull();

    // Authorisation remains possible and effective afterwards.
    const approved = await returnsSvc.approveReturn(waBActor, ret.id, {
      chargeBearer: "VENDOR",
      chargeAmountPaisa: "5000",
    });
    expect(approved.status).toBe("APPROVED");
    expect(approved.chargeBearer).toBe("VENDOR");
    const scan = await deliveriesSvc.scanBackPackage(staffBActor, {
      warehouseId: fx.whB,
      trackingId,
    });
    expect(scan.returnRequest?.status).toBe("RECEIVED");
    const closed = await deliveriesSvc.closeBatch(waBActor, batch.id);
    expect(closed.batch.status).toBe("COMPLETED");
  }, 120_000);
});

describe("P6-R5: return authorisation is single-outcome under concurrency", () => {
  it("concurrent approve + reject yields exactly one recorded outcome", async () => {
    const parcel = await atDestination();
    const batch = await makeBatch(fx.riderAUser);
    const added = await deliveriesSvc.addBatchPackages(waBActor, batch.id, {
      packageIds: [parcel.packageId],
    });
    expect(added.added).toHaveLength(1);
    const ret = await returnsSvc.initiateReturn(waBActor, {
      packageId: parcel.packageId,
      reason: "VENDOR_REQUEST",
      notes: "Vendor asked for the parcel back",
    });
    expect(ret.status).toBe("REQUESTED");

    const results = await Promise.allSettled([
      returnsSvc.approveReturn(waBActor, ret.id, { chargeBearer: "COMPANY" }),
      returnsSvc.rejectReturn(waBActor, ret.id, { reason: "Not actually required" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0].status === "rejected") {
      expect(rejected[0].reason).toBeInstanceOf(errors.ConflictError);
    }

    const row = await prisma.returnRequest.findUniqueOrThrow({ where: { id: ret.id } });
    expect(["APPROVED", "REJECTED"]).toContain(row.status);
    // Exactly one authorisation event and one audit row exist —
    // the loser recorded nothing.
    const events = await prisma.trackingEvent.count({
      where: {
        packageId: parcel.packageId,
        eventType: { in: ["RETURN_APPROVED", "RETURN_REJECTED"] },
      },
    });
    expect(events).toBe(1);
    const audits = await prisma.auditLog.count({
      where: {
        entityId: ret.id,
        action: { in: ["return.approved", "return.rejected"] },
      },
    });
    expect(audits).toBe(1);

    await deliveriesSvc.cancelBatch(waBActor, batch.id);
  }, 120_000);
});

describe("P6-R6: detailed-tracking lockout bookkeeping", () => {
  it("a locked denial writes nothing, unknown codes write no audit row, malformed codes write nothing at all", async () => {
    const parcel = await bookOne();
    for (let i = 0; i < 5; i++) {
      await expect(
        packagesSvc.getDetailedTracking(parcel.trackingId, phone(300 + i)),
      ).rejects.toBeInstanceOf(errors.NotFoundError);
    }
    const countFailures = () =>
      prisma.trackingAccessAttempt.count({
        where: { trackingId: parcel.trackingId, succeeded: false },
      });
    expect(await countFailures()).toBe(5);
    // Correct phone during the lock: denied — and the denial must
    // NOT extend the window by writing a fresh failure row.
    await expect(
      packagesSvc.getDetailedTracking(parcel.trackingId, RECIPIENT_PHONE),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    expect(await countFailures()).toBe(5);

    // Unknown (well-formed) code: the failed attempt is recorded
    // (keyed, so the lockout can engage) but NO audit row is
    // written for it.
    let unknownId = trackingLib.generateTrackingId();
    while (await prisma.package.findUnique({ where: { trackingId: unknownId } })) {
      unknownId = trackingLib.generateTrackingId();
    }
    await expect(
      packagesSvc.getDetailedTracking(unknownId, RECIPIENT_PHONE),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    expect(
      await prisma.trackingAccessAttempt.count({ where: { trackingId: unknownId } }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({
        where: {
          action: "tracking.detailed_access_denied",
          after: { path: ["trackingId"], equals: unknownId },
        },
      }),
    ).toBe(0);

    // Malformed code: nothing is written at all.
    const malformed = "NOT-A-TRACKING-ID";
    await expect(
      packagesSvc.getDetailedTracking(malformed, RECIPIENT_PHONE),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    expect(
      await prisma.trackingAccessAttempt.count({ where: { trackingId: malformed } }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: {
          action: "tracking.detailed_access_denied",
          after: { path: ["trackingId"], equals: malformed },
        },
      }),
    ).toBe(0);
  }, 60_000);

  it("a successful verification clears the code's prior failures", async () => {
    const parcel = await bookOne();
    for (let i = 0; i < 3; i++) {
      await expect(
        packagesSvc.getDetailedTracking(parcel.trackingId, phone(400 + i)),
      ).rejects.toBeInstanceOf(errors.NotFoundError);
    }
    expect(
      await prisma.trackingAccessAttempt.count({
        where: { trackingId: parcel.trackingId, succeeded: false },
      }),
    ).toBe(3);
    const view = await packagesSvc.getDetailedTracking(parcel.trackingId, RECIPIENT_PHONE);
    expect(view.recipientName).toBe("P6F Recipient");
    expect(
      await prisma.trackingAccessAttempt.count({
        where: { trackingId: parcel.trackingId, succeeded: false },
      }),
    ).toBe(0);
    expect(
      await prisma.trackingAccessAttempt.count({
        where: { trackingId: parcel.trackingId, succeeded: true },
      }),
    ).toBe(1);
  }, 60_000);
});

describe("P6-R7 + P6-R1: scan-back authority and OTP regeneration restriction", () => {
  it("scan-back of an out-for-delivery package needs a WA + a reason and names the displaced rider", async () => {
    const { packageId, trackingId, assignment, batch } = await outForDelivery();
    const reason = "Rider returned to base ill; parcel recovered at the gate";

    // Ordinary warehouse staff cannot sever the rider's custody,
    // even with a reason.
    await expect(
      deliveriesSvc.scanBackPackage(staffBActor, {
        warehouseId: fx.whB,
        trackingId,
        reason,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // A Warehouse Admin still needs the reason.
    await expect(
      deliveriesSvc.scanBackPackage(waBActor, {
        warehouseId: fx.whB,
        trackingId,
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      deliveriesSvc.scanBackPackage(waBActor, {
        warehouseId: fx.whB,
        trackingId,
      }),
    ).rejects.toThrow(/reason/);
    // Nothing moved: the rider still holds the package.
    const custodyBefore = await prisma.packageCustody.findFirst({
      where: { packageId, endedAt: null },
    });
    expect(custodyBefore?.custodianUserId).toBe(fx.riderAUser);

    const scan = await deliveriesSvc.scanBackPackage(waBActor, {
      warehouseId: fx.whB,
      trackingId,
      reason,
    });
    expect(scan.status).toBe("READY_FOR_DELIVERY");
    expect(scan.assignmentId).toBe(assignment.id);

    const assignmentRow = await prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(assignmentRow.status).toBe("FAILED");
    expect(assignmentRow.failureNote).toContain(reason);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "delivery.scan_back", entityId: packageId },
      orderBy: { createdAt: "desc" },
    });
    const after = audit?.after as Record<string, unknown> | null;
    expect(after?.reason).toBe(reason);
    expect(after?.displacedRiderId).toBe(fx.riderAProfile);
    expect(after?.displacedRiderUserId).toBe(fx.riderAUser);

    const event = await prisma.trackingEvent.findFirst({
      where: { packageId, newStatus: "READY_FOR_DELIVERY" },
      orderBy: { occurredAt: "desc" },
    });
    expect(event?.notes).toContain(reason);

    const closed = await deliveriesSvc.closeBatch(waBActor, batch.id);
    expect(closed.batch.status).toBe("COMPLETED");
    expect(closed.returnedOrBack).toBe(1);
  }, 120_000);

  it("OTP regeneration is restricted to the assigned rider or the batch warehouse's WA", async () => {
    const { assignment, batch } = await outForDelivery();

    // Plain warehouse staff hold no delivery.confirm permission at
    // all — refused at the permission gate.
    await expect(
      deliveriesSvc.regenerateOtp(staffBActor, assignment.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // The reviewer's hole: an actor WITH delivery.confirm whose
    // presence at the warehouse is only a STAFF membership (global
    // WA role, staff membership — the P2-4 shape) could mint a code
    // under presence-based scope. Now refused at the service layer,
    // with the denial audited against the assignment.
    await expect(
      deliveriesSvc.regenerateOtp(waStaffBActor, assignment.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const denial = await prisma.auditLog.findFirst({
      where: {
        action: "access.denied",
        actorId: fx.waStaffB,
        entityId: assignment.id,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(denial).not.toBeNull();
    expect((denial?.after as Record<string, unknown> | null)?.reason).toBe(
      "otp_regenerate_requires_rider_or_warehouse_admin",
    );
    // Another rider cannot mint one either.
    await expect(
      deliveriesSvc.regenerateOtp(riderBActor, assignment.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    // The batch warehouse's WA can (recipient called the warehouse).
    const byWa = await deliveriesSvc.regenerateOtp(waBActor, assignment.id);
    expect(byWa.assignmentId).toBe(assignment.id);
    // And the assigned rider can; the rider's code is the live one.
    await deliveriesSvc.regenerateOtp(riderAActor, assignment.id);
    const delivered = await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P6F Recipient",
      otpCode: await recipientOtp(assignment.id),
    });
    expect(delivered.assignment.status).toBe("COMPLETED");
    await deliveriesSvc.closeBatch(riderAActor, batch.id);
  }, 120_000);
});
