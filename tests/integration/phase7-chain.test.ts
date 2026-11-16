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
    // In transit: custody sits with the line-haul driver for every parcel.
    for (const p of Object.values(parcels)) {
      await expectCustody(p.packageId, { userId: fx.linehaulUser });
      const pkg = await pkgStatus(p.packageId);
      expect(pkg.operationalStatus).toBe("IN_TRANSIT");
    }
  });

  it("runs the trip: depart + arrive", async () => {
    await tripsSvc.departTrip(linehaulActor, chain.trip1);
    await tripsSvc.arriveTrip(linehaulActor, chain.trip1);
    const trip = await prisma.trip.findUniqueOrThrow({ where: { id: chain.trip1 } });
    expect(trip.status).toBe("ARRIVED");
  });

  it("receives five of six at destination — the sixth goes missing and opens an investigation", async () => {
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
        condition: "GOOD",
      });
    }
    await transfersSvc.finishReceiving(waBActor, chain.transfer1);

    // P4 was never scanned: item MISSING, package flagged, incident open.
    const item4 = await prisma.transferItem.findFirstOrThrow({
      where: { transferId: chain.transfer1, packageId: parcels.P4.packageId },
    });
    expect(item4.itemStatus).toBe("MISSING");
    const pkg4 = await pkgStatus(parcels.P4.packageId);
    expect(pkg4.exceptionStatus).toBe("MISSING");
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

    // Investigation: a follow-up task on the incident, worked to close.
    const task = await incidentsSvc.createIncidentFollowUpTask(waBActor, incident!.id, {
      assigneeId: fx.staffB,
    });
    chain.investigationTask = task.id;
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "ACCEPTED" });
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "IN_PROGRESS" });
    await tasksSvc.updateTaskStatus(staffBActor, task.id, {
      status: "SUBMITTED",
      note: "Vehicle and cage searched; parcel not found — shortage confirmed.",
    });
    await tasksSvc.updateTaskStatus(waBActor, task.id, { status: "VERIFIED" });
    const closed = await tasksSvc.updateTaskStatus(waBActor, task.id, { status: "CLOSED" });
    expect(closed.status).toBe("CLOSED");

    // Reconcile + close with the shortage on record.
    const reconciled = await transfersSvc.reconcileTransfer(waBActor, chain.transfer1);
    expect(reconciled.reconciliation.missing).toBe(1);
    expect(reconciled.reconciliation.received).toBe(5);
    await transfersSvc.closeTransfer(waBActor, chain.transfer1);
  });

  it("handles the damaged parcel: destination inspection finds damage, incident raised, quarantined", async () => {
    const p5 = parcels.P5;
    await inventorySvc.moveToInspection(staffBActor, p5.packageId);
    await inventorySvc.startInspection(staffBActor, p5.packageId);
    await inventorySvc.recordInspection(staffBActor, {
      packageId: p5.packageId,
      condition: "DAMAGED",
      actualWeightKg: 2,
    });
    const pkg = await pkgStatus(p5.packageId);
    expect(pkg.condition).toBe("DAMAGED");
    expect(pkg.exceptionStatus).toBe("DAMAGED");
    const record = await openRecord(p5.packageId);
    expect(record).not.toBeNull();
    const location = await prisma.storageLocation.findUniqueOrThrow({
      where: { id: record!.storageLocationId! },
      include: { zone: true },
    });
    expect(location.zone.kind).toBe("DAMAGED");

    const incident = await incidentsSvc.createIncident(waBActor, {
      category: "DAMAGED_PACKAGE",
      description: "Crushed corner found at destination inspection; contents rattling.",
      packageId: p5.packageId,
      warehouseId: fx.whB,
    });
    expect(incident.category).toBe("DAMAGED_PACKAGE");
    chain.damageIncident = incident.id;
    // Custody never moved during handling: still the destination warehouse.
    await expectCustody(p5.packageId, { warehouseId: fx.whB });
  });
});
