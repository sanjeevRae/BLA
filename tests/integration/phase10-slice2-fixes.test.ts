import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 10 slice 2 — low-severity queue fix regressions. Each test
 * re-runs the finding it closes:
 *
 *  P3-5  a merged-away customer record still resolves the portal
 *        actor to the surviving (winner) customer.
 *  P3-6  rejectBooking is atomic: order + packages + audits land
 *        together in the rejected end-state.
 *  P3-7a an idempotency key replayed against a DIFFERENT package is
 *        a clean ConflictError, not a raw P2002.
 *  P3-10 updateCustomer onto another customer's phone is a
 *        ConflictError, not a 500.
 *  P3-11 the pricing band is selected on billable weight (fixed
 *        point), not declared weight.
 *  P4-4  repeat misroute scans at one warehouse record ONE
 *        observation, not a stack.
 *  P4-5  transitionPackageInTx rejections are audit-logged even
 *        though the caller's transaction rolls back.
 *  P4-6  the capacity gate holds inside the intake transaction.
 *  P4-7  moveInternal refuses a non-damaged package into the
 *        DAMAGED zone (putAway parity).
 *  P4-8  supplies: reason mandatory for ADJUSTMENT /
 *        DAMAGE_WRITE_OFF; quantities and on-hand bounded.
 *  P5-7  listAssignableDrivers is warehouse-scoped for scoped
 *        actors and returns a slim, PII-free picker view.
 *  P5-8  driver profiles require a driver role and a non-expired
 *        licence; impossible calendar dates fail validation in the
 *        driver and vehicle schemas.
 *  F8    concurrent recordPayment with one idempotency key returns
 *        the SAME payment to both callers (one row).
 *  F9    concurrent voidInvoice: one reversal, the loser gets the
 *        clean already-reversed error; reversal legs store the
 *        reason.
 *  F10   the payment immutability trigger also guards
 *        invoiceId/orderId.
 *  F12a  submitRemittance validates the handover warehouse
 *        (exists, ACTIVE, plausible for this rider).
 *  F12b  submitRemittance honours an idempotency key (replay
 *        returns the original; journals post once).
 *  F12d  accept-counted SURPLUS is parked in the COD_DISCREPANCY
 *        suspense account, not dropped.
 *  F12e  a processed refund marks PaymentAllocation.refundedPaisa
 *        and keeps the original allocation row intact; invoice
 *        paid derivation nets the refund.
 *
 * Fixture warehouses are shared across runs (WH-ZS2 codes,
 * find-or-create); users/vendors/bookings are per-run unique. The
 * journey helpers mirror tests/integration/phase7-finance-fixes.
 */

