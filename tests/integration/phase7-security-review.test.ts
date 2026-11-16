import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 7 INDEPENDENT SECURITY REVIEW — adversarial PoCs.
 *
 * Written by a reviewer who did not build Phase 7. Every probe
 * asserts BOTH the refusal AND that no state changed on the refused
 * operation (row counts / status re-reads). Surfaces:
 *  S1 driver incident scope + follow-up tasks
 *  S2 bulk booking cross-vendor / atomicity / limits / scope
 *  S3 reassignment races + session isolation + pre-departure trips
 *  S4 returns custody (transfer hooks, inspect/complete scope,
 *     deterioration idempotency)
 *  S5 POD evidence reuse
 *  S6 driver detail scope + GPS gating
 *  S7 pickup leg scope + exception-clearing precision
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
const email = (label: string) => `p7s-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);
const RECIPIENT_PHONE = phone(101);
const TODAY = new Date().toISOString().slice(0, 10);
const BOGUS_UUID = "00000000-0000-4000-8000-000000000000";

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
let incidentsSvc: typeof import("@/server/services/incidents");
let returnsSvc: typeof import("@/server/services/returns");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

type Actor = Awaited<ReturnType<typeof actorFor>>;

const fx: Record<string, string> = {};
let adminActor: Actor;
let waAActor: Actor;
let staffAActor: Actor;
let waBActor: Actor;
let staffBActor: Actor;
let waCActor: Actor;
let lh1Actor: Actor;
let lh2Actor: Actor;
let riderAActor: Actor;
let riderBActor: Actor;
let riderPActor: Actor;
let riderP2Actor: Actor;
let vendor1Actor: Actor;
let customerActor: Actor;
let serviceCode: string;
let vendorAddrA: string;
let vendorAddrB: string;

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
      fullName: `P7S ${label}`,
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

async function makeDriver(
  label: string,
  roleCode: string,
  homeWarehouseId: string,
  capabilities: string[],
): Promise<{ userId: string; profileId: string }> {
  const userId = await makeUser(label, roleCode);
  const profile = await driversSvc.createDriverProfile(adminActor, {
    userId,
    homeWarehouseId,
    licenseNumber: `LIC-P7S-${label}-${RUN}`.toUpperCase(),
    licenseCategory: "B",
    licenseExpiry: "2030-01-01",
    capabilities: capabilities as never,
  });
  return { userId, profileId: profile.id };
}

async function makeVendor(label: string): Promise<{ vendorId: string; ownerUserId: string }> {
  const vendor = await vendorsSvc.createVendor(adminActor, {
    businessName: `P7S Vendor ${label} ${RUN}`,
    contactName: "P7S Contact",
    email: email(`vendor-${label}`),
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
  const ownerUserId = await makeUser(`owner-${label}`, "VENDOR");
  await prisma.vendorUser.create({
    data: {
      userId: ownerUserId,
      vendorId: vendor.id,
      vendorRole: "OWNER",
      isActive: true,
      invitedById: fx.adminUser,
    },
  });
  return { vendorId: vendor.id, ownerUserId };
}

async function makeVehicle(label: string): Promise<string> {
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P7S ${label} ${RUN.slice(-5)} ${Math.floor(Math.random() * 1e6)}`.toUpperCase(),
    type: "TRUCK",
    capacityKg: 5000,
    homeWarehouseId: fx.whA,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  return vehicle.id;
}

// --- booking / flow helpers -------------------------------------------------

async function bookDropoff(
  originWarehouseId: string,
  destDistrict: string,
  codAmountPaisa = "0",
): Promise<{ packageId: string; trackingId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId: fx.vendor1,
    sender: { name: "P7S Sender", phone: phone(42), email: null },
    recipient: {
      name: "P7S Recipient",
      phone: RECIPIENT_PHONE,
      addressLine: "Main Street 1",
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
  const pkg = booking.shipments[0].packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId };
}

async function bookPickup(
  vendorAddressId: string,
  recipientDistrict: string,
): Promise<{ packageId: string; trackingId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId: fx.vendor1,
    sender: { name: "P7S Sender", phone: phone(43), email: null },
    recipient: {
      name: "P7S Recipient",
      phone: phone(103),
      addressLine: "Pickup Street 1",
      city: "Town",
      district: recipientDistrict,
      province: "Bagmati",
    },
    pickup: { method: "RIDER_PICKUP" as const, vendorAddressId },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
  });
  const pkg = booking.shipments[0].packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId };
}

