import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 7 (V2) — the spec §14 logistics chain as ONE continuous
 * scenario against bla_test, asserting custody / inventory / ledger
 * state at every step (not just service success):
 *
 *   vendor booking (rider pickup) → pickup assignment → rider
 *   collection → warehouse receiving → inspection → put-away →
 *   sorting (internal move) → ready for dispatch → transfer →
 *   per-package loading scans → dispatch → in transit → destination
 *   receiving INCLUDING a partial receive → missing package opens an
 *   investigation (incident + follow-up task) → damaged package
 *   handled (inspection + incident + quarantine) → local delivery
 *   batch → attempts → partial delivery success (3 of 4) → refused
 *   package returns cross-warehouse (request → approval → scan-back
 *   → transfer → receiving → inspection → vendor handover →
 *   completion, original history preserved) → COD collection →
 *   rider remittance (shortage accepted at counted amount +
 *   discrepancy incident; a surplus leg on a second rider) →
 *   vendor settlement (prepare → approve → pay, ledger exact).
 *
 * Fixture warehouses are per-suite shared (WH-ZC7 codes,
 * find-or-create); everything else is per-run unique.
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
const email = (label: string) => `p7c-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);
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
let incidentsSvc: typeof import("@/server/services/incidents");
let tasksSvc: typeof import("@/server/services/tasks");
let remittancesSvc: typeof import("@/server/services/cod-remittances");
let settlementsSvc: typeof import("@/server/services/settlements");
let catalog: typeof import("@/lib/permissions/catalog");
let financeDomain: typeof import("@/lib/finance/domain");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let financeActor: Awaited<ReturnType<typeof actorFor>>;
let vendorActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
let staffBActor: Awaited<ReturnType<typeof actorFor>>;
let pickupRiderActor: Awaited<ReturnType<typeof actorFor>>;
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
      fullName: `P7C ${label}`,
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

// ---------------------------------------------------------------------------
// State shared across the chain steps.
// ---------------------------------------------------------------------------

interface Parcel {
  packageId: string;
  trackingId: string;
  orderId: string;
  codPaisa: string;
}

const parcels: Record<string, Parcel> = {};
const chain: Record<string, string> = {};

async function openCustody(packageId: string) {
  return prisma.packageCustody.findFirst({ where: { packageId, endedAt: null } });
}

async function openCustodies(packageId: string) {
  return prisma.packageCustody.findMany({ where: { packageId, endedAt: null } });
}

async function openRecord(packageId: string) {
  return prisma.inventoryRecord.findFirst({ where: { packageId, releasedAt: null } });
}

async function pkgStatus(packageId: string) {
  const pkg = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
  return pkg;
}

/** Exactly one open custody record, held by the expected party. */
async function expectCustody(
  packageId: string,
  expected: { userId?: string; warehouseId?: string },
) {
  const open = await openCustodies(packageId);
  expect(open).toHaveLength(1);
  if (expected.userId) expect(open[0].custodianUserId).toBe(expected.userId);
  if (expected.warehouseId) expect(open[0].warehouseId).toBe(expected.warehouseId);
  return open[0];
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

async function bookParcel(label: string, codPaisa: string, recipientPhone: string) {
  const booking = await bookingsSvc.createBooking(vendorActor, {
    vendorId: fx.vendor,
    sender: { name: "P7C Sender", phone: phone(42), email: null },
    recipient: {
      name: `P7C Recipient ${label}`,
      phone: recipientPhone,
      addressLine: "Lakeside Street 1",
      city: "Beta Town",
      district: fx.districtB,
      province: "Bagmati",
    },
    pickup: { method: "RIDER_PICKUP" as const, vendorAddressId: fx.vendorAddress },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: codPaisa,
    items: [{ description: `Parcel ${label}`, quantity: 1, weightKg: 1.0 }],
  });
  const pkg = booking.shipments[0].packages[0];
  parcels[label] = {
    packageId: pkg.id,
    trackingId: pkg.trackingId,
    orderId: booking.id,
    codPaisa,
  };
  return parcels[label];
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
  incidentsSvc = await import("@/server/services/incidents");
  tasksSvc = await import("@/server/services/tasks");
  remittancesSvc = await import("@/server/services/cod-remittances");
  settlementsSvc = await import("@/server/services/settlements");
  catalog = await import("@/lib/permissions/catalog");
  financeDomain = await import("@/lib/finance/domain");

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

  // Phase 7 chart of accounts (same upserts as the seed).
  for (const account of financeDomain.COMPANY_ACCOUNTS) {
    await prisma.financialAccount.upsert({
      where: { code: account.code },
      update: { name: account.name, kind: account.kind },
      create: { code: account.code, name: account.name, kind: account.kind, ownerType: "COMPANY" },
    });
  }

  fx.adminUser = await makeUser("admin", "ADMIN");
  adminActor = await actorFor(fx.adminUser);
  fx.financeUser = await makeUser("finance", "FINANCE");
  financeActor = await actorFor(fx.financeUser);

  fx.districtA = "P7C Alpha District";
  fx.districtB = "P7C Beta District";
  const a = await ensureWarehouse("WH-ZC7-01", "P7C Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  fx.locDspA = a.locations.DISPATCH;
  const b = await ensureWarehouse("WH-ZC7-02", "P7C Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;
  fx.locRetB = b.locations.RETURNS;
  fx.locStoB = b.locations.STORAGE;

  serviceCode = `P7CSTD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P7C Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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
    businessName: `P7C Vendor ${RUN}`,
    contactName: "P7C Contact",
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
  vendorActor = await actorFor(fx.vendorOwnerUser);
  const address = await vendorsSvc.addVendorAddress(adminActor, fx.vendor, {
    kind: "PICKUP",
    addressLine1: "Industrial Road 1",
    city: "Alpha",
    district: fx.districtA,
    province: "Bagmati",
    approve: true,
  });
  fx.vendorAddress = address.id;

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

  // Pickup rider homed at the origin warehouse A.
  fx.pickupRiderUser = await makeUser("pickupRider", "RIDER");
  const pickupProfile = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.pickupRiderUser,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P7C-PU-${RUN}`,
    licenseCategory: "B",
    licenseExpiry: "2030-01-01",
    capabilities: ["PICKUP", "DELIVERY"],
  });
  fx.pickupRiderProfile = pickupProfile.id;
  pickupRiderActor = await actorFor(fx.pickupRiderUser);

  // Line-haul driver + vehicle for the A→B legs.
  fx.linehaulUser = await makeUser("linehaul", "LINEHAUL_DRIVER");
  const linehaul = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.linehaulUser,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P7C-LH-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.linehaulProfile = linehaul.id;
  linehaulActor = await actorFor(fx.linehaulUser);
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P7C TRK ${RUN.slice(-6)}`.toUpperCase(),
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
      licenseNumber: `LIC-P7C-${label}-${RUN}`.toUpperCase(),
      licenseCategory: "B",
      licenseExpiry: "2030-01-01",
      capabilities: ["DELIVERY", "PICKUP"],
    });
    fx[`${label}User`] = userId;
    fx[`${label}Profile`] = profile.id;
  }
  riderAActor = await actorFor(fx.riderAUser);
  riderBActor = await actorFor(fx.riderBUser);
}, 240_000);

