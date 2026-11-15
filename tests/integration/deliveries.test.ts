import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 6 integration tests (docs: implementation-roadmap Phase 6,
 * delivery-workflow, return-workflow, security-architecture §7)
 * against the local bla_test database: the full last-mile journey
 * (book → receive → transfer → destination receive →
 * READY_FOR_DELIVERY wired by assignment → batch → pickup → OTP
 * delivery with POD + exact COD), OTP failure counting / lockout /
 * expiry, COD mismatch recording, failed attempts progressing to
 * the return flow at the attempt limit, return receiving reopening
 * warehouse inventory, rider isolation (rider B cannot see or act on
 * rider A's packages), pickup shortage handling, batch closure
 * blocked by an unaccounted package, one-open-assignment
 * enforcement, and the detailed-tracking phone second factor with
 * its per-code lockout.
 *
 * Fixture warehouses are SHARED across runs (WH-ZP6 codes,
 * find-or-create) like the Phase 3/4/5 suites; users/vendors/
 * bookings/vehicles are per-run unique.
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
const email = (label: string) => `p6-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);
const RECIPIENT_PHONE = phone(101);
const TODAY = new Date().toISOString().slice(0, 10);

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
      fullName: `P6 ${label}`,
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
    sender: { name: "P6 Sender", phone: phone(42), email: null },
    recipient: {
      name: "P6 Recipient",
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
    idempotencyKey: `p6-load-${RUN}-${trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(linehaulActor, tripId);
  await tripsSvc.arriveTrip(linehaulActor, tripId);
  const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
    trackingId,
    idempotencyKey: `p6-unload-${RUN}-${trackingId}`,
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

async function openCustody(packageId: string) {
  return prisma.packageCustody.findFirst({ where: { packageId, endedAt: null } });
}

async function openRecord(packageId: string) {
  return prisma.inventoryRecord.findFirst({ where: { packageId, releasedAt: null } });
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
    otp: pickup.taken[0].otp,
  };
}

const wrongOtpFor = (real: string) => (real === "000000" ? "111111" : "000000");

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

  fx.districtA = "P6Alpha District";
  fx.districtB = "P6Beta District";
  const a = await ensureWarehouse("WH-ZP6-01", "P6 Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  const b = await ensureWarehouse("WH-ZP6-02", "P6 Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;
  fx.locRetB = b.locations.RETURNS;

  serviceCode = `P6STD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P6 Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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
    businessName: `P6 Vendor ${RUN}`,
    contactName: "P6 Contact",
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
  waAActor = await actorFor(fx.waA);
  staffAActor = await actorFor(fx.staffA);
  waBActor = await actorFor(fx.waB);
  staffBActor = await actorFor(fx.staffB);

  // Line-haul driver + vehicle for the A→B leg.
  fx.linehaulUser = await makeUser("linehaul", "LINEHAUL_DRIVER");
  const linehaul = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.linehaulUser,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P6-LH-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.linehaulProfile = linehaul.id;
  linehaulActor = await actorFor(fx.linehaulUser);
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P6 TRK ${RUN.slice(-6)}`.toUpperCase(),
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
      licenseNumber: `LIC-P6-${label}-${RUN}`.toUpperCase(),
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

describe("happy path: last-mile delivery with POD + exact COD", () => {
  it("runs destination receive → batch → pickup → OTP delivery, closing custody and recording COD", async () => {
    const { packageId, trackingId, batch, assignment, otp } = await outForDelivery("25000");

    // Assignment wired READY_FOR_DELIVERY on the way through.
    const events = await prisma.trackingEvent.findMany({
      where: { packageId },
      orderBy: { occurredAt: "asc" },
      select: { newStatus: true },
    });
    const statuses = events.map((e) => e.newStatus);
    expect(statuses).toContain("READY_FOR_DELIVERY");
    expect(statuses.indexOf("READY_FOR_DELIVERY")).toBeLessThan(
      statuses.indexOf("DELIVERY_ASSIGNED"),
    );

    let pkg = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.operationalStatus).toBe("OUT_FOR_DELIVERY");
    expect(pkg.deliveryStatus).toBe("OUT_FOR_DELIVERY");
    // Out with the rider: custody is the rider, no open stock record.
    const custodyOut = await openCustody(packageId);
    expect(custodyOut?.custodianType).toBe("USER");
    expect(custodyOut?.custodianUserId).toBe(fx.riderAUser);
    expect(await openRecord(packageId)).toBeNull();
    // OTP material is hashed at rest, never plaintext.
    const assignmentRow = await prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(assignmentRow.otpCodeHash).not.toBeNull();
    expect(assignmentRow.otpCodeHash).not.toBe(otp);
    expect(assignmentRow.otpExpiresAt!.getTime()).toBeGreaterThan(Date.now());

    const delivered = await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P6 Recipient",
      relationshipToRecipient: "Self",
      otpCode: otp,
      codCollectedPaisa: "25000",
    });
    expect(delivered.assignment.status).toBe("COMPLETED");
    expect(delivered.cod).toEqual({
      expectedPaisa: "25000",
      collectedPaisa: "25000",
      status: "MATCHED",
    });

    pkg = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.operationalStatus).toBe("DELIVERED");
    expect(pkg.deliveryStatus).toBe("DELIVERED");
    const custodyFinal = await openCustody(packageId);
    expect(custodyFinal?.custodianType).toBe("RECIPIENT");
    expect(await openRecord(packageId)).toBeNull();

    const pod = await prisma.proofOfDelivery.findFirst({ where: { packageId } });
    expect(pod?.receivedByName).toBe("P6 Recipient");
    expect(pod?.method).toBe("OTP");
    expect(pod?.otpVerifiedAt).not.toBeNull();
    const cod = await prisma.deliveryCodCollection.findUnique({ where: { packageId } });
    expect(cod?.status).toBe("MATCHED");
    expect(cod?.expectedPaisa).toBe(BigInt(25000));
    expect(cod?.collectedPaisa).toBe(BigInt(25000));
    const deliveredAttempt = await prisma.deliveryAttempt.findFirst({
      where: { packageId, result: "DELIVERED" },
    });
    expect(deliveredAttempt).not.toBeNull();

    // End of day: the batch closes cleanly.
    const closed = await deliveriesSvc.closeBatch(riderAActor, batch.id);
    expect(closed.batch.status).toBe("COMPLETED");
    expect(closed.delivered).toBe(1);
    fx.happyTrackingId = trackingId;
  });
});

