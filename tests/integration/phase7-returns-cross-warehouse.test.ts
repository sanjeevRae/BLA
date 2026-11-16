import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 7 integration tests — cross-warehouse returns
 * (docs/return-workflow.md §3 steps 4–6, rule 4) against the local
 * bla_test database:
 *
 *  (i)   the full cross-warehouse segment — a package whose shipment
 *        origin is KTM is delivered out of PKR, refused, authorised
 *        and scanned back at PKR (return RECEIVED, destination KTM),
 *        manifested onto a PKR→KTM transfer, dispatched (return
 *        IN_TRANSIT, delivery assignment blocked), received at KTM
 *        (return RECEIVED again, first-receipt stamps preserved),
 *        inspected and completed with vendor handover at KTM — with
 *        the original delivery history only ever appended to;
 *  (ii)  manifesting a travelling return toward the WRONG warehouse
 *        is refused;
 *  (iii) manifesting a return that is still REQUESTED (not yet
 *        received) is refused;
 *  (iv)  a same-warehouse return never travels, and its same-
 *        warehouse flow still completes end to end;
 *  (v)   deterioration between initiation (GOOD) and inspection
 *        (DAMAGED) raises a DAMAGED_PACKAGE incident linked to the
 *        package at the inspection warehouse.
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
let returnsSvc: typeof import("@/server/services/returns");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let waKtmActor: Awaited<ReturnType<typeof actorFor>>;
let staffKtmActor: Awaited<ReturnType<typeof actorFor>>;
let waPkrActor: Awaited<ReturnType<typeof actorFor>>;
let staffPkrActor: Awaited<ReturnType<typeof actorFor>>;
let linehaulActor: Awaited<ReturnType<typeof actorFor>>;
let riderPkrActor: Awaited<ReturnType<typeof actorFor>>;
let riderKtmActor: Awaited<ReturnType<typeof actorFor>>;
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
  originWarehouseId: string,
  destDistrict: string,
): Promise<{ packageId: string; trackingId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId: fx.vendor,
    sender: { name: "P7R Sender", phone: phone(42), email: null },
    recipient: {
      name: "P7R Recipient",
      phone: RECIPIENT_PHONE,
      addressLine: "Main Street 1",
      city: "Town",
      district: destDistrict,
      province: "Bagmati",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
  });
  const pkg = booking.shipments[0].packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId };
}

/** Origin warehouse intake chain: receive → inspect → put away → ready. */
async function intakeAtOrigin(
  parcel: { packageId: string; trackingId: string },
  staff: Awaited<ReturnType<typeof actorFor>>,
  warehouseId: string,
  storageLocationId: string,
) {
  await inventorySvc.receivePackage(staff, { warehouseId, trackingId: parcel.trackingId });
  await inventorySvc.moveToInspection(staff, parcel.packageId);
  await inventorySvc.startInspection(staff, parcel.packageId);
  await inventorySvc.recordInspection(staff, {
    packageId: parcel.packageId,
    condition: "GOOD",
    actualWeightKg: 2,
  });
  await inventorySvc.putAwayPackage(staff, parcel.packageId, storageLocationId);
  await inventorySvc.markReadyForDispatch(staff, parcel.packageId);
}

/** Run one full transfer leg (manifest → crew → load → dispatch →
 *  trip → destination scan + complete → finish → reconcile → close). */