describe("Phase 7 chain — booking → pickup → origin warehouse", () => {
  it("books six parcels for rider pickup at the vendor address", async () => {
    await bookParcel("P1", "0", phone(101));
    await bookParcel("P2", "500000", phone(102));
    await bookParcel("P3", "300000", phone(103));
    await bookParcel("P4", "0", phone(104));
    await bookParcel("P5", "0", phone(105));
    await bookParcel("P6", "0", phone(106));
    for (const label of ["P1", "P2", "P3", "P4", "P5", "P6"]) {
      const pkg = await pkgStatus(parcels[label].packageId);
      // Booked for pickup: routed to the origin warehouse but not yet
      // collected — no custody, no stock, status BOOKED.
      expect(pkg.currentWarehouseId).toBe(fx.whA);
      expect(pkg.operationalStatus).toBe("BOOKED");
      expect(await openCustody(pkg.id)).toBeNull();
      expect(await openRecord(pkg.id)).toBeNull();
    }
  });

  it("assigns a pickup batch and the rider collects all six", async () => {
    const batch = await deliveriesSvc.createDeliveryBatch(waAActor, {
      warehouseId: fx.whA,
      riderUserId: fx.pickupRiderUser,
      batchDate: TODAY,
      kind: "PICKUP",
    });
    chain.pickupBatch = batch.id;
    const added = await deliveriesSvc.addBatchPackages(waAActor, batch.id, {
      packageIds: Object.values(parcels).map((p) => p.packageId),
    });
    expect(added.rejected).toEqual([]);
    expect(added.added).toHaveLength(6);
    const pickup = await deliveriesSvc.confirmPickupCollection(pickupRiderActor, batch.id, {
      trackingIds: Object.values(parcels).map((p) => p.trackingId),
    });
    expect(pickup.failed).toEqual([]);
    expect(pickup.taken).toHaveLength(6);
    for (const p of Object.values(parcels)) {
      // Custody moved to the collecting rider — exactly one open record.
      await expectCustody(p.packageId, { userId: fx.pickupRiderUser });
      expect(await openRecord(p.packageId)).toBeNull();
    }
  });

  it("receives all six into the origin warehouse", async () => {
    for (const p of Object.values(parcels)) {
      await inventorySvc.receivePackage(staffAActor, {
        warehouseId: fx.whA,
        trackingId: p.trackingId,
      });
    }
    for (const p of Object.values(parcels)) {
      // Custody is now the warehouse; an open inventory record exists.
      await expectCustody(p.packageId, { warehouseId: fx.whA });
      const record = await openRecord(p.packageId);
      expect(record).not.toBeNull();
      expect(record!.warehouseId).toBe(fx.whA);
    }
  });

  it("inspects, put-aways, sorts (internal move) and readies each parcel", async () => {
    for (const p of Object.values(parcels)) {
      await inventorySvc.moveToInspection(staffAActor, p.packageId);
      await inventorySvc.startInspection(staffAActor, p.packageId);
      await inventorySvc.recordInspection(staffAActor, {
        packageId: p.packageId,
        condition: "GOOD",
        actualWeightKg: 2,
      });
      await inventorySvc.putAwayPackage(staffAActor, p.packageId, fx.locStoA);
      // Sorting: storage → dispatch staging inside the same warehouse.
      await inventorySvc.moveInternal(staffAActor, {
        packageId: p.packageId,
        toLocationId: fx.locDspA,
      });
      await inventorySvc.markReadyForDispatch(staffAActor, p.packageId);
      const pkg = await pkgStatus(p.packageId);
      expect(pkg.operationalStatus).toBe("READY_FOR_DISPATCH");
      expect(pkg.condition).toBe("GOOD");
      const record = await openRecord(p.packageId);
      expect(record!.storageLocationId).toBe(fx.locDspA);
      await expectCustody(p.packageId, { warehouseId: fx.whA });
    }
  });
});