describe("OTP gate", () => {
  it("counts wrong codes, locks at the limit, rejects expired codes, and recovers via regeneration", async () => {
    const { assignment, otp } = await outForDelivery();
    const wrong = wrongOtpFor(otp);

    for (let i = 1; i <= 3; i++) {
      await expect(
        deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
          receivedByName: "P6 Recipient",
          otpCode: wrong,
        }),
      ).rejects.toBeInstanceOf(errors.DomainValidationError);
      const row = await prisma.deliveryAssignment.findUniqueOrThrow({
        where: { id: assignment.id },
      });
      expect(row.otpFailedAttempts).toBe(i);
      expect(row.otpLockedAt === null).toBe(i < 3);
    }
    // Even the CORRECT code is refused while locked.
    await expect(
      deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
        receivedByName: "P6 Recipient",
        otpCode: otp,
      }),
    ).rejects.toThrow(/locked/);
    const otpFailureAudits = await prisma.auditLog.count({
      where: { action: "delivery.otp_failed", entityId: assignment.id },
    });
    expect(otpFailureAudits).toBe(3);

    // Regeneration clears the lock and issues a working code.
    const regen = await deliveriesSvc.regenerateOtp(riderAActor, assignment.id);
    const rowAfter = await prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(rowAfter.otpLockedAt).toBeNull();
    expect(rowAfter.otpFailedAttempts).toBe(0);
    const delivered = await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P6 Recipient",
      otpCode: regen.otp,
    });
    expect(delivered.assignment.status).toBe("COMPLETED");
  });

  it("rejects an expired code", async () => {
    const { assignment, otp, batch } = await outForDelivery();
    await prisma.deliveryAssignment.update({
      where: { id: assignment.id },
      data: { otpExpiresAt: new Date(Date.now() - 60_000) },
    });
    await expect(
      deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
        receivedByName: "P6 Recipient",
        otpCode: otp,
      }),
    ).rejects.toThrow(/expired/);
    // Recovery: regenerate, deliver, close.
    const regen = await deliveriesSvc.regenerateOtp(riderAActor, assignment.id);
    await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P6 Recipient",
      otpCode: regen.otp,
    });
    await deliveriesSvc.closeBatch(riderAActor, batch.id);
  });
});

