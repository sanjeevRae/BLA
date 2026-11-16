import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 2 (V2) finance hardening integration tests against the
 * local bla_test database.
 *
 * Covered:
 *  - C2: the DB deferred constraint trigger
 *    "LedgerTransaction_journal_balanced" rejects any commit that
 *    leaves a journalRef with ΣDEBIT ≠ ΣCREDIT — including direct
 *    LedgerTransaction inserts that bypass postJournal, and a
 *    single unbalanced leg appended to an existing balanced ref.
 *  - C3: Payment.requestFingerprint — an idempotency key replayed
 *    with the identical payload returns the original payment; the
 *    same key with a different amount / allocations /
 *    transactionRef is a ConflictError. Concurrent identical
 *    replays collapse to exactly one payment; concurrent
 *    different-payload submissions under one key let exactly one
 *    payment through.
 *  - COD business rule: a COD obligation can never be settled
 *    beyond its outstanding (collected) amount — verify/resolve
 *    cap verifiedPaisa per line at collectedPaisa (Σ verified ≤
 *    Σ collected even when Finance counts MORE than was
 *    collected), and a collection can never be remitted twice.
 *
 * Harness mirrors tests/integration/finance.test.ts: catalog sync
 * in beforeAll, RUN-unique fixtures (prefix "P2B"), shared fixture
 * warehouses WH-QB2-*. Invoice/payment fixtures for the C3 tests
 * are direct ISSUED invoices (payable fixtures with exact paisa
 * totals); the COD tests use the full delivery journey helpers
 * copied from finance.test.ts.
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
const email = (label: string) => `p2b-${label}-${RUN}@bla.test`;
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
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let financeDomain: typeof import("@/lib/finance/domain");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let financeActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
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
      fullName: `P2B ${label}`,
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
    businessName: `P2B Vendor ${label} ${RUN}`,
    contactName: "P2B Contact",
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
    sender: { name: "P2B Sender", phone: phone(42), email: null },
    recipient: {
      name: "P2B Recipient",
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
    idempotencyKey: `p2b-load-${RUN}-${trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(linehaulActor, tripId);
  await tripsSvc.arriveTrip(linehaulActor, tripId);
  const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
    trackingId,
    idempotencyKey: `p2b-unload-${RUN}-${trackingId}`,
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
 * COD amount (MATCHED). Mirrors finance.test.ts. */
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
    receivedByName: "P2B Recipient",
    relationshipToRecipient: "Self",
    otpCode: await recipientOtp(added.added[0].id),
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

/** Direct ISSUED invoice fixture with an exact paisa total — a
 * payable invoice for the C3 payment tests without a delivery
 * journey (the COD tests below use real journeys). */
let invoiceSeq = 0;
async function makePayableInvoice(vendorId: string, totalPaisa: bigint) {
  invoiceSeq += 1;
  const invoiceNumber = `INV-P2B-${RUN}-${invoiceSeq}`;
  const invoice = await prisma.invoice.create({
    data: {
      invoiceNumber,
      vendorId,
      subtotalPaisa: totalPaisa,
      discountPaisa: BigInt(0),
      taxPaisa: BigInt(0),
      totalPaisa,
      status: "ISSUED",
      dueAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      issuedById: fx.adminUser,
    },
  });
  return { id: invoice.id, invoiceNumber, totalPaisa: totalPaisa.toString() };
}

let legSeq = 0;
/** One direct LedgerTransaction leg (bypasses postJournal). */
function directLeg(
  journalRef: string,
  accountId: string,
  direction: "DEBIT" | "CREDIT",
  amountPaisa: bigint,
) {
  legSeq += 1;
  return {
    reference: `TXN-P2B-${RUN}-${legSeq}`,
    journalRef,
    accountId,
    direction,
    amountPaisa,
    type: "PAYMENT_RECEIVED",
    occurredAt: new Date(),
    actorId: fx.adminUser,
  };
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

  // Chart of accounts (same upserts as the seed).
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

  fx.districtA = "P2BAlpha District";
  fx.districtB = "P2BBeta District";
  const a = await ensureWarehouse("WH-QB2-01", "P2B Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  const b = await ensureWarehouse("WH-QB2-02", "P2B Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;

  serviceCode = `P2BSTD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P2B Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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

  const vendorPay = await makeVendor("PAY");
  fx.vendorPay = vendorPay.vendorId;
  const vendorCod = await makeVendor("COD");
  fx.vendorCod = vendorCod.vendorId;

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
    licenseNumber: `LIC-P2B-LH-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.linehaulProfile = linehaul.id;
  linehaulActor = await actorFor(fx.linehaulUser);
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P2B TRK ${RUN.slice(-6)}`.toUpperCase(),
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
      licenseNumber: `LIC-P2B-${label}-${RUN}`,
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

// Journey-heavy integration tests: the COD journeys run ~25
// service calls each — allow a generous per-test ceiling.
describe("Phase 2 finance hardening", { timeout: 180000 }, () => {
  // -----------------------------------------------------------------
  // C2 — journal-balance deferred constraint trigger
  // -----------------------------------------------------------------

  it("C2: rejects an unbalanced direct journal insert at commit and leaves no rows", async () => {
    const account = await prisma.financialAccount.findUniqueOrThrow({
      where: { code: "CASH_ON_HAND" },
    });
    const journalRef = `P2B-UNBAL-${RUN}`;
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.ledgerTransaction.create({
          data: directLeg(journalRef, account.id, "DEBIT", BigInt(100000)),
        });
        await tx.ledgerTransaction.create({
          data: directLeg(journalRef, account.id, "CREDIT", BigInt(99999)),
        });
      }),
    ).rejects.toThrow();
    const rows = await prisma.ledgerTransaction.findMany({ where: { journalRef } });
    expect(rows).toHaveLength(0);
  });

  it("C2: commits a balanced direct journal insert", async () => {
    const cash = await prisma.financialAccount.findUniqueOrThrow({
      where: { code: "CASH_ON_HAND" },
    });
    const bank = await prisma.financialAccount.findUniqueOrThrow({ where: { code: "BANK" } });
    const journalRef = `P2B-BAL-${RUN}`;
    await prisma.$transaction(async (tx) => {
      await tx.ledgerTransaction.create({
        data: directLeg(journalRef, cash.id, "DEBIT", BigInt(42000)),
      });
      await tx.ledgerTransaction.create({
        data: directLeg(journalRef, bank.id, "CREDIT", BigInt(42000)),
      });
    });
    const sums = await journalSums(journalRef);
    expect(sums.count).toBe(2);
    expect(sums.debits).toBe(BigInt(42000));
    expect(sums.credits).toBe(BigInt(42000));
    fx.balancedJournalRef = journalRef;
    fx.balancedAccountId = cash.id;
  });

  it("C2: rejects appending one unbalanced leg to an existing balanced journalRef", async () => {
    const journalRef = fx.balancedJournalRef;
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.ledgerTransaction.create({
          data: directLeg(journalRef, fx.balancedAccountId, "DEBIT", BigInt(1)),
        });
      }),
    ).rejects.toThrow();
    // The original balanced journal is untouched.
    const sums = await journalSums(journalRef);
    expect(sums.count).toBe(2);
    expect(sums.debits).toBe(sums.credits);
  });

  // -----------------------------------------------------------------
  // C3 — payment idempotency fingerprint
  // -----------------------------------------------------------------

  it("C3: identical replay returns the original; a different payload under the same key conflicts", async () => {
    const inv1 = await makePayableInvoice(fx.vendorPay, BigInt(1000000));
    const inv2 = await makePayableInvoice(fx.vendorPay, BigInt(1000000));
    const key = `p2b-fp-${RUN}`;
    const payload = {
      amountPaisa: "200000",
      method: "BANK_TRANSFER" as const,
      transactionRef: `P2B-REF-${RUN}`,
      idempotencyKey: key,
      allocations: [{ invoiceId: inv1.id, amountPaisa: "120000" }],
    };

    const first = await invoicesSvc.recordPayment(financeActor, payload);
    const stored = await prisma.payment.findUniqueOrThrow({ where: { id: first.id } });
    expect(stored.requestFingerprint).not.toBeNull();
    expect(stored.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    const journalBefore = await journalSums(`PAY-${first.id}`);
    expect(journalBefore.count).toBe(2);
    expect(journalBefore.debits).toBe(BigInt(200000));

    // Identical replay: same payment, no second row, no second journal.
    const replay = await invoicesSvc.recordPayment(financeActor, { ...payload });
    expect(replay.id).toBe(first.id);
    expect(await prisma.payment.count({ where: { idempotencyKey: key } })).toBe(1);
    const journalAfter = await journalSums(`PAY-${first.id}`);
    expect(journalAfter.count).toBe(journalBefore.count);

    // Same key + different amount → ConflictError.
    await expect(
      invoicesSvc.recordPayment(financeActor, { ...payload, amountPaisa: "210000" }),
    ).rejects.toBeInstanceOf(errors.ConflictError);

    // Same key + different allocations → ConflictError.
    await expect(
      invoicesSvc.recordPayment(financeActor, {
        ...payload,
        allocations: [{ invoiceId: inv2.id, amountPaisa: "120000" }],
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);

    // Same key + different transactionRef → ConflictError.
    await expect(
      invoicesSvc.recordPayment(financeActor, {
        ...payload,
        transactionRef: `P2B-REF-OTHER-${RUN}`,
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);

    // None of the conflicting attempts created anything.
    expect(await prisma.payment.count({ where: { idempotencyKey: key } })).toBe(1);
    const detail = await invoicesSvc.getInvoice(financeActor, inv1.id);
    expect(BigInt(detail.paidPaisa)).toBe(BigInt(120000));
  });

  it("C3 concurrency: N=4 identical simultaneous payments collapse to exactly one payment", async () => {
    const inv = await makePayableInvoice(fx.vendorPay, BigInt(1000000));
    const key = `p2b-conc-same-${RUN}`;
    const payload = {
      amountPaisa: "150000",
      method: "CASH" as const,
      idempotencyKey: key,
      allocations: [{ invoiceId: inv.id, amountPaisa: "150000" }],
    };
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => invoicesSvc.recordPayment(financeActor, { ...payload })),
    );
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof invoicesSvc.recordPayment>>> =>
        r.status === "fulfilled",
    );
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(fulfilled.map((r) => r.value.id));
    expect(ids.size).toBe(1);
    expect(await prisma.payment.count({ where: { idempotencyKey: key } })).toBe(1);
    const onlyId = [...ids][0]!;
    const journal = await journalSums(`PAY-${onlyId}`);
    expect(journal.count).toBe(2);
    expect(journal.debits).toBe(BigInt(150000));
    // The invoice's paid total reflects exactly one payment.
    const detail = await invoicesSvc.getInvoice(financeActor, inv.id);
    expect(BigInt(detail.paidPaisa)).toBe(BigInt(150000));
  });

  it("C3 concurrency: N=3 simultaneous different amounts under one key — exactly one succeeds", async () => {
    const inv = await makePayableInvoice(fx.vendorPay, BigInt(1000000));
    const key = `p2b-conc-diff-${RUN}`;
    const amounts = ["100000", "110000", "120000"];
    const results = await Promise.allSettled(
      amounts.map((amountPaisa) =>
        invoicesSvc.recordPayment(financeActor, {
          amountPaisa,
          method: "CASH" as const,
          idempotencyKey: key,
          allocations: [{ invoiceId: inv.id, amountPaisa }],
        }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      if (r.status !== "rejected") continue;
      expect(
        r.reason instanceof errors.ConflictError ||
          r.reason instanceof errors.DomainValidationError,
      ).toBe(true);
    }
    expect(await prisma.payment.count({ where: { idempotencyKey: key } })).toBe(1);
    const winner = await prisma.payment.findUniqueOrThrow({ where: { idempotencyKey: key } });
    const detail = await invoicesSvc.getInvoice(financeActor, inv.id);
    expect(BigInt(detail.paidPaisa)).toBe(winner.amountPaisa);
  });

  // -----------------------------------------------------------------
  // COD — over-settlement is impossible
  // -----------------------------------------------------------------

  it("COD: counted MORE than collected still settles at most the collected amount (surplus capped)", async () => {
    const cod = BigInt(400000);
    const counted = BigInt(475000); // Finance counts Rs 750 MORE than collected.
    const delivered = await deliverCod(fx.vendorCod, cod.toString(), fx.riderAUser, riderAActor);
    const remittance = await remittancesSvc.submitRemittance(riderAActor, {
      collectionIds: [delivered.collectionId],
      declaredAmountPaisa: cod.toString(),
      method: "CASH",
    });

    const parked = await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
      countedAmountPaisa: counted.toString(),
    });
    expect(parked.status).toBe("DISCREPANCY");

    const resolved = await remittancesSvc.resolveRemittance(financeActor, remittance.id, {
      resolution: "ACCEPTED_COUNTED",
      note: "Counted more than the recorded collection; surplus parked for investigation.",
    });
    expect(resolved.status).toBe("CLOSED");
    expect(resolved.resolution).toBe("ACCEPTED_COUNTED");

    // The enforcement point: verifiedPaisa per line is capped at
    // collectedPaisa, so Σ verified ≤ Σ collected despite counted > collected.
    const lines = await prisma.codRemittanceLine.findMany({ where: { remittanceId: remittance.id } });
    expect(lines).toHaveLength(1);
    for (const line of lines) {
      expect(line.verifiedPaisa).not.toBeNull();
      expect(line.verifiedPaisa! <= line.collectedPaisa).toBe(true);
    }
    const sumVerified = lines.reduce((s, l) => s + (l.verifiedPaisa ?? BigInt(0)), BigInt(0));
    const sumCollected = lines.reduce((s, l) => s + l.collectedPaisa, BigInt(0));
    expect(sumCollected).toBe(cod);
    expect(sumVerified).toBe(cod);
    expect(sumVerified <= sumCollected).toBe(true);
    expect(sumVerified < counted).toBe(true);

    // The surplus is parked in its own balanced journal, NOT
    // settled against the rider's obligation.
    const surplus = await journalSums(`${remittance.remittanceNumber}:SURPLUS`);
    expect(surplus.count).toBeGreaterThan(0);
    expect(surplus.debits).toBe(surplus.credits);
    expect(surplus.debits).toBe(counted - cod);

    const position = await remittancesSvc.getRiderCodPosition(riderAActor);
    expect(BigInt(position.verifiedRemittedPaisa)).toBeGreaterThanOrEqual(cod);

    // A second remittance over the same collection is impossible.
    await expect(
      remittancesSvc.submitRemittance(riderAActor, {
        collectionIds: [delivered.collectionId],
        declaredAmountPaisa: cod.toString(),
        method: "CASH",
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  });

  it("COD: a short count settles only the counted amount, and a collection cannot be remitted twice", async () => {
    const cod = BigInt(500000);
    const counted = BigInt(450000);
    const delivered = await deliverCod(fx.vendorCod, cod.toString(), fx.riderAUser, riderAActor);
    const remittance = await remittancesSvc.submitRemittance(riderAActor, {
      collectionIds: [delivered.collectionId],
      declaredAmountPaisa: cod.toString(),
      method: "CASH",
    });
    expect(remittance.status).toBe("SUBMITTED");

    // While the first remittance is still open, a second
    // remittance over the same collection is impossible.
    await expect(
      remittancesSvc.submitRemittance(riderAActor, {
        collectionIds: [delivered.collectionId],
        declaredAmountPaisa: cod.toString(),
        method: "CASH",
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    // Rider B cannot remit rider A's collection either.
    await expect(
      remittancesSvc.submitRemittance(riderBActor, {
        collectionIds: [delivered.collectionId],
        declaredAmountPaisa: cod.toString(),
        method: "CASH",
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    const parked = await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
      countedAmountPaisa: counted.toString(),
    });
    expect(parked.status).toBe("DISCREPANCY");

    const resolved = await remittancesSvc.resolveRemittance(financeActor, remittance.id, {
      resolution: "ACCEPTED_COUNTED",
      note: "Short count accepted; shortfall stays on the rider's record.",
    });
    expect(resolved.status).toBe("CLOSED");

    const line = await prisma.codRemittanceLine.findUniqueOrThrow({
      where: { codCollectionId: delivered.collectionId },
    });
    expect(line.collectedPaisa).toBe(cod);
    expect(line.verifiedPaisa).toBe(counted);
    expect(line.verifiedPaisa! <= line.collectedPaisa).toBe(true);

    // The rider still owes the shortfall — the obligation was
    // settled only up to the counted (verified) amount.
    const position = await remittancesSvc.getRiderCodPosition(riderAActor);
    expect(BigInt(position.ledgerOwedPaisa)).toBeGreaterThanOrEqual(cod - counted);
  });
});