async function intake(
  parcel: { packageId: string; trackingId: string },
  staff: Actor,
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

/** Full transfer leg A→B etc. using lh3 + the shared chain vehicle. */
async function transferLeg(
  originWa: Actor,
  destWa: Actor,
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
  await transfersSvc.generateManifest(originWa, transfer.id);
  const crewed = await transfersSvc.assignTransferCrew(originWa, {
    transferId: transfer.id,
    driverId: fx.lh3Profile,
    vehicleId: fx.vehicle,
  });
  const loaded = await transfersSvc.loadTransferPackage(originWa, transfer.id, {
    trackingId: parcel.trackingId,
    idempotencyKey: `p7s-load-${RUN}-${parcel.trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(originWa, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  const lh3Actor = await actorFor(fx.lh3User);
  await tripsSvc.departTrip(lh3Actor, tripId);
  await tripsSvc.arriveTrip(lh3Actor, tripId);
  const scan = await transfersSvc.scanDestinationPackage(destWa, transfer.id, {
    trackingId: parcel.trackingId,
    idempotencyKey: `p7s-unload-${RUN}-${parcel.trackingId}`,
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

/** Book at A → intake at A → transfer A→B → RECEIVED_AT_DESTINATION at B. */
async function atDestinationB(codAmountPaisa = "0") {
  const parcel = await bookDropoff(fx.whA, fx.districtB, codAmountPaisa);
  await intake(parcel, staffAActor, fx.whA, fx.locStoA);
  await transferLeg(waAActor, waBActor, fx.whA, fx.whB, parcel);
  const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
  expect(pkg.operationalStatus).toBe("RECEIVED_AT_DESTINATION");
  expect(pkg.currentWarehouseId).toBe(fx.whB);
  return parcel;
}

/** Book at A → intake at A only: READY_FOR_DISPATCH at A. */
async function readyAtA() {
  const parcel = await bookDropoff(fx.whA, fx.districtB);
  await intake(parcel, staffAActor, fx.whA, fx.locStoA);
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
  if (!payload?.otpCode) throw new Error(`No recipient OTP for ${assignmentId}`);
  return payload.otpCode;
}

async function openCustodies(packageId: string) {
  return prisma.packageCustody.findMany({ where: { packageId, endedAt: null } });
}

/** Batch at B for `riderUserId`, add parcels, rider picks them all up. */
async function outForDeliveryB(
  parcels: { packageId: string; trackingId: string }[],
  riderUserId: string,
  riderActor: Actor,
) {
  const batch = await deliveriesSvc.createDeliveryBatch(waBActor, {
    warehouseId: fx.whB,
    riderUserId,
    batchDate: TODAY,
    kind: "DELIVERY",
  });
  const added = await deliveriesSvc.addBatchPackages(waBActor, batch.id, {
    packageIds: parcels.map((p) => p.packageId),
  });
  expect(added.rejected).toEqual([]);
  const pickup = await deliveriesSvc.confirmPickup(riderActor, batch.id, {
    trackingIds: parcels.map((p) => p.trackingId),
  });
  expect(pickup.failed).toEqual([]);
  expect(pickup.taken).toHaveLength(parcels.length);
  return { batchId: batch.id, assignments: added.added };
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
  incidentsSvc = await import("@/server/services/incidents");
  returnsSvc = await import("@/server/services/returns");
  errors = await import("@/lib/errors");
  actorErrors = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");

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

  fx.districtA = "P7SAlpha District";
  fx.districtB = "P7SBeta District";
  fx.districtC = "P7SGamma District";
  const a = await ensureWarehouse("WH-ZP7S-01", "P7S Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  const b = await ensureWarehouse("WH-ZP7S-02", "P7S Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;
  fx.locStoB = b.locations.STORAGE;
  const c = await ensureWarehouse("WH-ZP7S-03", "P7S Gamma (shared fixture)", fx.districtC);
  fx.whC = c.id;
  fx.locStoC = c.locations.STORAGE;

  serviceCode = `P7SSTD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P7S Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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

  const v1 = await makeVendor("one");
  fx.vendor1 = v1.vendorId;
  fx.vendor1Owner = v1.ownerUserId;
  const v2 = await makeVendor("two");
  fx.vendor2 = v2.vendorId;
  fx.vendor2Owner = v2.ownerUserId;
  vendor1Actor = await actorFor(fx.vendor1Owner);
  expect(vendor1Actor.vendorId).toBe(fx.vendor1);

  const addrA = await vendorsSvc.addVendorAddress(adminActor, fx.vendor1, {
    kind: "PICKUP",
    addressLine1: "Pickup Road A 1",
    city: "P7S Alpha (shared fixture)",
    district: fx.districtA,
    province: "Bagmati",
    approve: true,
  });
  vendorAddrA = addrA.id;
  const addrB = await vendorsSvc.addVendorAddress(adminActor, fx.vendor1, {
    kind: "PICKUP",
    addressLine1: "Pickup Road B 1",
    city: "P7S Beta (shared fixture)",
    district: fx.districtB,
    province: "Bagmati",
    approve: true,
  });
  vendorAddrB = addrB.id;

  fx.waA = await makeUser("waA", "WAREHOUSE_ADMIN");
  await addMembership(fx.waA, fx.whA, "WAREHOUSE_ADMIN");
  fx.staffA = await makeUser("staffA", "WAREHOUSE_STAFF");
  await addMembership(fx.staffA, fx.whA, "WAREHOUSE_STAFF");
  fx.waB = await makeUser("waB", "WAREHOUSE_ADMIN");
  await addMembership(fx.waB, fx.whB, "WAREHOUSE_ADMIN");
  fx.staffB = await makeUser("staffB", "WAREHOUSE_STAFF");
  await addMembership(fx.staffB, fx.whB, "WAREHOUSE_STAFF");
  fx.waC = await makeUser("waC", "WAREHOUSE_ADMIN");
  await addMembership(fx.waC, fx.whC, "WAREHOUSE_ADMIN");
  waAActor = await actorFor(fx.waA);
  staffAActor = await actorFor(fx.staffA);
  waBActor = await actorFor(fx.waB);
  staffBActor = await actorFor(fx.staffB);
  waCActor = await actorFor(fx.waC);

  for (const label of ["lh1", "lh2", "lh3", "lh4", "lh5", "lh6"] as const) {
    const d = await makeDriver(label, "LINEHAUL_DRIVER", fx.whA, ["LINEHAUL"]);
    fx[`${label}User`] = d.userId;
    fx[`${label}Profile`] = d.profileId;
  }
  lh1Actor = await actorFor(fx.lh1User);
  lh2Actor = await actorFor(fx.lh2User);
  expect(lh1Actor.warehouseIds).toEqual([]);

  for (const label of ["riderA", "riderB", "riderC"] as const) {
    const d = await makeDriver(label, "RIDER", fx.whB, ["DELIVERY", "PICKUP"]);
    fx[`${label}User`] = d.userId;
    fx[`${label}Profile`] = d.profileId;
  }
  riderAActor = await actorFor(fx.riderAUser);
  riderBActor = await actorFor(fx.riderBUser);
  expect(riderAActor.driverId).toBe(fx.riderAProfile);
  expect(riderAActor.warehouseIds).toEqual([]);

  for (const label of ["riderP", "riderP2"] as const) {
    const d = await makeDriver(label, "RIDER", fx.whA, ["DELIVERY", "PICKUP"]);
    fx[`${label}User`] = d.userId;
    fx[`${label}Profile`] = d.profileId;
  }
  riderPActor = await actorFor(fx.riderPUser);
  riderP2Actor = await actorFor(fx.riderP2User);

  fx.vehicle = await makeVehicle("CHAIN");

  fx.customerUser = await makeUser("customer", "CUSTOMER");
  const custPhone = phone(777);
  await prisma.customer.create({
    data: {
      fullName: "P7S Customer",
      phone: custPhone,
      normalizedPhone: custPhone,
      email: email("customer-profile"),
      userId: fx.customerUser,
    },
  });
  customerActor = await actorFor(fx.customerUser);
  expect(customerActor.customerId).not.toBeNull();
}, 240_000);

// ===========================================================================
// S2 — BULK BOOKING
// ===========================================================================

function vendorRow(vendorId: string, suffix: number, overrides: Record<string, unknown> = {}) {
  return {
    vendorId,
    sender: { name: "P7S Bulk Sender", phone: phone(42), email: null },
    recipient: {
      name: "P7S Bulk Recipient",
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
      name: "P7S Staff Recipient",
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

const orderCountFor = (createdById: string) =>
  prisma.order.count({ where: { createdById } });
const packageCountForOrders = async (createdById: string) =>
  prisma.package.count({ where: { order: { createdById } } });

describe("S2 bulk booking — cross-vendor, atomicity, limits, scope", () => {
  it("cross-vendor row (row 2 names vendor2) refuses the WHOLE bulk: zero orders/packages for either vendor", async () => {
    const beforeOrders = await orderCountFor(fx.vendor1Owner);
    const beforePkgs = await packageCountForOrders(fx.vendor1Owner);
    const beforeV2 = await prisma.order.count({ where: { vendorId: fx.vendor2 } });
    const failure = await bookingsSvc
      .createBulkBookings(vendor1Actor, {
        orders: [vendorRow(fx.vendor1, 201), vendorRow(fx.vendor2, 202)] as never,
      })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(actorErrors.AuthorizationError);
    expect((failure as Error).message).toContain("Row 2");
    expect(await orderCountFor(fx.vendor1Owner)).toBe(beforeOrders);
    expect(await packageCountForOrders(fx.vendor1Owner)).toBe(beforePkgs);
    expect(await prisma.order.count({ where: { vendorId: fx.vendor2 } })).toBe(beforeV2);
  });

  it("schema-invalid row 2 after a valid row 1 aborts everything (zero writes)", async () => {
    const before = await orderCountFor(fx.vendor1Owner);
    const bad = vendorRow(fx.vendor1, 212, { items: [] });
    const failure = await bookingsSvc
      .createBulkBookings(vendor1Actor, {
        orders: [vendorRow(fx.vendor1, 211), bad] as never,
      })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(errors.DomainValidationError);
    expect((failure as Error).message).toContain("Row 2");
    expect(await orderCountFor(fx.vendor1Owner)).toBe(before);
  });

  it("in-transaction failure on row 2 (nonexistent drop-off warehouse) rolls back row 1", async () => {
    const before = await orderCountFor(fx.adminUser);
    const beforePkgs = await packageCountForOrders(fx.adminUser);
    const failure = await bookingsSvc
      .createBulkBookings(adminActor, {
        orders: [staffRow(fx.whA, 221), staffRow(BOGUS_UUID, 222)] as never,
      })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(errors.DomainValidationError);
    expect((failure as Error).message).toContain("Row 2");
    expect(await orderCountFor(fx.adminUser)).toBe(before);
    expect(await packageCountForOrders(fx.adminUser)).toBe(beforePkgs);
  });

  it("51 rows refused and 0 rows refused, with zero writes either way", async () => {
    const before = await orderCountFor(fx.vendor1Owner);
    const rows51 = Array.from({ length: 51 }, (_, i) => vendorRow(fx.vendor1, 300 + i));
    const failure = await bookingsSvc
      .createBulkBookings(vendor1Actor, { orders: rows51 as never })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(errors.DomainValidationError);
    expect((failure as Error).message).toContain("50");
    await expect(
      bookingsSvc.createBulkBookings(vendor1Actor, { orders: [] as never }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    expect(await orderCountFor(fx.vendor1Owner)).toBe(before);
  });

  it("warehouse-scoped actor (WA@A) with row 2 origin at B loses the whole bulk", async () => {
    const before = await orderCountFor(fx.waA);
    const failure = await bookingsSvc
      .createBulkBookings(waAActor, {
        orders: [staffRow(fx.whA, 231), staffRow(fx.whB, 232)] as never,
      })
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(actorErrors.AuthorizationError);
    expect((failure as Error).message).toContain("Row 2");
    expect(await orderCountFor(fx.waA)).toBe(before);
  });

  it("one valid bulk call books each row exactly once (no retry double-booking); tracking IDs unique", async () => {
    const before = await orderCountFor(fx.vendor1Owner);
    const created = await bookingsSvc.createBulkBookings(vendor1Actor, {
      orders: [vendorRow(fx.vendor1, 241), vendorRow(fx.vendor1, 242), vendorRow(fx.vendor1, 243)] as never,
    });
    expect(created).toHaveLength(3);
    expect(await orderCountFor(fx.vendor1Owner)).toBe(before + 3);
    const trackingIds = created.flatMap((o) =>
      o.shipments.flatMap((s) => s.packages.map((p) => p.trackingId)),
    );
    expect(trackingIds).toHaveLength(3);
    expect(new Set(trackingIds).size).toBe(3);
  });
});

// ===========================================================================
// S7 — PICKUP LEG
// ===========================================================================

async function pickupBatchAtA(riderUserId: string) {
  return deliveriesSvc.createDeliveryBatch(waAActor, {
    warehouseId: fx.whA,
    riderUserId,
    batchDate: TODAY,
    kind: "PICKUP",
  });
}

async function failedPickup(parcel: { packageId: string; trackingId: string }) {
  const batch = await pickupBatchAtA(fx.riderPUser);
  const added = await deliveriesSvc.addBatchPackages(waAActor, batch.id, {
    packageIds: [parcel.packageId],
  });
  expect(added.rejected).toEqual([]);
  const assignmentId = added.added[0].id;
  const res = await deliveriesSvc.recordPickupAttempt(riderPActor, assignmentId, {
    reason: "Sender unavailable — shop closed",
  });
  expect(res.assignment.status).toBe("FAILED");
  const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
  expect(pkg.exceptionStatus).toBe("PICKUP_FAILED");
  return { batchId: batch.id, assignmentId };
}

describe("S7 pickup leg — scope, eligibility, exception precision", () => {
  it("WA@A cannot add a pickup package physically at B to a batch at A (rejected, no assignment row)", async () => {
    const parcel = await bookPickup(vendorAddrB, fx.districtB);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
    expect(pkg.currentWarehouseId).toBe(fx.whB);
    const batch = await pickupBatchAtA(fx.riderPUser);
    const res = await deliveriesSvc.addBatchPackages(waAActor, batch.id, {
      packageIds: [parcel.packageId],
    });
    expect(res.added).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].reason).toMatch(/another warehouse/);
    expect(
      await prisma.deliveryAssignment.count({ where: { packageId: parcel.packageId } }),
    ).toBe(0);
  });

  it("WAREHOUSE_DROPOFF package is refused by a PICKUP batch (no assignment row)", async () => {
    const parcel = await bookDropoff(fx.whA, fx.districtA);
    const batch = await pickupBatchAtA(fx.riderPUser);
    const res = await deliveriesSvc.addBatchPackages(waAActor, batch.id, {
      packageIds: [parcel.packageId],
    });
    expect(res.added).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].reason).toMatch(/not a rider-pickup booking/);
    expect(
      await prisma.deliveryAssignment.count({ where: { packageId: parcel.packageId } }),
    ).toBe(0);
  });

  it("PROBE: a package carrying an ACTIVE delivery assignment must not be pickup-assigned", async () => {
    const parcel = await bookPickup(vendorAddrA, fx.districtA);
    // Fixture surgery: an ACTIVE (PENDING) DELIVERY assignment on a
    // BOOKED pickup package — the state the invariant speaks about.
    const deliveryBatch = await deliveriesSvc.createDeliveryBatch(waAActor, {
      warehouseId: fx.whA,
      riderUserId: fx.riderPUser,
      batchDate: TODAY,
      kind: "DELIVERY",
    });
    await prisma.deliveryAssignment.create({
      data: {
        packageId: parcel.packageId,
        driverId: fx.riderPProfile,
        batchId: deliveryBatch.id,
        kind: "DELIVERY",
        status: "PENDING",
        assignedById: fx.adminUser,
      },
    });
    const batch = await pickupBatchAtA(fx.riderPUser);
    const res = await deliveriesSvc.addBatchPackages(waAActor, batch.id, {
      packageIds: [parcel.packageId],
    });
    // Invariant: pickup assignment must be refused while a delivery
    // assignment is active.
    expect(res.added).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    const pickupAssignments = await prisma.deliveryAssignment.count({
      where: { packageId: parcel.packageId, kind: "PICKUP" },
    });
    expect(pickupAssignments).toBe(0);
  });

  it("a DAMAGED blocking exception is NOT cleared and blocks pickup re-assignment", async () => {
    const parcel = await bookPickup(vendorAddrA, fx.districtA);
    await failedPickup(parcel);
    // Surgery: while the failed pickup awaited rescheduling, the
    // parcel was found damaged — exception flag now DAMAGED.
    await prisma.package.update({
      where: { id: parcel.packageId },
      data: { exceptionStatus: "DAMAGED" },
    });
    const batch = await pickupBatchAtA(fx.riderP2User);
    const res = await deliveriesSvc.addBatchPackages(waAActor, batch.id, {
      packageIds: [parcel.packageId],
    });
    expect(res.added).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
    expect(pkg.exceptionStatus).toBe("DAMAGED");
    expect(
      await prisma.deliveryAssignment.count({
        where: { packageId: parcel.packageId, kind: "PICKUP", status: "PENDING" },
      }),
    ).toBe(0);
  });

  it("re-assignment clears ONLY PICKUP_FAILED: a different non-blocking exception survives; PICKUP_FAILED clears to NONE", async () => {
    // Control: plain PICKUP_FAILED clears on re-assignment.
    const control = await bookPickup(vendorAddrA, fx.districtA);
    await failedPickup(control);
    const batch1 = await pickupBatchAtA(fx.riderP2User);
    const re1 = await deliveriesSvc.addBatchPackages(waAActor, batch1.id, {
      packageIds: [control.packageId],
    });
    expect(re1.rejected).toEqual([]);
    const controlPkg = await prisma.package.findUniqueOrThrow({ where: { id: control.packageId } });
    expect(controlPkg.exceptionStatus).toBe("NONE");

    // Probe: exception overwritten by a different (non-blocking)
    // flag before rescheduling — re-assignment must NOT clear it.
    const parcel = await bookPickup(vendorAddrA, fx.districtA);
    await failedPickup(parcel);
    await prisma.package.update({
      where: { id: parcel.packageId },
      data: { exceptionStatus: "CUSTOMER_UNAVAILABLE" },
    });
    const batch2 = await pickupBatchAtA(fx.riderP2User);
    const re2 = await deliveriesSvc.addBatchPackages(waAActor, batch2.id, {
      packageIds: [parcel.packageId],
    });
    expect(re2.rejected).toEqual([]);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
    expect(pkg.exceptionStatus).toBe("CUSTOMER_UNAVAILABLE");
  });

  it("collection generates NO OTP material and NO delivery-OTP notification; wrong rider refused; shortages stay PENDING", async () => {
    const p1 = await bookPickup(vendorAddrA, fx.districtA);
    const p2 = await bookPickup(vendorAddrA, fx.districtA);
    const batch = await pickupBatchAtA(fx.riderPUser);
    const added = await deliveriesSvc.addBatchPackages(waAActor, batch.id, {
      packageIds: [p1.packageId, p2.packageId],
    });
    expect(added.rejected).toEqual([]);
    const asg1 = added.added.find((a) => a.packageId === p1.packageId)!;
    const asg2 = added.added.find((a) => a.packageId === p2.packageId)!;

    // A rider who does not own the batch cannot collect from it.
    await expect(
      deliveriesSvc.confirmPickupCollection(riderP2Actor, batch.id, {
        trackingIds: [p1.trackingId],
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const stillAssigned = await prisma.package.findUniqueOrThrow({ where: { id: p1.packageId } });
    expect(stillAssigned.operationalStatus).toBe("PICKUP_ASSIGNED");

    // Collect only p1: p2 is a shortage and stays PENDING.
    const res = await deliveriesSvc.confirmPickupCollection(riderPActor, batch.id, {
      trackingIds: [p1.trackingId],
    });
    expect(res.taken).toHaveLength(1);
    expect(res.shortages.map((s) => s.trackingId)).toEqual([p2.trackingId]);
    const asg2Row = await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: asg2.id } });
    expect(asg2Row.status).toBe("PENDING");
    const pkg2 = await prisma.package.findUniqueOrThrow({ where: { id: p2.packageId } });
    expect(pkg2.operationalStatus).toBe("PICKUP_ASSIGNED");

    // No OTP material on the completed pickup assignment.
    const asg1Row = await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: asg1.id } });
    expect(asg1Row.status).toBe("COMPLETED");
    expect(asg1Row.otpCodeHash).toBeNull();
    expect(asg1Row.otpGeneratedAt).toBeNull();
    expect(asg1Row.otpExpiresAt).toBeNull();
    const otpNotes = await prisma.notification.count({
      where: { category: "DELIVERY_OTP", entityType: "DeliveryAssignment", entityId: asg1.id },
    });
    expect(otpNotes).toBe(0);
  });
});