describe("Phase 7 chain — transfer A→B with a partial receive", () => {
  it("creates the transfer, loads every parcel by scan and dispatches", async () => {
    const transfer = await transfersSvc.createTransfer(waAActor, {
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
    });
    chain.transfer1 = transfer.id;
    const added = await transfersSvc.addTransferItems(
      waAActor,
      transfer.id,
      Object.values(parcels).map((p) => p.packageId),
    );
    expect(added.rejected).toEqual([]);
    await transfersSvc.generateManifest(waAActor, transfer.id);
    const crewed = await transfersSvc.assignTransferCrew(waAActor, {
      transferId: transfer.id,
      driverId: fx.linehaulProfile,
      vehicleId: fx.vehicle,
    });
    for (const p of Object.values(parcels)) {
      await transfersSvc.loadTransferPackage(waAActor, transfer.id, {
        trackingId: p.trackingId,
        idempotencyKey: `p7c-load-${RUN}-${p.trackingId}`,
      });
    }
    const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
    chain.trip1 = dispatched.tripId ?? crewed.tripId!;
    // Dispatched: custody sits with the line-haul driver for every parcel.
    for (const p of Object.values(parcels)) {
      await expectCustody(p.packageId, { userId: fx.linehaulUser });
      const pkg = await pkgStatus(p.packageId);
      expect(pkg.operationalStatus).toBe("DISPATCHED");
    }
  });

  it("runs the trip: depart + arrive", async () => {
    await tripsSvc.departTrip(linehaulActor, chain.trip1);
    for (const p of Object.values(parcels)) {
      const pkg = await pkgStatus(p.packageId);
      expect(pkg.operationalStatus).toBe("IN_TRANSIT");
    }
    await tripsSvc.arriveTrip(linehaulActor, chain.trip1);
    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: chain.trip1 } });
    expect(trip.status).toBe("ARRIVED");
  });

  it("receives five of six at destination (one damaged on arrival) — the sixth goes missing", async () => {
    const received = ["P1", "P2", "P3", "P5", "P6"];
    for (const label of received) {
      const p = parcels[label];
      const scan = await transfersSvc.scanDestinationPackage(waBActor, chain.transfer1, {
        trackingId: p.trackingId,
        idempotencyKey: `p7c-unload-${RUN}-${p.trackingId}`,
      });
      expect(scan.kind).toBe("RECEIVED_SCAN");
      await transfersSvc.completePackageReceiving(waBActor, chain.transfer1, {
        packageId: p.packageId,
        condition: label === "P5" ? "DAMAGED" : "GOOD",
        ...(label === "P5" ? { notes: "Crushed corner, contents rattling" } : {}),
      });
    }
    const finished = await transfersSvc.finishReceiving(waBActor, chain.transfer1);
    expect(finished.status).toBe("RECONCILIATION_PENDING");
    expect(finished.reconciliation.missingCount).toBe(1);
    expect(finished.reconciliation.damagedCount).toBe(1);
    expect(finished.reconciliation.receivedCount).toBe(4);

    // P4 was never scanned: item MISSING, package flagged, incident open,
    // and the parcel is still in the line-haul driver's custody.
    const item4 = await prisma.transferItem.findFirstOrThrow({
      where: { transferId: chain.transfer1, packageId: parcels.P4.packageId },
    });
    expect(item4.itemStatus).toBe("MISSING");
    const pkg4 = await pkgStatus(parcels.P4.packageId);
    expect(pkg4.exceptionStatus).toBe("MISSING");
    await expectCustody(parcels.P4.packageId, { userId: fx.linehaulUser });
    const incident = await prisma.incident.findFirst({
      where: { transferId: chain.transfer1, category: "TRANSFER_SHORTAGE" },
    });
    expect(incident).not.toBeNull();
    chain.shortageIncident = incident!.id;

    // The five received parcels are stocked at B under warehouse custody.
    for (const label of received) {
      const p = parcels[label];
      const pkg = await pkgStatus(p.packageId);
      expect(pkg.operationalStatus).toBe("RECEIVED_AT_DESTINATION");
      expect(pkg.currentWarehouseId).toBe(fx.whB);
      await expectCustody(p.packageId, { warehouseId: fx.whB });
      expect(await openRecord(p.packageId)).not.toBeNull();
    }
    // P5 arrived damaged: flagged and quarantined in B's DAMAGED zone.
    const pkg5 = await pkgStatus(parcels.P5.packageId);
    expect(pkg5.condition).toBe("DAMAGED");
    expect(pkg5.exceptionStatus).toBe("DAMAGED");
    const record5 = await openRecord(parcels.P5.packageId);
    const location5 = await prisma.storageLocation.findUniqueOrThrow({
      where: { id: record5!.storageLocationId! },
      include: { zone: true },
    });
    expect(location5.zone.kind).toBe("DAMAGED");
  });

  it("investigates the shortage, recovers the parcel by late scan, reconciles and closes", async () => {
    // Investigation: a follow-up task on the incident, worked to close.
    const task = await incidentsSvc.createIncidentFollowUpTask(waBActor, chain.shortageIncident, {
      assigneeId: fx.staffB,
    });
    chain.investigationTask = task.id;
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "ACCEPTED" });
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "IN_PROGRESS" });
    await tasksSvc.updateTaskStatus(staffBActor, task.id, {
      status: "SUBMITTED",
      note: "Parcel found in the vehicle's side cage — late scan completed.",
    });
    await tasksSvc.updateTaskStatus(waBActor, task.id, { status: "VERIFIED" });
    const closed = await tasksSvc.updateTaskStatus(waBActor, task.id, { status: "CLOSED" });
    expect(closed.status).toBe("CLOSED");

    // While P4 is unaccounted, reconciliation refuses and parks the
    // transfer in EXCEPTION.
    await expect(transfersSvc.reconcileTransfer(waBActor, chain.transfer1)).rejects.toThrow(
      /unaccounted/,
    );
    const blocked = await transfersSvc.getTransfer(waBActor, chain.transfer1);
    expect(blocked.status).toBe("EXCEPTION");

    // Late scan: the parcel turns up; the MISSING flag clears.
    const late = await transfersSvc.scanDestinationPackage(waBActor, chain.transfer1, {
      trackingId: parcels.P4.trackingId,
      idempotencyKey: `p7c-unload-late-${RUN}-${parcels.P4.trackingId}`,
    });
    expect(late.kind).toBe("RECEIVED_SCAN");
    const found = await pkgStatus(parcels.P4.packageId);
    expect(found.exceptionStatus).toBe("NONE");
    await transfersSvc.completePackageReceiving(waBActor, chain.transfer1, {
      packageId: parcels.P4.packageId,
      condition: "GOOD",
    });
    await transfersSvc.finishReceiving(waBActor, chain.transfer1);
    const reconciled = await transfersSvc.reconcileTransfer(waBActor, chain.transfer1);
    expect(reconciled.status).toBe("RECONCILED");
    expect(reconciled.reconciliation.receivedCount).toBe(5);
    expect(reconciled.reconciliation.damagedCount).toBe(1);
    await transfersSvc.closeTransfer(waBActor, chain.transfer1);

    // P4 joins the deliverable stock at B; the shortage incident resolves.
    const pkg4 = await pkgStatus(parcels.P4.packageId);
    expect(pkg4.operationalStatus).toBe("RECEIVED_AT_DESTINATION");
    await expectCustody(parcels.P4.packageId, { warehouseId: fx.whB });
    await incidentsSvc.acknowledgeIncident(waBActor, chain.shortageIncident);
    await incidentsSvc.assignIncident(waBActor, chain.shortageIncident, {
      assigneeId: fx.staffB,
    });
    await incidentsSvc.proposeIncidentResolution(waBActor, chain.shortageIncident, {
      resolution: "Parcel recovered by late scan and received in good condition.",
    });
    await incidentsSvc.approveIncidentResolution(adminActor, chain.shortageIncident);
    await incidentsSvc.resolveIncident(waBActor, chain.shortageIncident, {});
    const closedIncident = await incidentsSvc.closeIncident(waBActor, chain.shortageIncident);
    expect(closedIncident.status).toBe("CLOSED");
  });

  it("handles the damaged parcel: incident raised with a follow-up task, custody stays at B", async () => {
    const incident = await incidentsSvc.createIncident(waBActor, {
      category: "DAMAGED_PACKAGE",
      description: "Crushed corner found on arrival at destination; contents rattling.",
      packageId: parcels.P5.packageId,
      warehouseId: fx.whB,
    });
    expect(incident.category).toBe("DAMAGED_PACKAGE");
    chain.damageIncident = incident.id;
    const task = await incidentsSvc.createIncidentFollowUpTask(waBActor, incident.id, {
      assigneeId: fx.staffB,
    });
    expect(task.relatedIncidentId).toBe(incident.id);
    // Custody never moved during handling: still the destination warehouse.
    await expectCustody(parcels.P5.packageId, { warehouseId: fx.whB });
  });
});