describe("COD mismatch", () => {
  it("records a MISMATCH collection with exact amounts and still completes the delivery", async () => {
    const { packageId, assignment, otp, batch } = await outForDelivery("25000");
    // A mismatch without an explanation is refused outright.
    await expect(
      deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
        receivedByName: "P6 Recipient",
        otpCode: otp,
        codCollectedPaisa: "24000",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);

    const delivered = await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P6 Recipient",
      otpCode: otp,
      codCollectedPaisa: "24000",
      notes: "Recipient paid 1000 paisa less — balance promised tomorrow",
    });
    expect(delivered.cod).toEqual({
      expectedPaisa: "25000",
      collectedPaisa: "24000",
      status: "MISMATCH",
    });
    const cod = await prisma.deliveryCodCollection.findUnique({ where: { packageId } });
    expect(cod?.status).toBe("MISMATCH");
    expect(cod?.expectedPaisa).toBe(BigInt(25000));
    expect(cod?.collectedPaisa).toBe(BigInt(24000));
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.operationalStatus).toBe("DELIVERED");
    await deliveriesSvc.closeBatch(riderAActor, batch.id);
  });
});

describe("failed attempts → return flow", () => {
  it("progresses attempts, initiates a return at the limit, and completes the return at the warehouse", async () => {
    const { packageId, trackingId, assignment, batch } = await outForDelivery();

    for (let n = 1; n <= 3; n++) {
      const res = await deliveriesSvc.recordDeliveryAttempt(riderAActor, assignment.id, {
        result: "RECIPIENT_UNAVAILABLE",
        contactOutcome: "CALLED_NO_ANSWER",
        notes: `Attempt ${n}: nobody home`,
      });
      expect(res.attemptNumber).toBe(n);
      expect(res.failedAttempts).toBe(n);
      if (n < 3) {
        expect(res.returnRequest).toBeNull();
        expect(res.maxAttemptsReached).toBe(false);
      } else {
        expect(res.maxAttemptsReached).toBe(true);
        expect(res.returnRequest).not.toBeNull();
      }
    }
    const pkgAfterAttempts = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkgAfterAttempts.operationalStatus).toBe("DELIVERY_ATTEMPTED");
    expect(pkgAfterAttempts.exceptionStatus).toBe("RETURN_REQUESTED");
    expect(pkgAfterAttempts.deliveryStatus).toBe("RETURN_INITIATED");

    const ret = await prisma.returnRequest.findFirstOrThrow({ where: { packageId } });
    expect(ret.status).toBe("REQUESTED");
    expect(ret.reason).toBe("ATTEMPT_LIMIT_REACHED");
    expect(ret.returnNumber).toMatch(/^RTN-\d+$/);

    const approved = await returnsSvc.approveReturn(waBActor, ret.id, {
      chargeBearer: "VENDOR",
      chargeAmountPaisa: "5000",
    });
    expect(approved.status).toBe("APPROVED");

    // The rider hands the package back; the warehouse scan advances
    // the return and reopens stock in the Returns zone.
    const scan = await deliveriesSvc.scanBackPackage(staffBActor, {
      warehouseId: fx.whB,
      trackingId,
    });
    expect(scan.returnRequest?.status).toBe("RECEIVED");
    const pkgBack = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkgBack.operationalStatus).toBe("READY_FOR_DELIVERY");
    expect(pkgBack.deliveryStatus).toBe("RETURNED_TO_WAREHOUSE");
    const record = await openRecord(packageId);
    expect(record?.warehouseId).toBe(fx.whB);
    expect(record?.storageLocationId).toBe(fx.locRetB);
    const custodyBack = await openCustody(packageId);
    expect(custodyBack?.custodianType).toBe("WAREHOUSE");
    expect(custodyBack?.warehouseId).toBe(fx.whB);

    const inspected = await returnsSvc.inspectReturn(staffBActor, ret.id, {
      condition: "GOOD",
    });
    expect(inspected.status).toBe("INSPECTED");

    const completed = await returnsSvc.completeReturn(waBActor, ret.id, {});
    expect(completed.status).toBe("COMPLETED");
    expect(completed.handedToUserId).toBe(fx.vendorOwnerUser);
    const pkgFinal = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkgFinal.deliveryStatus).toBe("RETURNED_TO_SENDER");
    expect(pkgFinal.exceptionStatus).toBe("NONE");
    expect(await openRecord(packageId)).toBeNull();
    const custodyFinal = await openCustody(packageId);
    expect(custodyFinal?.custodianType).toBe("USER");
    expect(custodyFinal?.custodianUserId).toBe(fx.vendorOwnerUser);

    // Batch closes: the failed assignment is accounted by the return.
    const closed = await deliveriesSvc.closeBatch(waBActor, batch.id);
    expect(closed.batch.status).toBe("COMPLETED");
    expect(closed.returnedOrBack).toBe(1);
  });

  it("a REFUSED attempt initiates a return immediately", async () => {
    const { packageId, assignment, batch } = await outForDelivery();
    const res = await deliveriesSvc.recordDeliveryAttempt(riderAActor, assignment.id, {
      result: "REFUSED",
      notes: "Recipient refused the parcel at the door",
    });
    expect(res.returnRequest).not.toBeNull();
    const ret = await prisma.returnRequest.findFirstOrThrow({ where: { packageId } });
    expect(ret.reason).toBe("RECIPIENT_REFUSED");
    // Tidy the batch: scan back + close.
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    await deliveriesSvc.scanBackPackage(staffBActor, {
      warehouseId: fx.whB,
      trackingId: pkg.trackingId,
    });
    await deliveriesSvc.closeBatch(waBActor, batch.id);
  });
});

