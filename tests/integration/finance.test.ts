import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 7 integration tests (docs: implementation-roadmap Phase 7,
 * financial-workflow, cod-reconciliation, database-schema §9)
 * against the local bla_test database.
 *
 * Covered: invoice generation from DELIVERED shipments at their
 * snapshotted charges (exact paisa), idempotent under re-run AND
 * concurrent runs; partial payments + the overpayment rule;
 * idempotent payment replay (Scenario 12); every journal balanced
 * (Σ debits = Σ credits) across invoice / payment / remittance /
 * settlement / refund / reversal flows; the COD happy path settling
 * the rider's obligation exactly; the Scenario 5 mismatch
 * (collect 5000, remit 4500) landing in DISCREPANCY with the rider
 * unable to confirm their own remittance and warehouse staff
 * unable to verify; a collection remitted twice is impossible; a
 * vendor settlement matching a hand-computed fixture
 * (COD − charges − deduction); void via compensating reversal with
 * originals intact; ledger/payment immutability enforced by the DB;
 * vendor A / vendor B read isolation (audited); rider isolation.
 *
 * Fixture warehouses are SHARED across runs (WH-ZP7 codes,
 * find-or-create); users/vendors/bookings are per-run unique. The
 * delivery journey helpers mirror tests/integration/deliveries.test.ts.
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
const email = (label: string) => `p7-${label}-${RUN}@bla.test`;
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
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
let linehaulActor: Awaited<ReturnType<typeof actorFor>>;
let riderAActor: Awaited<ReturnType<typeof actorFor>>;
let riderBActor: Awaited<ReturnType<typeof actorFor>>;
let vendorBActor: Awaited<ReturnType<typeof actorFor>>;
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
      fullName: `P7 ${label}`,
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
    businessName: `P7 Vendor ${label} ${RUN}`,
    contactName: "P7 Contact",
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
): Promise<{ packageId: string; trackingId: string; shipmentId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId,
    sender: { name: "P7 Sender", phone: phone(42), email: null },
    recipient: {
      name: "P7 Recipient",
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
  const shipment = booking.shipments[0];
  const pkg = shipment.packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId, shipmentId: shipment.id };
}