describe("Phase 7 chain — local delivery with partial success", () => {
  it("delivers four of five in one batch; the refused parcel enters the return flow", async () => {
    const batch = await deliveriesSvc.createDeliveryBatch(waBActor, {
      warehouseId: fx.whB,
      riderUserId: fx.riderAUser,
      batchDate: TODAY,
      kind: "DELIVERY",
    });
    chain.deliveryBatch = batch.id;
    const labels = ["P1", "P2", "P3", "P4", "P6"];
    const added = await deliveriesSvc.addBatchPackages(waBActor, batch.id, {
      packageIds: labels.map((l) => parcels[l].packageId),
    });
    expect(added.rejected).toEqual([]);
    expect(added.added).toHaveLength(5);
    const assignmentByPackage = new Map(added.added.map((a) => [a.packageId, a.id]));
    const pickup = await deliveriesSvc.confirmPickup(riderAActor, batch.id, {
      trackingIds: labels.map((l) => parcels[l].trackingId),
    });
    expect(pickup.failed).toEqual([]);
    expect(pickup.taken).toHaveLength(5);
    for (const l of labels) {
      await expectCustody(parcels[l].packageId, { userId: fx.riderAUser });
    }

    const deliver = async (
      label: string,
      codCollectedPaisa?: string,
      notes?: string,
    ) => {
      const assignmentId = assignmentByPackage.get(parcels[label].packageId)!;
      const otp = await recipientOtp(assignmentId);
      return deliveriesSvc.confirmDelivery(riderAActor, assignmentId, {
        receivedByName: `Recipient ${label}`,
        otpCode: otp,
        ...(codCollectedPaisa ? { codCollectedPaisa } : {}),
        ...(notes ? { notes } : {}),
      });
    };

    // P1 prepaid, P4 (the recovered parcel) prepaid — both delivered.
    await deliver("P1");
    await deliver("P4");
    // P2 COD exact.
    const d2 = await deliver("P2", "500000");
    expect(d2.cod?.status).toBe("MATCHED");
    // P3 COD short with the mandatory mismatch explanation.
    const d3 = await deliver("P3", "250000", "Recipient paid part in cash, rest refused");
    expect(d3.cod?.status).toBe("MISMATCH");
    expect(d3.cod?.expectedPaisa).toBe("300000");
    expect(d3.cod?.collectedPaisa).toBe("250000");

    for (const l of ["P1", "P2", "P3", "P4"]) {
      const pkg = await pkgStatus(parcels[l].packageId);
      expect(pkg.operationalStatus).toBe("DELIVERED");
      expect(pkg.deliveryStatus).toBe("DELIVERED");
      // The rider no longer holds custody of delivered parcels.
      const open = await openCustodies(parcels[l].packageId);
      expect(open).toHaveLength(1);
      expect(open[0].custodianUserId).not.toBe(fx.riderAUser);
      // A POD exists for each delivery.
      const pod = await prisma.proofOfDelivery.findFirst({
        where: { packageId: parcels[l].packageId },
      });
      expect(pod).not.toBeNull();
    }
    // COD collections recorded exactly.
    const c2 = await prisma.deliveryCodCollection.findFirstOrThrow({
      where: { packageId: parcels.P2.packageId },
    });
    expect(c2.status).toBe("MATCHED");
    expect(c2.collectedPaisa.toString()).toBe("500000");
    const c3 = await prisma.deliveryCodCollection.findFirstOrThrow({
      where: { packageId: parcels.P3.packageId },
    });
    expect(c3.status).toBe("MISMATCH");
    expect(c3.expectedPaisa.toString()).toBe("300000");
    chain.codP2 = c2.id;
    chain.codP3 = c3.id;

    // P6: recipient refuses at the door → return opens.
    const attempt = await deliveriesSvc.recordDeliveryAttempt(
      riderAActor,
      assignmentByPackage.get(parcels.P6.packageId)!,
      {
        result: "REFUSED",
        failureReason: "Recipient refused the parcel at the door",
        nextAction: "RETURN_TO_SENDER",
      },
    );
    let returnId = attempt.returnRequest?.id ?? null;
    if (!returnId) {
      const initiated = await returnsSvc.initiateReturn(waBActor, {
        packageId: parcels.P6.packageId,
        reason: "RECIPIENT_REFUSED",
      });
      returnId = initiated.id;
    }
    chain.returnP6 = returnId;
    const approved = await returnsSvc.approveReturn(waBActor, returnId, {
      chargeBearer: "VENDOR",
      chargeAmountPaisa: "10000",
    });
    expect(approved.status).toBe("APPROVED");
    expect(approved.destinationWarehouseId).toBe(fx.whA);

    // Rider brings P6 back; B scans it into the Returns zone.
    const scan = await deliveriesSvc.scanBackPackage(staffBActor, {
      warehouseId: fx.whB,
      trackingId: parcels.P6.trackingId,
    });
    expect(scan.returnRequest?.status).toBe("RECEIVED");
    await expectCustody(parcels.P6.packageId, { warehouseId: fx.whB });

    // Partial success closes out: 4 delivered, 1 returned.
    const closedBatch = await deliveriesSvc.closeBatch(waBActor, batch.id);
    expect(closedBatch.batch.status).toBe("COMPLETED");
  });
});

