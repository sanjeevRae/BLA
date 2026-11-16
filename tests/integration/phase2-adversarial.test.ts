import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// A controllable NextAuth session so the REAL getActorContext
// (@/lib/auth/permissions) can run in tests — the membership
// revocation assertions are about exactly that per-request resolver,
// so a mirror would prove nothing.
const authState = vi.hoisted(() => ({ userId: null as string | null }));
vi.mock("@/auth", () => ({
  auth: async () =>
    authState.userId ? { user: { id: authState.userId } } : null,
}));

/**
 * Phase 2 V2 (D) — adversarial validation suite against bla_test.
 *
 *   1. Invitation redemption rate limit: a per-IP failure budget
 *      (20 / 10 min, mirroring login) checked BEFORE the token
 *      lookup; an exhausted IP gets the SAME generic refusal as an
 *      invalid token — a valid token from a burnt IP is refused,
 *      the same token from a fresh IP succeeds, and two simultaneous
 *      accepts of one token still yield exactly one account.
 *   2. L-2: listPackageMovements with no determinable scope
 *      warehouse (no open record, currentWarehouseId null) must not
 *      fall through unchecked — scoped actors pass only when the
 *      package's movement history touches their warehouses.
 *   3. Cross-resource IDOR: foreign packages in transfer mutations,
 *      shipment/destination mismatch on transfer item add, a bulk
 *      handover with one foreign package rejecting the WHOLE batch,
 *      export scope == report scope, and search composing with
 *      scope on packages + drivers lists.
 *   4. Lifecycle concurrency: two simultaneous transitions — one
 *      winner, one ConflictError, exactly one TrackingEvent.
 *   5. Cross-domain invariants: DELIVERED implies a ProofOfDelivery
 *      (and recordDeliveryAttempt cannot produce DELIVERED);
 *      refunds bounded by the un-refunded remainder with a clean
 *      NotFound for unknown payments; a transfer-shortage incident
 *      stays open across unrelated transitions and cannot close
 *      while transfer items remain MISSING.
 *   6. Membership revocation immediacy through the real
 *      getActorContext: revoke the row → the rebuilt context loses
 *      the warehouse and scoped calls are denied; a suspended user
 *      resolves to no context at all.
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
const email = (label: string) => `p2c-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);
const RECIPIENT_PHONE = phone(101);
const TODAY = new Date().toISOString().slice(0, 10);
const GENERIC_REFUSAL = "Invitation is invalid or has already been used";
// Per-run IPs so re-runs inside the 10-minute window never collide.
const ipOctet = (parseInt(RUN.slice(-4), 36) % 180) + 20;
const IP_BURN = `198.51.100.${ipOctet}`;
const IP_FRESH = `198.51.100.${ipOctet + 1}`;
const IP_RACE = `203.0.113.${ipOctet}`;

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let inventorySvc: typeof import("@/server/services/inventory");
let lifecycleSvc: typeof import("@/server/services/package-lifecycle");
let transfersSvc: typeof import("@/server/services/transfers");
let tripsSvc: typeof import("@/server/services/trips");
let deliveriesSvc: typeof import("@/server/services/deliveries");
let custodySvc: typeof import("@/server/services/custody");
let packagesSvc: typeof import("@/server/services/packages");
let driversSvc: typeof import("@/server/services/drivers");
let vehiclesSvc: typeof import("@/server/services/vehicles");
let reportsSvc: typeof import("@/server/services/reports");
let reportsExport: typeof import("@/server/services/reports-export");
let invitationsSvc: typeof import("@/server/services/invitations");
let invoicesSvc: typeof import("@/server/services/invoices");
let adjustmentsSvc: typeof import("@/server/services/finance-adjustments");
let incidentsSvc: typeof import("@/server/services/incidents");
let permissionsLib: typeof import("@/lib/auth/permissions");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let serviceCode = "";
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let financeActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
let staffBActor: Awaited<ReturnType<typeof actorFor>>;
let linehaulActor: Awaited<ReturnType<typeof actorFor>>;
let riderActor: Awaited<ReturnType<typeof actorFor>>;

type Actor = Awaited<ReturnType<typeof actorFor>>;

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
      fullName: `P2C ${label} ${RUN}`,
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
  originWarehouseId: string,
  destDistrict: string,
  codAmountPaisa = "0",
): Promise<{ packageId: string; trackingId: string; shipmentId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId: fx.vendor,
    sender: { name: "P2C Sender", phone: phone(42), email: null },
    recipient: {
      name: "P2C Recipient",
      phone: RECIPIENT_PHONE,
      addressLine: "Some Street 1",
      city: "Town",
      district: destDistrict,
      province: "Bagmati",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa,
    items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
  });
  const shipment = booking.shipments[0];
  const pkg = shipment.packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId, shipmentId: shipment.id };
}

/** Book at A → receive → inspect → put away → ready for dispatch. */
async function readyOne(
  destDistrict: string,
  codAmountPaisa = "0",
): Promise<{ packageId: string; trackingId: string; shipmentId: string }> {
  const booked = await bookOne(fx.whA, destDistrict, codAmountPaisa);
  await inventorySvc.receivePackage(staffAActor, {
    warehouseId: fx.whA,
    trackingId: booked.trackingId,
  });
  await inventorySvc.moveToInspection(staffAActor, booked.packageId);
  await inventorySvc.startInspection(staffAActor, booked.packageId);
  await inventorySvc.recordInspection(staffAActor, {
    packageId: booked.packageId,
    condition: "GOOD",
    actualWeightKg: 2,
  });
  await inventorySvc.putAwayPackage(staffAActor, booked.packageId, fx.locStoA);
  const ready = await inventorySvc.markReadyForDispatch(staffAActor, booked.packageId);
  expect(ready.operationalStatus).toBe("READY_FOR_DISPATCH");
  return booked;
}

