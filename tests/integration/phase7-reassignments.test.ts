import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 7 (V2) reassignment integration tests against the local
 * bla_test database:
 *  - deliveries.reassignBatch — whole-batch rider swap moving
 *    PENDING + IN_PROGRESS assignments, custody transfer for
 *    collected packages, FRESH recipient OTP (old code rejected),
 *    old rider's tracking session ENDED with REASSIGNED, old-batch
 *    closure rule (closes when nothing is pending; stays OPEN when
 *    delivered-COD close-out is pending on it).
 *  - trips.replaceTripDriver — en-route-only driver replacement
 *    with custody swap, availability moves, session end, and
 *    pre-departure refusal pointing at crew assignment.
 *  - Races: reassignBatch ∥ confirmDelivery and
 *    replaceTripDriver ∥ arriveTrip — exactly one succeeds and the
 *    end state (custody holder, assignment/trip state) is coherent
 *    with the winner.
 *
 * Fixture warehouses are SHARED across runs (WH-ZP7R codes,
 * find-or-create) like the Phase 5/6 suites; users/vendors/
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
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
const RUN_NUM = String(Math.floor(Math.random() * 90000) + 10000);
const email = (label: string) => `p7r-${label}-${RUN}@bla.test`;
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
let trackingSvc: typeof import("@/server/services/tracking");
let trackingDomain: typeof import("@/lib/tracking/domain");
let errors: typeof import("@/lib/errors");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
let lh1Actor: Awaited<ReturnType<typeof actorFor>>;
let lh2Actor: Awaited<ReturnType<typeof actorFor>>;
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
      fullName: `P7R ${label}`,
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
    sender: { name: "P7R Sender", phone: phone(42), email: null },
    recipient: {
      name: "P7R Recipient",
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
    driverId: fx.lh1Profile,
    vehicleId: fx.vehicle,
  });
  const loaded = await transfersSvc.loadTransferPackage(waAActor, transfer.id, {
    trackingId,
    idempotencyKey: `p7r-load-${RUN}-${trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(lh1Actor, tripId);
  await tripsSvc.arriveTrip(lh1Actor, tripId);
  const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
    trackingId,
    idempotencyKey: `p7r-unload-${RUN}-${trackingId}`,
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

/** Book at A → ready at A (no transfer): a line-haul candidate. */
async function readyOne(): Promise<{ packageId: string; trackingId: string }> {
  const { packageId, trackingId } = await bookOne();
  await inventorySvc.receivePackage(staffAActor, { warehouseId: fx.whA, trackingId });
  await inventorySvc.moveToInspection(staffAActor, packageId);
  await inventorySvc.startInspection(staffAActor, packageId);
  await inventorySvc.recordInspection(staffAActor, {
    packageId,
    condition: "GOOD",
    actualWeightKg: 2,
  });
  await inventorySvc.putAwayPackage(staffAActor, packageId, fx.locStoA);
  const ready = await inventorySvc.markReadyForDispatch(staffAActor, packageId);
  expect(ready.operationalStatus).toBe("READY_FOR_DISPATCH");
  return { packageId, trackingId };
}

async function openCustodies(packageId: string) {
  return prisma.packageCustody.findMany({ where: { packageId, endedAt: null } });
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

async function makeVehicle(label: string): Promise<string> {
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P7R ${label} ${RUN.slice(-5)}`.toUpperCase(),
    type: "TRUCK",
    capacityKg: 5000,
    homeWarehouseId: fx.whA,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  return vehicle.id;
}

/** A dispatched + departed (IN_TRANSIT) trip A→B for `driverProfile`. */
async function enRouteTrip(
  driverProfile: string,
  driverActor: Awaited<ReturnType<typeof actorFor>>,
  packageCount: number,
): Promise<{ transferId: string; tripId: string; packageIds: string[] }> {
  const parcels = [];
  for (let i = 0; i < packageCount; i++) parcels.push(await readyOne());
  const vehicleId = await makeVehicle(`T${Math.floor(Math.random() * 1e6)}`);
  const transfer = await transfersSvc.createTransfer(waAActor, {
    originWarehouseId: fx.whA,
    destinationWarehouseId: fx.whB,
  });
  const added = await transfersSvc.addTransferItems(
    waAActor,
    transfer.id,
    parcels.map((p) => p.packageId),
  );
  expect(added.rejected).toEqual([]);
  await transfersSvc.generateManifest(waAActor, transfer.id);
  const crewed = await transfersSvc.assignTransferCrew(waAActor, {
    transferId: transfer.id,
    driverId: driverProfile,
    vehicleId,
  });
  for (const p of parcels) {
    await transfersSvc.loadTransferPackage(waAActor, transfer.id, {
      trackingId: p.trackingId,
      idempotencyKey: `p7r-trip-load-${RUN}-${p.trackingId}`,
    });
  }
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(driverActor, tripId);
  return { transferId: transfer.id, tripId, packageIds: parcels.map((p) => p.packageId) };
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
  trackingSvc = await import("@/server/services/tracking");
  trackingDomain = await import("@/lib/tracking/domain");
  errors = await import("@/lib/errors");
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

  fx.districtA = "P7RAlpha District";
  fx.districtB = "P7RBeta District";
  const a = await ensureWarehouse("WH-ZP7R-01", "P7R Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  const b = await ensureWarehouse("WH-ZP7R-02", "P7R Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;

  serviceCode = `P7RSTD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P7R Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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
    businessName: `P7R Vendor ${RUN}`,
    contactName: "P7R Contact",
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

  // Line-haul drivers: lh1 runs the delivery-chain transfers and is
  // the "old" driver in the trip tests; lh2/lh4 are replacement
  // targets; lh3 holds a pre-departure trip of its own.
  for (const label of ["lh1", "lh2", "lh3", "lh4"] as const) {
    const userId = await makeUser(label, "LINEHAUL_DRIVER");
    const profile = await driversSvc.createDriverProfile(adminActor, {
      userId,
      homeWarehouseId: fx.whA,
      licenseNumber: `LIC-P7R-${label}-${RUN}`.toUpperCase(),
      licenseCategory: "C",
      licenseExpiry: "2030-01-01",
      capabilities: ["LINEHAUL"],
    });
    fx[`${label}User`] = userId;
    fx[`${label}Profile`] = profile.id;
  }
  lh1Actor = await actorFor(fx.lh1User);
  lh2Actor = await actorFor(fx.lh2User);

  // Shared vehicle for the sequential atDestination chain (freed at
  // each transfer close, like the Phase 6 suite).
  fx.vehicle = await makeVehicle("CHAIN");

  // Last-mile riders homed at destination warehouse B.
  for (const label of ["riderA", "riderB", "riderC"] as const) {
    const userId = await makeUser(label, "RIDER");
    const profile = await driversSvc.createDriverProfile(adminActor, {
      userId,
      homeWarehouseId: fx.whB,
      licenseNumber: `LIC-P7R-${label}-${RUN}`.toUpperCase(),
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

describe("tracking vocabulary", () => {
  it("includes REASSIGNED in TRACKING_END_REASONS", () => {
    expect(trackingDomain.TRACKING_END_REASONS).toContain("REASSIGNED");
  });
});

describe("reassignBatch — whole-batch rider swap", () => {
  it("moves PENDING + IN_PROGRESS packages, transfers custody, mints a fresh OTP, ends the old session REASSIGNED and closes the old batch", async () => {
    const parcelPending = await atDestination();
    const parcelOut = await atDestination();
    const batch = await deliveriesSvc.createDeliveryBatch(waBActor, {
      warehouseId: fx.whB,
      riderUserId: fx.riderAUser,
      batchDate: TODAY,
      kind: "DELIVERY",
    });
    const added = await deliveriesSvc.addBatchPackages(waBActor, batch.id, {
      packageIds: [parcelPending.packageId, parcelOut.packageId],
    });
    expect(added.rejected).toEqual([]);
    const pendingAssignment = added.added.find((a) => a.packageId === parcelPending.packageId)!;
    const outAssignment = added.added.find((a) => a.packageId === parcelOut.packageId)!;

    // Pick up ONLY the "out" parcel. The other is marked a pickup
    // shortage (FAILED) by confirmPickup; flipping that row back to
    // PENDING restores its exact pre-pickup state (package still
    // DELIVERY_ASSIGNED at the warehouse, warehouse custody and
    // stock open) — a dispatcher re-presenting the parcel to the
    // same rider. This is fixture surgery on OUR OWN row only.
    const pickup = await deliveriesSvc.confirmPickup(riderAActor, batch.id, {
      trackingIds: [parcelOut.trackingId],
    });
    expect(pickup.taken).toHaveLength(1);
    await prisma.deliveryAssignment.update({
      where: { id: pendingAssignment.id },
      data: { status: "PENDING", completedAt: null, failureNote: null },
    });
    const oldOtp = await recipientOtp(outAssignment.id);
    const oldHash = (
      await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: outAssignment.id } })
    ).otpCodeHash;
    expect(oldHash).not.toBeNull();

    // Old rider starts GPS tracking on the old batch.
    const session = await trackingSvc.startTrackingSession(riderAActor, {
      deliveryBatchId: batch.id,
      permissionAcknowledged: true,
    });
    expect(session.status).toBe("ACTIVE");

    const result = await deliveriesSvc.reassignBatch(waBActor, batch.id, {
      riderUserId: fx.riderBUser,
      reason: "Rider A called in sick mid-round",
    });
    expect(result.moved).toEqual({ pending: 1, accepted: 0, inProgress: 1, total: 2 });
    expect(result.oldBatchClosed).toBe(true);
    expect(result.previousBatch.status).toBe("COMPLETED");
    expect(result.batch.riderId).toBe(fx.riderBProfile);
    expect(result.batch.warehouseId).toBe(fx.whB);
    expect(result.batch.kind).toBe("DELIVERY");
    expect(result.batch.status).toBe("IN_PROGRESS");
    expect(result.batch.batchDate).toBe(TODAY);

    // Old assignments are terminal REASSIGNED with the reason.
    for (const old of [pendingAssignment, outAssignment]) {
      const row = await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: old.id } });
      expect(row.status).toBe("REASSIGNED");
      expect(row.failureNote).toBe("Rider A called in sick mid-round");
      expect(row.completedAt).not.toBeNull();
      expect(row.otpCodeHash).toBeNull();
    }
    // New assignments mirror status and link back.
    const newPending = result.assignments.find((a) => a.packageId === parcelPending.packageId)!;
    const newOut = result.assignments.find((a) => a.packageId === parcelOut.packageId)!;
    expect(newPending.status).toBe("PENDING");
    expect(newPending.reassignedFromId).toBe(pendingAssignment.id);
    expect(newOut.status).toBe("IN_PROGRESS");
    expect(newOut.reassignedFromId).toBe(outAssignment.id);
    expect(newOut.driverId).toBe(fx.riderBProfile);

    // Custody: exactly one open row, held by the new rider.
    const custodies = await openCustodies(parcelOut.packageId);
    expect(custodies).toHaveLength(1);
    expect(custodies[0].custodianType).toBe("USER");
    expect(custodies[0].custodianUserId).toBe(fx.riderBUser);

    // Old rider's session ENDED with REASSIGNED (also proves the DB
    // CHECK accepts the new vocabulary value).
    const sessionRow = await prisma.trackingSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(sessionRow.status).toBe("ENDED");
    expect(sessionRow.endReason).toBe("REASSIGNED");

    // Notifications: new rider per package, old rider for the batch.
    const newRiderNotes = await prisma.notification.count({
      where: {
        userId: fx.riderBUser,
        category: "DELIVERY_ASSIGNED",
        entityId: { in: [newPending.id, newOut.id] },
      },
    });
    expect(newRiderNotes).toBe(2);
    const oldRiderNotes = await prisma.notification.count({
      where: {
        userId: fx.riderAUser,
        category: "GENERAL",
        entityType: "DeliveryBatch",
        entityId: batch.id,
      },
    });
    expect(oldRiderNotes).toBe(1);

    // Audit with counts + reason.
    const audit = await prisma.auditLog.findFirst({
      where: { action: "delivery.batch_reassigned", entityId: batch.id },
    });
    expect(audit).not.toBeNull();
    const after = audit!.after as { reason?: string; moved?: { total?: number } };
    expect(after.reason).toBe("Rider A called in sick mid-round");
    expect(after.moved?.total).toBe(2);

    // New rider can start a session on the NEW batch.
    const newSession = await trackingSvc.startTrackingSession(riderBActor, {
      deliveryBatchId: result.batch.id,
      permissionAcknowledged: true,
    });
    expect(newSession.status).toBe("ACTIVE");
    await trackingSvc.stopTrackingSession(riderBActor, newSession.id);

    // The OLD code is rejected for the new assignment; the FRESH
    // code (delivered to the recipient for the new assignment)
    // confirms the delivery.
    const newAssignmentRow = await prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: newOut.id },
    });
    expect(newAssignmentRow.otpCodeHash).not.toBeNull();
    expect(newAssignmentRow.otpCodeHash).not.toBe(oldHash);
    await expect(
      deliveriesSvc.confirmDelivery(riderBActor, newOut.id, {
        receivedByName: "P7R Recipient",
        otpCode: oldOtp,
      }),
    ).rejects.toThrow(/Incorrect delivery code/);
    const newOtp = await recipientOtp(newOut.id);
    const delivered = await deliveriesSvc.confirmDelivery(riderBActor, newOut.id, {
      receivedByName: "P7R Recipient",
      otpCode: newOtp,
    });
    expect(delivered.assignment.status).toBe("COMPLETED");
    const finalCustody = await openCustodies(parcelOut.packageId);
    expect(finalCustody).toHaveLength(1);
    expect(finalCustody[0].custodianType).toBe("RECIPIENT");
  });

  it("leaves the old batch OPEN when delivered-COD close-out is pending on it", async () => {
    const parcelCod = await atDestination("10000");
    const parcelOut = await atDestination();
    const batch = await deliveriesSvc.createDeliveryBatch(waBActor, {
      warehouseId: fx.whB,
      riderUserId: fx.riderAUser,
      batchDate: TODAY,
      kind: "DELIVERY",
    });
    const added = await deliveriesSvc.addBatchPackages(waBActor, batch.id, {
      packageIds: [parcelCod.packageId, parcelOut.packageId],
    });
    expect(added.rejected).toEqual([]);
    const codAssignment = added.added.find((a) => a.packageId === parcelCod.packageId)!;
    await deliveriesSvc.confirmPickup(riderAActor, batch.id, {
      trackingIds: [parcelCod.trackingId, parcelOut.trackingId],
    });
    const delivered = await deliveriesSvc.confirmDelivery(riderAActor, codAssignment.id, {
      receivedByName: "P7R Recipient",
      otpCode: await recipientOtp(codAssignment.id),
      codCollectedPaisa: "10000",
    });
    expect(delivered.cod?.status).toBe("MATCHED");

    const result = await deliveriesSvc.reassignBatch(waBActor, batch.id, {
      riderUserId: fx.riderBUser,
      reason: "Rider A finished for the day",
    });
    expect(result.moved.total).toBe(1);
    // The COD the old rider collected on THIS batch is not yet on a
    // remittance — the old batch stays open for their close-out.
    expect(result.oldBatchClosed).toBe(false);
    expect(result.previousBatch.status).toBe("IN_PROGRESS");
    const custodies = await openCustodies(parcelOut.packageId);
    expect(custodies).toHaveLength(1);
    expect(custodies[0].custodianUserId).toBe(fx.riderBUser);
  });

  it("validates reason, rider difference and batch state", async () => {
    const batch = await deliveriesSvc.createDeliveryBatch(waBActor, {
      warehouseId: fx.whB,
      riderUserId: fx.riderCUser,
      batchDate: TODAY,
      kind: "DELIVERY",
    });
    await expect(
      deliveriesSvc.reassignBatch(waBActor, batch.id, {
        riderUserId: fx.riderBUser,
        reason: "ab",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      deliveriesSvc.reassignBatch(waBActor, batch.id, {
        riderUserId: fx.riderCUser,
        reason: "Same rider swap attempt",
      }),
    ).rejects.toThrow(/already assigned to this rider/);
    // A line-haul user is not an eligible delivery rider.
    await expect(
      deliveriesSvc.reassignBatch(waBActor, batch.id, {
        riderUserId: fx.lh2User,
        reason: "Wrong role for the round",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    // Cancelled batches refuse.
    await deliveriesSvc.cancelBatch(waBActor, batch.id);
    await expect(
      deliveriesSvc.reassignBatch(waBActor, batch.id, {
        riderUserId: fx.riderBUser,
        reason: "Batch was cancelled already",
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  });
});

describe("race: reassignBatch ∥ confirmDelivery", () => {
  it("exactly one succeeds and the end state matches the winner", async () => {
    const parcel = await atDestination();
    const batch = await deliveriesSvc.createDeliveryBatch(waBActor, {
      warehouseId: fx.whB,
      riderUserId: fx.riderAUser,
      batchDate: TODAY,
      kind: "DELIVERY",
    });
    const added = await deliveriesSvc.addBatchPackages(waBActor, batch.id, {
      packageIds: [parcel.packageId],
    });
    const assignment = added.added[0];
    await deliveriesSvc.confirmPickup(riderAActor, batch.id, {
      trackingIds: [parcel.trackingId],
    });
    const otp = await recipientOtp(assignment.id);

    const [reassign, delivery] = await Promise.allSettled([
      deliveriesSvc.reassignBatch(waBActor, batch.id, {
        riderUserId: fx.riderBUser,
        reason: "Race: rider swap mid-delivery",
      }),
      deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
        receivedByName: "P7R Recipient",
        otpCode: otp,
      }),
    ]);
    const successes = [reassign, delivery].filter((r) => r.status === "fulfilled");
    expect(successes).toHaveLength(1);

    const custodies = await openCustodies(parcel.packageId);
    expect(custodies).toHaveLength(1);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
    const oldRow = await prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    if (delivery.status === "fulfilled") {
      // Delivery won: package delivered, custody with the recipient,
      // the swap was refused and created nothing.
      expect(pkg.operationalStatus).toBe("DELIVERED");
      expect(oldRow.status).toBe("COMPLETED");
      expect(custodies[0].custodianType).toBe("RECIPIENT");
      const stray = await prisma.deliveryAssignment.count({
        where: { packageId: parcel.packageId, reassignedFromId: assignment.id },
      });
      expect(stray).toBe(0);
    } else {
      // Swap won: package still out, custody with the new rider,
      // old assignment REASSIGNED, delivery refused.
      expect(pkg.operationalStatus).toBe("OUT_FOR_DELIVERY");
      expect(oldRow.status).toBe("REASSIGNED");
      expect(custodies[0].custodianType).toBe("USER");
      expect(custodies[0].custodianUserId).toBe(fx.riderBUser);
      const moved = await prisma.deliveryAssignment.findFirst({
        where: { packageId: parcel.packageId, reassignedFromId: assignment.id },
      });
      expect(moved?.status).toBe("IN_PROGRESS");
      expect(moved?.driverId).toBe(fx.riderBProfile);
    }
  });
});

// ---------------------------------------------------------------------------

describe("replaceTripDriver — en-route driver replacement", () => {
  it("refuses a pre-departure trip and points at crew assignment", async () => {
    const parcel = await readyOne();
    const vehicleId = await makeVehicle("PRE");
    const transfer = await transfersSvc.createTransfer(waAActor, {
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
    });
    await transfersSvc.addTransferItems(waAActor, transfer.id, [parcel.packageId]);
    await transfersSvc.generateManifest(waAActor, transfer.id);
    const crewed = await transfersSvc.assignTransferCrew(waAActor, {
      transferId: transfer.id,
      driverId: fx.lh3Profile,
      vehicleId,
    });
    expect(crewed.tripId).not.toBeNull();
    await expect(
      tripsSvc.replaceTripDriver(waAActor, crewed.tripId!, {
        driverId: fx.lh4Profile,
        reason: "Trying to swap before departure",
      }),
    ).rejects.toThrow(/crew assignment/);
    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: crewed.tripId! } });
    expect(trip.driverId).toBe(fx.lh3Profile);
  });

  it("swaps driver + custody en route, frees the old driver, ends their session REASSIGNED and blocks their pings", async () => {
    const { transferId, tripId, packageIds } = await enRouteTrip(
      fx.lh1Profile,
      lh1Actor,
      2,
    );
    // Custody starts with the old driver (dispatch's write).
    for (const packageId of packageIds) {
      const custodies = await openCustodies(packageId);
      expect(custodies).toHaveLength(1);
      expect(custodies[0].custodianUserId).toBe(fx.lh1User);
    }
    const session = await trackingSvc.startTrackingSession(lh1Actor, {
      tripId,
      permissionAcknowledged: true,
    });
    expect(session.status).toBe("ACTIVE");

    // Same driver and a non-linehaul profile are refused first
    // (both roll back cleanly).
    await expect(
      tripsSvc.replaceTripDriver(waAActor, tripId, {
        driverId: fx.lh1Profile,
        reason: "Same driver replacement attempt",
      }),
    ).rejects.toThrow(/already assigned to that driver/);
    await expect(
      tripsSvc.replaceTripDriver(waAActor, tripId, {
        driverId: fx.riderAProfile,
        reason: "Rider cannot drive line-haul",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);

    const view = await tripsSvc.replaceTripDriver(waAActor, tripId, {
      driverId: fx.lh2Profile,
      reason: "Driver reported vehicle trouble and fatigue",
    });
    expect(view.driverId).toBe(fx.lh2Profile);
    expect(view.status).toBe("IN_TRANSIT");

    const tripRow = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(tripRow.driverId).toBe(fx.lh2Profile);
    const transferRow = await prisma.transfer.findUniqueOrThrow({
      where: { id: transferId },
    });
    expect(transferRow.driverId).toBe(fx.lh2Profile);
    expect(transferRow.vehicleId).not.toBeNull();

    // Custody: exactly one open row per package, held by lh2.
    for (const packageId of packageIds) {
      const custodies = await openCustodies(packageId);
      expect(custodies).toHaveLength(1);
      expect(custodies[0].custodianType).toBe("USER");
      expect(custodies[0].custodianUserId).toBe(fx.lh2User);
    }
    // Availability: old freed, new on trip.
    const oldDriver = await prisma.driver.findUniqueOrThrow({ where: { id: fx.lh1Profile } });
    expect(oldDriver.availabilityStatus).toBe("AVAILABLE");
    expect(oldDriver.currentTripId).toBeNull();
    const newDriver = await prisma.driver.findUniqueOrThrow({ where: { id: fx.lh2Profile } });
    expect(newDriver.availabilityStatus).toBe("ON_TRIP");
    expect(newDriver.currentTripId).toBe(tripId);

    // Old session ENDED / REASSIGNED; old driver's pings refused.
    const sessionRow = await prisma.trackingSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(sessionRow.status).toBe("ENDED");
    expect(sessionRow.endReason).toBe("REASSIGNED");
    await expect(
      trackingSvc.postLocationPing(lh1Actor, {
        trackingSessionId: session.id,
        latitude: 27.71,
        longitude: 85.31,
        accuracyMeters: 10,
        recordedAt: new Date().toISOString(),
        sequenceId: 1,
      }),
    ).rejects.toThrow(/not active/);

    // New driver can start their own session on the trip.
    const newSession = await trackingSvc.startTrackingSession(lh2Actor, {
      tripId,
      permissionAcknowledged: true,
    });
    expect(newSession.status).toBe("ACTIVE");
    await trackingSvc.stopTrackingSession(lh2Actor, newSession.id);

    // Audit + both drivers notified.
    const audit = await prisma.auditLog.findFirst({
      where: { action: "trip.driver_replaced", entityId: tripId },
    });
    expect(audit).not.toBeNull();
    const after = audit!.after as {
      previousDriverId?: string;
      newDriverId?: string;
      transferId?: string;
      reason?: string;
    };
    expect(after.previousDriverId).toBe(fx.lh1Profile);
    expect(after.newDriverId).toBe(fx.lh2Profile);
    expect(after.transferId).toBe(transferId);
    expect(after.reason).toBe("Driver reported vehicle trouble and fatigue");
    const notes = await prisma.notification.count({
      where: {
        category: "GENERAL",
        entityType: "Trip",
        entityId: tripId,
        userId: { in: [fx.lh1User, fx.lh2User] },
      },
    });
    expect(notes).toBe(2);
  });
});

describe("race: replaceTripDriver ∥ arriveTrip", () => {
  it("exactly one succeeds; custody holder matches the final trip driver", async () => {
    const { tripId, packageIds } = await enRouteTrip(fx.lh1Profile, lh1Actor, 2);

    const [replace, arrive] = await Promise.allSettled([
      tripsSvc.replaceTripDriver(waAActor, tripId, {
        driverId: fx.lh4Profile,
        reason: "Race: driver swap at arrival time",
      }),
      tripsSvc.arriveTrip(lh1Actor, tripId),
    ]);
    const successes = [replace, arrive].filter((r) => r.status === "fulfilled");
    expect(successes).toHaveLength(1);

    const tripRow = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    const finalDriverUserId =
      tripRow.driverId === fx.lh1Profile ? fx.lh1User : fx.lh4User;
    if (arrive.status === "fulfilled") {
      expect(tripRow.status).toBe("ARRIVED");
      expect(tripRow.driverId).toBe(fx.lh1Profile);
    } else {
      expect(tripRow.status).toBe("IN_TRANSIT");
      expect(tripRow.driverId).toBe(fx.lh4Profile);
    }
    for (const packageId of packageIds) {
      const custodies = await openCustodies(packageId);
      expect(custodies).toHaveLength(1);
      expect(custodies[0].custodianType).toBe("USER");
      expect(custodies[0].custodianUserId).toBe(finalDriverUserId);
    }
  });
});
