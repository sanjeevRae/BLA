import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 7 security-review fix regressions (F1–F7, F11) against the
 * local bla_test database. Each test re-runs the reviewer's attack:
 *
 *  F1  reject a remittance, re-submit the same collection — the
 *      rider's ledger position must equal the collection exactly
 *      once (the rejection reverses the submission journal and the
 *      re-post is keyed), never double.
 *  F2  cod.read is scoped: an unrelated vendor sees no remittances
 *      and is denied (audited) a rider's COD position; a warehouse
 *      admin sees only their own warehouses' remittances/riders.
 *  F3  approve ∥ reject races on adjustments always land in exactly
 *      one consistent outcome — never REJECTED with a live journal.
 *  F4  two credit notes / write-offs that individually fit cannot
 *      both apply past the target's remaining bound.
 *  F5  a second PENDING settlement cannot re-claim the first
 *      settlement's shipping charges.
 *  F6  cancelling a settlement releases its lines — the same
 *      collection is preparable again.
 *  F7  refunds against company settlement payouts are refused at
 *      request time and again at processing time.
 *  F11 a zero-charge delivered shipment invoices cleanly alongside
 *      a charged one (no zero-amount accrual legs).
 *
 * Fixture warehouses are SHARED across runs (WH-ZF7 codes,
 * find-or-create); users/vendors/bookings are per-run unique. The
 * delivery journey helpers mirror tests/integration/finance.test.ts.
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
const email = (label: string) => `p7f-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);
const RECIPIENT_PHONE = phone(101);
const TODAY = new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let inventorySvc: typeof import("@/server/services/inventory");
let transfersSvc: typeof import("@/server/services/transfers");
let tripsSvc: typeof import("@/server/services/trips");
let driversSvc: typeof import("@/server/services/drivers");
let vehiclesSvc: typeof import("@/server/services/vehicles");
let deliveriesSvc: typeof import("@/server/services/deliveries");
let invoicesSvc: typeof import("@/server/services/invoices");
let remittancesSvc: typeof import("@/server/services/cod-remittances");
let settlementsSvc: typeof import("@/server/services/settlements");
let adjustmentsSvc: typeof import("@/server/services/finance-adjustments");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let financeDomain: typeof import("@/lib/finance/domain");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let financeActor: Awaited<ReturnType<typeof actorFor>>;
let superAdminActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let linehaulActor: Awaited<ReturnType<typeof actorFor>>;
let riderAActor: Awaited<ReturnType<typeof actorFor>>;
let riderF1Actor: Awaited<ReturnType<typeof actorFor>>;
let serviceCode: string;
let freeServiceCode: string;

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
      fullName: `P7F ${label}`,
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

async function makeVendor(label: string): Promise<{ vendorId: string; ownerUserId: string }> {
  const vendor = await vendorsSvc.createVendor(adminActor, {
    businessName: `P7F Vendor ${label} ${RUN}`,
    contactName: "P7F Contact",
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
  const ownerUserId = await makeUser(`vendorOwner-${label}`, "VENDOR");
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

async function bookOne(
  vendorId: string,
  codAmountPaisa = "0",
  svcCode: string = serviceCode,
): Promise<{ packageId: string; trackingId: string; shipmentId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId,
    sender: { name: "P7F Sender", phone: phone(42), email: null },
    recipient: {
      name: "P7F Recipient",
      phone: RECIPIENT_PHONE,
      addressLine: "Lakeside Street 1",
      city: "Town",
      district: fx.districtB,
      province: "Bagmati",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: fx.whA },
    shippingServiceCode: svcCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa,
    items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
  });
  const shipment = booking.shipments[0];
  const pkg = shipment.packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId, shipmentId: shipment.id };
}

/** Book at A → full transfer chain → RECEIVED_AT_DESTINATION at B. */
async function atDestination(vendorId: string, codAmountPaisa = "0", svcCode: string = serviceCode) {
  const { packageId, trackingId, shipmentId } = await bookOne(vendorId, codAmountPaisa, svcCode);
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
    idempotencyKey: `p7f-load-${RUN}-${trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(linehaulActor, tripId);
  await tripsSvc.arriveTrip(linehaulActor, tripId);
  const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
    trackingId,
    idempotencyKey: `p7f-unload-${RUN}-${trackingId}`,
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
  return { packageId, trackingId, shipmentId };
}