async function manifestedTransfer(packageIds: string[]) {
  const transfer = await transfersSvc.createTransfer(waAActor, {
    originWarehouseId: fx.whA,
    destinationWarehouseId: fx.whB,
  });
  const added = await transfersSvc.addTransferItems(waAActor, transfer.id, packageIds);
  expect(added.rejected).toEqual([]);
  expect(added.added).toHaveLength(packageIds.length);
  const manifested = await transfersSvc.generateManifest(waAActor, transfer.id);
  expect(manifested.manifest).not.toBeNull();
  return manifested;
}

async function crewedTransfer(packageIds: string[]) {
  const transfer = await manifestedTransfer(packageIds);
  const crewed = await transfersSvc.assignTransferCrew(waAActor, {
    transferId: transfer.id,
    driverId: fx.linehaulProfile,
    vehicleId: fx.vehicle,
  });
  expect(crewed.tripId).not.toBeNull();
  return crewed;
}

/** Drive a crewed transfer to RECEIVED_AT_DESTINATION + closed. */
async function completeTransferJourney(
  transfer: { id: string; tripId: string | null },
  parcel: { packageId: string; trackingId: string },
) {
  const loaded = await transfersSvc.loadTransferPackage(waAActor, transfer.id, {
    trackingId: parcel.trackingId,
    idempotencyKey: `p2c-load-${RUN}-${parcel.trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
  const tripId = dispatched.tripId ?? transfer.tripId!;
  await tripsSvc.departTrip(linehaulActor, tripId);
  await tripsSvc.arriveTrip(linehaulActor, tripId);
  const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
    trackingId: parcel.trackingId,
    idempotencyKey: `p2c-unload-${RUN}-${parcel.trackingId}`,
  });
  expect(scan.kind).toBe("RECEIVED_SCAN");
  await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
    packageId: parcel.packageId,
    condition: "GOOD",
  });
  await transfersSvc.finishReceiving(waBActor, transfer.id);
  await transfersSvc.reconcileTransfer(waBActor, transfer.id);
  await transfersSvc.closeTransfer(waBActor, transfer.id);
  const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
  expect(pkg.operationalStatus).toBe("RECEIVED_AT_DESTINATION");
}

/** Book at A → full transfer chain → RECEIVED_AT_DESTINATION at B. */
async function atDestination(codAmountPaisa = "0") {
  const parcel = await readyOne(fx.districtB, codAmountPaisa);
  const transfer = await crewedTransfer([parcel.packageId]);
  await completeTransferJourney(transfer, parcel);
  return parcel;
}

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

/** Parcel at destination B, out with the rider (IN_PROGRESS). */
async function outForDelivery(codAmountPaisa = "0") {
  const parcel = await atDestination(codAmountPaisa);
  const batch = await deliveriesSvc.createDeliveryBatch(waBActor, {
    warehouseId: fx.whB,
    riderUserId: fx.riderUser,
    batchDate: TODAY,
    kind: "DELIVERY",
  });
  const added = await deliveriesSvc.addBatchPackages(waBActor, batch.id, {
    packageIds: [parcel.packageId],
  });
  expect(added.rejected).toEqual([]);
  const pickup = await deliveriesSvc.confirmPickup(riderActor, batch.id, {
    trackingIds: [parcel.trackingId],
  });
  expect(pickup.failed).toEqual([]);
  return { ...parcel, batchId: batch.id, assignmentId: added.added[0].id };
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
  lifecycleSvc = await import("@/server/services/package-lifecycle");
  transfersSvc = await import("@/server/services/transfers");
  tripsSvc = await import("@/server/services/trips");
  deliveriesSvc = await import("@/server/services/deliveries");
  custodySvc = await import("@/server/services/custody");
  packagesSvc = await import("@/server/services/packages");
  driversSvc = await import("@/server/services/drivers");
  vehiclesSvc = await import("@/server/services/vehicles");
  reportsSvc = await import("@/server/services/reports");
  reportsExport = await import("@/server/services/reports-export");
  invitationsSvc = await import("@/server/services/invitations");
  invoicesSvc = await import("@/server/services/invoices");
  adjustmentsSvc = await import("@/server/services/finance-adjustments");
  incidentsSvc = await import("@/server/services/incidents");
  permissionsLib = await import("@/lib/auth/permissions");
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
  fx.financeUser = await makeUser("finance", "FINANCE");
  financeActor = await actorFor(fx.financeUser);

  fx.districtA = "P2CAlpha District";
  fx.districtB = "P2CBeta District";
  fx.districtC = "P2CGamma District";
  const a = await ensureWarehouse("WH-QC2-01", "P2C Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  const b = await ensureWarehouse("WH-QC2-02", "P2C Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;
  const c = await ensureWarehouse("WH-QC2-03", "P2C Gamma (shared fixture)", fx.districtC);
  fx.whC = c.id;

  serviceCode = `P2CSTD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P2C Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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
    businessName: `P2C Vendor ${RUN}`,
    contactName: "P2C Contact",
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

  fx.waA = await makeUser("waA", "WAREHOUSE_ADMIN");
  await addMembership(fx.waA, fx.whA, "WAREHOUSE_ADMIN");
  fx.staffA = await makeUser("staffA", "WAREHOUSE_STAFF");
  await addMembership(fx.staffA, fx.whA, "WAREHOUSE_STAFF");
  fx.waB = await makeUser("waB", "WAREHOUSE_ADMIN");
  await addMembership(fx.waB, fx.whB, "WAREHOUSE_ADMIN");
  fx.staffB = await makeUser("staffB", "WAREHOUSE_STAFF");
  await addMembership(fx.staffB, fx.whB, "WAREHOUSE_STAFF");
  waAActor = await actorFor(fx.waA);
  staffAActor = await actorFor(fx.staffA);
  waBActor = await actorFor(fx.waB);
  staffBActor = await actorFor(fx.staffB);

  fx.linehaulUser = await makeUser("linehaul", "LINEHAUL_DRIVER");
  const linehaul = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.linehaulUser,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P2C-LH-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.linehaulProfile = linehaul.id;
  linehaulActor = await actorFor(fx.linehaulUser);

  fx.riderUser = await makeUser("rider", "RIDER");
  const rider = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.riderUser,
    homeWarehouseId: fx.whB,
    licenseNumber: `LIC-P2C-RD-${RUN}`,
    licenseExpiry: "2030-01-01",
    capabilities: ["DELIVERY", "PICKUP"],
  });
  fx.riderProfile = rider.id;
  riderActor = await actorFor(fx.riderUser);

  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P2C TRK ${RUN.slice(-6)}`.toUpperCase(),
    type: "TRUCK",
    capacityKg: 5000,
    homeWarehouseId: fx.whA,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  fx.vehicle = vehicle.id;
}, 180_000);

// ---------------------------------------------------------------------
// 1) Invitation redemption rate limit
// ---------------------------------------------------------------------

describe("invitation redemption rate limit", { timeout: 180_000 }, () => {
  it("a burnt IP is refused a VALID token with the generic message; a fresh IP succeeds", async () => {
    const inviteeEmail = email("ratelimit");
    const created = await invitationsSvc.createInvitation(adminActor, {
      email: inviteeEmail,
      roleCode: "WAREHOUSE_STAFF",
      warehouseId: fx.whA,
    });

    // Burn the budget: 20 failed redemptions from one IP.
    for (let i = 0; i < 20; i++) {
      await expect(
        invitationsSvc.acceptInvitation(
          {
            token: `bad-token-${RUN}-${i}-0123456789abcdef0123456789`,
            fullName: "Budget Burner",
            password: "burner-password-1",
          },
          { ipAddress: IP_BURN },
        ),
      ).rejects.toMatchObject({
        name: "DomainValidationError",
        message: GENERIC_REFUSAL,
      });
    }
    const failedRows = await prisma.invitationAttempt.count({
      where: { ipAddress: IP_BURN, succeeded: false },
    });
    expect(failedRows).toBe(20);

    // The VALID token from the burnt IP: same generic refusal, no
    // distinguishable throttle error, invitation NOT consumed, no
    // account created, and the limiter's own refusal writes no row
    // (the budget must be able to decay with its window).
    await expect(
      invitationsSvc.acceptInvitation(
        { token: created.token, fullName: "Rate Limited", password: "limited-password-1" },
        { ipAddress: IP_BURN },
      ),
    ).rejects.toMatchObject({ name: "DomainValidationError", message: GENERIC_REFUSAL });
    const stillPending = await prisma.userInvitation.findUnique({
      where: { id: created.invitationId },
    });
    expect(stillPending?.status).toBe("PENDING");
    expect(await prisma.user.count({ where: { email: inviteeEmail } })).toBe(0);
    expect(
      await prisma.invitationAttempt.count({
        where: { ipAddress: IP_BURN, succeeded: false },
      }),
    ).toBe(20);

    // The same token from a different IP succeeds, and the success
    // is recorded against that IP + token hash.
    const accepted = await invitationsSvc.acceptInvitation(
      { token: created.token, fullName: "Rate Limited", password: "limited-password-1" },
      { ipAddress: IP_FRESH },
    );
    expect(accepted.email).toBe(inviteeEmail);
    expect(await prisma.user.count({ where: { email: inviteeEmail } })).toBe(1);
    const tokenHash = createHash("sha256").update(created.token).digest("hex");
    const successRows = await prisma.invitationAttempt.count({
      where: { ipAddress: IP_FRESH, tokenHash, succeeded: true },
    });
    expect(successRows).toBe(1);
  });

  it("two simultaneous accepts of one token (with IP) yield exactly one success and one user", async () => {
    const inviteeEmail = email("raceip");
    const created = await invitationsSvc.createInvitation(adminActor, {
      email: inviteeEmail,
      roleCode: "WAREHOUSE_STAFF",
      warehouseId: fx.whA,
    });
    const attempts = await Promise.allSettled([
      invitationsSvc.acceptInvitation(
        { token: created.token, fullName: "Racer One", password: "racer-password-1" },
        { ipAddress: IP_RACE },
      ),
      invitationsSvc.acceptInvitation(
        { token: created.token, fullName: "Racer Two", password: "racer-password-2" },
        { ipAddress: IP_RACE },
      ),
    ]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((a) => a.status === "rejected")).toHaveLength(1);
    expect(await prisma.user.count({ where: { email: inviteeEmail } })).toBe(1);
    const tokenHash = createHash("sha256").update(created.token).digest("hex");
    expect(
      await prisma.invitationAttempt.count({
        where: { tokenHash, ipAddress: IP_RACE, succeeded: true },
      }),
    ).toBe(1);
    expect(
      await prisma.invitationAttempt.count({
        where: { tokenHash, ipAddress: IP_RACE, succeeded: false },
      }),
    ).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------
// 2) L-2 — movement history scope
// ---------------------------------------------------------------------

describe("L-2 — listPackageMovements without a determinable scope warehouse", { timeout: 180_000 }, () => {
  it("scoped actors pass only when the movement history touches their warehouse", async () => {
    const booked = await bookOne(fx.whA, fx.districtB);
    await inventorySvc.receivePackage(staffAActor, {
      warehouseId: fx.whA,
      trackingId: booked.trackingId,
    });
    // Careful fixture for the L-2 state: the package was received at
    // A (a RECEIVING movement to A exists) but has since been fully
    // released — no open inventory record — and carries no current
    // warehouse, so no scope warehouse is determinable.
    await prisma.inventoryRecord.updateMany({
      where: { packageId: booked.packageId, releasedAt: null },
      data: {
        releasedAt: new Date(),
        releasedById: fx.staffA,
        releaseReason: "CORRECTION",
      },
    });
    await prisma.package.update({
      where: { id: booked.packageId },
      data: { currentWarehouseId: null },
    });
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: booked.packageId } });
    expect(pkg.currentWarehouseId).toBeNull();
    expect(
      await prisma.inventoryRecord.count({
        where: { packageId: booked.packageId, releasedAt: null },
      }),
    ).toBe(0);

    // Warehouse B's admin: the history never touches B — denied,
    // and the denial is audited with the scope reason.
    await expect(
      inventorySvc.listPackageMovements(waBActor, booked.packageId),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const denial = await prisma.auditLog.findFirst({
      where: {
        actorId: fx.waB,
        action: "access.denied",
        entityType: "Package",
        entityId: booked.packageId,
        after: { path: ["reason"], equals: "warehouse_out_of_scope" },
      },
    });
    expect(denial).not.toBeNull();

    // Warehouse A's admin: the receiving movement touches A — reads.
    const movementsA = await inventorySvc.listPackageMovements(waAActor, booked.packageId);
    expect(movementsA.length).toBeGreaterThanOrEqual(1);
    expect(movementsA.some((m) => m.toWarehouseCode === "WH-QC2-01")).toBe(true);

    // Unscoped admin reads regardless of history.
    const movementsAdmin = await inventorySvc.listPackageMovements(adminActor, booked.packageId);
    expect(movementsAdmin.length).toBe(movementsA.length);
  });
});

// ---------------------------------------------------------------------
// 3) Cross-resource IDOR
// ---------------------------------------------------------------------

describe("cross-resource IDOR", { timeout: 240_000 }, () => {
  it("(a) a package stocked at warehouse B cannot be loaded onto warehouse A's transfer", async () => {
    const own = await readyOne(fx.districtB);
    const transfer = await crewedTransfer([own.packageId]);

    // A package that belongs to warehouse B: booked out of B,
    // received and stocked at B.
    const foreign = await bookOne(fx.whB, fx.districtA);
    await inventorySvc.receivePackage(staffBActor, {
      warehouseId: fx.whB,
      trackingId: foreign.trackingId,
    });
    const before = await prisma.package.findUniqueOrThrow({ where: { id: foreign.packageId } });
    expect(before.operationalStatus).toBe("RECEIVED_AT_ORIGIN");

    await expect(
      transfersSvc.loadTransferPackage(waAActor, transfer.id, {
        trackingId: foreign.trackingId,
      }),
    ).rejects.toBeInstanceOf(errors.NotFoundError);

    // No state change anywhere: the foreign package is untouched,
    // no transfer item/scan appeared, the manifest is unchanged.
    const after = await prisma.package.findUniqueOrThrow({ where: { id: foreign.packageId } });
    expect(after.operationalStatus).toBe("RECEIVED_AT_ORIGIN");
    expect(
      await prisma.transferItem.count({
        where: { transferId: transfer.id, packageId: foreign.packageId },
      }),
    ).toBe(0);
    expect(await prisma.transferItem.count({ where: { transferId: transfer.id } })).toBe(1);

    // The transfer itself is unharmed: its own package still loads
    // and completes the journey (also frees the shared linehaul
    // driver for later tests).
    await completeTransferJourney(transfer, own);
  });

  it("(b) a package destined for warehouse C is rejected from an A→B transfer", async () => {
    const transfer = await transfersSvc.createTransfer(waAActor, {
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
    });
    const foreign = await readyOne(fx.districtC);
    const result = await transfersSvc.addTransferItems(waAActor, transfer.id, [
      foreign.packageId,
    ]);
    expect(result.added).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].packageId).toBe(foreign.packageId);
    expect(result.rejected[0].reason).toMatch(/different warehouse/i);
    expect(await prisma.transferItem.count({ where: { transferId: transfer.id } })).toBe(0);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: foreign.packageId } });
    expect(pkg.operationalStatus).toBe("READY_FOR_DISPATCH");
  });

  it("(c) a handover batch with ONE foreign-warehouse package rejects the whole batch", async () => {
    const mkReceived = async (originWarehouseId: string, actor: Actor, warehouseId: string) => {
      const booked = await bookOne(originWarehouseId, fx.districtB);
      await inventorySvc.receivePackage(actor, {
        warehouseId,
        trackingId: booked.trackingId,
      });
      return booked.packageId;
    };
    const a1 = await mkReceived(fx.whA, staffAActor, fx.whA);
    const a2 = await mkReceived(fx.whA, staffAActor, fx.whA);
    const b1 = await mkReceived(fx.whB, staffBActor, fx.whB);

    const batchesBefore = await prisma.handoverBatch.count({
      where: { warehouseId: { in: [fx.whA, fx.whB] } },
    });
    await expect(
      custodySvc.initiateHandover(adminActor, {
        packageIds: [a1, a2, b1],
        toCustodianType: "USER",
        toUserId: fx.staffA,
      }),
    ).rejects.toMatchObject({
      name: "DomainValidationError",
      message: expect.stringMatching(/same warehouse/i),
    });
    // Zero partial writes: no batch, no handover rows for any of the
    // three packages — the two valid ones included.
    expect(
      await prisma.handoverBatch.count({
        where: { warehouseId: { in: [fx.whA, fx.whB] } },
      }),
    ).toBe(batchesBefore);
    expect(
      await prisma.custodyHandover.count({ where: { packageId: { in: [a1, a2, b1] } } }),
    ).toBe(0);

    // Control: the same two A packages without the foreign one DO
    // form a batch — the rejection was the foreign ID, not the data.
    const batch = await custodySvc.initiateHandover(waAActor, {
      packageIds: [a1, a2],
      toCustodianType: "USER",
      toUserId: fx.staffA,
    });
    expect(batch.status).toBe("PENDING");
    expect(batch.expectedCount).toBe(2);
  });

  it("(d) the CSV export carries exactly the warehouse scope of the report call", async () => {
    const range = { from: TODAY, to: TODAY };
    const report = await reportsSvc.getWarehouseReport(waAActor, { ...range });
    expect(report.rows.map((r) => r.warehouseId)).toEqual([fx.whA]);

    const { csv } = await reportsExport.buildReportCsv(waAActor, "warehouses", { ...range });
    expect(csv).toContain("WH-QC2-01");
    expect(csv).not.toContain("WH-QC2-02");
    expect(csv).not.toContain("WH-QC2-03");
    // Exactly one warehouse data row is exported — the same single
    // row the report call returned.
    const warehouseLines = csv.split("\n").filter((line) => line.includes("WH-QC2-"));
    expect(warehouseLines).toHaveLength(1);
  });

  it("(e) search composes with scope on packages and drivers lists", async () => {
    // A package entirely local to A (origin A, destination district
    // served by A): invisible to B even when searched by its exact
    // tracking id.
    const local = await bookOne(fx.whA, fx.districtA);
    const foreignSearch = await packagesSvc.listPackages(waBActor, {
      search: local.trackingId,
    });
    expect(foreignSearch.packages).toEqual([]);
    expect(foreignSearch.meta.total).toBe(0);
    const ownSearch = await packagesSvc.listPackages(waAActor, {
      search: local.trackingId,
    });
    expect(ownSearch.packages.map((p) => p.id)).toContain(local.packageId);

    // Same composition on the drivers list: a driver homed at A is
    // unfindable from B by exact name search.
    const driverUser = await makeUser("scopedriver", "RIDER");
    const driverName = `P2C scopedriver ${RUN}`;
    const profile = await driversSvc.createDriverProfile(adminActor, {
      userId: driverUser,
      homeWarehouseId: fx.whA,
      licenseNumber: `LIC-P2C-SD-${RUN}`,
      licenseExpiry: "2030-01-01",
      capabilities: ["DELIVERY"],
    });
    const foreignDriverSearch = await driversSvc.listDrivers(waBActor, {
      search: driverName,
    });
    expect(foreignDriverSearch.items).toEqual([]);
    const ownDriverSearch = await driversSvc.listDrivers(waAActor, {
      search: driverName,
    });
    expect(ownDriverSearch.items.map((d) => d.id)).toContain(profile.id);
  });
});

// ---------------------------------------------------------------------
// 4) Lifecycle concurrency
// ---------------------------------------------------------------------

describe("lifecycle concurrency", { timeout: 180_000 }, () => {
  it("two simultaneous transitions: one winner, one ConflictError, one TrackingEvent", async () => {
    const booked = await bookOne(fx.whA, fx.districtB);
    const results = await Promise.allSettled([
      lifecycleSvc.transitionPackage(adminActor, booked.packageId, "CANCELLED", {
        notes: "P2C race A",
      }),
      lifecycleSvc.transitionPackage(adminActor, booked.packageId, "CANCELLED", {
        notes: "P2C race B",
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(errors.ConflictError);

    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: booked.packageId } });
    expect(pkg.operationalStatus).toBe("CANCELLED");
    const events = await prisma.trackingEvent.count({
      where: { packageId: booked.packageId, newStatus: "CANCELLED" },
    });
    expect(events).toBe(1);
  });
});

// ---------------------------------------------------------------------
// 5) Cross-domain invariants
// ---------------------------------------------------------------------

describe("cross-domain invariants", { timeout: 240_000 }, () => {
  it("(i) DELIVERED always carries a ProofOfDelivery; a plain attempt can never produce it", async () => {
    // A recorded attempt with result DELIVERED is refused outright —
    // delivery only happens through the OTP-gated confirmation.
    const attemptParcel = await outForDelivery("0");
    await expect(
      deliveriesSvc.recordDeliveryAttempt(riderActor, attemptParcel.assignmentId, {
        result: "DELIVERED",
        notes: "P2C shortcut attempt",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    // A genuine failed attempt records fine and delivers nothing.
    const failed = await deliveriesSvc.recordDeliveryAttempt(
      riderActor,
      attemptParcel.assignmentId,
      {
        result: "RECIPIENT_UNAVAILABLE",
        contactOutcome: "CALLED_NO_ANSWER",
        notes: "P2C nobody home",
      },
    );
    expect(failed.attemptNumber).toBe(1);
    let pkg = await prisma.package.findUniqueOrThrow({ where: { id: attemptParcel.packageId } });
    expect(pkg.deliveryStatus).not.toBe("DELIVERED");
    expect(
      await prisma.proofOfDelivery.count({ where: { packageId: attemptParcel.packageId } }),
    ).toBe(0);

    // The real confirmation: POD row exists and both statuses land.
    const deliveredParcel = await outForDelivery("0");
    await deliveriesSvc.confirmDelivery(riderActor, deliveredParcel.assignmentId, {
      receivedByName: "P2C Recipient",
      relationshipToRecipient: "Self",
      otpCode: await recipientOtp(deliveredParcel.assignmentId),
      codCollectedPaisa: "0",
    });
    pkg = await prisma.package.findUniqueOrThrow({ where: { id: deliveredParcel.packageId } });
    expect(pkg.operationalStatus).toBe("DELIVERED");
    expect(pkg.deliveryStatus).toBe("DELIVERED");
    const pod = await prisma.proofOfDelivery.findFirst({
      where: { packageId: deliveredParcel.packageId },
    });
    expect(pod).not.toBeNull();
    expect(pod!.method).toBe("OTP");
  });

  it("(ii) refunds: unknown payment is a clean NotFound; over-refund is rejected", async () => {
    await expect(
      adjustmentsSvc.requestRefund(financeActor, {
        paymentId: "00000000-0000-4000-8000-000000000000",
        amountPaisa: "100",
        reason: "P2C no such payment",
      }),
    ).rejects.toBeInstanceOf(errors.NotFoundError);

    // A real payment: deliver (COD 0) → invoice → pay in full.
    const parcel = await outForDelivery("0");
    await deliveriesSvc.confirmDelivery(riderActor, parcel.assignmentId, {
      receivedByName: "P2C Recipient",
      relationshipToRecipient: "Self",
      otpCode: await recipientOtp(parcel.assignmentId),
      codCollectedPaisa: "0",
    });
    const invoice = await invoicesSvc.generateVendorInvoice(financeActor, {
      vendorId: fx.vendor,
    });
    expect(invoice).not.toBeNull();
    const payment = await invoicesSvc.recordPayment(financeActor, {
      amountPaisa: invoice!.totalPaisa,
      method: "BANK_TRANSFER",
      allocations: [{ invoiceId: invoice!.id, amountPaisa: invoice!.totalPaisa }],
    });

    // Refund beyond the payment is rejected and writes nothing.
    const tooMuch = (BigInt(payment.amountPaisa) + BigInt(1)).toString();
    await expect(
      adjustmentsSvc.requestRefund(financeActor, {
        paymentId: payment.id,
        amountPaisa: tooMuch,
        reason: "P2C too much",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    expect(await prisma.refund.count({ where: { paymentId: payment.id } })).toBe(0);

    // A partial refund commits against the remainder; a second one
    // that would exceed what is left is then rejected too.
    const partial = await adjustmentsSvc.requestRefund(financeActor, {
      paymentId: payment.id,
      amountPaisa: "100",
      reason: "P2C partial",
    });
    expect(partial.status).toBe("REQUESTED");
    await expect(
      adjustmentsSvc.requestRefund(financeActor, {
        paymentId: payment.id,
        amountPaisa: payment.amountPaisa,
        reason: "P2C remainder bust",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    expect(await prisma.refund.count({ where: { paymentId: payment.id } })).toBe(1);
  });

  it("(iii) a transfer-shortage incident stays open across unrelated transitions and cannot close while items are MISSING", async () => {
    const p1 = await readyOne(fx.districtB);
    const p2 = await readyOne(fx.districtB);
    const transfer = await crewedTransfer([p1.packageId, p2.packageId]);
    await transfersSvc.loadTransferPackage(waAActor, transfer.id, { trackingId: p1.trackingId });
    await transfersSvc.loadTransferPackage(waAActor, transfer.id, { trackingId: p2.trackingId });
    const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
    await tripsSvc.departTrip(linehaulActor, dispatched.tripId!);
    await tripsSvc.arriveTrip(linehaulActor, dispatched.tripId!);
    // Only p1 is unloaded + received; p2 never turns up.
    await transfersSvc.scanDestinationPackage(waBActor, transfer.id, { trackingId: p1.trackingId });
    await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
      packageId: p1.packageId,
      condition: "GOOD",
    });
    const finished = await transfersSvc.finishReceiving(waBActor, transfer.id);
    expect(finished.reconciliation.missingCount).toBe(1);
    const missingItem = await prisma.transferItem.findFirstOrThrow({
      where: { transferId: transfer.id, packageId: p2.packageId },
    });
    expect(missingItem.itemStatus).toBe("MISSING");
    const missingPkg = await prisma.package.findUniqueOrThrow({ where: { id: p2.packageId } });
    expect(missingPkg.exceptionStatus).toBe("MISSING");

    // The reconciliation raised the shortage incident; it is OPEN.
    const incident = await prisma.incident.findFirst({
      where: { transferId: transfer.id, category: "TRANSFER_SHORTAGE" },
    });
    expect(incident).not.toBeNull();
    expect(incident!.status).toBe("REPORTED");

    // An unrelated package lifecycle transition does not touch it.
    const unrelated = await bookOne(fx.whA, fx.districtB);
    await lifecycleSvc.transitionPackage(adminActor, unrelated.packageId, "CANCELLED", {
      notes: "P2C unrelated transition",
    });
    const afterUnrelated = await prisma.incident.findUniqueOrThrow({
      where: { id: incident!.id },
    });
    expect(afterUnrelated.status).toBe("REPORTED");

    // It cannot be closed from OPEN while the item is unaccounted.
    await expect(incidentsSvc.closeIncident(waBActor, incident!.id)).rejects.toBeInstanceOf(
      errors.ConflictError,
    );

    // Even in RESOLVED state, closure is refused while transfer
    // items remain MISSING/DISPUTED — unless the resolution was an
    // Admin-approved loss write-off. This fixture's approver is a
    // warehouse admin, so the guard must refuse. (Constructed
    // directly, the way transfers.ts raises incidents in-tx, because
    // the service workflow cannot reach RESOLVED for a money/loss
    // category without an Admin approver.)
    const resolvedFixture = await prisma.incident.create({
      data: {
        incidentNumber: `INC-P2C-${RUN}`,
        category: "TRANSFER_SHORTAGE",
        severity: "HIGH",
        status: "RESOLVED",
        transferId: transfer.id,
        warehouseId: fx.whB,
        packageId: p2.packageId,
        reporterId: fx.waB,
        description: "P2C resolved-fixture shortage",
        resolution: "P2C fixture resolution",
        resolutionProposedById: fx.waB,
        resolutionApprovedById: fx.waB,
        resolvedAt: new Date(),
      },
    });
    await expect(incidentsSvc.closeIncident(adminActor, resolvedFixture.id)).rejects.toMatchObject({
      name: "ConflictError",
      message: expect.stringMatching(/unaccounted/),
    });
    const stillResolved = await prisma.incident.findUniqueOrThrow({
      where: { id: resolvedFixture.id },
    });
    expect(stillResolved.status).toBe("RESOLVED");
  });
});

// ---------------------------------------------------------------------
// 6) Membership revocation immediacy (real getActorContext)
// ---------------------------------------------------------------------

describe("membership revocation immediacy", { timeout: 180_000 }, () => {
  it("revoking the membership row removes the warehouse from the rebuilt context; suspension resolves to no context", async () => {
    const revUser = await makeUser("revoked", "WAREHOUSE_ADMIN");
    await addMembership(revUser, fx.whA, "WAREHOUSE_ADMIN");

    authState.userId = revUser;
    try {
      const before = await permissionsLib.getActorContext();
      expect(before).not.toBeNull();
      expect(before!.warehouseIds).toContain(fx.whA);

      // Revoke in the DB — the very next per-request rebuild must
      // already exclude the warehouse (no cached scope).
      await prisma.warehouseMembership.updateMany({
        where: { userId: revUser, warehouseId: fx.whA, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const after = await permissionsLib.getActorContext();
      expect(after).not.toBeNull();
      expect(after!.warehouseIds).not.toContain(fx.whA);
      expect(after!.warehouseIds).toEqual([]);

      // And a scoped service call into A with the rebuilt context is
      // denied: a package stocked at A is outside the empty scope.
      const stocked = await bookOne(fx.whA, fx.districtB);
      await inventorySvc.receivePackage(staffAActor, {
        warehouseId: fx.whA,
        trackingId: stocked.trackingId,
      });
      await expect(
        inventorySvc.listPackageMovements(after!, stocked.packageId),
      ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

      // A user suspended in the DB is refused by the same path:
      // the resolver returns no context at all.
      const suspendedUser = await makeUser("suspended", "WAREHOUSE_ADMIN");
      await addMembership(suspendedUser, fx.whA, "WAREHOUSE_ADMIN");
      await prisma.user.update({
        where: { id: suspendedUser },
        data: { status: "SUSPENDED" },
      });
      authState.userId = suspendedUser;
      expect(await permissionsLib.getActorContext()).toBeNull();
    } finally {
      authState.userId = null;
    }
  });
});