describe("Phase 7 chain — cross-warehouse return of the refused parcel", () => {
  it("travels B→A on a transfer, is inspected and handed to the vendor at A", async () => {
    const transfer = await transfersSvc.createTransfer(waBActor, {
      originWarehouseId: fx.whB,
      destinationWarehouseId: fx.whA,
    });
    chain.transfer2 = transfer.id;
    const added = await transfersSvc.addTransferItems(waBActor, transfer.id, [
      parcels.P6.packageId,
    ]);
    expect(added.rejected).toEqual([]);
    const linked = await returnsSvc.getReturn(waBActor, chain.returnP6);
    expect(linked.transferId).toBe(transfer.id);
    await transfersSvc.generateManifest(waBActor, transfer.id);
    const crewed = await transfersSvc.assignTransferCrew(waBActor, {
      transferId: transfer.id,
      driverId: fx.linehaulProfile,
      vehicleId: fx.vehicle,
    });
    const loaded = await transfersSvc.loadTransferPackage(waBActor, transfer.id, {
      trackingId: parcels.P6.trackingId,
      idempotencyKey: `p7c-load2-${RUN}-${parcels.P6.trackingId}`,
    });
    expect(loaded.allLoaded).toBe(true);
    const dispatched = await transfersSvc.dispatchTransfer(waBActor, transfer.id);
    chain.trip2 = dispatched.tripId ?? crewed.tripId!;
    const inTransit = await returnsSvc.getReturn(waBActor, chain.returnP6);
    expect(inTransit.status).toBe("IN_TRANSIT");
    // While travelling, the return cannot be delivery-assigned.
    const pkgMid = await pkgStatus(parcels.P6.packageId);
    expect(pkgMid.currentWarehouseId).toBe(fx.whB);

    await tripsSvc.departTrip(linehaulActor, chain.trip2);
    await tripsSvc.arriveTrip(linehaulActor, chain.trip2);
    const scan = await transfersSvc.scanDestinationPackage(waAActor, transfer.id, {
      trackingId: parcels.P6.trackingId,
      idempotencyKey: `p7c-unload2-${RUN}-${parcels.P6.trackingId}`,
    });
    expect(scan.kind).toBe("RECEIVED_SCAN");
    await transfersSvc.completePackageReceiving(waAActor, transfer.id, {
      packageId: parcels.P6.packageId,
      condition: "GOOD",
    });
    await transfersSvc.finishReceiving(waAActor, transfer.id);
    await transfersSvc.reconcileTransfer(waAActor, transfer.id);
    await transfersSvc.closeTransfer(waAActor, transfer.id);

    const arrived = await returnsSvc.getReturn(waAActor, chain.returnP6);
    expect(arrived.status).toBe("RECEIVED");
    await expectCustody(parcels.P6.packageId, { warehouseId: fx.whA });

    const inspected = await returnsSvc.inspectReturn(waAActor, chain.returnP6, {
      condition: "GOOD",
    });
    expect(inspected.status).toBe("INSPECTED");
    const completed = await returnsSvc.completeReturn(waAActor, chain.returnP6, {
      handedToUserId: fx.vendorOwnerUser,
    });
    expect(completed.status).toBe("COMPLETED");
    expect(completed.handedToUserId).toBe(fx.vendorOwnerUser);

    // Original delivery history is preserved — the refusal attempt and
    // every earlier event are still on the package's timeline.
    const attemptRow = await prisma.deliveryAttempt.findFirst({
      where: { assignment: { packageId: parcels.P6.packageId }, result: "REFUSED" },
    });
    expect(attemptRow).not.toBeNull();
    const eventTypes = (
      await prisma.trackingEvent.findMany({
        where: { packageId: parcels.P6.packageId },
        select: { eventType: true },
      })
    ).map((e) => e.eventType);
    expect(eventTypes).toContain("RETURN_REQUESTED");
    expect(eventTypes).toContain("RETURN_IN_TRANSIT");
    expect(eventTypes).toContain("RETURN_RECEIVED_AT_DESTINATION");
  });
});