// ===========================================================================
// S1 — DRIVER INCIDENT SCOPE + FOLLOW-UP TASKS
// ===========================================================================

const incidentCountFor = (reporterId: string) =>
  prisma.incident.count({ where: { reporterId } });

let s1: {
  asgA: string;
  asgB: string;
  pkgB: string;
  tripId: string;
  tripPkg: string;
  ownIncidentId: string;
} | null = null;

async function s1Setup() {
  if (s1) return s1;
  const parcelA = await atDestinationB();
  const batchA = await deliveriesSvc.createDeliveryBatch(waBActor, {
    warehouseId: fx.whB,
    riderUserId: fx.riderAUser,
    batchDate: TODAY,
    kind: "DELIVERY",
  });
  const addedA = await deliveriesSvc.addBatchPackages(waBActor, batchA.id, {
    packageIds: [parcelA.packageId],
  });
  expect(addedA.rejected).toEqual([]);

  const parcelB = await atDestinationB();
  const batchB = await deliveriesSvc.createDeliveryBatch(waBActor, {
    warehouseId: fx.whB,
    riderUserId: fx.riderBUser,
    batchDate: TODAY,
    kind: "DELIVERY",
  });
  const addedB = await deliveriesSvc.addBatchPackages(waBActor, batchB.id, {
    packageIds: [parcelB.packageId],
  });
  expect(addedB.rejected).toEqual([]);

  // lh1's own EN-ROUTE trip A→B with one manifested package.
  const tripParcel = await readyAtA();
  const vehicleId = await makeVehicle("S1TRIP");
  const transfer = await transfersSvc.createTransfer(waAActor, {
    originWarehouseId: fx.whA,
    destinationWarehouseId: fx.whB,
  });
  const tAdded = await transfersSvc.addTransferItems(waAActor, transfer.id, [
    tripParcel.packageId,
  ]);
  expect(tAdded.rejected).toEqual([]);
  await transfersSvc.generateManifest(waAActor, transfer.id);
  const crewed = await transfersSvc.assignTransferCrew(waAActor, {
    transferId: transfer.id,
    driverId: fx.lh1Profile,
    vehicleId,
  });
  await transfersSvc.loadTransferPackage(waAActor, transfer.id, {
    trackingId: tripParcel.trackingId,
    idempotencyKey: `p7s-s1-load-${RUN}-${tripParcel.trackingId}`,
  });
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(lh1Actor, tripId);
  const tripRow = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
  expect(tripRow.status).toBe("IN_TRANSIT");

  s1 = {
    asgA: addedA.added[0].id,
    asgB: addedB.added[0].id,
    pkgB: parcelB.packageId,
    tripId,
    tripPkg: tripParcel.packageId,
    ownIncidentId: "",
  };
  return s1;
}