async function runTransferLeg(
  originWa: Awaited<ReturnType<typeof actorFor>>,
  destWa: Awaited<ReturnType<typeof actorFor>>,
  originWarehouseId: string,
  destinationWarehouseId: string,
  parcel: { packageId: string; trackingId: string },
) {
  const transfer = await transfersSvc.createTransfer(originWa, {
    originWarehouseId,
    destinationWarehouseId,
  });
  const added = await transfersSvc.addTransferItems(originWa, transfer.id, [parcel.packageId]);
  expect(added.rejected).toEqual([]);
  expect(added.added).toHaveLength(1);
  await transfersSvc.generateManifest(originWa, transfer.id);
  const crewed = await transfersSvc.assignTransferCrew(originWa, {
    transferId: transfer.id,
    driverId: fx.linehaulProfile,
    vehicleId: fx.vehicle,
  });
  const loaded = await transfersSvc.loadTransferPackage(originWa, transfer.id, {
    trackingId: parcel.trackingId,
    idempotencyKey: `p7r-load-${RUN}-${parcel.trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(originWa, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(linehaulActor, tripId);
  await tripsSvc.arriveTrip(linehaulActor, tripId);
  const scan = await transfersSvc.scanDestinationPackage(destWa, transfer.id, {
    trackingId: parcel.trackingId,
    idempotencyKey: `p7r-unload-${RUN}-${parcel.trackingId}`,
  });
  expect(scan.kind).toBe("RECEIVED_SCAN");
  await transfersSvc.completePackageReceiving(destWa, transfer.id, {
    packageId: parcel.packageId,
    condition: "GOOD",
  });
  await transfersSvc.finishReceiving(destWa, transfer.id);
  await transfersSvc.reconcileTransfer(destWa, transfer.id);
  await transfersSvc.closeTransfer(destWa, transfer.id);
  return transfer;
}

/** Book at KTM → forward transfer KTM→PKR → RECEIVED_AT_DESTINATION at PKR. */
async function atPkr() {
  const parcel = await bookOne(fx.whKtm, fx.districtPkr);
  await intakeAtOrigin(parcel, staffKtmActor, fx.whKtm, fx.locStoKtm);
  await runTransferLeg(waKtmActor, waPkrActor, fx.whKtm, fx.whPkr, parcel);
  const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
  expect(pkg.operationalStatus).toBe("RECEIVED_AT_DESTINATION");
  expect(pkg.currentWarehouseId).toBe(fx.whPkr);
  return parcel;
}

async function openCustody(packageId: string) {
  return prisma.packageCustody.findFirst({ where: { packageId, endedAt: null } });
}

async function openRecord(packageId: string) {
  return prisma.inventoryRecord.findFirst({ where: { packageId, releasedAt: null } });
}

/** Batch + assign + pickup at PKR, then a REFUSED attempt — the
 *  return is auto-initiated in REQUESTED (mirrors deliveries.test). */
async function refusedReturnAtPkr() {
  const parcel = await atPkr();
  const batch = await deliveriesSvc.createDeliveryBatch(waPkrActor, {
    warehouseId: fx.whPkr,
    riderUserId: fx.riderPkrUser,
    batchDate: TODAY,
    kind: "DELIVERY",
  });
  const added = await deliveriesSvc.addBatchPackages(waPkrActor, batch.id, {
    packageIds: [parcel.packageId],
  });
  expect(added.rejected).toEqual([]);
  const pickup = await deliveriesSvc.confirmPickup(riderPkrActor, batch.id, {
    trackingIds: [parcel.trackingId],
  });
  expect(pickup.taken).toHaveLength(1);
  const res = await deliveriesSvc.recordDeliveryAttempt(riderPkrActor, added.added[0].id, {
    result: "REFUSED",
    notes: "Recipient refused the parcel at the door",
  });
  expect(res.returnRequest).not.toBeNull();
  const ret = await prisma.returnRequest.findFirstOrThrow({
    where: { packageId: parcel.packageId },
  });
  expect(ret.status).toBe("REQUESTED");
  return { ...parcel, batch, returnId: ret.id };
}

/** A PKR return authorised + scanned back: status RECEIVED at PKR,
 *  destination (return) warehouse KTM. */
async function receivedReturnAtPkr() {
  const ctx = await refusedReturnAtPkr();
  await returnsSvc.approveReturn(waPkrActor, ctx.returnId, { chargeBearer: "VENDOR" });
  const scan = await deliveriesSvc.scanBackPackage(staffPkrActor, {
    warehouseId: fx.whPkr,
    trackingId: ctx.trackingId,
  });
  expect(scan.returnRequest?.status).toBe("RECEIVED");
  return ctx;
}

/** A LOCAL KTM parcel (origin = destination = KTM) taken out,
 *  refused, authorised and scanned back — a same-warehouse return
 *  in RECEIVED at KTM. */
async function receivedLocalReturnAtKtm() {
  const parcel = await bookOne(fx.whKtm, fx.districtKtm);
  await intakeAtOrigin(parcel, staffKtmActor, fx.whKtm, fx.locStoKtm);
  const batch = await deliveriesSvc.createDeliveryBatch(waKtmActor, {
    warehouseId: fx.whKtm,
    riderUserId: fx.riderKtmUser,
    batchDate: TODAY,
    kind: "DELIVERY",
  });
  const added = await deliveriesSvc.addBatchPackages(waKtmActor, batch.id, {
    packageIds: [parcel.packageId],
  });
  expect(added.rejected).toEqual([]);
  const pickup = await deliveriesSvc.confirmPickup(riderKtmActor, batch.id, {
    trackingIds: [parcel.trackingId],
  });
  expect(pickup.taken).toHaveLength(1);
  const res = await deliveriesSvc.recordDeliveryAttempt(riderKtmActor, added.added[0].id, {
    result: "REFUSED",
    notes: "Recipient refused the parcel at the door",
  });
  expect(res.returnRequest).not.toBeNull();
  const ret = await prisma.returnRequest.findFirstOrThrow({
    where: { packageId: parcel.packageId },
  });
  await returnsSvc.approveReturn(waKtmActor, ret.id, { chargeBearer: "VENDOR" });
  const scan = await deliveriesSvc.scanBackPackage(staffKtmActor, {
    warehouseId: fx.whKtm,
    trackingId: parcel.trackingId,
  });
  expect(scan.returnRequest?.status).toBe("RECEIVED");
  return { ...parcel, batch, returnId: ret.id };
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

  fx.districtKtm = "P7R KTM District";
  fx.districtPkr = "P7R PKR District";
  fx.districtThird = "P7R Third District";
  const ktm = await ensureWarehouse("WH-ZP7R-01", "P7R KTM (shared fixture)", fx.districtKtm);
  fx.whKtm = ktm.id;
  fx.locStoKtm = ktm.locations.STORAGE;
  fx.locRetKtm = ktm.locations.RETURNS;
  const pkr = await ensureWarehouse("WH-ZP7R-02", "P7R PKR (shared fixture)", fx.districtPkr);
  fx.whPkr = pkr.id;
  const third = await ensureWarehouse("WH-ZP7R-03", "P7R Third (shared fixture)", fx.districtThird);
  fx.whThird = third.id;

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

  fx.waKtm = await makeUser("waKtm", "WAREHOUSE_ADMIN");
  await addMembership(fx.waKtm, fx.whKtm, "WAREHOUSE_ADMIN");
  fx.staffKtm = await makeUser("staffKtm", "WAREHOUSE_STAFF");
  await addMembership(fx.staffKtm, fx.whKtm, "WAREHOUSE_STAFF");
  fx.waPkr = await makeUser("waPkr", "WAREHOUSE_ADMIN");
  await addMembership(fx.waPkr, fx.whPkr, "WAREHOUSE_ADMIN");
  fx.staffPkr = await makeUser("staffPkr", "WAREHOUSE_STAFF");
  await addMembership(fx.staffPkr, fx.whPkr, "WAREHOUSE_STAFF");
  waKtmActor = await actorFor(fx.waKtm);
  staffKtmActor = await actorFor(fx.staffKtm);
  waPkrActor = await actorFor(fx.waPkr);
  staffPkrActor = await actorFor(fx.staffPkr);

  // Line-haul driver + vehicle (home KTM; runs both directions).
  fx.linehaulUser = await makeUser("linehaul", "LINEHAUL_DRIVER");
  const linehaul = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.linehaulUser,
    homeWarehouseId: fx.whKtm,
    licenseNumber: `LIC-P7R-LH-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.linehaulProfile = linehaul.id;
  linehaulActor = await actorFor(fx.linehaulUser);
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P7R TRK ${RUN.slice(-6)}`.toUpperCase(),
    type: "TRUCK",
    capacityKg: 5000,
    homeWarehouseId: fx.whKtm,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  fx.vehicle = vehicle.id;

  // Last-mile riders at PKR and KTM.
  for (const [label, warehouseId] of [
    ["riderPkr", fx.whPkr],
    ["riderKtm", fx.whKtm],
  ] as const) {
    const userId = await makeUser(label, "RIDER");
    const profile = await driversSvc.createDriverProfile(adminActor, {
      userId,
      homeWarehouseId: warehouseId,
      licenseNumber: `LIC-P7R-${label}-${RUN}`.toUpperCase(),
      licenseCategory: "B",
      licenseExpiry: "2030-01-01",
      capabilities: ["DELIVERY", "PICKUP"],
    });
    fx[`${label}User`] = userId;
    fx[`${label}Profile`] = profile.id;
  }
  riderPkrActor = await actorFor(fx.riderPkrUser);
  riderKtmActor = await actorFor(fx.riderKtmUser);
}, 240_000);

// ---------------------------------------------------------------------------

describe("cross-warehouse returns (Phase 7)", () => {
  it("(i) travels PKR → KTM on a normal transfer and completes at the return warehouse", async () => {
    const { packageId, trackingId, returnId } = await receivedReturnAtPkr();

    // Creation derived the destination from the shipment origin (KTM).
    const atPkrRow = await prisma.returnRequest.findUniqueOrThrow({ where: { id: returnId } });
    expect(atPkrRow.status).toBe("RECEIVED");
    expect(atPkrRow.warehouseId).toBe(fx.whPkr);
    expect(atPkrRow.destinationWarehouseId).toBe(fx.whKtm);
    expect(atPkrRow.transferId).toBeNull();
    expect(atPkrRow.receivedById).toBe(fx.staffPkr);
    const viewAtPkr = await returnsSvc.getReturn(waPkrActor, returnId);
    expect(viewAtPkr.destinationWarehouseId).toBe(fx.whKtm);
    expect(viewAtPkr.destinationWarehouseCode).toBe("WH-ZP7R-01");
    expect(viewAtPkr.transferId).toBeNull();
    expect(viewAtPkr.transferNumber).toBeNull();

    // Snapshot the history so far — the return travel may only append.
    const eventsBefore = await prisma.trackingEvent.findMany({
      where: { packageId },
      select: { id: true },
    });
    expect(eventsBefore.length).toBeGreaterThan(0);

    // Manifest onto a PKR→KTM transfer (item add links the return).
    const transfer = await transfersSvc.createTransfer(waPkrActor, {
      originWarehouseId: fx.whPkr,
      destinationWarehouseId: fx.whKtm,
    });
    const added = await transfersSvc.addTransferItems(waPkrActor, transfer.id, [packageId]);
    expect(added.rejected).toEqual([]);
    expect(added.added).toHaveLength(1);
    const linked = await prisma.returnRequest.findUniqueOrThrow({ where: { id: returnId } });
    expect(linked.transferId).toBe(transfer.id);
    expect(linked.status).toBe("RECEIVED");
    const linkedView = await returnsSvc.getReturn(waPkrActor, returnId);
    expect(linkedView.transferId).toBe(transfer.id);
    expect(linkedView.transferNumber).toBe(transfer.transferNumber);
    // listReturns exposes the destination fields too.
    const listed = await returnsSvc.listReturns(waKtmActor, { warehouseId: fx.whKtm });
    const listedRow = listed.items.find((r) => r.id === returnId);
    expect(listedRow?.destinationWarehouseId).toBe(fx.whKtm);
    expect(listedRow?.transferId).toBe(transfer.id);

    await transfersSvc.generateManifest(waPkrActor, transfer.id);
    const pkgManifested = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkgManifested.operationalStatus).toBe("TRANSFER_ASSIGNED");
    const crewed = await transfersSvc.assignTransferCrew(waPkrActor, {
      transferId: transfer.id,
      driverId: fx.linehaulProfile,
      vehicleId: fx.vehicle,
    });
    const loaded = await transfersSvc.loadTransferPackage(waPkrActor, transfer.id, {
      trackingId,
      idempotencyKey: `p7r-load-ret-${RUN}-${trackingId}`,
    });
    expect(loaded.allLoaded).toBe(true);
    const dispatched = await transfersSvc.dispatchTransfer(waPkrActor, transfer.id);

    // Dispatch moved the return to IN_TRANSIT…
    const inTransit = await prisma.returnRequest.findUniqueOrThrow({ where: { id: returnId } });
    expect(inTransit.status).toBe("IN_TRANSIT");
    // …and an IN_TRANSIT return cannot be inspected or completed
    // (status guard: not RECEIVED/INSPECTED — asserted with the
    // unscoped admin so the status guard, not a scope check, fires).
    await expect(
      returnsSvc.inspectReturn(adminActor, returnId, { condition: "GOOD" }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    // …and the package cannot be assigned for delivery.
    const batch = await deliveriesSvc.createDeliveryBatch(waPkrActor, {
      warehouseId: fx.whPkr,
      riderUserId: fx.riderPkrUser,
      batchDate: TODAY,
      kind: "DELIVERY",
    });
    const blocked = await deliveriesSvc.addBatchPackages(waPkrActor, batch.id, {
      packageIds: [packageId],
    });
    expect(blocked.added).toEqual([]);
    expect(blocked.rejected).toHaveLength(1);
    expect(blocked.rejected[0].reason).toMatch(/open return/);

    // Trip to KTM; destination receiving lands it in KTM's RETURNS zone.
    const tripId = dispatched.tripId ?? crewed.tripId!;
    await tripsSvc.departTrip(linehaulActor, tripId);
    await tripsSvc.arriveTrip(linehaulActor, tripId);
    const scan = await transfersSvc.scanDestinationPackage(waKtmActor, transfer.id, {
      trackingId,
      idempotencyKey: `p7r-unload-ret-${RUN}-${trackingId}`,
    });
    expect(scan.kind).toBe("RECEIVED_SCAN");
    const recordAtKtm = await openRecord(packageId);
    expect(recordAtKtm?.warehouseId).toBe(fx.whKtm);
    expect(recordAtKtm?.storageLocationId).toBe(fx.locRetKtm);
    await transfersSvc.completePackageReceiving(waKtmActor, transfer.id, {
      packageId,
      condition: "GOOD",
    });

    // Receiving completion returned the return to RECEIVED, keeping
    // the FIRST receipt stamps (the PKR scan-back) untouched.
    const arrived = await prisma.returnRequest.findUniqueOrThrow({ where: { id: returnId } });
    expect(arrived.status).toBe("RECEIVED");
    expect(arrived.receivedById).toBe(atPkrRow.receivedById);
    expect(arrived.receivedAt?.getTime()).toBe(atPkrRow.receivedAt?.getTime());
    const arrivalEvent = await prisma.trackingEvent.findFirst({
      where: { packageId, eventType: "RETURN_RECEIVED_AT_DESTINATION" },
    });
    expect(arrivalEvent?.warehouseId).toBe(fx.whKtm);

    await transfersSvc.finishReceiving(waKtmActor, transfer.id);
    await transfersSvc.reconcileTransfer(waKtmActor, transfer.id);
    await transfersSvc.closeTransfer(waKtmActor, transfer.id);

    // Inspection authorises against the DESTINATION warehouse: PKR
    // staff are out of scope now; KTM staff inspect.
    await expect(
      returnsSvc.inspectReturn(staffPkrActor, returnId, { condition: "GOOD" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const inspected = await returnsSvc.inspectReturn(staffKtmActor, returnId, {
      condition: "GOOD",
    });
    expect(inspected.status).toBe("INSPECTED");
    expect(inspected.inspectedById).toBe(fx.staffKtm);

    // Completion = vendor handover at KTM.
    const completed = await returnsSvc.completeReturn(waKtmActor, returnId, {});
    expect(completed.status).toBe("COMPLETED");
    expect(completed.handedToUserId).toBe(fx.vendorOwnerUser);
    expect(completed.destinationWarehouseId).toBe(fx.whKtm);
    const pkgFinal = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkgFinal.deliveryStatus).toBe("RETURNED_TO_SENDER");
    expect(pkgFinal.currentWarehouseId).toBe(fx.whKtm);
    expect(await openRecord(packageId)).toBeNull();
    const custodyFinal = await openCustody(packageId);
    expect(custodyFinal?.custodianType).toBe("USER");
    expect(custodyFinal?.custodianUserId).toBe(fx.vendorOwnerUser);

    // Original delivery history untouched: every earlier event is
    // still there, and the return travel only appended its own.
    const eventsAfter = await prisma.trackingEvent.findMany({
      where: { packageId },
      select: { id: true, eventType: true },
    });
    const afterIds = new Set(eventsAfter.map((e) => e.id));
    for (const e of eventsBefore) expect(afterIds.has(e.id)).toBe(true);
    expect(eventsAfter.length).toBeGreaterThan(eventsBefore.length);
    expect(eventsAfter.some((e) => e.eventType === "RETURN_IN_TRANSIT")).toBe(true);
  });

  it("(ii) refuses to manifest a travelling return toward the wrong warehouse", async () => {
    const { packageId, returnId } = await receivedReturnAtPkr();
    const wrong = await transfersSvc.createTransfer(waPkrActor, {
      originWarehouseId: fx.whPkr,
      destinationWarehouseId: fx.whThird,
    });
    await expect(
      transfersSvc.addTransferItems(waPkrActor, wrong.id, [packageId]),
    ).rejects.toThrow(/may only travel to its return warehouse/);
    const items = await prisma.transferItem.count({ where: { transferId: wrong.id } });
    expect(items).toBe(0);
    const ret = await prisma.returnRequest.findUniqueOrThrow({ where: { id: returnId } });
    expect(ret.transferId).toBeNull();
    expect(ret.status).toBe("RECEIVED");
    await transfersSvc.cancelTransfer(waPkrActor, wrong.id, "test cleanup");
  });

  it("(vi) offers the received return in the transfer picker only toward its return warehouse", async () => {
    const { packageId } = await receivedReturnAtPkr();
    const towardReturn = await transfersSvc.listEligiblePackages(
      waPkrActor,
      fx.whPkr,
      fx.whKtm,
    );
    expect(towardReturn.map((p) => p.id)).toContain(packageId);
    const towardThird = await transfersSvc.listEligiblePackages(
      waPkrActor,
      fx.whPkr,
      fx.whThird,
    );
    expect(towardThird.map((p) => p.id)).not.toContain(packageId);
  });

  it("(iii) refuses to manifest a return that is still REQUESTED", async () => {
    const { packageId, trackingId, batch, returnId } = await refusedReturnAtPkr();
    const transfer = await transfersSvc.createTransfer(waPkrActor, {
      originWarehouseId: fx.whPkr,
      destinationWarehouseId: fx.whKtm,
    });
    await expect(
      transfersSvc.addTransferItems(waPkrActor, transfer.id, [packageId]),
    ).rejects.toThrow(/only a RECEIVED return can be manifested/);
    const items = await prisma.transferItem.count({ where: { transferId: transfer.id } });
    expect(items).toBe(0);
    const ret = await prisma.returnRequest.findUniqueOrThrow({ where: { id: returnId } });
    expect(ret.transferId).toBeNull();
    await transfersSvc.cancelTransfer(waPkrActor, transfer.id, "test cleanup");
    // Tidy: authorise + scan back so the delivery batch can close.
    await returnsSvc.approveReturn(waPkrActor, returnId, { chargeBearer: "VENDOR" });
    await deliveriesSvc.scanBackPackage(staffPkrActor, {
      warehouseId: fx.whPkr,
      trackingId,
    });
    await deliveriesSvc.closeBatch(waPkrActor, batch.id);
  });

  it("(iv) keeps a same-warehouse return off transfers and completes it in place", async () => {
    const { packageId, returnId } = await receivedLocalReturnAtKtm();
    const ret = await prisma.returnRequest.findUniqueOrThrow({ where: { id: returnId } });
    expect(ret.warehouseId).toBe(fx.whKtm);
    expect(ret.destinationWarehouseId).toBe(fx.whKtm);

    // A same-warehouse return never travels.
    const transfer = await transfersSvc.createTransfer(waKtmActor, {
      originWarehouseId: fx.whKtm,
      destinationWarehouseId: fx.whPkr,
    });
    await expect(
      transfersSvc.addTransferItems(waKtmActor, transfer.id, [packageId]),
    ).rejects.toThrow(/same-warehouse return/);
    await transfersSvc.cancelTransfer(waKtmActor, transfer.id, "test cleanup");

    // The same-warehouse flow completes end to end at KTM.
    const inspected = await returnsSvc.inspectReturn(staffKtmActor, returnId, {
      condition: "GOOD",
    });
    expect(inspected.status).toBe("INSPECTED");
    const completed = await returnsSvc.completeReturn(waKtmActor, returnId, {});
    expect(completed.status).toBe("COMPLETED");
    expect(completed.handedToUserId).toBe(fx.vendorOwnerUser);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.deliveryStatus).toBe("RETURNED_TO_SENDER");
    expect(await openRecord(packageId)).toBeNull();
  });

  it("(v) raises a DAMAGED_PACKAGE incident when inspection finds deterioration", async () => {
    const { packageId, returnId } = await receivedLocalReturnAtKtm();
    const ret = await prisma.returnRequest.findUniqueOrThrow({ where: { id: returnId } });
    expect(ret.conditionAtInitiation).toBe("GOOD");

    const inspected = await returnsSvc.inspectReturn(staffKtmActor, returnId, {
      condition: "DAMAGED",
    });
    expect(inspected.status).toBe("INSPECTED");
    expect(inspected.conditionAtInspection).toBe("DAMAGED");

    const incident = await prisma.incident.findFirst({
      where: { packageId, category: "DAMAGED_PACKAGE" },
    });
    expect(incident).not.toBeNull();
    expect(incident?.warehouseId).toBe(fx.whKtm);
    expect(incident?.reporterId).toBe(fx.staffKtm);
    expect(incident?.sourceKey).toBe(`return-deterioration:${returnId}`);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.exceptionStatus).toBe("DAMAGED");
    expect(pkg.condition).toBe("DAMAGED");
  });
});