describe("Phase 7 chain — COD, remittance (shortage + surplus), settlement", () => {
  it("remits rider A's COD with a shortage: discrepancy incident + rider debt, journals balanced", async () => {
    const position = await remittancesSvc.getRiderCodPosition(riderAActor);
    expect(position.awaitingRemittanceTotalPaisa).toBe("750000");
    expect(position.awaitingRemittance).toHaveLength(2);

    const remittance = await remittancesSvc.submitRemittance(riderAActor, {
      collectionIds: [chain.codP2, chain.codP3],
      declaredAmountPaisa: "750000",
      warehouseId: fx.whB,
      idempotencyKey: `p7c-remit-a-${RUN}`,
    });
    chain.remittanceA = remittance.id;
    // Finance counts only Rs 7,000 in the envelope — Rs 500 short of the
    // declared/collected amount: a verification discrepancy.
    const verified = await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
      countedAmountPaisa: "700000",
    });
    expect(verified.status).toBe("DISCREPANCY");
    expect(verified.expectedPaisa).toBe("800000");
    expect(verified.countedAmountPaisa).toBe("700000");
    expect(verified.discrepancyPaisa).toBe("-50000");

    // The discrepancy auto-opened a COD_DISCREPANCY incident.
    const incident = await prisma.incident.findFirst({
      where: { remittanceId: remittance.id, category: "COD_DISCREPANCY" },
    });
    expect(incident).not.toBeNull();

    const resolved = await remittancesSvc.resolveRemittance(financeActor, remittance.id, {
      resolution: "ACCEPTED_COUNTED",
      note: "Shortage accepted at counted amount; rider owes the difference.",
    });
    expect(resolved.status).toBe("CLOSED");

    // The rider now owes exactly the 50,000-paisa shortfall.
    const after = await remittancesSvc.getRiderCodPosition(riderAActor);
    expect(after.ledgerOwedPaisa).toBe("50000");
    expect(after.awaitingRemittance).toHaveLength(0);

    // Every journal written for this remittance balances to the paisa.
    const byDirection = await prisma.ledgerTransaction.groupBy({
      by: ["journalRef", "direction"],
      where: { journalRef: { startsWith: remittance.remittanceNumber } },
      _sum: { amountPaisa: true },
    });
    expect(byDirection.length).toBeGreaterThan(0);
    const sums = new Map<string, { d: bigint; c: bigint }>();
    for (const row of byDirection) {
      const entry = sums.get(row.journalRef) ?? { d: BigInt(0), c: BigInt(0) };
      if (row.direction === "DEBIT") entry.d = row._sum.amountPaisa ?? BigInt(0);
      else entry.c = row._sum.amountPaisa ?? BigInt(0);
      sums.set(row.journalRef, entry);
    }
    expect(sums.size).toBeGreaterThan(0);
    for (const [, s] of sums) expect(s.d).toBe(s.c);
  });

  it("runs a surplus leg for rider B: over-collection posts a balanced surplus journal", async () => {
    // A second vendor, local to B (dropoff at B, delivered at B).
    const vendor2 = await vendorsSvc.createVendor(adminActor, {
      businessName: `P7C Vendor Two ${RUN}`,
      contactName: "P7C Contact Two",
      email: email("vendor2"),
      phone: phone(21),
      billingPreference: "COD_OFFSET",
      creditLimitPaisa: null,
      registrationNumber: null,
    });
    await vendorsSvc.setVendorVerificationStatus(adminActor, vendor2.id, {
      target: "UNDER_REVIEW",
      notes: null,
    });
    await vendorsSvc.setVendorVerificationStatus(adminActor, vendor2.id, {
      target: "APPROVED",
      notes: null,
    });
    const booking = await bookingsSvc.createBooking(adminActor, {
      vendorId: vendor2.id,
      sender: { name: "P7C Sender Two", phone: phone(43), email: null },
      recipient: {
        name: "P7C Local Recipient",
        phone: phone(107),
        addressLine: "Lakeside Street 9",
        city: "Beta Town",
        district: fx.districtB,
        province: "Bagmati",
      },
      pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: fx.whB },
      shippingServiceCode: serviceCode,
      paymentMethod: "CASH" as const,
      codAmountPaisa: "100000",
      items: [{ description: "Local parcel", quantity: 1, weightKg: 1.0 }],
    });
    const pkg = booking.shipments[0].packages[0];
    await inventorySvc.receivePackage(staffBActor, {
      warehouseId: fx.whB,
      trackingId: pkg.trackingId,
    });
    await inventorySvc.moveToInspection(staffBActor, pkg.id);
    await inventorySvc.startInspection(staffBActor, pkg.id);
    await inventorySvc.recordInspection(staffBActor, {
      packageId: pkg.id,
      condition: "GOOD",
      actualWeightKg: 2,
    });
    await inventorySvc.putAwayPackage(staffBActor, pkg.id, fx.locStoB);
    await inventorySvc.markReadyForDispatch(staffBActor, pkg.id);

    const batch = await deliveriesSvc.createDeliveryBatch(waBActor, {
      warehouseId: fx.whB,
      riderUserId: fx.riderBUser,
      batchDate: TODAY,
      kind: "DELIVERY",
    });
    const added = await deliveriesSvc.addBatchPackages(waBActor, batch.id, {
      packageIds: [pkg.id],
    });
    expect(added.rejected).toEqual([]);
    const pickup = await deliveriesSvc.confirmPickup(riderBActor, batch.id, {
      trackingIds: [pkg.trackingId],
    });
    expect(pickup.taken).toHaveLength(1);
    const otp = await recipientOtp(added.added[0].id);
    const delivered = await deliveriesSvc.confirmDelivery(riderBActor, added.added[0].id, {
      receivedByName: "Local Recipient",
      otpCode: otp,
      codCollectedPaisa: "120000",
      notes: "Recipient paid extra against an earlier balance",
    });
    expect(delivered.cod?.status).toBe("MISMATCH");
    const collection = await prisma.deliveryCodCollection.findFirstOrThrow({
      where: { packageId: pkg.id },
    });

    const remittance = await remittancesSvc.submitRemittance(riderBActor, {
      collectionIds: [collection.id],
      declaredAmountPaisa: "120000",
      warehouseId: fx.whB,
      idempotencyKey: `p7c-remit-b-${RUN}`,
    });
    // The rider collected 120,000 against 100,000 expected (a delivery
    // mismatch). Finance counts 125,000 in the envelope — 5,000 MORE
    // than the rider declared/collected: a surplus discrepancy.
    const verified = await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
      countedAmountPaisa: "125000",
    });
    expect(verified.expectedPaisa).toBe("100000");
    expect(verified.countedAmountPaisa).toBe("125000");
    expect(verified.status).toBe("DISCREPANCY");
    expect(verified.discrepancyPaisa).toBe("5000");
    const resolvedB = await remittancesSvc.resolveRemittance(financeActor, remittance.id, {
      resolution: "ACCEPTED_COUNTED",
      note: "Surplus accepted at counted amount.",
    });
    expect(resolvedB.status).toBe("CLOSED");

    // The surplus is journalised under its own journal, and every
    // journal for this remittance balances to the paisa.
    const remitRows = await prisma.ledgerTransaction.findMany({
      where: { journalRef: { startsWith: remittance.remittanceNumber } },
    });
    expect(remitRows.length).toBeGreaterThan(0);
    const surplus = remitRows.filter((r) => r.journalRef.endsWith(":SURPLUS"));
    expect(surplus.length).toBeGreaterThan(0);
    const byJournal = new Map<string, { d: bigint; c: bigint }>();
    for (const row of remitRows) {
      const entry = byJournal.get(row.journalRef) ?? { d: BigInt(0), c: BigInt(0) };
      if (row.direction === "DEBIT") entry.d += row.amountPaisa;
      else entry.c += row.amountPaisa;
      byJournal.set(row.journalRef, entry);
    }
    for (const [, s] of byJournal) expect(s.d).toBe(s.c);
  });

  it("settles the vendor: prepare → approve → pay, net payable exact, ledger balanced", async () => {
    const prepared = await settlementsSvc.prepareSettlement(financeActor, {
      vendorId: fx.vendor,
    });
    const detail = await settlementsSvc.getSettlement(financeActor, prepared.id);
    // Gross COD settled for the vendor = amounts verified on the
    // remittance lines: P2's 500,000 in full + 200,000 of P3's line
    // (the counted 700,000 attributed across lines in order).
    expect(detail.grossCodPaisa).toBe("700000");
    expect(BigInt(detail.netPayablePaisa)).toBe(
      BigInt(detail.grossCodPaisa) -
        BigInt(detail.shippingChargesPaisa) -
        BigInt(detail.otherDeductionsPaisa),
    );
    expect(BigInt(detail.netPayablePaisa)).toBeGreaterThan(BigInt(0));
    // The vendor's return charge (Rs 100, bearer VENDOR) is inside the
    // settlement's deductions/lines.
    const lineKinds = detail.lines.map((l) => l.kind);
    expect(lineKinds.length).toBeGreaterThan(0);

    // Finance cannot approve its own preparation path — Admin approves.
    await expect(
      settlementsSvc.approveSettlement(financeActor, prepared.id),
    ).rejects.toThrow();
    const approved = await settlementsSvc.approveSettlement(adminActor, prepared.id);
    expect(approved.status).toBe("APPROVED");
    const paid = await settlementsSvc.paySettlement(financeActor, prepared.id, {
      method: "BANK_TRANSFER",
      transactionRef: `P7C-PAY-${RUN}`,
    });
    expect(paid.status).toBe("SETTLED");

    // The settlement journal balances to the paisa, and the vendor
    // payable account moved by exactly the net payable.
    const rows = await prisma.ledgerTransaction.findMany({
      where: { journalRef: { startsWith: paid.settlementNumber } },
    });
    expect(rows.length).toBeGreaterThan(0);
    const byJournal = new Map<string, { d: bigint; c: bigint }>();
    for (const row of rows) {
      const entry = byJournal.get(row.journalRef) ?? { d: BigInt(0), c: BigInt(0) };
      if (row.direction === "DEBIT") entry.d += row.amountPaisa;
      else entry.c += row.amountPaisa;
      byJournal.set(row.journalRef, entry);
    }
    for (const [, s] of byJournal) expect(s.d).toBe(s.c);

    const payableAccount = await prisma.financialAccount.findUnique({
      where: { code: financeDomain.vendorPayableAccountCode(fx.vendor) },
    });
    expect(payableAccount).not.toBeNull();
    const payableRows = await prisma.ledgerTransaction.findMany({
      where: { accountId: payableAccount!.id },
    });
    let payableBalance = BigInt(0); // LIABILITY: credit-normal
    for (const row of payableRows) {
      payableBalance += row.direction === "CREDIT" ? row.amountPaisa : -row.amountPaisa;
    }
    expect(payableBalance).toBe(BigInt(0));
  });
});