describe("rider isolation", () => {
  it("rider B cannot view or act on rider A's assignments (denied + audited)", async () => {
    const { assignment, batch } = await outForDelivery();

    await expect(deliveriesSvc.getRiderBatch(riderBActor, batch.id)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    await expect(
      deliveriesSvc.recordDeliveryAttempt(riderBActor, assignment.id, {
        result: "RECIPIENT_UNAVAILABLE",
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      deliveriesSvc.confirmDelivery(riderBActor, assignment.id, {
        receivedByName: "Intruder",
        otpCode: "123456",
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(deliveriesSvc.getDeliveryBatch(riderBActor, batch.id)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    const riderBBatches = await deliveriesSvc.listRiderBatches(riderBActor, { date: TODAY });
    expect(riderBBatches.map((b) => b.id)).not.toContain(batch.id);

    const denials = await prisma.auditLog.count({
      where: {
        action: "access.denied",
        actorId: fx.riderBUser,
        entityId: { in: [assignment.id, batch.id] },
      },
    });
    expect(denials).toBeGreaterThanOrEqual(3);

    // Rider A finishes the job and closes the batch.
    const fresh = await prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    expect(fresh.status).toBe("IN_PROGRESS");
    const pickupOtp = await deliveriesSvc.regenerateOtp(riderAActor, assignment.id);
    await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P6 Recipient",
      otpCode: pickupOtp.otp,
    });
    await deliveriesSvc.closeBatch(riderAActor, batch.id);
  });
});

describe("pickup shortage + batch closure rules", () => {
  it("marks an unscanned package as an explicit shortage and lets the dispatcher re-batch it", async () => {
    const p1 = await atDestination();
    const p2 = await atDestination();
    const batch = await makeBatch(fx.riderAUser);
    const added = await deliveriesSvc.addBatchPackages(waBActor, batch.id, {
      packageIds: [p1.packageId, p2.packageId],
    });
    expect(added.added).toHaveLength(2);

    const pickup = await deliveriesSvc.confirmPickup(riderAActor, batch.id, {
      trackingIds: [p1.trackingId],
    });
    expect(pickup.taken).toHaveLength(1);
    expect(pickup.shortages.map((s) => s.trackingId)).toEqual([p2.trackingId]);

    const shortAssignment = await prisma.deliveryAssignment.findFirstOrThrow({
      where: { packageId: p2.packageId },
    });
    expect(shortAssignment.status).toBe("FAILED");
    expect(shortAssignment.failureNote).toContain("PICKUP_SHORTAGE");
    const shortPkg = await prisma.package.findUniqueOrThrow({ where: { id: p2.packageId } });
    expect(shortPkg.operationalStatus).toBe("DELIVERY_ASSIGNED");
    expect(await openRecord(p2.packageId)).not.toBeNull();

    // Deliver the taken package; the batch then closes — the
    // shortage is accounted (stock never left the warehouse).
    await deliveriesSvc.confirmDelivery(riderAActor, pickup.taken[0].assignmentId, {
      receivedByName: "P6 Recipient",
      otpCode: pickup.taken[0].otp,
    });
    const closed = await deliveriesSvc.closeBatch(riderAActor, batch.id);
    expect(closed.batch.status).toBe("COMPLETED");
    expect(closed.delivered).toBe(1);
    expect(closed.returnedOrBack).toBe(1);

    // The dispatcher can re-batch the shorted package (the stale
    // DELIVERY_ASSIGNED state is released inside the add).
    const batch2 = await makeBatch(fx.riderBUser);
    const readded = await deliveriesSvc.addBatchPackages(waBActor, batch2.id, {
      packageIds: [p2.packageId],
    });
    expect(readded.rejected).toEqual([]);
    expect(readded.added).toHaveLength(1);
    const pickup2 = await deliveriesSvc.confirmPickup(riderBActor, batch2.id, {
      trackingIds: [p2.trackingId],
    });
    await deliveriesSvc.confirmDelivery(riderBActor, readded.added[0].id, {
      receivedByName: "P6 Recipient",
      otpCode: pickup2.taken[0].otp,
    });
    await deliveriesSvc.closeBatch(riderBActor, batch2.id);
  });

  it("blocks batch closure while a package is out unaccounted, naming it", async () => {
    const p1 = await atDestination();
    const p2 = await atDestination();
    const batch = await makeBatch(fx.riderAUser);
    await deliveriesSvc.addBatchPackages(waBActor, batch.id, {
      packageIds: [p1.packageId, p2.packageId],
    });
    const pickup = await deliveriesSvc.confirmPickup(riderAActor, batch.id, {
      trackingIds: [p1.trackingId, p2.trackingId],
    });
    expect(pickup.taken).toHaveLength(2);
    await deliveriesSvc.confirmDelivery(riderAActor, pickup.taken[0].assignmentId, {
      receivedByName: "P6 Recipient",
      otpCode: pickup.taken[0].otp,
    });
    await expect(deliveriesSvc.closeBatch(riderAActor, batch.id)).rejects.toThrow(
      new RegExp(`unaccounted.*${p2.trackingId}`),
    );
    // Scan the second package back; closure now succeeds.
    await deliveriesSvc.scanBackPackage(staffBActor, {
      warehouseId: fx.whB,
      trackingId: p2.trackingId,
    });
    const closed = await deliveriesSvc.closeBatch(riderAActor, batch.id);
    expect(closed.batch.status).toBe("COMPLETED");
    expect(closed.delivered).toBe(1);
    expect(closed.returnedOrBack).toBe(1);
  });
});

describe("one open assignment per package", () => {
  it("rejects a second batch assignment, including under concurrency", async () => {
    const parcel = await atDestination();
    const batchA = await makeBatch(fx.riderAUser);
    const batchB = await makeBatch(fx.riderBUser);
    const first = await deliveriesSvc.addBatchPackages(waBActor, batchA.id, {
      packageIds: [parcel.packageId],
    });
    expect(first.added).toHaveLength(1);
    const second = await deliveriesSvc.addBatchPackages(waBActor, batchB.id, {
      packageIds: [parcel.packageId],
    });
    expect(second.added).toEqual([]);
    expect(second.rejected).toHaveLength(1);
    expect(second.rejected[0].reason).toMatch(/already has an open delivery assignment/);

    // Concurrency: two fresh batches race for one fresh package —
    // exactly one wins (Package row lock + partial unique index).
    const parcel2 = await atDestination();
    const batchC = await makeBatch(fx.riderAUser);
    const batchD = await makeBatch(fx.riderBUser);
    const results = await Promise.allSettled([
      deliveriesSvc.addBatchPackages(waBActor, batchC.id, { packageIds: [parcel2.packageId] }),
      deliveriesSvc.addBatchPackages(waBActor, batchD.id, { packageIds: [parcel2.packageId] }),
    ]);
    const addedTotal = results.reduce((n, r) => {
      if (r.status === "fulfilled") return n + r.value.added.length;
      return n;
    }, 0);
    expect(addedTotal).toBe(1);
    const active = await prisma.deliveryAssignment.count({
      where: { packageId: parcel2.packageId, status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS"] } },
    });
    expect(active).toBe(1);

    // Cleanup: cancel both batches' assignments.
    await deliveriesSvc.cancelBatch(waBActor, batchA.id);
    await deliveriesSvc.cancelBatch(waBActor, batchC.id).catch(() => undefined);
    await deliveriesSvc.cancelBatch(waBActor, batchD.id).catch(() => undefined);
  });

  it("refuses batch creation for an ineligible rider", async () => {
    // The line-haul driver holds no RIDER role.
    await expect(
      deliveriesSvc.createDeliveryBatch(waBActor, {
        warehouseId: fx.whB,
        riderUserId: fx.linehaulUser,
        batchDate: TODAY,
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
  });
});

describe("detailed tracking second factor", () => {
  it("reveals the timeline + POD for the correct recipient phone", async () => {
    const view = await packagesSvc.getDetailedTracking(fx.happyTrackingId, RECIPIENT_PHONE);
    expect(view.recipientName).toBe("P6 Recipient");
    expect(view.status).toBe("DELIVERED");
    expect(view.proofOfDelivery?.receivedByName).toBe("P6 Recipient");
    expect(view.timeline.length).toBeGreaterThan(3);
    expect(view.timeline.some((e) => e.status === "DELIVERED")).toBe(true);
  });

  it("gives the identical generic denial for a wrong phone and an unknown tracking ID", async () => {
    const wrongPhone = await packagesSvc
      .getDetailedTracking(fx.happyTrackingId, phone(202))
      .catch((e: Error) => e);
    expect(wrongPhone).toBeInstanceOf(errors.NotFoundError);

    let unknownId = trackingLib.generateTrackingId();
    while (await prisma.package.findUnique({ where: { trackingId: unknownId } })) {
      unknownId = trackingLib.generateTrackingId();
    }
    const unknown = await packagesSvc
      .getDetailedTracking(unknownId, RECIPIENT_PHONE)
      .catch((e: Error) => e);
    expect(unknown).toBeInstanceOf(errors.NotFoundError);
    expect((unknown as Error).message).toBe((wrongPhone as Error).message);

    const attemptRows = await prisma.trackingAccessAttempt.count({
      where: { trackingId: fx.happyTrackingId, succeeded: false },
    });
    expect(attemptRows).toBeGreaterThanOrEqual(1);
    const auditRows = await prisma.auditLog.count({
      where: { action: "tracking.detailed_access_denied" },
    });
    expect(auditRows).toBeGreaterThanOrEqual(2);
  });

  it("locks the detailed view after repeated wrong phones — even for the correct phone", async () => {
    const parcel = await bookOne();
    for (let i = 0; i < 5; i++) {
      await expect(
        packagesSvc.getDetailedTracking(parcel.trackingId, phone(300 + i)),
      ).rejects.toBeInstanceOf(errors.NotFoundError);
    }
    // Correct phone, but the code is now locked for the cooling period.
    await expect(
      packagesSvc.getDetailedTracking(parcel.trackingId, RECIPIENT_PHONE),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    const failures = await prisma.trackingAccessAttempt.count({
      where: { trackingId: parcel.trackingId, succeeded: false },
    });
    expect(failures).toBeGreaterThanOrEqual(6);
  });
});