describe("S1 driver incident scope", () => {
  it("driver A linking driver B's assignment / package / another driver's trip is refused and creates NO incident", async () => {
    const ctx = await s1Setup();
    const before = await incidentCountFor(fx.riderAUser);

    await expect(
      incidentsSvc.createIncident(riderAActor, {
        category: "DELIVERY_FAILURE",
        description: "Probe: linking rider B assignment",
        deliveryAssignmentId: ctx.asgB,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    await expect(
      incidentsSvc.createIncident(riderAActor, {
        category: "DAMAGED_PACKAGE",
        description: "Probe: linking rider B package directly",
        packageId: ctx.pkgB,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    await expect(
      incidentsSvc.createIncident(riderAActor, {
        category: "DRIVER_BREAKDOWN",
        description: "Probe: rider linking line-haul trip",
        tripId: ctx.tripId,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    // A line-haul peer cannot claim lh1's trip either.
    await expect(
      incidentsSvc.createIncident(lh2Actor, {
        category: "DRIVER_BREAKDOWN",
        description: "Probe: lh2 linking lh1 trip",
        tripId: ctx.tripId,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    // Nor can a rider claim the package manifested on lh1's trip.
    await expect(
      incidentsSvc.createIncident(riderAActor, {
        category: "DAMAGED_PACKAGE",
        description: "Probe: rider linking manifested package of lh1",
        packageId: ctx.tripPkg,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    expect(await incidentCountFor(fx.riderAUser)).toBe(before);
    expect(await incidentCountFor(fx.lh2User)).toBe(0);
  });

  it("combined-link smuggling is refused: own assignment + foreign trip, and own assignment + foreign package", async () => {
    const ctx = await s1Setup();
    const before = await incidentCountFor(fx.riderAUser);
    await expect(
      incidentsSvc.createIncident(riderAActor, {
        category: "DELIVERY_FAILURE",
        description: "Probe: own assignment plus lh1 trip",
        deliveryAssignmentId: ctx.asgA,
        tripId: ctx.tripId,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      incidentsSvc.createIncident(riderAActor, {
        category: "DELIVERY_FAILURE",
        description: "Probe: own assignment plus rider B package",
        deliveryAssignmentId: ctx.asgA,
        packageId: ctx.pkgB,
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    // A bare foreign warehouseId with no valid work link is refused too.
    await expect(
      incidentsSvc.createIncident(riderAActor, {
        category: "DELIVERY_FAILURE",
        description: "Probe: foreign warehouse, no links",
        warehouseId: fx.whC,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    expect(await incidentCountFor(fx.riderAUser)).toBe(before);
  });

  it("controls: own assignment, own trip and own manifested package all succeed with derived warehouses", async () => {
    const ctx = await s1Setup();
    const own = await incidentsSvc.createIncident(riderAActor, {
      category: "DELIVERY_FAILURE",
      description: "Recipient gate locked, could not deliver",
      deliveryAssignmentId: ctx.asgA,
    });
    expect(own.warehouseId).toBe(fx.whB);
    expect(own.deliveryAssignmentId).toBe(ctx.asgA);
    ctx.ownIncidentId = own.id;

    const tripIncident = await incidentsSvc.createIncident(lh1Actor, {
      category: "DRIVER_BREAKDOWN",
      description: "Engine warning light on the highway",
      tripId: ctx.tripId,
    });
    expect(tripIncident.warehouseId).toBe(fx.whA);
    expect(tripIncident.tripId).toBe(ctx.tripId);

    const manifested = await incidentsSvc.createIncident(lh1Actor, {
      category: "DAMAGED_PACKAGE",
      description: "Corner crushed on manifested parcel",
      packageId: ctx.tripPkg,
    });
    expect(manifested.packageId).toBe(ctx.tripPkg);
  });

  it("driver reads: another driver cannot getIncident or list the incident; foreign WA cannot either", async () => {
    const ctx = await s1Setup();
    expect(ctx.ownIncidentId).not.toBe("");
    await expect(
      incidentsSvc.getIncident(riderBActor, ctx.ownIncidentId),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      incidentsSvc.getIncident(waCActor, ctx.ownIncidentId),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const listB = await incidentsSvc.listIncidents(riderBActor, { pageSize: 100 });
    expect(listB.items.map((i) => i.id)).not.toContain(ctx.ownIncidentId);
    const listA = await incidentsSvc.listIncidents(riderAActor, { pageSize: 100 });
    expect(listA.items.map((i) => i.id)).toContain(ctx.ownIncidentId);
    const detail = await incidentsSvc.getIncident(riderAActor, ctx.ownIncidentId);
    expect(detail.id).toBe(ctx.ownIncidentId);
  });

  it("follow-up tasks: scoped-out actors refused; fake/vendor/customer assignees refused; warehouse derives from the incident", async () => {
    const ctx = await s1Setup();
    const taskCount = () =>
      prisma.task.count({ where: { relatedIncidentId: ctx.ownIncidentId } });
    expect(await taskCount()).toBe(0);

    // The reporter (a rider) holds no incident.manage.
    await expect(
      incidentsSvc.createIncidentFollowUpTask(riderAActor, ctx.ownIncidentId, {
        assigneeId: fx.staffB,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // A warehouse manager of an unrelated warehouse cannot see it.
    await expect(
      incidentsSvc.createIncidentFollowUpTask(waCActor, ctx.ownIncidentId, {
        assigneeId: fx.staffB,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    expect(await taskCount()).toBe(0);

    // Nonexistent user, vendor user and customer user assignees.
    await expect(
      incidentsSvc.createIncidentFollowUpTask(waBActor, ctx.ownIncidentId, {
        assigneeId: BOGUS_UUID,
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      incidentsSvc.createIncidentFollowUpTask(waBActor, ctx.ownIncidentId, {
        assigneeId: fx.vendor1Owner,
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      incidentsSvc.createIncidentFollowUpTask(waBActor, ctx.ownIncidentId, {
        assigneeId: fx.customerUser,
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    expect(await taskCount()).toBe(0);

    // Control: a real staff assignee works; the task inherits the
    // incident's warehouse (B) — the schema carries no warehouse input.
    const task = await incidentsSvc.createIncidentFollowUpTask(waBActor, ctx.ownIncidentId, {
      assigneeId: fx.staffB,
    });
    expect(task.warehouseId).toBe(fx.whB);
    expect(task.relatedIncidentId).toBe(ctx.ownIncidentId);
    expect(task.assigneeId).toBe(fx.staffB);
    expect(await taskCount()).toBe(1);
  });
});

// ===========================================================================
// S5 — POD EVIDENCE REUSE
// ===========================================================================

const REF1 = `evidence://p7s-${RUN}-photo-1`;
const REF2 = `evidence://p7s-${RUN}-race-1`;
const hashOf = (ref: string) => deliveriesSvc.hashEvidenceReference(ref);
const bindingCount = (ref: string) =>
  prisma.deliveryEvidenceBinding.count({ where: { evidenceHash: hashOf(ref) } });
const podCount = (packageId: string) =>
  prisma.proofOfDelivery.count({ where: { packageId } });

let s5: { asgByPkg: Map<string, string>; pkgs: string[] } | null = null;

async function s5Setup() {
  if (s5) return s5;
  const parcels = [
    await atDestinationB(),
    await atDestinationB(),
    await atDestinationB(),
    await atDestinationB(),
  ];
  const { assignments } = await outForDeliveryB(parcels, fx.riderAUser, riderAActor);
  const asgByPkg = new Map(assignments.map((a) => [a.packageId, a.id]));
  s5 = { asgByPkg, pkgs: parcels.map((p) => p.packageId) };
  return s5;
}

async function deliver(assignmentId: string, extra: Record<string, unknown> = {}) {
  return deliveriesSvc.confirmDelivery(riderAActor, assignmentId, {
    receivedByName: "P7S Recipient",
    otpCode: await recipientOtp(assignmentId),
    ...extra,
  });
}

describe("S5 evidence reuse", () => {
  it("same reference on a second package is refused and the second delivery is FULLY rolled back", async () => {
    const ctx = await s5Setup();
    const [pkg1, pkg2] = ctx.pkgs;
    const asg1 = ctx.asgByPkg.get(pkg1)!;
    const asg2 = ctx.asgByPkg.get(pkg2)!;

    const ok = await deliver(asg1, { photoFileId: REF1 });
    expect(ok.assignment.status).toBe("COMPLETED");
    expect(await bindingCount(REF1)).toBe(1);
    expect(await podCount(pkg1)).toBe(1);

    const failure = await deliver(asg2, { photoFileId: REF1 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(errors.DomainValidationError);
    expect((failure as Error).message).toContain("already been used");

    // Full rollback: package not delivered, assignment still out,
    // no POD, custody still with the rider, no second binding.
    const pkg2Row = await prisma.package.findUniqueOrThrow({ where: { id: pkg2 } });
    expect(pkg2Row.operationalStatus).toBe("OUT_FOR_DELIVERY");
    const asg2Row = await prisma.deliveryAssignment.findUniqueOrThrow({ where: { id: asg2 } });
    expect(asg2Row.status).toBe("IN_PROGRESS");
    expect(await podCount(pkg2)).toBe(0);
    expect(await bindingCount(REF1)).toBe(1);
    const custodies = await openCustodies(pkg2);
    expect(custodies).toHaveLength(1);
    expect(custodies[0].custodianUserId).toBe(fx.riderAUser);
  });

  it("cross-kind reuse (photo ref as signature) and whitespace-padded reuse are both refused, state unchanged", async () => {
    const ctx = await s5Setup();
    const pkg2 = ctx.pkgs[1];
    const asg2 = ctx.asgByPkg.get(pkg2)!;

    const crossKind = await deliver(asg2, { signatureFileId: REF1 }).catch((e: unknown) => e);
    expect(crossKind).toBeInstanceOf(errors.DomainValidationError);
    expect((crossKind as Error).message).toContain("already been used");

    const padded = await deliver(asg2, { photoFileId: `  ${REF1}  ` }).catch(
      (e: unknown) => e,
    );
    expect(padded).toBeInstanceOf(errors.DomainValidationError);
    expect((padded as Error).message).toContain("already been used");

    const pkg2Row = await prisma.package.findUniqueOrThrow({ where: { id: pkg2 } });
    expect(pkg2Row.operationalStatus).toBe("OUT_FOR_DELIVERY");
    expect(await podCount(pkg2)).toBe(0);
    expect(await bindingCount(REF1)).toBe(1);
  });

  it("blank / whitespace-only references bind nothing and the delivery succeeds cleanly", async () => {
    const ctx = await s5Setup();
    const pkg2 = ctx.pkgs[1];
    const asg2 = ctx.asgByPkg.get(pkg2)!;
    const bindingsBefore = await prisma.deliveryEvidenceBinding.count();
    const ok = await deliver(asg2, { photoFileId: "   ", signatureFileId: " \t " });
    expect(ok.assignment.status).toBe("COMPLETED");
    const pod = await prisma.proofOfDelivery.findFirstOrThrow({ where: { packageId: pkg2 } });
    expect(pod.photoFileId).toBeNull();
    expect(pod.signatureFileId).toBeNull();
    expect(await prisma.deliveryEvidenceBinding.count()).toBe(bindingsBefore);
  });

  it("bind primitive: same package re-binding the same hash does not duplicate (either kind); cross-package throws", async () => {
    const ctx = await s5Setup();
    const pkg1 = ctx.pkgs[0];
    const asg1 = ctx.asgByPkg.get(pkg1)!;
    const pod1 = await prisma.proofOfDelivery.findFirstOrThrow({ where: { packageId: pkg1 } });

    const again = await prisma.$transaction((tx) =>
      deliveriesSvc.bindDeliveryEvidence(tx, {
        evidenceHash: hashOf(REF1),
        evidenceKind: "SIGNATURE",
        packageId: pkg1,
        assignmentId: asg1,
        proofOfDeliveryId: pod1.id,
        createdById: fx.riderAUser,
      }),
    );
    expect(again).toBe(false);
    expect(await bindingCount(REF1)).toBe(1);

    const pkg2 = ctx.pkgs[1];
    const asg2 = ctx.asgByPkg.get(pkg2)!;
    await expect(
      prisma.$transaction((tx) =>
        deliveriesSvc.bindDeliveryEvidence(tx, {
          evidenceHash: hashOf(REF1),
          evidenceKind: "PHOTO",
          packageId: pkg2,
          assignmentId: asg2,
          proofOfDeliveryId: pod1.id,
          createdById: fx.riderAUser,
        }),
      ),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    expect(await bindingCount(REF1)).toBe(1);
  });

  it("concurrent deliveries racing the SAME fresh reference: exactly one wins, loser fully rolled back", async () => {
    const ctx = await s5Setup();
    const pkg3 = ctx.pkgs[2];
    const pkg4 = ctx.pkgs[3];
    const asg3 = ctx.asgByPkg.get(pkg3)!;
    const asg4 = ctx.asgByPkg.get(pkg4)!;
    const [otp3, otp4] = [await recipientOtp(asg3), await recipientOtp(asg4)];

    const results = await Promise.allSettled([
      deliveriesSvc.confirmDelivery(riderAActor, asg3, {
        receivedByName: "P7S Recipient",
        otpCode: otp3,
        photoFileId: REF2,
      }),
      deliveriesSvc.confirmDelivery(riderAActor, asg4, {
        receivedByName: "P7S Recipient",
        otpCode: otp4,
        photoFileId: REF2,
      }),
    ]);
    const successes = results.filter((r) => r.status === "fulfilled");
    expect(successes).toHaveLength(1);
    expect(await bindingCount(REF2)).toBe(1);
    const deliveredCount =
      (await prisma.package.count({
        where: { id: { in: [pkg3, pkg4] }, operationalStatus: "DELIVERED" },
      })) ?? 0;
    expect(deliveredCount).toBe(1);
    expect((await podCount(pkg3)) + (await podCount(pkg4))).toBe(1);
  });
});

// ===========================================================================
// S3 — REASSIGNMENT RACES / SESSIONS / PRE-DEPARTURE TRIPS / COD
// ===========================================================================

describe("S3 reassignment races and session isolation", () => {
  it("race reassignBatch ∥ confirmDelivery: exactly one succeeds, one open custody, at most one POD", async () => {
    const parcel = await atDestinationB();
    const { batchId, assignments } = await outForDeliveryB([parcel], fx.riderAUser, riderAActor);
    const assignment = assignments[0];
    const otp = await recipientOtp(assignment.id);

    const [reassign, delivery] = await Promise.allSettled([
      deliveriesSvc.reassignBatch(waBActor, batchId, {
        riderUserId: fx.riderBUser,
        reason: "Race probe: swap mid-delivery",
      }),
      deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
        receivedByName: "P7S Recipient",
        otpCode: otp,
      }),
    ]);
    expect([reassign, delivery].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const custodies = await openCustodies(parcel.packageId);
    expect(custodies).toHaveLength(1);
    expect((await podCount(parcel.packageId)) <= 1).toBe(true);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
    if (delivery.status === "fulfilled") {
      expect(pkg.operationalStatus).toBe("DELIVERED");
      expect(custodies[0].custodianType).toBe("RECIPIENT");
    } else {
      expect(pkg.operationalStatus).toBe("OUT_FOR_DELIVERY");
      expect(custodies[0].custodianUserId).toBe(fx.riderBUser);
    }
  });

  it("concurrent double-reassign of the same batch: exactly one winner, one successor assignment, one custody", async () => {
    const parcel = await atDestinationB();
    const { batchId, assignments } = await outForDeliveryB([parcel], fx.riderAUser, riderAActor);
    const oldAssignment = assignments[0];

    const [toB, toC] = await Promise.allSettled([
      deliveriesSvc.reassignBatch(waBActor, batchId, {
        riderUserId: fx.riderBUser,
        reason: "Race probe: double swap to B",
      }),
      deliveriesSvc.reassignBatch(waBActor, batchId, {
        riderUserId: fx.riderCUser,
        reason: "Race probe: double swap to C",
      }),
    ]);
    const winners = [toB, toC].filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    const successors = await prisma.deliveryAssignment.count({
      where: { reassignedFromId: oldAssignment.id },
    });
    expect(successors).toBe(1);
    const oldRow = await prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: oldAssignment.id },
    });
    expect(oldRow.status).toBe("REASSIGNED");
    const custodies = await openCustodies(parcel.packageId);
    expect(custodies).toHaveLength(1);
    expect([fx.riderBUser, fx.riderCUser]).toContain(custodies[0].custodianUserId);
  });

  it("reassigning batch 1 ends ONLY batch 1's tracking session; the session on batch 2 stays ACTIVE", async () => {
    const p1 = await atDestinationB();
    const p2 = await atDestinationB();
    const { batchId: batch1 } = await outForDeliveryB([p1], fx.riderAUser, riderAActor);

    // Second batch for the same rider, created directly (fixture
    // surgery on our own rows), with its own ACTIVE session row.
    const batch2Row = await prisma.deliveryBatch.create({
      data: {
        riderId: fx.riderAProfile,
        warehouseId: fx.whB,
        batchDate: new Date(TODAY),
        kind: "DELIVERY",
        status: "OPEN",
        createdById: fx.waB,
      },
    });
    const added2 = await deliveriesSvc.addBatchPackages(waBActor, batch2Row.id, {
      packageIds: [p2.packageId],
    });
    expect(added2.rejected).toEqual([]);
    await deliveriesSvc.confirmPickup(riderAActor, batch2Row.id, {
      trackingIds: [p2.trackingId],
    });

    const session1 = await trackingSvc.startTrackingSession(riderAActor, {
      deliveryBatchId: batch1,
      permissionAcknowledged: true,
    });
    expect(session1.status).toBe("ACTIVE");
    // NOTE: a partial unique index allows only ONE active session
    // per driver, so a same-driver session on batch 2 cannot even
    // exist; the other-batch session below belongs to rider B. The
    // invariant under probe is that the batch-1 reassignment ends
    // sessions by BATCH, never touching batch 2's session.
    const session2 = await prisma.trackingSession.create({
      data: {
        driverId: fx.riderBProfile,
        deliveryBatchId: batch2Row.id,
        trackingType: "DELIVERY",
        originWarehouseId: fx.whB,
        status: "ACTIVE",
        startReason: "DRIVER",
        permissionAcknowledgedAt: new Date(),
      },
    });

    await deliveriesSvc.reassignBatch(waBActor, batch1, {
      riderUserId: fx.riderBUser,
      reason: "Session isolation probe swap",
    });

    const s1Row = await prisma.trackingSession.findUniqueOrThrow({ where: { id: session1.id } });
    expect(s1Row.status).toBe("ENDED");
    expect(s1Row.endReason).toBe("REASSIGNED");
    const s2Row = await prisma.trackingSession.findUniqueOrThrow({ where: { id: session2.id } });
    expect(s2Row.status).toBe("ACTIVE");
    expect(s2Row.endReason).toBeNull();
    await prisma.trackingSession.update({
      where: { id: session2.id },
      data: { status: "ENDED", endedAt: new Date(), endReason: "ASSIGNMENT_COMPLETED" },
    });
  });

  it("COD-pending old batch stays OPEN and its COD collection stays attached + reconcilable after reassign", async () => {
    const codParcel = await atDestinationB("10000");
    const outParcel = await atDestinationB();
    const { batchId, assignments } = await outForDeliveryB(
      [codParcel, outParcel],
      fx.riderAUser,
      riderAActor,
    );
    const codAsg = assignments.find((a) => a.packageId === codParcel.packageId)!;
    const delivered = await deliveriesSvc.confirmDelivery(riderAActor, codAsg.id, {
      receivedByName: "P7S Recipient",
      otpCode: await recipientOtp(codAsg.id),
      codCollectedPaisa: "10000",
    });
    expect(delivered.cod?.status).toBe("MATCHED");

    const result = await deliveriesSvc.reassignBatch(waBActor, batchId, {
      riderUserId: fx.riderBUser,
      reason: "Rider A done for the day",
    });
    expect(result.oldBatchClosed).toBe(false);
    const batchRow = await prisma.deliveryBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batchRow.status).toBe("IN_PROGRESS");
    const collection = await prisma.deliveryCodCollection.findFirstOrThrow({
      where: { packageId: codParcel.packageId },
    });
    expect(collection.batchId).toBe(batchId);
    expect(collection.status).toBe("MATCHED");
    expect(collection.collectedPaisa.toString()).toBe("10000");
  });

  it("replaceTripDriver refuses EVERY pre-departure status (PLANNED/ASSIGNED/LOADING) and ARRIVED; driver never changes", async () => {
    const parcel = await readyAtA();
    const vehicleId = await makeVehicle("PRE");
    const transfer = await transfersSvc.createTransfer(waAActor, {
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
    });
    await transfersSvc.addTransferItems(waAActor, transfer.id, [parcel.packageId]);
    await transfersSvc.generateManifest(waAActor, transfer.id);
    const crewed = await transfersSvc.assignTransferCrew(waAActor, {
      transferId: transfer.id,
      driverId: fx.lh2Profile,
      vehicleId,
    });
    const tripId = crewed.tripId!;
    const initial = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(["PLANNED", "ASSIGNED", "LOADING"]).toContain(initial.status);

    for (const status of ["PLANNED", "ASSIGNED", "LOADING"]) {
      await prisma.trip.update({ where: { id: tripId }, data: { status } });
      const failure = await tripsSvc
        .replaceTripDriver(waAActor, tripId, {
          driverId: fx.lh4Profile,
          reason: "Pre-departure swap probe",
        })
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(errors.ConflictError);
      expect((failure as Error).message).toContain("crew assignment");
      const row = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
      expect(row.driverId).toBe(fx.lh2Profile);
    }
    await prisma.trip.update({ where: { id: tripId }, data: { status: "ARRIVED" } });
    await expect(
      tripsSvc.replaceTripDriver(waAActor, tripId, {
        driverId: fx.lh4Profile,
        reason: "Post-arrival swap probe",
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    const row = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(row.driverId).toBe(fx.lh2Profile);
  });

  it("race replaceTripDriver ∥ arriveTrip: exactly one succeeds; custody holder matches the final trip driver", async () => {
    // En-route trip for lh5 with two manifested packages.
    const parcels = [await readyAtA(), await readyAtA()];
    const vehicleId = await makeVehicle("RACE");
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
      driverId: fx.lh5Profile,
      vehicleId,
    });
    for (const p of parcels) {
      await transfersSvc.loadTransferPackage(waAActor, transfer.id, {
        trackingId: p.trackingId,
        idempotencyKey: `p7s-race-load-${RUN}-${p.trackingId}`,
      });
    }
    const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
    const tripId = dispatched.tripId ?? crewed.tripId!;
    const lh5Actor = await actorFor(fx.lh5User);
    await tripsSvc.departTrip(lh5Actor, tripId);

    const [replace, arrive] = await Promise.allSettled([
      tripsSvc.replaceTripDriver(waAActor, tripId, {
        driverId: fx.lh6Profile,
        reason: "Race probe: swap at arrival",
      }),
      tripsSvc.arriveTrip(lh5Actor, tripId),
    ]);
    expect([replace, arrive].filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const tripRow = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    const expectedHolder = tripRow.driverId === fx.lh5Profile ? fx.lh5User : fx.lh6User;
    for (const p of parcels) {
      const custodies = await openCustodies(p.packageId);
      expect(custodies).toHaveLength(1);
      expect(custodies[0].custodianUserId).toBe(expectedHolder);
    }
  });
});

// ===========================================================================
// S4 — RETURNS CUSTODY
// ===========================================================================

async function refusedReturnAtB() {
  const parcel = await atDestinationB();
  const batch = await deliveriesSvc.createDeliveryBatch(waBActor, {
    warehouseId: fx.whB,
    riderUserId: fx.riderAUser,
    batchDate: TODAY,
    kind: "DELIVERY",
  });
  const added = await deliveriesSvc.addBatchPackages(waBActor, batch.id, {
    packageIds: [parcel.packageId],
  });
  expect(added.rejected).toEqual([]);
  await deliveriesSvc.confirmPickup(riderAActor, batch.id, {
    trackingIds: [parcel.trackingId],
  });
  const res = await deliveriesSvc.recordDeliveryAttempt(riderAActor, added.added[0].id, {
    result: "REFUSED",
    notes: "Recipient refused the parcel at the door",
  });
  expect(res.returnRequest).not.toBeNull();
  const ret = await prisma.returnRequest.findFirstOrThrow({
    where: { packageId: parcel.packageId },
  });
  expect(ret.status).toBe("REQUESTED");
  expect(ret.warehouseId).toBe(fx.whB);
  expect(ret.destinationWarehouseId).toBe(fx.whA);
  return { ...parcel, returnId: ret.id };
}

async function receivedReturnAtB() {
  const ctx = await refusedReturnAtB();
  await returnsSvc.approveReturn(waBActor, ctx.returnId, { chargeBearer: "VENDOR" });
  const scan = await deliveriesSvc.scanBackPackage(staffBActor, {
    warehouseId: fx.whB,
    trackingId: ctx.trackingId,
  });
  expect(scan.returnRequest?.status).toBe("RECEIVED");
  return ctx;
}

async function receivedLocalReturnAtA() {
  const parcel = await bookDropoff(fx.whA, fx.districtA);
  await intake(parcel, staffAActor, fx.whA, fx.locStoA);
  const batch = await deliveriesSvc.createDeliveryBatch(waAActor, {
    warehouseId: fx.whA,
    riderUserId: fx.riderPUser,
    batchDate: TODAY,
    kind: "DELIVERY",
  });
  const added = await deliveriesSvc.addBatchPackages(waAActor, batch.id, {
    packageIds: [parcel.packageId],
  });
  expect(added.rejected).toEqual([]);
  await deliveriesSvc.confirmPickup(riderPActor, batch.id, {
    trackingIds: [parcel.trackingId],
  });
  const res = await deliveriesSvc.recordDeliveryAttempt(riderPActor, added.added[0].id, {
    result: "REFUSED",
    notes: "Recipient refused the parcel at the door",
  });
  expect(res.returnRequest).not.toBeNull();
  const ret = await prisma.returnRequest.findFirstOrThrow({
    where: { packageId: parcel.packageId },
  });
  await returnsSvc.approveReturn(waAActor, ret.id, { chargeBearer: "VENDOR" });
  const scan = await deliveriesSvc.scanBackPackage(staffAActor, {
    warehouseId: fx.whA,
    trackingId: parcel.trackingId,
  });
  expect(scan.returnRequest?.status).toBe("RECEIVED");
  const row = await prisma.returnRequest.findUniqueOrThrow({ where: { id: ret.id } });
  expect(row.destinationWarehouseId).toBe(fx.whA);
  return { ...parcel, returnId: ret.id };
}

let s4Cross: Awaited<ReturnType<typeof receivedReturnAtB>> | null = null;

describe("S4 returns custody — transfer manifest hooks", () => {
  it("a RECEIVED cross-warehouse return manifested toward the WRONG warehouse is refused; a mixed add rolls back entirely", async () => {
    s4Cross = await receivedReturnAtB();
    // A legitimate B→C package to prove the whole add call rolls back.
    const valid = await bookDropoff(fx.whB, fx.districtC);
    await intake(valid, staffBActor, fx.whB, fx.locStoB);

    const transfer = await transfersSvc.createTransfer(waBActor, {
      originWarehouseId: fx.whB,
      destinationWarehouseId: fx.whC,
    });
    const failure = await transfersSvc
      .addTransferItems(waBActor, transfer.id, [valid.packageId, s4Cross.packageId])
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(errors.ConflictError);
    expect((failure as Error).message).toMatch(/return warehouse/);
    expect(await prisma.transferItem.count({ where: { transferId: transfer.id } })).toBe(0);
    const ret = await prisma.returnRequest.findUniqueOrThrow({ where: { id: s4Cross.returnId } });
    expect(ret.status).toBe("RECEIVED");
    expect(ret.transferId).toBeNull();
  });

  it("non-RECEIVED returns (REQUESTED, then APPROVED) cannot be manifested at all", async () => {
    const ctx = await refusedReturnAtB();
    const mkTransfer = () =>
      transfersSvc.createTransfer(waBActor, {
        originWarehouseId: fx.whB,
        destinationWarehouseId: fx.whA,
      });
    const t1 = await mkTransfer();
    await expect(
      transfersSvc.addTransferItems(waBActor, t1.id, [ctx.packageId]),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    expect(await prisma.transferItem.count({ where: { transferId: t1.id } })).toBe(0);

    await returnsSvc.approveReturn(waBActor, ctx.returnId, { chargeBearer: "VENDOR" });
    const t2 = await mkTransfer();
    await expect(
      transfersSvc.addTransferItems(waBActor, t2.id, [ctx.packageId]),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    expect(await prisma.transferItem.count({ where: { transferId: t2.id } })).toBe(0);
    const ret = await prisma.returnRequest.findUniqueOrThrow({ where: { id: ctx.returnId } });
    expect(ret.transferId).toBeNull();
  });

  it("a same-warehouse return never travels; after inspection (INSPECTED) it still cannot be manifested", async () => {
    const ctx = await receivedLocalReturnAtA();
    const transfer = await transfersSvc.createTransfer(waAActor, {
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
    });
    const failure = await transfersSvc
      .addTransferItems(waAActor, transfer.id, [ctx.packageId])
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(errors.ConflictError);
    expect((failure as Error).message).toMatch(/same-warehouse/);
    expect(await prisma.transferItem.count({ where: { transferId: transfer.id } })).toBe(0);

    await returnsSvc.inspectReturn(waAActor, ctx.returnId, { condition: "GOOD" });
    const t2 = await transfersSvc.createTransfer(waAActor, {
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
    });
    await expect(
      transfersSvc.addTransferItems(waAActor, t2.id, [ctx.packageId]),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    expect(await prisma.transferItem.count({ where: { transferId: t2.id } })).toBe(0);
  });
});

describe("S4 returns custody — inspect/complete scope + deterioration idempotency", () => {
  it("inspect and complete at a warehouse the package is NOT physically at are refused for scoped staff; the physical warehouse succeeds", async () => {
    expect(s4Cross).not.toBeNull();
    const ctx = s4Cross!;
    // Package physically at B; WA@A and WA@C are scoped elsewhere.
    await expect(
      returnsSvc.inspectReturn(waAActor, ctx.returnId, { condition: "GOOD" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      returnsSvc.inspectReturn(waCActor, ctx.returnId, { condition: "GOOD" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    let ret = await prisma.returnRequest.findUniqueOrThrow({ where: { id: ctx.returnId } });
    expect(ret.status).toBe("RECEIVED");

    const inspected = await returnsSvc.inspectReturn(waBActor, ctx.returnId, {
      condition: "GOOD",
    });
    expect(inspected.status).toBe("INSPECTED");

    await expect(
      returnsSvc.completeReturn(waAActor, ctx.returnId, {}),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    ret = await prisma.returnRequest.findUniqueOrThrow({ where: { id: ctx.returnId } });
    expect(ret.status).toBe("INSPECTED");
    const custodyBefore = await openCustodies(ctx.packageId);
    expect(custodyBefore).toHaveLength(1);
    expect(custodyBefore[0].custodianType).toBe("WAREHOUSE");
    expect(custodyBefore[0].warehouseId).toBe(fx.whB);

    const completed = await returnsSvc.completeReturn(waBActor, ctx.returnId, {});
    expect(completed.status).toBe("COMPLETED");
    const custodyAfter = await openCustodies(ctx.packageId);
    expect(custodyAfter).toHaveLength(1);
    expect(custodyAfter[0].custodianType).toBe("USER");
    expect(custodyAfter[0].custodianUserId).toBe(fx.vendor1Owner);
  });

  it("deterioration incident fires EXACTLY once: re-inspection is refused and the sourceKey primitive is idempotent", async () => {
    const ctx = await receivedLocalReturnAtA();
    const sourceKey = `return-deterioration:${ctx.returnId}`;
    expect(await prisma.incident.count({ where: { sourceKey } })).toBe(0);

    const inspected = await returnsSvc.inspectReturn(waAActor, ctx.returnId, {
      condition: "DAMAGED",
    });
    expect(inspected.status).toBe("INSPECTED");
    expect(inspected.conditionAtInspection).toBe("DAMAGED");
    expect(await prisma.incident.count({ where: { sourceKey } })).toBe(1);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: ctx.packageId } });
    expect(pkg.exceptionStatus).toBe("DAMAGED");

    // A second inspection attempt is refused and adds no incident.
    await expect(
      returnsSvc.inspectReturn(waAActor, ctx.returnId, { condition: "DAMAGED" }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    expect(await prisma.incident.count({ where: { sourceKey } })).toBe(1);

    // The underlying primitive: same sourceKey in two transactions.
    const manualKey = `p7s-manual-${RUN}`;
    const first = await prisma.$transaction((tx) =>
      incidentsSvc.raiseIncidentInTx(tx, {
        sourceKey: manualKey,
        category: "DAMAGED_PACKAGE",
        description: "Idempotency probe incident one",
        reporterId: fx.adminUser,
        warehouseId: fx.whA,
        packageId: ctx.packageId,
      }),
    );
    const second = await prisma.$transaction((tx) =>
      incidentsSvc.raiseIncidentInTx(tx, {
        sourceKey: manualKey,
        category: "DAMAGED_PACKAGE",
        description: "Idempotency probe incident one (retry)",
        reporterId: fx.adminUser,
        warehouseId: fx.whA,
        packageId: ctx.packageId,
      }),
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.incidentId).toBe(first.incidentId);
    expect(await prisma.incident.count({ where: { sourceKey: manualKey } })).toBe(1);
  });
});

// ===========================================================================
// S6 — DRIVER DETAIL SCOPE + GPS GATING
// ===========================================================================

describe("S6 driver profile scope and GPS gating", () => {
  it("setup: rider A carries a live GPS snapshot at warehouse B", async () => {
    // Fixture hygiene: no other ACTIVE session may exist for rider A
    // (one-active-session-per-driver index).
    await prisma.trackingSession.updateMany({
      where: { driverId: fx.riderAProfile, status: "ACTIVE" },
      data: { status: "ENDED", endedAt: new Date(), endReason: "ASSIGNMENT_COMPLETED" },
    });
    const batch = await prisma.deliveryBatch.create({
      data: {
        riderId: fx.riderAProfile,
        warehouseId: fx.whB,
        batchDate: new Date(TODAY),
        kind: "DELIVERY",
        status: "IN_PROGRESS",
        createdById: fx.waB,
      },
    });
    const session = await prisma.trackingSession.create({
      data: {
        driverId: fx.riderAProfile,
        deliveryBatchId: batch.id,
        trackingType: "DELIVERY",
        originWarehouseId: fx.whB,
        status: "ACTIVE",
        startReason: "DRIVER",
        permissionAcknowledgedAt: new Date(),
      },
    });
    const now = new Date();
    await prisma.driverCurrentLocation.create({
      data: {
        driverId: fx.riderAProfile,
        trackingSessionId: session.id,
        latitude: 27.71,
        longitude: 85.32,
        accuracyMeters: 12,
        lastRecordedAt: now,
        lastReceivedAt: now,
        freshnessState: "FRESH",
        activeBatchId: batch.id,
      },
    });
    expect(session.status).toBe("ACTIVE");
  });

  it("warehouse-scoped actor with NO connection to the driver is denied and the denial is audited", async () => {
    const before = await prisma.auditLog.count({
      where: {
        action: "access.denied",
        actorId: fx.waC,
        entityId: fx.riderAProfile,
      },
    });
    await expect(
      driversSvc.getDriverProfile(waCActor, fx.riderAProfile),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const after = await prisma.auditLog.count({
      where: {
        action: "access.denied",
        actorId: fx.waC,
        entityId: fx.riderAProfile,
      },
    });
    expect(after).toBe(before + 1);
  });

  it("gps key is ABSENT for a profile-readable actor without operations.live_view, present with it", async () => {
    const withGps = await driversSvc.getDriverProfile(waBActor, fx.riderAProfile);
    expect("gps" in withGps).toBe(true);
    expect(withGps.gps).not.toBeNull();
    expect(withGps.gps!.latitude).toBeCloseTo(27.71);

    const noLiveActor: Actor = {
      ...waBActor,
      permissions: new Set(
        [...waBActor.permissions].filter((p) => p !== "operations.live_view"),
      ),
    };
    expect(noLiveActor.permissions.has("driver.manage")).toBe(true);
    const without = await driversSvc.getDriverProfile(noLiveActor, fx.riderAProfile);
    expect(without.id).toBe(fx.riderAProfile);
    expect("gps" in without).toBe(false);
    expect(without.gps).toBeUndefined();
  });

  it("drivers, vendor actors and customer actors are all refused profile reads", async () => {
    // Another driver reading rider A.
    await expect(
      driversSvc.getDriverProfile(riderBActor, fx.riderAProfile),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // Rider A reading their OWN profile still fails the fleet gate
    // (driver.read_self does not satisfy driver.manage/assign).
    await expect(
      driversSvc.getDriverProfile(riderAActor, fx.riderAProfile),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // Vendor and customer actors.
    await expect(
      driversSvc.getDriverProfile(vendor1Actor, fx.riderAProfile),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      driversSvc.getDriverProfile(customerActor, fx.riderAProfile),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // Control: unscoped admin reads fine.
    const profile = await driversSvc.getDriverProfile(adminActor, fx.riderAProfile);
    expect(profile.id).toBe(fx.riderAProfile);
  });
});