/** Book at A → full transfer chain → RECEIVED_AT_DESTINATION at B. */
async function atDestination(vendorId: string, codAmountPaisa = "0") {
  const { packageId, trackingId, shipmentId } = await bookOne(vendorId, codAmountPaisa);
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
    idempotencyKey: `p7-load-${RUN}-${trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(linehaulActor, tripId);
  await tripsSvc.arriveTrip(linehaulActor, tripId);
  const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
    trackingId,
    idempotencyKey: `p7-unload-${RUN}-${trackingId}`,
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
) {
  const parcel = await atDestination(vendorId, codAmountPaisa);
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
    receivedByName: "P7 Recipient",
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

async function expectBalanced(journalRef: string) {
  const sums = await journalSums(journalRef);
  expect(sums.count).toBeGreaterThan(0);
  expect(sums.debits).toBe(sums.credits);
  expect(sums.debits).toBeGreaterThan(BigInt(0));
  return sums;
}

async function accountBalance(code: string): Promise<bigint> {
  const account = await prisma.financialAccount.findUniqueOrThrow({ where: { code } });
  const grouped = await prisma.ledgerTransaction.groupBy({
    by: ["direction"],
    where: { accountId: account.id },
    _sum: { amountPaisa: true },
  });
  let debits = BigInt(0);
  let credits = BigInt(0);
  for (const row of grouped) {
    if (row.direction === "DEBIT") debits = row._sum.amountPaisa ?? BigInt(0);
    else credits = row._sum.amountPaisa ?? BigInt(0);
  }
  return financeDomain.DEBIT_NORMAL_KINDS.includes(account.kind) ? debits - credits : credits - debits;
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

  fx.districtA = "P7Alpha District";
  fx.districtB = "P7Beta District";
  const a = await ensureWarehouse("WH-ZP7-01", "P7 Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  const b = await ensureWarehouse("WH-ZP7-02", "P7 Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;

  serviceCode = `P7STD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P7 Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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

  const vendorA = await makeVendor("A");
  fx.vendorA = vendorA.vendorId;
  const vendorB = await makeVendor("B");
  fx.vendorB = vendorB.vendorId;
  fx.vendorBOwner = vendorB.ownerUserId;
  vendorBActor = await actorFor(fx.vendorBOwner);
  const vendorCod = await makeVendor("COD");
  fx.vendorCod = vendorCod.vendorId;
  const vendorSettle = await makeVendor("SET");
  fx.vendorSettle = vendorSettle.vendorId;

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

  fx.linehaulUser = await makeUser("linehaul", "LINEHAUL_DRIVER");
  const linehaul = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.linehaulUser,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P7-LH-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.linehaulProfile = linehaul.id;
  linehaulActor = await actorFor(fx.linehaulUser);
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P7 TRK ${RUN.slice(-6)}`.toUpperCase(),
    type: "TRUCK",
    capacityKg: 5000,
    homeWarehouseId: fx.whA,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  fx.vehicle = vehicle.id;

  for (const label of ["riderA", "riderB"] as const) {
    const userId = await makeUser(label, "RIDER");
    const profile = await driversSvc.createDriverProfile(adminActor, {
      userId,
      homeWarehouseId: fx.whB,
      licenseNumber: `LIC-P7-${label}-${RUN}`,
      licenseCategory: "A",
      licenseExpiry: "2030-01-01",
      capabilities: ["DELIVERY", "PICKUP"],
    });
    fx[`${label}User`] = userId;
    fx[`${label}Profile`] = profile.id;
  }
  riderAActor = await actorFor(fx.riderAUser);
  riderBActor = await actorFor(fx.riderBUser);
});

// Journey-heavy integration tests: each delivery journey runs ~25
// service calls, and the full suite runs files in parallel on a
// shared VM — allow a generous per-test ceiling.
describe("Phase 7 finance", { timeout: 120000 }, () => {
  it("generates an invoice from delivered shipments at snapshotted charges, idempotently (incl. concurrent runs)", async () => {
    const first = await deliverCod(fx.vendorA, "0", fx.riderAUser, riderAActor);
    const second = await deliverCod(fx.vendorA, "0", fx.riderAUser, riderAActor);
    const snap1 = await prisma.shipment.findUniqueOrThrow({ where: { id: first.shipmentId } });
    const snap2 = await prisma.shipment.findUniqueOrThrow({ where: { id: second.shipmentId } });
    const expectedTotal = snap1.shippingChargePaisa + snap2.shippingChargePaisa;
    expect(expectedTotal).toBeGreaterThan(BigInt(0));

    // Concurrent generation runs must produce exactly one invoice.
    const [runA, runB] = await Promise.all([
      invoicesSvc.generateVendorInvoice(financeActor, { vendorId: fx.vendorA }),
      invoicesSvc.generateVendorInvoice(financeActor, { vendorId: fx.vendorA }),
    ]);
    const created = [runA, runB].filter((r) => r !== null);
    expect(created).toHaveLength(1);
    const invoice = created[0]!;
    expect(BigInt(invoice.totalPaisa)).toBe(expectedTotal);
    expect(invoice.status).toBe("ISSUED");

    const lines = await prisma.invoiceLine.findMany({ where: { invoiceId: invoice.id } });
    expect(lines).toHaveLength(2);
    expect(lines.reduce((s, l) => s + l.amountPaisa, BigInt(0))).toBe(expectedTotal);

    // Re-running is a no-op.
    const again = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId: fx.vendorA });
    expect(again).toBeNull();
    const count = await prisma.invoice.count({ where: { vendorId: fx.vendorA } });
    expect(count).toBe(1);

    // The accrual journal is balanced and matches the invoice total.
    const sums = await expectBalanced(invoice.invoiceNumber);
    expect(sums.debits).toBe(expectedTotal);

    fx.invoiceA = invoice.id;
    fx.invoiceATotal = expectedTotal.toString();
  });

  it("records partial payments, derives status, and rejects overpayment beyond outstanding", async () => {
    const total = BigInt(fx.invoiceATotal);
    const part = total / BigInt(2);
    const payment = await invoicesSvc.recordPayment(financeActor, {
      amountPaisa: part.toString(),
      method: "BANK_TRANSFER",
      allocations: [{ invoiceId: fx.invoiceA, amountPaisa: part.toString() }],
    });
    let detail = await invoicesSvc.getInvoice(financeActor, fx.invoiceA);
    expect(detail.status).toBe("PARTIALLY_PAID");
    expect(BigInt(detail.paidPaisa)).toBe(part);
    expect(BigInt(detail.outstandingPaisa)).toBe(total - part);
    await expectBalanced(`PAY-${payment.id}`);

    // Overpaying the remainder is rejected (no implicit credit balance).
    await expect(
      invoicesSvc.recordPayment(financeActor, {
        amountPaisa: (total - part + BigInt(1)).toString(),
        method: "CASH",
        allocations: [{ invoiceId: fx.invoiceA, amountPaisa: (total - part + BigInt(1)).toString() }],
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);

    const rest = await invoicesSvc.recordPayment(financeActor, {
      amountPaisa: (total - part).toString(),
      method: "CASH",
      allocations: [{ invoiceId: fx.invoiceA, amountPaisa: (total - part).toString() }],
    });
    detail = await invoicesSvc.getInvoice(financeActor, fx.invoiceA);
    expect(detail.status).toBe("PAID");
    expect(BigInt(detail.outstandingPaisa)).toBe(BigInt(0));
    await expectBalanced(`PAY-${rest.id}`);

    // Warehouse staff hold no payment permission.
    await expect(
      invoicesSvc.recordPayment(waBActor, {
        amountPaisa: "100",
        method: "CASH",
        allocations: [{ invoiceId: fx.invoiceA, amountPaisa: "100" }],
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("replays an idempotent payment exactly once (Scenario 12)", async () => {
    const parcel = await deliverCod(fx.vendorB, "0", fx.riderAUser, riderAActor);
    void parcel;
    const invoice = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId: fx.vendorB });
    expect(invoice).not.toBeNull();
    fx.invoiceB1 = invoice!.id;

    const key = `p7-idem-${RUN}`;
    const first = await invoicesSvc.recordPayment(financeActor, {
      amountPaisa: invoice!.totalPaisa,
      method: "MOBILE_WALLET",
      idempotencyKey: key,
      allocations: [{ invoiceId: invoice!.id, amountPaisa: invoice!.totalPaisa }],
    });
    const replay = await invoicesSvc.recordPayment(financeActor, {
      amountPaisa: invoice!.totalPaisa,
      method: "MOBILE_WALLET",
      idempotencyKey: key,
      allocations: [{ invoiceId: invoice!.id, amountPaisa: invoice!.totalPaisa }],
    });
    expect(replay.id).toBe(first.id);
    const payments = await prisma.payment.count({ where: { idempotencyKey: key } });
    expect(payments).toBe(1);
    const detail = await invoicesSvc.getInvoice(financeActor, invoice!.id);
    expect(detail.status).toBe("PAID");
    expect(BigInt(detail.paidPaisa)).toBe(BigInt(invoice!.totalPaisa));
    fx.paymentB1 = first.id;
    fx.invoiceB1Total = invoice!.totalPaisa;
  });

  it("settles the rider's COD obligation exactly on the happy path", async () => {
    const cod = BigInt(500000); // Rs 5,000.00
    const delivered = await deliverCod(fx.vendorCod, cod.toString(), fx.riderAUser, riderAActor);

    let position = await remittancesSvc.getRiderCodPosition(riderAActor);
    expect(position.driverId).toBe(fx.riderAProfile);
    expect(BigInt(position.awaitingRemittanceTotalPaisa)).toBe(cod);
    expect(position.awaitingRemittance.map((c) => c.collectionId)).toContain(delivered.collectionId);

    const remittance = await remittancesSvc.submitRemittance(riderAActor, {
      collectionIds: [delivered.collectionId],
      declaredAmountPaisa: cod.toString(),
      method: "CASH",
    });
    expect(remittance.status).toBe("SUBMITTED");
    await expectBalanced(`COD-${delivered.collectionId}`);

    let pkg = await prisma.package.findUniqueOrThrow({ where: { id: delivered.packageId } });
    expect(pkg.paymentStatus).toBe("COD_COLLECTED");
    position = await remittancesSvc.getRiderCodPosition(riderAActor);
    expect(BigInt(position.ledgerOwedPaisa)).toBe(cod);

    const verified = await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
      countedAmountPaisa: cod.toString(),
    });
    expect(verified.status).toBe("VERIFIED");
    expect(verified.discrepancyPaisa).toBe("0");
    await expectBalanced(remittance.remittanceNumber);

    pkg = await prisma.package.findUniqueOrThrow({ where: { id: delivered.packageId } });
    expect(pkg.paymentStatus).toBe("COD_REMITTED");
    position = await remittancesSvc.getRiderCodPosition(riderAActor);
    expect(BigInt(position.ledgerOwedPaisa)).toBe(BigInt(0));
    expect(BigInt(position.verifiedRemittedPaisa)).toBe(cod);

    fx.collectionCod1 = delivered.collectionId;
    fx.vendorCodShipmentCharge = (
      await prisma.shipment.findUniqueOrThrow({ where: { id: delivered.shipmentId } })
    ).shippingChargePaisa.toString();
  });

  it("parks a short handover in DISCREPANCY (Scenario 5) and settles only the counted amount", async () => {
    const cod = BigInt(500000);
    const counted = BigInt(450000);
    const delivered = await deliverCod(fx.vendorCod, cod.toString(), fx.riderAUser, riderAActor);
    const remittance = await remittancesSvc.submitRemittance(riderAActor, {
      collectionIds: [delivered.collectionId],
      declaredAmountPaisa: cod.toString(),
      method: "CASH",
    });

    // The rider can never verify their own remittance…
    await expect(
      remittancesSvc.verifyRemittance(riderAActor, remittance.id, {
        countedAmountPaisa: cod.toString(),
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // …and neither can warehouse staff (cod.read only, no cod.verify).
    await expect(
      remittancesSvc.verifyRemittance(waBActor, remittance.id, {
        countedAmountPaisa: cod.toString(),
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    const parked = await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
      countedAmountPaisa: counted.toString(),
    });
    expect(parked.status).toBe("DISCREPANCY");
    expect(parked.discrepancyPaisa).toBe((counted - cod).toString());
    // No money moved into clearing while the discrepancy is open.
    const clearingJournal = await journalSums(remittance.remittanceNumber);
    expect(clearingJournal.count).toBe(0);
    // The discrepancy is on the audit record (Phase 8 incident link point).
    const audit = await prisma.auditLog.findFirst({
      where: { action: "cod.discrepancy_opened", entityId: remittance.id },
    });
    expect(audit).not.toBeNull();

    const suspenseBefore = await accountBalance("COD_DISCREPANCY");
    const resolved = await remittancesSvc.resolveRemittance(financeActor, remittance.id, {
      resolution: "ACCEPTED_COUNTED",
      note: "Rider reported a short count at handover; accepted counted cash, shortfall on record.",
    });
    expect(resolved.status).toBe("CLOSED");
    expect(resolved.resolution).toBe("ACCEPTED_COUNTED");
    await expectBalanced(remittance.remittanceNumber);
    await expectBalanced(`${remittance.remittanceNumber}:SHORTFALL`);

    const line = await prisma.codRemittanceLine.findUniqueOrThrow({
      where: { codCollectionId: delivered.collectionId },
    });
    expect(line.verifiedPaisa).toBe(counted);

    // The rider still owes the Rs 500 shortfall; the suspense
    // account carries it; the package is NOT marked remitted.
    const position = await remittancesSvc.getRiderCodPosition(riderAActor);
    expect(BigInt(position.ledgerOwedPaisa)).toBe(cod - counted);
    // Company-level suspense account: assert the delta (bla_test is
    // shared across suite runs).
    expect((await accountBalance("COD_DISCREPANCY")) - suspenseBefore).toBe(cod - counted);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: delivered.packageId } });
    expect(pkg.paymentStatus).toBe("COD_COLLECTED");

    fx.collectionCod2 = delivered.collectionId;
  });

  it("makes a second remittance of the same collection impossible", async () => {
    await expect(
      remittancesSvc.submitRemittance(riderAActor, {
        collectionIds: [fx.collectionCod1],
        declaredAmountPaisa: "500000",
        method: "CASH",
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    // Rider B cannot remit rider A's collections either.
    await expect(
      remittancesSvc.submitRemittance(riderBActor, {
        collectionIds: [fx.collectionCod2],
        declaredAmountPaisa: "500000",
        method: "CASH",
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("pays a vendor settlement matching the hand-computed fixture (COD − charges − deduction)", async () => {
    const cod = BigInt(1000000); // Rs 10,000.00
    const deduction = BigInt(25000); // Rs 250.00
    const delivered = await deliverCod(fx.vendorSettle, cod.toString(), fx.riderAUser, riderAActor);
    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: delivered.shipmentId } });
    const charges = shipment.shippingChargePaisa;

    const invoice = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId: fx.vendorSettle });
    expect(invoice).not.toBeNull();
    expect(BigInt(invoice!.totalPaisa)).toBe(charges);

    const remittance = await remittancesSvc.submitRemittance(riderAActor, {
      collectionIds: [delivered.collectionId],
      declaredAmountPaisa: cod.toString(),
      method: "CASH",
    });
    await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
      countedAmountPaisa: cod.toString(),
    });

    const prepared = await settlementsSvc.prepareSettlement(financeActor, {
      vendorId: fx.vendorSettle,
      deductions: [{ amountPaisa: deduction.toString(), description: "Damaged-goods handling fee" }],
    });
    expect(BigInt(prepared.grossCodPaisa)).toBe(cod);
    expect(BigInt(prepared.shippingChargesPaisa)).toBe(charges);
    expect(BigInt(prepared.otherDeductionsPaisa)).toBe(deduction);
    const expectedNet = cod - charges - deduction;
    expect(BigInt(prepared.netPayablePaisa)).toBe(expectedNet);

    const detail = await settlementsSvc.getSettlement(financeActor, prepared.id);
    expect(detail.lines.filter((l) => l.kind === "COD_CREDIT")).toHaveLength(1);
    expect(detail.lines.filter((l) => l.kind === "SHIPPING_CHARGE")).toHaveLength(1);
    expect(detail.lines.filter((l) => l.kind === "DEDUCTION")).toHaveLength(1);

    // Finance prepares/pays but cannot approve; admin approves.
    await expect(settlementsSvc.approveSettlement(financeActor, prepared.id)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    const approved = await settlementsSvc.approveSettlement(adminActor, prepared.id);
    expect(approved.status).toBe("APPROVED");

    const paid = await settlementsSvc.paySettlement(financeActor, prepared.id, {
      method: "BANK_TRANSFER",
      transactionRef: `P7-SETTLE-${RUN}`,
    });
    expect(paid.status).toBe("SETTLED");
    const sums = await expectBalanced(prepared.settlementNumber);
    expect(sums.debits).toBe(expectedNet + deduction);

    const invoiceAfter = await invoicesSvc.getInvoice(financeActor, invoice!.id);
    expect(invoiceAfter.status).toBe("PAID");
    expect(BigInt(invoiceAfter.settlementCoveragePaisa)).toBe(charges);

    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: delivered.packageId } });
    expect(pkg.paymentStatus).toBe("COD_SETTLED");

    // The vendor's payable position returns to exactly zero.
    expect(await accountBalance(`VENDOR_PAYABLE:${fx.vendorSettle}`)).toBe(BigInt(0));
    const statement = await settlementsSvc.getVendorStatement(financeActor, fx.vendorSettle);
    expect(BigInt(statement.unsettledVerifiedCodPaisa)).toBe(BigInt(0));
  });

  it("voids an invoice only via compensating reversal entries, originals intact", async () => {
    const parcel = await deliverCod(fx.vendorB, "0", fx.riderAUser, riderAActor);
    void parcel;
    const invoice = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId: fx.vendorB });
    expect(invoice).not.toBeNull();
    const original = await journalSums(invoice!.invoiceNumber);
    expect(original.count).toBeGreaterThan(0);

    const voided = await invoicesSvc.voidInvoice(financeActor, invoice!.id, {
      reason: "Generated against the wrong billing period",
    });
    expect(voided.status).toBe("CANCELLED");

    // Originals untouched; the reversal journal mirrors them exactly.
    const after = await journalSums(invoice!.invoiceNumber);
    expect(after.count).toBe(original.count);
    expect(after.debits).toBe(original.debits);
    const reversal = await expectBalanced(`REV:${invoice!.invoiceNumber}`);
    expect(reversal.debits).toBe(original.debits);
    const reversalRows = await prisma.ledgerTransaction.findMany({
      where: { journalRef: `REV:${invoice!.invoiceNumber}` },
    });
    expect(reversalRows.every((r) => r.reversalOfId !== null && r.type === "REVERSAL")).toBe(true);

    // The vendor payable accrual is fully unwound.
    const payableEntries = await prisma.ledgerTransaction.findMany({
      where: { invoiceId: invoice!.id },
    });
    const net = payableEntries.reduce(
      (s, e) => s + (e.direction === "DEBIT" ? e.amountPaisa : -e.amountPaisa),
      BigInt(0),
    );
    expect(net).toBe(BigInt(0));
  });

  it("enforces ledger and payment immutability at the database level", async () => {
    const entry = await prisma.ledgerTransaction.findFirstOrThrow({
      orderBy: { createdAt: "asc" },
    });
    await expect(
      prisma.$executeRaw`UPDATE "app"."LedgerTransaction" SET "amountPaisa" = 1 WHERE "id" = ${entry.id}`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`DELETE FROM "app"."LedgerTransaction" WHERE "id" = ${entry.id}`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`UPDATE "app"."Payment" SET "amountPaisa" = 1 WHERE "id" = ${fx.paymentB1}`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`DELETE FROM "app"."Payment" WHERE "id" = ${fx.paymentB1}`,
    ).rejects.toThrow();
  });

  it("processes a refund through four-eyes approval, re-deriving payment and invoice status", async () => {
    const total = BigInt(fx.invoiceB1Total);
    const refundAmount = total / BigInt(4);
    const refund = await adjustmentsSvc.requestRefund(financeActor, {
      paymentId: fx.paymentB1,
      amountPaisa: refundAmount.toString(),
      reason: "Vendor overcharged on a duplicate booking",
    });
    expect(refund.status).toBe("REQUESTED");
    // The requester cannot approve their own refund.
    await expect(adjustmentsSvc.approveRefund(financeActor, refund.id)).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
    const approved = await adjustmentsSvc.approveRefund(superAdminActor, refund.id);
    expect(approved.status).toBe("APPROVED");
    const processed = await adjustmentsSvc.processRefund(financeActor, refund.id);
    expect(processed.status).toBe("PROCESSED");
    await expectBalanced(`REF-${refund.id}`);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fx.paymentB1 } });
    expect(payment.status).toBe("PARTIALLY_REFUNDED");
    expect(payment.amountPaisa).toBe(total); // original amount never edited
    const detail = await invoicesSvc.getInvoice(financeActor, fx.invoiceB1);
    expect(detail.status).toBe("PARTIALLY_PAID");
    expect(BigInt(detail.paidPaisa)).toBe(total - refundAmount);
  });

  it("applies an invoice credit note only with a different approver (four-eyes)", async () => {
    // A fresh payable invoice for vendor B.
    await deliverCod(fx.vendorB, "0", fx.riderAUser, riderAActor);
    const invoice = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId: fx.vendorB });
    expect(invoice).not.toBeNull();
    const credit = BigInt(invoice!.totalPaisa) / BigInt(2);

    const adjustment = await adjustmentsSvc.createAdjustment(financeActor, {
      targetType: "INVOICE",
      targetId: invoice!.id,
      amountPaisa: credit.toString(),
      reason: "Goodwill credit for a delayed delivery",
    });
    expect(adjustment.status).toBe("REQUESTED");
    // Finance cannot approve adjustments at all (catalog grant).
    await expect(adjustmentsSvc.approveAdjustment(financeActor, adjustment.id)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    const applied = await adjustmentsSvc.approveAdjustment(superAdminActor, adjustment.id);
    expect(applied.status).toBe("APPLIED");
    await expectBalanced(`ADJ-${adjustment.id}`);

    const detail = await invoicesSvc.getInvoice(financeActor, invoice!.id);
    expect(BigInt(detail.adjustmentCreditsPaisa)).toBe(credit);
    expect(detail.status).toBe("PARTIALLY_PAID");

    // Four-eyes: the super admin cannot approve their own adjustment.
    const own = await adjustmentsSvc.createAdjustment(superAdminActor, {
      targetType: "INVOICE",
      targetId: invoice!.id,
      amountPaisa: "100",
      reason: "Self-approval probe",
    });
    await expect(adjustmentsSvc.approveAdjustment(superAdminActor, own.id)).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
  });

  it("derives OVERDUE at read time from dueAt without storing it", async () => {
    await deliverCod(fx.vendorCod, "0", fx.riderAUser, riderAActor);
    const invoice = await invoicesSvc.generateVendorInvoice(financeActor, {
      vendorId: fx.vendorCod,
      dueInDays: 0,
    });
    expect(invoice).not.toBeNull();
    await prisma.invoice.update({
      where: { id: invoice!.id },
      data: { dueAt: new Date(Date.now() - 60 * 1000) },
    });
    const detail = await invoicesSvc.getInvoice(financeActor, invoice!.id);
    expect(detail.status).toBe("OVERDUE");
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice!.id } });
    expect(row.status).toBe("ISSUED");
  });

  it("keeps vendor B's billing fully isolated from vendor A (audited denials)", async () => {
    const list = await invoicesSvc.listInvoices(vendorBActor, {});
    expect(list.items.every((i) => i.vendorId === fx.vendorB)).toBe(true);
    expect(list.items.some((i) => i.id === fx.invoiceA)).toBe(false);

    await expect(invoicesSvc.getInvoice(vendorBActor, fx.invoiceA)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    const denied = await prisma.auditLog.findFirst({
      where: {
        action: "access.denied",
        actorId: fx.vendorBOwner,
        entityType: "Invoice",
        entityId: fx.invoiceA,
      },
    });
    expect(denied).not.toBeNull();

    const settlements = await settlementsSvc.listSettlements(vendorBActor, {});
    expect(settlements.items.every((s) => s.vendorId === fx.vendorB)).toBe(true);
    await expect(
      settlementsSvc.getVendorStatement(vendorBActor, fx.vendorA),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("keeps riders isolated to their own COD obligations", async () => {
    const listB = await remittancesSvc.listRemittances(riderBActor, {});
    expect(listB.items).toHaveLength(0);
    await expect(
      remittancesSvc.getRiderCodPosition(riderBActor, fx.riderAProfile),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const positionB = await remittancesSvc.getRiderCodPosition(riderBActor);
    expect(BigInt(positionB.awaitingRemittanceTotalPaisa)).toBe(BigInt(0));
  });
});