/** Deliver one parcel with the given rider, collecting exactly the
 * COD amount (MATCHED). Returns the finance-relevant ids. */
async function deliverCod(
  vendorId: string,
  codAmountPaisa: string,
  riderUserId: string,
  riderActor: Awaited<ReturnType<typeof actorFor>>,
  svcCode: string = serviceCode,
) {
  const parcel = await atDestination(vendorId, codAmountPaisa, svcCode);
  const batch = await deliveriesSvc.createDeliveryBatch(waBActor, {
    warehouseId: fx.whB,
    riderUserId,
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
  const delivered = await deliveriesSvc.confirmDelivery(riderActor, added.added[0].id, {
    receivedByName: "P7F Recipient",
    relationshipToRecipient: "Self",
    otpCode: pickup.taken[0].otp,
    codCollectedPaisa: codAmountPaisa,
  });
  const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: parcel.shipmentId } });
  if (BigInt(codAmountPaisa) === BigInt(0)) {
    return { ...parcel, collectionId: "", orderId: shipment.orderId };
  }
  expect(delivered.cod?.status).toBe("MATCHED");
  const collection = await prisma.deliveryCodCollection.findUniqueOrThrow({
    where: { packageId: parcel.packageId },
  });
  return { ...parcel, collectionId: collection.id, orderId: shipment.orderId };
}

async function journalSums(journalRef: string): Promise<{ debits: bigint; credits: bigint; count: number }> {
  const entries = await prisma.ledgerTransaction.findMany({ where: { journalRef } });
  let debits = BigInt(0);
  let credits = BigInt(0);
  for (const entry of entries) {
    if (entry.direction === "DEBIT") debits += entry.amountPaisa;
    else credits += entry.amountPaisa;
  }
  return { debits, credits, count: entries.length };
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
  invoicesSvc = await import("@/server/services/invoices");
  remittancesSvc = await import("@/server/services/cod-remittances");
  settlementsSvc = await import("@/server/services/settlements");
  adjustmentsSvc = await import("@/server/services/finance-adjustments");
  errors = await import("@/lib/errors");
  actorErrors = await import("@/lib/auth/actor");
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
  fx.superAdminUser = await makeUser("superadmin", "SUPER_ADMIN");
  superAdminActor = await actorFor(fx.superAdminUser);

  fx.districtA = "P7F Alpha District";
  fx.districtB = "P7F Beta District";
  const a = await ensureWarehouse("WH-ZF7-01", "P7F Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  const b = await ensureWarehouse("WH-ZF7-02", "P7F Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;

  serviceCode = `P7FSTD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P7F Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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
  freeServiceCode = `P7FFREE${RUN.slice(-5)}`.toUpperCase();
  const freeService = await prisma.shippingService.create({
    data: { code: freeServiceCode, name: "P7F Free (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
  });
  await prisma.pricingRule.create({
    data: {
      shippingServiceId: freeService.id,
      baseRatePaisa: BigInt(0),
      perKgRatePaisa: BigInt(0),
      volumetricDivisor: 5000,
      createdById: fx.adminUser,
    },
  });

  fx.waA = await makeUser("waA", "WAREHOUSE_ADMIN");
  await addMembership(fx.waA, fx.whA, "WAREHOUSE_ADMIN");
  fx.staffA = await makeUser("staffA", "WAREHOUSE_STAFF");
  await addMembership(fx.staffA, fx.whA, "WAREHOUSE_STAFF");
  fx.waB = await makeUser("waB", "WAREHOUSE_ADMIN");
  await addMembership(fx.waB, fx.whB, "WAREHOUSE_ADMIN");
  waAActor = await actorFor(fx.waA);
  staffAActor = await actorFor(fx.staffA);
  waBActor = await actorFor(fx.waB);

  fx.linehaulUser = await makeUser("linehaul", "LINEHAUL_DRIVER");
  const linehaul = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.linehaulUser,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P7F-LH-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.linehaulProfile = linehaul.id;
  linehaulActor = await actorFor(fx.linehaulUser);
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P7F TRK ${RUN.slice(-6)}`.toUpperCase(),
    type: "TRUCK",
    capacityKg: 5000,
    homeWarehouseId: fx.whA,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  fx.vehicle = vehicle.id;

  for (const label of ["riderA", "riderF1"] as const) {
    const userId = await makeUser(label, "RIDER");
    const profile = await driversSvc.createDriverProfile(adminActor, {
      userId,
      homeWarehouseId: fx.whB,
      licenseNumber: `LIC-P7F-${label}-${RUN}`,
      licenseCategory: "A",
      licenseExpiry: "2030-01-01",
      capabilities: ["DELIVERY", "PICKUP"],
    });
    fx[`${label}User`] = userId;
    fx[`${label}Profile`] = profile.id;
  }
  riderAActor = await actorFor(fx.riderAUser);
  riderF1Actor = await actorFor(fx.riderF1User);
});