const mockSession = vi.hoisted(() => ({ userId: "" as string }));
vi.mock("@/auth", () => ({
  auth: async () => (mockSession.userId ? { user: { id: mockSession.userId } } : null),
}));

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
const email = (label: string) => `p10s2-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);
const RECIPIENT_PHONE = phone(101);
const TODAY = new Date().toISOString().slice(0, 10);

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let customersSvc: typeof import("@/server/services/customers");
let inventorySvc: typeof import("@/server/services/inventory");
let lifecycleSvc: typeof import("@/server/services/package-lifecycle");
let transfersSvc: typeof import("@/server/services/transfers");
let tripsSvc: typeof import("@/server/services/trips");
let driversSvc: typeof import("@/server/services/drivers");
let vehiclesSvc: typeof import("@/server/services/vehicles");
let deliveriesSvc: typeof import("@/server/services/deliveries");
let invoicesSvc: typeof import("@/server/services/invoices");
let remittancesSvc: typeof import("@/server/services/cod-remittances");
let adjustmentsSvc: typeof import("@/server/services/finance-adjustments");
let suppliesSvc: typeof import("@/server/services/supplies");
let permissionsLib: typeof import("@/lib/auth/permissions");
let errors: typeof import("@/lib/errors");
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
let serviceCode: string;
let bandedServiceCode: string;
let bandedHighRuleId: string;

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
      fullName: `P10S2 ${label}`,
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
  { code: "ZONE-SRT", name: "Sorting", kind: "SORTING" },
  { code: "ZONE-STO", name: "Storage", kind: "STORAGE" },
  { code: "ZONE-DSP", name: "Dispatch", kind: "DISPATCH" },
  { code: "ZONE-DMG", name: "Damaged / Quarantine", kind: "DAMAGED" },
  { code: "ZONE-RET", name: "Returns", kind: "RETURNS" },
] as const;

async function ensureWarehouse(
  code: string,
  name: string,
  district: string,
  capacityPackages?: number,
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
        capacityPackages: capacityPackages ?? null,
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

async function makeVendor(label: string): Promise<{ vendorId: string; ownerUserId: string }> {
  const vendor = await vendorsSvc.createVendor(adminActor, {
    businessName: `P10S2 Vendor ${label} ${RUN}`,
    contactName: "P10S2 Contact",
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
  opts: {
    codAmountPaisa?: string;
    svcCode?: string;
    actor?: Awaited<ReturnType<typeof actorFor>>;
    originWarehouseId?: string;
    items?: { description: string; quantity: number; weightKg: number; lengthCm?: number; widthCm?: number; heightCm?: number }[];
  } = {},
): Promise<{ packageId: string; trackingId: string; shipmentId: string; orderId: string }> {
  const booking = await bookingsSvc.createBooking(opts.actor ?? adminActor, {
    vendorId,
    sender: { name: "P10S2 Sender", phone: phone(42), email: null },
    recipient: {
      name: "P10S2 Recipient",
      phone: RECIPIENT_PHONE,
      addressLine: "Lakeside Street 1",
      city: "Town",
      district: fx.districtB,
      province: "Bagmati",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: opts.originWarehouseId ?? fx.whA },
    shippingServiceCode: opts.svcCode ?? serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: opts.codAmountPaisa ?? "0",
    items: opts.items ?? [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
  });
  const shipment = booking.shipments[0];
  const pkg = shipment.packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId, shipmentId: shipment.id, orderId: booking.id };
}

/** Book at A → full transfer chain → RECEIVED_AT_DESTINATION at B. */
async function atDestination(vendorId: string, codAmountPaisa = "0") {
  const { packageId, trackingId, shipmentId } = await bookOne(vendorId, { codAmountPaisa });
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
    idempotencyKey: `p10s2-load-${RUN}-${trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(linehaulActor, tripId);
  await tripsSvc.arriveTrip(linehaulActor, tripId);
  const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
    trackingId,
    idempotencyKey: `p10s2-unload-${RUN}-${trackingId}`,
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
 * COD amount (MATCHED). */
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
    receivedByName: "P10S2 Recipient",
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

async function makeRider(label: string, homeWarehouseId: string) {
  const userId = await makeUser(label, "RIDER");
  const profile = await driversSvc.createDriverProfile(adminActor, {
    userId,
    homeWarehouseId,
    licenseNumber: `LIC-P10S2-${label}-${RUN}`.toUpperCase(),
    licenseCategory: "A",
    licenseExpiry: "2030-01-01",
    capabilities: ["DELIVERY"],
  });
  const actor = await actorFor(userId);
  return { userId, profileId: profile.id, actor };
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
  customersSvc = await import("@/server/services/customers");
  inventorySvc = await import("@/server/services/inventory");
  lifecycleSvc = await import("@/server/services/package-lifecycle");
  transfersSvc = await import("@/server/services/transfers");
  tripsSvc = await import("@/server/services/trips");
  driversSvc = await import("@/server/services/drivers");
  vehiclesSvc = await import("@/server/services/vehicles");
  deliveriesSvc = await import("@/server/services/deliveries");
  invoicesSvc = await import("@/server/services/invoices");
  remittancesSvc = await import("@/server/services/cod-remittances");
  adjustmentsSvc = await import("@/server/services/finance-adjustments");
  suppliesSvc = await import("@/server/services/supplies");
  permissionsLib = await import("@/lib/auth/permissions");
  errors = await import("@/lib/errors");
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

  fx.districtA = "ZS2 Alpha District";
  fx.districtB = "ZS2 Beta District";
  fx.districtC = "ZS2 Gamma District";
  const a = await ensureWarehouse("WH-ZS2-01", "ZS2 Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  fx.locDmgA = a.locations.DAMAGED;
  const b = await ensureWarehouse("WH-ZS2-02", "ZS2 Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;
  const c = await ensureWarehouse("WH-ZS2-03", "ZS2 Gamma (capacity fixture)", fx.districtC, 1);
  fx.whC = c.id;

  serviceCode = `S2STD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P10S2 Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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

  // Banded tariff for P3-11: the declared weight (1 kg) sits in the
  // LOW band (divisor 5000 → volumetric 25 kg); the billable weight
  // belongs to the HIGH band (divisor 1000 → volumetric 125 kg).
  bandedServiceCode = `S2BND${RUN.slice(-5)}`.toUpperCase();
  const banded = await prisma.shippingService.create({
    data: { code: bandedServiceCode, name: "P10S2 Banded (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
  });
  await prisma.pricingRule.create({
    data: {
      shippingServiceId: banded.id,
      maxWeightKg: 5,
      baseRatePaisa: BigInt(10000),
      perKgRatePaisa: BigInt(1000),
      volumetricDivisor: 5000,
      createdById: fx.adminUser,
    },
  });
  const high = await prisma.pricingRule.create({
    data: {
      shippingServiceId: banded.id,
      minWeightKg: 5,
      baseRatePaisa: BigInt(20000),
      perKgRatePaisa: BigInt(2000),
      volumetricDivisor: 1000,
      createdById: fx.adminUser,
    },
  });
  bandedHighRuleId = high.id;

  fx.waA = await makeUser("waA", "WAREHOUSE_ADMIN");
  await addMembership(fx.waA, fx.whA, "WAREHOUSE_ADMIN");
  fx.staffA = await makeUser("staffA", "WAREHOUSE_STAFF");
  await addMembership(fx.staffA, fx.whA, "WAREHOUSE_STAFF");
  fx.waB = await makeUser("waB", "WAREHOUSE_ADMIN");
  await addMembership(fx.waB, fx.whB, "WAREHOUSE_ADMIN");
  fx.staffC = await makeUser("staffC", "WAREHOUSE_STAFF");
  await addMembership(fx.staffC, fx.whC, "WAREHOUSE_STAFF");
  waAActor = await actorFor(fx.waA);
  staffAActor = await actorFor(fx.staffA);
  waBActor = await actorFor(fx.waB);

  fx.linehaulUser = await makeUser("linehaul", "LINEHAUL_DRIVER");
  const linehaul = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.linehaulUser,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P10S2-LH-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.linehaulProfile = linehaul.id;
  linehaulActor = await actorFor(fx.linehaulUser);
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `S2 TRK ${RUN.slice(-6)}`.toUpperCase(),
    type: "TRUCK",
    capacityKg: 5000,
    homeWarehouseId: fx.whA,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  fx.vehicle = vehicle.id;
});

describe("P3-5 — merged customer keeps portal access via the winner", () => {
  it("getActorContext follows mergedIntoId to the surviving customer", async () => {
    const userId = await makeUser("portalCustomer", "CUSTOMER");
    const loser = await customersSvc.createCustomer(adminActor, {
      fullName: "P10S2 Loser",
      phone: phone(201),
      email: null,
    });
    await prisma.customer.update({ where: { id: loser.id }, data: { userId } });
    const winner = await customersSvc.createCustomer(adminActor, {
      fullName: "P10S2 Winner",
      phone: phone(202),
      email: null,
    });
    await customersSvc.mergeCustomers(adminActor, winner.id, loser.id);
    const loserRow = await prisma.customer.findUniqueOrThrow({ where: { id: loser.id } });
    expect(loserRow.isMerged).toBe(true);
    expect(loserRow.mergedIntoId).toBe(winner.id);

    mockSession.userId = userId;
    try {
      const actor = await permissionsLib.getActorContext();
      expect(actor?.customerId).toBe(winner.id);
    } finally {
      mockSession.userId = "";
    }
  });
});

describe("P3-6 — rejectBooking is atomic", () => {
  it("order, packages and audits land in the rejected end-state together", async () => {
    const { vendorId, ownerUserId } = await makeVendor("reject");
    const ownerActor = await actorFor(ownerUserId);
    const booking = await bookingsSvc.createBooking(ownerActor, {
      vendorId,
      sender: { name: "P10S2 Sender", phone: phone(42), email: null },
      recipient: {
        name: "P10S2 Recipient",
        phone: RECIPIENT_PHONE,
        addressLine: "Lakeside Street 1",
        city: "Town",
        district: fx.districtB,
        province: "Bagmati",
      },
      pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: fx.whA },
      shippingServiceCode: serviceCode,
      paymentMethod: "CASH" as const,
      codAmountPaisa: "0",
      items: [{ description: "Parcel", quantity: 2, weightKg: 1.0 }],
    });
    expect(booking.approvalStatus).toBe("PENDING");
    const packageIds = booking.shipments[0].packages.map((p) => p.id);
    expect(packageIds).toHaveLength(2);

    const rejected = await bookingsSvc.rejectBooking(adminActor, booking.id, "Incomplete paperwork");
    expect(rejected.approvalStatus).toBe("REJECTED");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: booking.id } });
    expect(order.status).toBe("CANCELLED");
    const packages = await prisma.package.findMany({ where: { id: { in: packageIds } } });
    expect(packages.every((p) => p.operationalStatus === "CANCELLED")).toBe(true);
    const rejectAudits = await prisma.auditLog.count({
      where: { action: "booking.reject", entityId: booking.id },
    });
    expect(rejectAudits).toBe(1);
    const cancelAudits = await prisma.auditLog.count({
      where: { action: "package.cancel", entityId: { in: packageIds } },
    });
    expect(cancelAudits).toBe(2);
  });
});

describe("P3-7a — lifecycle idempotency keys are package-bound", () => {
  it("replaying a key against a different package is a ConflictError, not P2002", async () => {
    const { vendorId } = await makeVendor("idem");
    const first = await bookOne(vendorId);
    const second = await bookOne(vendorId);
    const key = `p10s2-idem-${RUN}`;
    await lifecycleSvc.transitionPackage(adminActor, first.packageId, "CANCELLED", {
      idempotencyKey: key,
    });
    const replay = await lifecycleSvc
      .transitionPackage(adminActor, second.packageId, "CANCELLED", { idempotencyKey: key })
      .then(() => null, (e: unknown) => e);
    expect(replay).toBeInstanceOf(errors.ConflictError);
    expect((replay as Error).message).toContain("different package");
    // The second package is untouched.
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: second.packageId } });
    expect(pkg.operationalStatus).toBe("BOOKED");
  });
});

describe("P3-10 — updateCustomer phone collision is a conflict", () => {
  it("moving customer B onto customer A's phone throws ConflictError", async () => {
    const a = await customersSvc.createCustomer(adminActor, {
      fullName: "P10S2 Cust A",
      phone: phone(301),
      email: null,
    });
    const b = await customersSvc.createCustomer(adminActor, {
      fullName: "P10S2 Cust B",
      phone: phone(302),
      email: null,
    });
    const attempt = await customersSvc
      .updateCustomer(adminActor, b.id, { phone: a.phone })
      .then(() => null, (e: unknown) => e);
    expect(attempt).toBeInstanceOf(errors.ConflictError);
    const bRow = await prisma.customer.findUniqueOrThrow({ where: { id: b.id } });
    expect(bRow.phone).toBe(b.phone);
  });
});

describe("P3-11 — pricing band resolves on billable weight", () => {
  it("a volumetric-heavy parcel is priced by the band its billable weight falls in", async () => {
    const { vendorId } = await makeVendor("banded");
    const { shipmentId } = await bookOne(vendorId, {
      svcCode: bandedServiceCode,
      items: [
        {
          description: "Bulky light parcel",
          quantity: 1,
          weightKg: 1,
          lengthCm: 50,
          widthCm: 50,
          heightCm: 50,
        },
      ],
    });
    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId } });
    // Fixed point: divisor 1000 → volumetric 125 kg → HIGH band:
    // 20000 + 2000 × 125 = 270000. The pre-fix code priced the LOW
    // band on declared weight: 10000 + 1000 × 25 = 35000.
    expect(shipment.pricingRuleId).toBe(bandedHighRuleId);
    expect(shipment.shippingChargePaisa).toBe(BigInt(270000));
    expect(Number(shipment.totalWeightKg)).toBe(125);
  });
});

describe("P4-4 — misroute observations dedupe per warehouse", () => {
  it("two scans of a misrouted parcel at the same warehouse write ONE event", async () => {
    const { vendorId } = await makeVendor("misroute");
    const { packageId, trackingId } = await bookOne(vendorId);
    const first = await inventorySvc.receivePackage(waBActor, {
      warehouseId: fx.whB,
      trackingId,
    });
    expect(first.misrouted).toBe(true);
    const second = await inventorySvc.receivePackage(waBActor, {
      warehouseId: fx.whB,
      trackingId,
    });
    expect(second.misrouted).toBe(true);
    const events = await prisma.trackingEvent.count({
      where: { packageId, eventType: "EXCEPTION_RAISED", warehouseId: fx.whB },
    });
    expect(events).toBe(1);
  });
});

describe("P4-5 — transitionPackageInTx rejections are audited", () => {
  it("the rejection audit survives the caller's rollback", async () => {
    const { vendorId } = await makeVendor("txaudit");
    const { packageId } = await bookOne(vendorId);
    const attempt = await prisma
      .$transaction(async (tx) => {
        await lifecycleSvc.transitionPackageInTx(tx, adminActor, packageId, "DELIVERED", {});
      })
      .then(() => null, (e: unknown) => e);
    expect(attempt).toBeInstanceOf(errors.ConflictError);
    const audits = await prisma.auditLog.count({
      where: { action: "package.transition_rejected", entityId: packageId },
    });
    expect(audits).toBe(1);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.operationalStatus).toBe("BOOKED");
  });
});

describe("P4-6 — capacity gate inside the intake transaction", () => {
  it("a full warehouse (capacity 1) refuses the second intake", async () => {
    // Pick a fresh capacity-1 warehouse for this run: bla_test
    // accumulates rows across runs, so a fixed warehouse would
    // already be full from the previous run's intake. Candidates
    // rotate through the full WH-ZS2-03..99 space from a random
    // start — the original fixed pool of 8 exhausted after a few
    // full-suite runs (each run fills the warehouse it picks).
    let whC: string | null = null;
    let staffC: Awaited<ReturnType<typeof actorFor>> | null = null;
    const startN = 3 + Math.floor(Math.random() * 90);
    const candidateNs: number[] = [];
    for (let k = 0; k < 97; k += 1) candidateNs.push(3 + ((startN - 3 + k) % 97));
    for (const n of candidateNs) {
      if (whC) break;
      const code = `WH-ZS2-${String(n).padStart(2, "0")}`;
      const candidate = await ensureWarehouse(
        code,
        `ZS2 Gamma ${n} (capacity fixture)`,
        `ZS2 Gamma District ${n}`,
        1,
      );
      const open = await prisma.inventoryRecord.count({
        where: { warehouseId: candidate.id, releasedAt: null },
      });
      if (open > 0) continue;
      whC = candidate.id;
      const staffId = await makeUser(`staffC${n}`, "WAREHOUSE_STAFF");
      await addMembership(staffId, candidate.id, "WAREHOUSE_STAFF");
      staffC = await actorFor(staffId);
    }
    if (!whC || !staffC) throw new Error("no empty capacity-1 warehouse available");
    const { vendorId } = await makeVendor("capacity");
    const first = await bookOne(vendorId, { originWarehouseId: whC });
    const received = await inventorySvc.receivePackage(staffC, {
      warehouseId: whC,
      trackingId: first.trackingId,
    });
    expect(received.alreadyReceived).toBe(false);
    const second = await bookOne(vendorId, { originWarehouseId: whC });
    const attempt = await inventorySvc
      .receivePackage(staffC, { warehouseId: whC, trackingId: second.trackingId })
      .then(() => null, (e: unknown) => e);
    expect(attempt).toBeInstanceOf(errors.DomainValidationError);
    expect((attempt as Error).message).toContain("full package capacity");
  });
});

describe("P4-7 — moveInternal cannot place a healthy package in the damaged zone", () => {
  it("moving a stocked, undamaged package to a DAMAGED location is refused", async () => {
    const { vendorId } = await makeVendor("moveinternal");
    const { packageId, trackingId } = await bookOne(vendorId);
    await inventorySvc.receivePackage(staffAActor, { warehouseId: fx.whA, trackingId });
    const attempt = await inventorySvc
      .moveInternal(staffAActor, { packageId, toLocationId: fx.locDmgA })
      .then(() => null, (e: unknown) => e);
    expect(attempt).toBeInstanceOf(errors.DomainValidationError);
    expect((attempt as Error).message).toContain("quarantine only");
  });
});

describe("P4-8 — supplies bounds and mandatory reasons", () => {
  it("adjustments/write-offs need reasons; quantities and on-hand are capped", async () => {
    const item = await suppliesSvc.createStockItem(adminActor, {
      warehouseId: fx.whA,
      sku: `S2-SKU-${RUN}`,
      name: "P10S2 Tape",
      unit: "PCS",
      initialQuantity: 100,
    });
    const noReasonAdj = await suppliesSvc
      .recordStockMovement(adminActor, { stockItemId: item.id, type: "ADJUSTMENT", quantity: 5 })
      .then(() => null, (e: unknown) => e);
    expect(noReasonAdj).toBeInstanceOf(errors.DomainValidationError);
    const noReasonWriteOff = await suppliesSvc
      .recordStockMovement(adminActor, { stockItemId: item.id, type: "DAMAGE_WRITE_OFF", quantity: 5 })
      .then(() => null, (e: unknown) => e);
    expect(noReasonWriteOff).toBeInstanceOf(errors.DomainValidationError);
    const huge = await suppliesSvc
      .recordStockMovement(adminActor, { stockItemId: item.id, type: "PURCHASE", quantity: 2_000_000 })
      .then(() => null, (e: unknown) => e);
    expect(huge).toBeInstanceOf(errors.DomainValidationError);
    const overCap = await suppliesSvc
      .recordStockMovement(adminActor, { stockItemId: item.id, type: "PURCHASE", quantity: 999_999 })
      .then(() => null, (e: unknown) => e);
    expect(overCap).toBeInstanceOf(errors.DomainValidationError);
    const ok = await suppliesSvc.recordStockMovement(adminActor, {
      stockItemId: item.id,
      type: "ADJUSTMENT",
      quantity: -10,
      reason: "Cycle count correction",
    });
    expect(ok.item.quantityOnHand).toBe(90);
  });
});

describe("P5-7 — assignable drivers are scoped and PII-free", () => {
  it("a warehouse-scoped actor sees only own-warehouse drivers, with a slim view", async () => {
    const bDriverUser = await makeUser("linehaulB", "LINEHAUL_DRIVER");
    const bDriver = await driversSvc.createDriverProfile(adminActor, {
      userId: bDriverUser,
      homeWarehouseId: fx.whB,
      licenseNumber: `LIC-P10S2-LHB-${RUN}`,
      licenseCategory: "C",
      licenseExpiry: "2030-01-01",
      capabilities: ["LINEHAUL"],
    });
    const scoped = await driversSvc.listAssignableDrivers(waAActor);
    const scopedIds = scoped.map((r) => r.driver.id);
    expect(scopedIds).toContain(fx.linehaulProfile);
    expect(scopedIds).not.toContain(bDriver.id);
    for (const row of scoped) {
      expect(row.driver).not.toHaveProperty("email");
      expect(row.driver).not.toHaveProperty("licenseNumber");
      expect(row.driver).not.toHaveProperty("emergencyContactPhone");
    }
    const unscoped = await driversSvc.listAssignableDrivers(adminActor);
    expect(unscoped.map((r) => r.driver.id)).toContain(bDriver.id);
  });
});

describe("P5-8 — fleet validation", () => {
  it("driver profiles require a driver role and a live licence; impossible dates fail", async () => {
    const supportUser = await makeUser("notadriver", "SUPPORT");
    const roleAttempt = await driversSvc
      .createDriverProfile(adminActor, {
        userId: supportUser,
        homeWarehouseId: fx.whA,
        licenseNumber: `LIC-P10S2-X-${RUN}`,
        licenseExpiry: "2030-01-01",
        capabilities: ["DELIVERY"],
      })
      .then(() => null, (e: unknown) => e);
    expect(roleAttempt).toBeInstanceOf(errors.DomainValidationError);

    const riderUser = await makeUser("expiredrider", "RIDER");
    const expiredAttempt = await driversSvc
      .createDriverProfile(adminActor, {
        userId: riderUser,
        homeWarehouseId: fx.whA,
        licenseNumber: `LIC-P10S2-Y-${RUN}`,
        licenseExpiry: "2020-01-01",
        capabilities: ["DELIVERY"],
      })
      .then(() => null, (e: unknown) => e);
    expect(expiredAttempt).toBeInstanceOf(errors.DomainValidationError);

    const rider2User = await makeUser("baddaterider", "RIDER");
    const dateAttempt = await driversSvc
      .createDriverProfile(adminActor, {
        userId: rider2User,
        homeWarehouseId: fx.whA,
        licenseNumber: `LIC-P10S2-Z-${RUN}`,
        licenseExpiry: "2026-02-30",
        capabilities: ["DELIVERY"],
      })
      .then(() => null, (e: unknown) => e);
    expect(dateAttempt).toBeInstanceOf(errors.DomainValidationError);

    const vehicleAttempt = await vehiclesSvc
      .createVehicle(adminActor, {
        registration: `S2 BAD ${RUN.slice(-6)}`.toUpperCase(),
        type: "VAN",
        insuranceExpiry: "2026-02-30",
        registrationExpiry: "2027-01-01",
      })
      .then(() => null, (e: unknown) => e);
    expect(vehicleAttempt).toBeInstanceOf(errors.DomainValidationError);
  });
});

let invoiceRider: Awaited<ReturnType<typeof makeRider>> | null = null;

/** Invoice a fresh vendor's DELIVERED shipment (booking charge is
 * snapshotted: 15000 base + 5000 × 1 kg = 20000 paisa). */
async function invoiceForFreshVendor(label: string) {
  const { vendorId } = await makeVendor(label);
  invoiceRider ??= await makeRider("invoiceRider", fx.whB);
  await deliverCod(vendorId, "0", invoiceRider.userId, invoiceRider.actor);
  const invoice = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId });
  if (!invoice) throw new Error("invoice not generated");
  expect(invoice.totalPaisa).toBe("20000");
  return { vendorId, invoice };
}

describe("F8 — concurrent payment replay returns the original payment", () => {
  it("two concurrent recordPayment calls with one key create ONE payment, returned to both", async () => {
    const { invoice } = await invoiceForFreshVendor("f8");
    const key = `p10s2-pay-${RUN}`;
    const input = {
      amountPaisa: "20000",
      method: "CASH" as const,
      idempotencyKey: key,
      allocations: [{ invoiceId: invoice.id, amountPaisa: "20000" }],
    };
    const [r1, r2] = await Promise.allSettled([
      invoicesSvc.recordPayment(financeActor, input),
      invoicesSvc.recordPayment(financeActor, input),
    ]);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("fulfilled");
    if (r1.status === "fulfilled" && r2.status === "fulfilled") {
      expect(r1.value.id).toBe(r2.value.id);
    }
    const count = await prisma.payment.count({ where: { idempotencyKey: key } });
    expect(count).toBe(1);
    const after = await invoicesSvc.getInvoice(financeActor, invoice.id);
    expect(after.status).toBe("PAID");
    expect(after.paidPaisa).toBe("20000");
  });
});

describe("F9 — journal reversal is locked and stores its reason", () => {
  it("concurrent voidInvoice: exactly one reversal; the loser gets the clean error; legs carry the reason", async () => {
    const { invoice } = await invoiceForFreshVendor("f9");
    const reason = "Duplicate billing run";
    const [r1, r2] = await Promise.allSettled([
      invoicesSvc.voidInvoice(financeActor, invoice.id, { reason }),
      invoicesSvc.voidInvoice(financeActor, invoice.id, { reason }),
    ]);
    const settled = [r1, r2];
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((r) => r.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      // Either the invoice-level already-cancelled conflict or the
      // journal-level already-reversed error — both are clean
      // domain errors; a raw Prisma P2002 is the failure mode.
      expect(rejected.reason).not.toMatchObject({ code: "P2002" });
      expect(String(rejected.reason?.message ?? "")).toMatch(
        /already (cancelled|been reversed)/,
      );
    }
    const legs = await prisma.ledgerTransaction.findMany({
      where: { journalRef: `REV:${invoice.invoiceNumber}` },
    });
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) expect(leg.notes).toBe(reason);
  });
});

describe("F10 — payment immutability covers invoiceId/orderId", () => {
  it("direct SQL cannot re-point a payment; status-side columns still move", async () => {
    const { invoice } = await invoiceForFreshVendor("f10");
    const payment = await invoicesSvc.recordPayment(financeActor, {
      amountPaisa: "20000",
      method: "CASH",
      allocations: [{ invoiceId: invoice.id, amountPaisa: "20000" }],
    });
    await expect(
      prisma.$executeRaw`UPDATE "app"."Payment" SET "invoiceId" = gen_random_uuid() WHERE "id" = ${payment.id}`,
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.$executeRaw`UPDATE "app"."Payment" SET "orderId" = gen_random_uuid() WHERE "id" = ${payment.id}`,
    ).rejects.toThrow(/immutable/);
    // Control: the trigger is targeted — paidAt may still move.
    await prisma.$executeRaw`UPDATE "app"."Payment" SET "paidAt" = now() WHERE "id" = ${payment.id}`;
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(row.invoiceId).toBe(invoice.id);
  });
});

describe("F12a — remittance handover warehouse is validated", () => {
  it("a nonexistent warehouse 404s and a foreign warehouse is refused", async () => {
    const { vendorId } = await makeVendor("f12a");
    const rider = await makeRider("riderF12a", fx.whB);
    const { collectionId } = await deliverCod(vendorId, "10000", rider.userId, rider.actor);
    const ghost = await remittancesSvc
      .submitRemittance(rider.actor, {
        collectionIds: [collectionId],
        declaredAmountPaisa: "10000",
        warehouseId: "00000000-0000-4000-8000-000000000000",
      })
      .then(() => null, (e: unknown) => e);
    expect(ghost).toBeInstanceOf(errors.NotFoundError);
    const foreign = await remittancesSvc
      .submitRemittance(rider.actor, {
        collectionIds: [collectionId],
        declaredAmountPaisa: "10000",
        warehouseId: fx.whA,
      })
      .then(() => null, (e: unknown) => e);
    expect(foreign).toBeInstanceOf(errors.DomainValidationError);
    // The collection is still unremitted after both refusals.
    const lines = await prisma.codRemittanceLine.count({ where: { codCollectionId: collectionId } });
    expect(lines).toBe(0);
  });
});

describe("F12b — remittance submission idempotency", () => {
  it("a replayed key returns the original remittance and posts the journals once", async () => {
    const { vendorId } = await makeVendor("f12b");
    const rider = await makeRider("riderF12b", fx.whB);
    const { collectionId } = await deliverCod(vendorId, "10000", rider.userId, rider.actor);
    const key = `p10s2-rmt-${RUN}`;
    const input = {
      collectionIds: [collectionId],
      declaredAmountPaisa: "10000",
      idempotencyKey: key,
    };
    const first = await remittancesSvc.submitRemittance(rider.actor, input);
    const replay = await remittancesSvc.submitRemittance(rider.actor, input);
    expect(replay.id).toBe(first.id);
    const count = await prisma.codRemittance.count({ where: { idempotencyKey: key } });
    expect(count).toBe(1);
    const legs = await prisma.ledgerTransaction.count({
      where: { journalRef: `COD-${collectionId}` },
    });
    expect(legs).toBe(2);
  });
});

describe("F12d — accept-counted surplus is parked in suspense", () => {
  it("counted > collected posts a SURPLUS journal: clearing debited, suspense credited", async () => {
    const { vendorId } = await makeVendor("f12d");
    const rider = await makeRider("riderF12d", fx.whB);
    const { collectionId } = await deliverCod(vendorId, "10000", rider.userId, rider.actor);
    const remittance = await remittancesSvc.submitRemittance(rider.actor, {
      collectionIds: [collectionId],
      declaredAmountPaisa: "10000",
    });
    const verified = await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
      countedAmountPaisa: "12000",
    });
    expect(verified.status).toBe("DISCREPANCY");
    await remittancesSvc.resolveRemittance(financeActor, remittance.id, {
      resolution: "ACCEPTED_COUNTED",
      note: "Counted above collections — surplus parked pending investigation",
    });
    const legs = await prisma.ledgerTransaction.findMany({
      where: { journalRef: `${remittance.remittanceNumber}:SURPLUS` },
      include: { account: { select: { code: true } } },
    });
    expect(legs).toHaveLength(2);
    const debit = legs.find((l) => l.direction === "DEBIT");
    const credit = legs.find((l) => l.direction === "CREDIT");
    expect(debit?.account.code).toBe("COD_CLEARING");
    expect(debit?.amountPaisa).toBe(BigInt(2000));
    expect(credit?.account.code).toBe("COD_DISCREPANCY");
    expect(credit?.amountPaisa).toBe(BigInt(2000));
  });
});

describe("F12e — refunds mark allocations instead of destroying them", () => {
  it("a processed refund sets refundedPaisa, keeps the allocation, and nets the invoice paid figure", async () => {
    const { invoice } = await invoiceForFreshVendor("f12e");
    const payment = await invoicesSvc.recordPayment(financeActor, {
      amountPaisa: "20000",
      method: "CASH",
      allocations: [{ invoiceId: invoice.id, amountPaisa: "20000" }],
    });
    const refund = await adjustmentsSvc.requestRefund(financeActor, {
      paymentId: payment.id,
      amountPaisa: "8000",
      reason: "Customer overcharged",
    });
    await adjustmentsSvc.approveRefund(superAdminActor, refund.id);
    await adjustmentsSvc.processRefund(financeActor, refund.id);
    const allocation = await prisma.paymentAllocation.findFirstOrThrow({
      where: { paymentId: payment.id },
    });
    expect(allocation.amountPaisa).toBe(BigInt(20000));
    expect(allocation.refundedPaisa).toBe(BigInt(8000));
    const after = await invoicesSvc.getInvoice(financeActor, invoice.id);
    expect(after.paidPaisa).toBe("12000");
    expect(after.status).toBe("PARTIALLY_PAID");
  });
});