// Journey-heavy integration tests (same rationale as finance.test.ts).
describe("Phase 7 finance fixes", { timeout: 120000 }, () => {
  it("F1: reject then re-submit posts the collection's journal exactly once, net", async () => {
    const cod = BigInt(500000);
    const { vendorId } = await makeVendor("F1");
    // Dedicated rider: the DRIVER_CASH ledger position is asserted
    // absolutely, so no other test may touch this rider's account.
    const delivered = await deliverCod(vendorId, cod.toString(), fx.riderF1User, riderF1Actor);
    const collectionId = delivered.collectionId;

    const first = await remittancesSvc.submitRemittance(riderF1Actor, {
      collectionIds: [collectionId],
      declaredAmountPaisa: cod.toString(),
      method: "CASH",
    });
    let position = await remittancesSvc.getRiderCodPosition(riderF1Actor);
    expect(BigInt(position.ledgerOwedPaisa)).toBe(cod);

    // Finance counts short → DISCREPANCY → finance rejects the
    // remittance outright, handing the collection back.
    const parked = await remittancesSvc.verifyRemittance(financeActor, first.id, {
      countedAmountPaisa: "400000",
    });
    expect(parked.status).toBe("DISCREPANCY");
    const rejected = await remittancesSvc.resolveRemittance(financeActor, first.id, {
      resolution: "REJECTED",
      note: "Count does not match the handover; recount with the rider present.",
    });
    expect(rejected.status).toBe("CLOSED");
    expect(rejected.resolution).toBe("REJECTED");

    // The submission journal was reversed: the rider owes nothing
    // for the collection and it awaits remittance again.
    position = await remittancesSvc.getRiderCodPosition(riderF1Actor);
    expect(BigInt(position.ledgerOwedPaisa)).toBe(BigInt(0));
    expect(position.awaitingRemittance.map((c) => c.collectionId)).toContain(collectionId);
    const reversal = await journalSums(`REV:COD-${collectionId}`);
    expect(reversal.count).toBe(2);
    expect(reversal.debits).toBe(cod);
    expect(reversal.credits).toBe(cod);

    // Re-submission posts exactly one live journal: two postings
    // exist on paper, one is fully reversed, the rider's position
    // equals the collection amount — not double.
    const second = await remittancesSvc.submitRemittance(riderF1Actor, {
      collectionIds: [collectionId],
      declaredAmountPaisa: cod.toString(),
      method: "CASH",
    });
    position = await remittancesSvc.getRiderCodPosition(riderF1Actor);
    expect(BigInt(position.ledgerOwedPaisa)).toBe(cod);
    const posted = await journalSums(`COD-${collectionId}`);
    expect(posted.count).toBe(4); // two postings × two legs
    expect(posted.debits).toBe(cod * BigInt(2));

    // And the re-submitted remittance verifies cleanly.
    const verified = await remittancesSvc.verifyRemittance(financeActor, second.id, {
      countedAmountPaisa: cod.toString(),
    });
    expect(verified.status).toBe("VERIFIED");
    position = await remittancesSvc.getRiderCodPosition(riderF1Actor);
    expect(BigInt(position.ledgerOwedPaisa)).toBe(BigInt(0));
  });

  it("F2: cod.read is scoped for vendors and warehouse admins", async () => {
    const cod = BigInt(500000);
    const own = await makeVendor("F2OWN");
    const other = await makeVendor("F2OTHER");
    const otherActor = await actorFor(other.ownerUserId);
    const ownActor = await actorFor(own.ownerUserId);

    const delivered = await deliverCod(own.vendorId, cod.toString(), fx.riderAUser, riderAActor);
    const remittance = await remittancesSvc.submitRemittance(riderAActor, {
      collectionIds: [delivered.collectionId],
      declaredAmountPaisa: cod.toString(),
      method: "CASH",
    });

    // The vendor whose collection it is can see the remittance.
    const ownList = await remittancesSvc.listRemittances(ownActor, {});
    expect(ownList.items.map((r) => r.id)).toContain(remittance.id);
    await expect(remittancesSvc.getRemittance(ownActor, remittance.id)).resolves.toBeDefined();

    // An unrelated vendor cannot: not in the list, detail denied,
    // and the rider's COD position is denied AND audited.
    const otherList = await remittancesSvc.listRemittances(otherActor, {});
    expect(otherList.items.map((r) => r.id)).not.toContain(remittance.id);
    await expect(remittancesSvc.getRemittance(otherActor, remittance.id)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    const denialsBefore = await prisma.auditLog.count({
      where: { action: "access.denied", actorId: other.ownerUserId, entityType: "CodRemittance" },
    });
    await expect(
      remittancesSvc.getRiderCodPosition(otherActor, fx.riderAProfile),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const denialsAfter = await prisma.auditLog.count({
      where: { action: "access.denied", actorId: other.ownerUserId, entityType: "CodRemittance" },
    });
    expect(denialsAfter).toBeGreaterThan(denialsBefore);

    // Warehouse admin of the hand-in warehouse (B) sees it; the
    // admin of warehouse A does not — list, detail, or position.
    const listB = await remittancesSvc.listRemittances(waBActor, {});
    expect(listB.items.map((r) => r.id)).toContain(remittance.id);
    await expect(remittancesSvc.getRemittance(waBActor, remittance.id)).resolves.toBeDefined();
    await expect(
      remittancesSvc.getRiderCodPosition(waBActor, fx.riderAProfile),
    ).resolves.toBeDefined();

    const listA = await remittancesSvc.listRemittances(waAActor, {});
    expect(listA.items.map((r) => r.id)).not.toContain(remittance.id);
    await expect(remittancesSvc.getRemittance(waAActor, remittance.id)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    await expect(
      remittancesSvc.getRiderCodPosition(waAActor, fx.riderAProfile),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    // Finance keeps the global read.
    const financeList = await remittancesSvc.listRemittances(financeActor, {});
    expect(financeList.items.map((r) => r.id)).toContain(remittance.id);
  });

  it("F3: approve ∥ reject races on adjustments end in exactly one consistent outcome (×12)", async () => {
    const { vendorId } = await makeVendor("F3");
    await deliverCod(vendorId, "0", fx.riderAUser, riderAActor);
    const invoice = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId });
    expect(invoice).not.toBeNull();

    for (let i = 0; i < 12; i++) {
      const adjustment = await adjustmentsSvc.createAdjustment(financeActor, {
        targetType: "INVOICE",
        targetId: invoice!.id,
        amountPaisa: "100",
        reason: `Race probe ${i} for the F3 regression`,
      });
      // Start the approval first and give it a head start so the
      // rejection is issued while the approval transaction is in
      // flight — the reviewer's interleave. On fixed code the loser
      // re-reads the status under the row lock and conflicts.
      const approvePromise = adjustmentsSvc.approveAdjustment(superAdminActor, adjustment.id);
      await sleep(25);
      const rejectPromise = adjustmentsSvc.rejectAdjustment(superAdminActor, adjustment.id);
      const [approveResult, rejectResult] = await Promise.allSettled([approvePromise, rejectPromise]);

      const fulfilled = [approveResult, rejectResult].filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(1);

      const row = await prisma.financialAdjustment.findUniqueOrThrow({
        where: { id: adjustment.id },
      });
      const journal = await journalSums(`ADJ-${adjustment.id}`);
      if (row.status === "APPLIED") {
        expect(approveResult.status).toBe("fulfilled");
        expect(row.ledgerJournalRef).toBe(`ADJ-${adjustment.id}`);
        expect(journal.count).toBe(2);
        expect(journal.debits).toBe(BigInt(100));
      } else {
        expect(row.status).toBe("REJECTED");
        expect(rejectResult.status).toBe("fulfilled");
        expect(row.ledgerJournalRef).toBeNull();
        // The core F3 invariant: a REJECTED adjustment never has a
        // live journal attached.
        expect(journal.count).toBe(0);
      }
    }
  });

  it("F4: two invoice credit notes that each fit cannot both apply past the total", async () => {
    const { vendorId } = await makeVendor("F4INV");
    await deliverCod(vendorId, "0", fx.riderAUser, riderAActor);
    const invoice = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId });
    expect(invoice).not.toBeNull();
    const total = invoice!.totalPaisa;

    const first = await adjustmentsSvc.createAdjustment(financeActor, {
      targetType: "INVOICE",
      targetId: invoice!.id,
      amountPaisa: total,
      reason: "Full credit note — first of a pair",
    });
    const applied = await adjustmentsSvc.approveAdjustment(superAdminActor, first.id);
    expect(applied.status).toBe("APPLIED");

    // Creation still allows the second note (it is bounded by the
    // invoice total alone)…
    const second = await adjustmentsSvc.createAdjustment(financeActor, {
      targetType: "INVOICE",
      targetId: invoice!.id,
      amountPaisa: total,
      reason: "Full credit note — second of a pair",
    });
    // …but approval must refuse: the remaining bound is now zero.
    await expect(adjustmentsSvc.approveAdjustment(superAdminActor, second.id)).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
    const row = await prisma.financialAdjustment.findUniqueOrThrow({ where: { id: second.id } });
    expect(row.status).toBe("REQUESTED");
    expect(await journalSums(`ADJ-${second.id}`)).toEqual({ debits: BigInt(0), credits: BigInt(0), count: 0 });
    const detail = await invoicesSvc.getInvoice(financeActor, invoice!.id);
    expect(BigInt(detail.adjustmentCreditsPaisa)).toBe(BigInt(total));
  });

  it("F4: two COD write-offs that each fit the shortfall cannot both apply", async () => {
    const cod = BigInt(500000);
    const counted = BigInt(450000);
    const shortfall = cod - counted;
    const { vendorId } = await makeVendor("F4COD");
    const delivered = await deliverCod(vendorId, cod.toString(), fx.riderAUser, riderAActor);
    const remittance = await remittancesSvc.submitRemittance(riderAActor, {
      collectionIds: [delivered.collectionId],
      declaredAmountPaisa: cod.toString(),
      method: "CASH",
    });
    await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
      countedAmountPaisa: counted.toString(),
    });
    const resolved = await remittancesSvc.resolveRemittance(financeActor, remittance.id, {
      resolution: "ACCEPTED_COUNTED",
      note: "Short count accepted; shortfall on the rider's record.",
    });
    expect(resolved.status).toBe("CLOSED");

    // Both write-offs are created while the shortfall is intact —
    // each individually fits it.
    const first = await adjustmentsSvc.createAdjustment(financeActor, {
      targetType: "COD_COLLECTION",
      targetId: delivered.collectionId,
      amountPaisa: shortfall.toString(),
      reason: "Write off the accepted shortfall — first",
    });
    const second = await adjustmentsSvc.createAdjustment(financeActor, {
      targetType: "COD_COLLECTION",
      targetId: delivered.collectionId,
      amountPaisa: shortfall.toString(),
      reason: "Write off the accepted shortfall — duplicate",
    });
    const applied = await adjustmentsSvc.approveAdjustment(superAdminActor, first.id);
    expect(applied.status).toBe("APPLIED");
    await expect(adjustmentsSvc.approveAdjustment(superAdminActor, second.id)).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
    const row = await prisma.financialAdjustment.findUniqueOrThrow({ where: { id: second.id } });
    expect(row.status).toBe("REQUESTED");
  });

  it("F5: a second PENDING settlement cannot re-claim the first settlement's charges", async () => {
    const cod = BigInt(300000);
    const { vendorId } = await makeVendor("F5");
    const delivered = await deliverCod(vendorId, cod.toString(), fx.riderAUser, riderAActor);
    const invoice = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId });
    expect(invoice).not.toBeNull();
    const remittance = await remittancesSvc.submitRemittance(riderAActor, {
      collectionIds: [delivered.collectionId],
      declaredAmountPaisa: cod.toString(),
      method: "CASH",
    });
    await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
      countedAmountPaisa: cod.toString(),
    });

    const first = await settlementsSvc.prepareSettlement(financeActor, { vendorId });
    const firstDetail = await settlementsSvc.getSettlement(financeActor, first.id);
    expect(firstDetail.lines.filter((l) => l.kind === "SHIPPING_CHARGE")).toHaveLength(1);
    expect(firstDetail.lines.filter((l) => l.kind === "COD_CREDIT")).toHaveLength(1);

    // Everything this vendor has is now claimed by the PENDING
    // settlement — a second preparation has nothing to settle.
    await expect(settlementsSvc.prepareSettlement(financeActor, { vendorId })).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
  });

  it("F6: cancelling a settlement releases its collections and charges for re-preparation", async () => {
    const cod = BigInt(200000);
    const { vendorId } = await makeVendor("F6");
    const delivered = await deliverCod(vendorId, cod.toString(), fx.riderAUser, riderAActor);
    const invoice = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId });
    expect(invoice).not.toBeNull();
    const remittance = await remittancesSvc.submitRemittance(riderAActor, {
      collectionIds: [delivered.collectionId],
      declaredAmountPaisa: cod.toString(),
      method: "CASH",
    });
    await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
      countedAmountPaisa: cod.toString(),
    });

    const first = await settlementsSvc.prepareSettlement(financeActor, { vendorId });
    const cancelled = await settlementsSvc.cancelSettlement(financeActor, first.id, {
      reason: "Prepared against the wrong period",
    });
    expect(cancelled.status).toBe("CANCELLED");
    const remainingLines = await prisma.vendorSettlementLine.count({
      where: { settlementId: first.id },
    });
    expect(remainingLines).toBe(0);

    const second = await settlementsSvc.prepareSettlement(financeActor, { vendorId });
    const detail = await settlementsSvc.getSettlement(financeActor, second.id);
    expect(detail.lines.filter((l) => l.kind === "COD_CREDIT").map((l) => l.codCollectionId)).toContain(
      delivered.collectionId,
    );
    expect(detail.lines.filter((l) => l.kind === "SHIPPING_CHARGE").map((l) => l.invoiceId)).toContain(
      invoice!.id,
    );
    expect(BigInt(detail.grossCodPaisa)).toBe(cod);
  });

  it("F7: refunds against a settlement payout are refused at request and at processing", async () => {
    const cod = BigInt(400000);
    const { vendorId } = await makeVendor("F7");
    const delivered = await deliverCod(vendorId, cod.toString(), fx.riderAUser, riderAActor);
    const invoice = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId });
    expect(invoice).not.toBeNull();
    const remittance = await remittancesSvc.submitRemittance(riderAActor, {
      collectionIds: [delivered.collectionId],
      declaredAmountPaisa: cod.toString(),
      method: "CASH",
    });
    await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
      countedAmountPaisa: cod.toString(),
    });
    const prepared = await settlementsSvc.prepareSettlement(financeActor, { vendorId });
    await settlementsSvc.approveSettlement(adminActor, prepared.id);
    const paid = await settlementsSvc.paySettlement(financeActor, prepared.id, {
      method: "BANK_TRANSFER",
      transactionRef: `P7F-SETTLE-${RUN}`,
    });
    expect(paid.status).toBe("SETTLED");
    const settlementRow = await prisma.vendorSettlement.findUniqueOrThrow({
      where: { id: prepared.id },
    });
    const payoutPaymentId = settlementRow.paymentId;
    expect(payoutPaymentId).not.toBeNull();
    const payout = await prisma.payment.findUniqueOrThrow({ where: { id: payoutPaymentId! } });
    expect(payout.payerType).toBe("COMPANY");

    // Request-time guard.
    await expect(
      adjustmentsSvc.requestRefund(financeActor, {
        paymentId: payoutPaymentId!,
        amountPaisa: "1000",
        reason: "Attempted refund of a settlement payout",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);

    // Processing-time backstop: even a refund row that exists
    // anyway (created directly here) cannot be processed.
    const planted = await prisma.refund.create({
      data: {
        paymentId: payoutPaymentId!,
        amountPaisa: BigInt(1000),
        reason: "Planted APPROVED refund against a settlement payout",
        status: "APPROVED",
        requestedById: fx.financeUser,
        approvedById: fx.superAdminUser,
      },
    });
    await expect(adjustmentsSvc.processRefund(financeActor, planted.id)).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
    const settlementAfter = await prisma.vendorSettlement.findUniqueOrThrow({
      where: { id: prepared.id },
    });
    expect(settlementAfter.status).toBe("SETTLED");
    const payoutAfter = await prisma.payment.findUniqueOrThrow({ where: { id: payoutPaymentId! } });
    expect(payoutAfter.status).toBe("PAID");
  });

  it("F11: a zero-charge shipment invoices cleanly alongside a charged one", async () => {
    const { vendorId } = await makeVendor("F11");
    const free = await deliverCod(vendorId, "0", fx.riderAUser, riderAActor, freeServiceCode);
    const charged = await deliverCod(vendorId, "0", fx.riderAUser, riderAActor);
    const freeShipment = await prisma.shipment.findUniqueOrThrow({ where: { id: free.shipmentId } });
    const chargedShipment = await prisma.shipment.findUniqueOrThrow({
      where: { id: charged.shipmentId },
    });
    expect(freeShipment.shippingChargePaisa).toBe(BigInt(0));
    expect(chargedShipment.shippingChargePaisa).toBeGreaterThan(BigInt(0));

    const invoice = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId });
    expect(invoice).not.toBeNull();
    expect(BigInt(invoice!.totalPaisa)).toBe(chargedShipment.shippingChargePaisa);

    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: invoice!.id } });
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.amountPaisa === BigInt(0))).toBe(true);

    // The accrual journal carries only the charged line's legs and
    // balances at the invoice total.
    const sums = await journalSums(invoice!.invoiceNumber);
    expect(sums.count).toBe(2);
    expect(sums.debits).toBe(chargedShipment.shippingChargePaisa);
    expect(sums.credits).toBe(chargedShipment.shippingChargePaisa);
  });
});
