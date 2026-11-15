import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 9 SECURITY REVIEW PoC suite (read-only review of HEAD 6f9d229).
 *
 * Assertions encode the SECURE / CORRECT expectation:
 *  - tests in "controls" describes are expected to PASS (verified sound);
 *  - tests in "findings" describes FAIL on the unfixed code, and each
 *    failure is the live proof of the finding in the review report.
 *
 * Dataset (per-run unique, WH-ZR9 warehouses):
 *   J1 vendor1 A→B COD 100000 delivered at B by riderB (homed B),
 *      then remitted by riderB and verified by finance.
 *   J2 vendor2 B→A COD  70000 delivered at A by riderA (homed A),
 *      never remitted.
 *   J3 vendor1 A→B COD  55555 delivered at B by riderA (homed A,
 *      holds a B membership — the cross-homed rider case).
 *   B1/B2 vendor3 orders whose createdAt is moved to exactly
 *      00:00:00.000 NPT today and 23:59:59.999 NPT yesterday
 *      (Kathmandu-midnight boundary probes).
 *   Invoice for vendor2 (J2 charges), voided mid-test.
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
const email = (label: string) => `p9r-${label}-${RUN}@bla.test`;
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
let remittancesSvc: typeof import("@/server/services/cod-remittances");
let invoicesSvc: typeof import("@/server/services/invoices");
let reportsSvc: typeof import("@/server/services/reports");
let reportsFinanceSvc: typeof import("@/server/services/reports-finance");
let reportsExportSvc: typeof import("@/server/services/reports-export");
let reportsDomain: typeof import("@/lib/reports/domain");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let financeActor: Awaited<ReturnType<typeof actorFor>>;
let supportActor: Awaited<ReturnType<typeof actorFor>>;
let customerActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let vendor1OwnerActor: Awaited<ReturnType<typeof actorFor>>;
let riderAActor: Awaited<ReturnType<typeof actorFor>>;
let riderBActor: Awaited<ReturnType<typeof actorFor>>;
let linehaulAActor: Awaited<ReturnType<typeof actorFor>>;
let serviceCode: string;
let rangeToday: { from: string; to: string };
let todayStr: string;
let yesterdayStr: string;

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
      fullName: `P9R ${label}`,
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

async function makeWarehouse(
  label: string,
  capacityPackages: number,
): Promise<{ id: string; code: string; district: string; locations: Record<string, string> }> {
  const district = `P9R${label} District ${RUN}`;
  let warehouse: { id: string; code: string } | null = null;
  for (let attempt = 0; attempt < 40 && !warehouse; attempt += 1) {
    const nn = String(Math.floor(Math.random() * 90) + 10);
    const code = `WH-ZR9-${nn}`;
    const existing = await prisma.warehouse.findUnique({ where: { code } });
    if (existing) continue;
    warehouse = await prisma.warehouse.create({
      data: {
        code,
        name: `P9R ${label} ${RUN}`,
        type: "REGIONAL",
        status: "ACTIVE",
        district,
        city: `P9R ${label}`,
        province: "Bagmati",
        country: "Nepal",
        capacityPackages,
      },
    });
  }
  if (!warehouse) throw new Error("could not allocate a fixture warehouse code");
  await prisma.serviceArea.create({
    data: {
      name: `P9R ${label} Area ${RUN}`,
      district,
      city: `P9R ${label}`,
      province: "Bagmati",
      servingWarehouseId: warehouse.id,
    },
  });
  const locations: Record<string, string> = {};
  for (const def of ZONE_DEFS) {
    const zone = await prisma.warehouseZone.create({
      data: { warehouseId: warehouse.id, code: def.code, name: def.name, kind: def.kind },
    });
    const location = await prisma.storageLocation.create({
      data: { zoneId: zone.id, rack: "R1", fullCode: `${warehouse.code}/${def.code}/R1` },
    });
    locations[def.kind] = location.id;
  }
  return { id: warehouse.id, code: warehouse.code, district, locations };
}

interface Side {
  wh: string;
  code: string;
  district: string;
  locSto: string;
  wa: Awaited<ReturnType<typeof actorFor>>;
  staff: Awaited<ReturnType<typeof actorFor>>;
  linehaul: Awaited<ReturnType<typeof actorFor>>;
  linehaulProfile: string;
  vehicle: string;
  rider: Awaited<ReturnType<typeof actorFor>>;
  riderUser: string;
  riderProfile: string;
}
let sideA: Side;
let sideB: Side;

async function bookOne(
  from: Side,
  to: Side,
  vendorId: string,
  codAmountPaisa: string,
): Promise<{ packageId: string; trackingId: string; shipmentId: string; orderId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId,
    sender: { name: "P9R Sender", phone: phone(42), email: null },
    recipient: {
      name: "P9R Recipient",
      phone: RECIPIENT_PHONE,
      addressLine: "Lakeside Street 1",
      city: "Town",
      district: to.district,
      province: "Bagmati",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: from.wh },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa,
    items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
  });
  const shipment = booking.shipments[0];
  const pkg = shipment.packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId, shipmentId: shipment.id, orderId: booking.id };
}

async function journey(
  from: Side,
  to: Side,
  vendorId: string,
  codAmountPaisa: string,
) {
  const parcel = await bookOne(from, to, vendorId, codAmountPaisa);
  await inventorySvc.receivePackage(from.staff, { warehouseId: from.wh, trackingId: parcel.trackingId });
  await inventorySvc.moveToInspection(from.staff, parcel.packageId);
  await inventorySvc.startInspection(from.staff, parcel.packageId);
  await inventorySvc.recordInspection(from.staff, {
    packageId: parcel.packageId,
    condition: "GOOD",
    actualWeightKg: 2,
  });
  await inventorySvc.putAwayPackage(from.staff, parcel.packageId, from.locSto);
  await inventorySvc.markReadyForDispatch(from.staff, parcel.packageId);

  const transfer = await transfersSvc.createTransfer(from.wa, {
    originWarehouseId: from.wh,
    destinationWarehouseId: to.wh,
  });
  const added = await transfersSvc.addTransferItems(from.wa, transfer.id, [parcel.packageId]);
  expect(added.rejected).toEqual([]);
  await transfersSvc.generateManifest(from.wa, transfer.id);
  const crewed = await transfersSvc.assignTransferCrew(from.wa, {
    transferId: transfer.id,
    driverId: from.linehaulProfile,
    vehicleId: from.vehicle,
  });
  const loaded = await transfersSvc.loadTransferPackage(from.wa, transfer.id, {
    trackingId: parcel.trackingId,
    idempotencyKey: `p9r-load-${RUN}-${parcel.trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(from.wa, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(from.linehaul, tripId);
  await tripsSvc.arriveTrip(from.linehaul, tripId);
  const scan = await transfersSvc.scanDestinationPackage(to.wa, transfer.id, {
    trackingId: parcel.trackingId,
    idempotencyKey: `p9r-unload-${RUN}-${parcel.trackingId}`,
  });
  expect(scan.kind).toBe("RECEIVED_SCAN");
  await transfersSvc.completePackageReceiving(to.wa, transfer.id, {
    packageId: parcel.packageId,
    condition: "GOOD",
  });
  await transfersSvc.finishReceiving(to.wa, transfer.id);
  await transfersSvc.reconcileTransfer(to.wa, transfer.id);
  await transfersSvc.closeTransfer(to.wa, transfer.id);
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
  if (!payload?.otpCode) throw new Error(`No recipient OTP notification for ${assignmentId}`);
  return payload.otpCode;
}

/** Deliver a parcel sitting at `side`'s warehouse, using the given
 *  rider (defaults to the side's own rider). */
async function deliverAt(
  side: Side,
  parcel: { packageId: string; trackingId: string },
  codAmountPaisa: string,
  rider?: { actor: Awaited<ReturnType<typeof actorFor>>; userId: string },
) {
  const riderActor = rider?.actor ?? side.rider;
  const riderUserId = rider?.userId ?? side.riderUser;
  const batch = await deliveriesSvc.createDeliveryBatch(side.wa, {
    warehouseId: side.wh,
    riderUserId,
    batchDate: TODAY,
    kind: "DELIVERY",
  });
  const added = await deliveriesSvc.addBatchPackages(side.wa, batch.id, {
    packageIds: [parcel.packageId],
  });
  expect(added.rejected).toEqual([]);
  expect(added.added).toHaveLength(1);
  const assignment = added.added[0];
  const pickup = await deliveriesSvc.confirmPickup(riderActor, batch.id, {
    trackingIds: [parcel.trackingId],
  });
  expect(pickup.failed).toEqual([]);
  const delivered = await deliveriesSvc.confirmDelivery(riderActor, assignment.id, {
    receivedByName: "P9R Recipient",
    relationshipToRecipient: "Self",
    otpCode: await recipientOtp(assignment.id),
    codCollectedPaisa: codAmountPaisa,
  });
  return { ...parcel, batch, assignment, delivered };
}

async function deniedCount(actorId: string): Promise<number> {
  return prisma.auditLog.count({
    where: { actorId, action: "access.denied" },
  });
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
  remittancesSvc = await import("@/server/services/cod-remittances");
  invoicesSvc = await import("@/server/services/invoices");
  reportsSvc = await import("@/server/services/reports");
  reportsFinanceSvc = await import("@/server/services/reports-finance");
  reportsExportSvc = await import("@/server/services/reports-export");
  reportsDomain = await import("@/lib/reports/domain");
  actorErrors = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");

  todayStr = reportsDomain.kathmanduToday();
  yesterdayStr = reportsDomain.addDays(todayStr, -1);
  rangeToday = { from: todayStr, to: todayStr };

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
  fx.financeUser = await makeUser("finance", "FINANCE");
  financeActor = await actorFor(fx.financeUser);
  fx.supportUser = await makeUser("support", "SUPPORT");
  supportActor = await actorFor(fx.supportUser);
  fx.customerUser = await makeUser("customer", "CUSTOMER");
  customerActor = await actorFor(fx.customerUser);

  const a = await makeWarehouse("Alpha", 10);
  fx.whA = a.id;
  const b = await makeWarehouse("Beta", 20);
  fx.whB = b.id;

  serviceCode = `P9RSTD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P9R Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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

  async function makeVendor(label: string): Promise<string> {
    const vendor = await vendorsSvc.createVendor(adminActor, {
      businessName: `P9R Vendor ${label} ${RUN}`,
      contactName: "P9R Contact",
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
    return vendor.id;
  }
  fx.vendor1 = await makeVendor("one");
  fx.vendor2 = await makeVendor("two");
  fx.vendor3 = await makeVendor("three");
  fx.vendor1OwnerUser = await makeUser("vendor1Owner", "VENDOR");
  await prisma.vendorUser.create({
    data: { userId: fx.vendor1OwnerUser, vendorId: fx.vendor1, vendorRole: "OWNER", isActive: true, invitedById: fx.adminUser },
  });
  vendor1OwnerActor = await actorFor(fx.vendor1OwnerUser);

  async function buildSide(
    label: "A" | "B",
    wh: { id: string; code: string; district: string; locations: Record<string, string> },
  ): Promise<Side> {
    const waUser = await makeUser(`wa${label}`, "WAREHOUSE_ADMIN");
    await addMembership(waUser, wh.id, "WAREHOUSE_ADMIN");
    const staffUser = await makeUser(`staff${label}`, "WAREHOUSE_STAFF");
    await addMembership(staffUser, wh.id, "WAREHOUSE_STAFF");
    const linehaulUser = await makeUser(`linehaul${label}`, "LINEHAUL_DRIVER");
    const linehaul = await driversSvc.createDriverProfile(adminActor, {
      userId: linehaulUser,
      homeWarehouseId: wh.id,
      licenseNumber: `LIC-P9R-LH${label}-${RUN}`,
      licenseCategory: "C",
      licenseExpiry: "2030-01-01",
      capabilities: ["LINEHAUL"],
    });
    const vehicle = await vehiclesSvc.createVehicle(adminActor, {
      registration: `P9R TRK${label} ${RUN.slice(-6)}`.toUpperCase(),
      type: "TRUCK",
      capacityKg: 5000,
      homeWarehouseId: wh.id,
      insuranceExpiry: "2027-06-01",
      registrationExpiry: "2027-06-01",
    });
    const riderUser = await makeUser(`rider${label}`, "RIDER");
    const rider = await driversSvc.createDriverProfile(adminActor, {
      userId: riderUser,
      homeWarehouseId: wh.id,
      licenseNumber: `LIC-P9R-R${label}-${RUN}`,
      licenseCategory: "A",
      licenseExpiry: "2030-01-01",
      capabilities: ["DELIVERY"],
    });
    return {
      wh: wh.id,
      code: wh.code,
      district: wh.district,
      locSto: wh.locations.STORAGE,
      wa: await actorFor(waUser),
      staff: await actorFor(staffUser),
      linehaul: await actorFor(linehaulUser),
      linehaulProfile: linehaul.id,
      vehicle: vehicle.id,
      rider: await actorFor(riderUser),
      riderUser,
      riderProfile: rider.id,
    };
  }
  sideA = await buildSide("A", a);
  sideB = await buildSide("B", b);
  waAActor = sideA.wa;
  waBActor = sideB.wa;
  staffAActor = sideA.staff;
  riderBActor = sideB.rider;
  linehaulAActor = sideA.linehaul;
  fx.riderAProfile = sideA.riderProfile;
  fx.riderBProfile = sideB.riderProfile;
  fx.riderAUser = sideA.riderUser;

  // riderA (homed A) also holds an active membership at B, so B's
  // warehouse admin may legitimately put him on a B delivery batch.
  await addMembership(sideA.riderUser, sideB.wh, "RIDER");
  riderAActor = await actorFor(sideA.riderUser);

  // --- Dataset -------------------------------------------------------
  const j1 = await journey(sideA, sideB, fx.vendor1, "100000");
  await deliverAt(sideB, j1, "100000");
  const j2 = await journey(sideB, sideA, fx.vendor2, "70000");
  await deliverAt(sideA, j2, "70000");
  const j3 = await journey(sideA, sideB, fx.vendor1, "55555");
  await deliverAt(sideB, j3, "55555", { actor: riderAActor, userId: sideA.riderUser });

  // riderB remits J1's collection; finance verifies the exact count.
  const coll1 = await prisma.deliveryCodCollection.findUniqueOrThrow({
    where: { packageId: j1.packageId },
  });
  const remittance = await remittancesSvc.submitRemittance(riderBActor, {
    collectionIds: [coll1.id],
    declaredAmountPaisa: "100000",
    method: "CASH",
  });
  const verified = await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
    countedAmountPaisa: "100000",
  });
  expect(verified.status).toBe("VERIFIED");

  // Invoice for vendor2 (J2 charges) — voided inside its test.
  const invoice2 = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId: fx.vendor2 });
  expect(invoice2).not.toBeNull();
  fx.invoice2 = invoice2!.id;
  const invoice2Row = await prisma.invoice.findUniqueOrThrow({ where: { id: fx.invoice2 } });
  fx.invoice2Total = invoice2Row.totalPaisa.toString();

  // Boundary probes: vendor3 orders at the Kathmandu-midnight edges.
  const start = reportsDomain.kathmanduDayStartUtc(todayStr);
  const b1 = await bookOne(sideA, sideB, fx.vendor3, "0");
  await prisma.order.update({
    where: { id: b1.orderId },
    data: { createdAt: start },
  });
  const b2 = await bookOne(sideA, sideB, fx.vendor3, "0");
  await prisma.order.update({
    where: { id: b2.orderId },
    data: { createdAt: new Date(start.getTime() - 1) },
  });
});

// ---------------------------------------------------------------------------
// Controls — expected to PASS on the reviewed code (verified sound).
// ---------------------------------------------------------------------------

describe("controls: role boundaries", () => {
  it("CUSTOMER is denied every report surface", async () => {
    const E = actorErrors.AuthorizationError;
    await expect(reportsSvc.getOverviewReport(customerActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getDailyReport(customerActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getWarehouseReport(customerActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getDriverReport(customerActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getDriverSelfReport(customerActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getVendorReport(customerActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getTransferReport(customerActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsFinanceSvc.getFinanceReport(customerActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsFinanceSvc.getCodReport(customerActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsExportSvc.buildReportCsv(customerActor, "warehouses", rangeToday)).rejects.toThrow(E);
  });

  it("SUPPORT is denied every report surface", async () => {
    const E = actorErrors.AuthorizationError;
    await expect(reportsSvc.getOverviewReport(supportActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getDailyReport(supportActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getWarehouseReport(supportActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getDriverReport(supportActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getVendorReport(supportActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getTransferReport(supportActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsFinanceSvc.getFinanceReport(supportActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsFinanceSvc.getCodReport(supportActor, rangeToday)).rejects.toThrow(E);
  });

  it("WAREHOUSE_STAFF (no report permissions) is denied scoped reports", async () => {
    const E = actorErrors.AuthorizationError;
    await expect(reportsSvc.getDailyReport(staffAActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getWarehouseReport(staffAActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getDriverReport(staffAActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getTransferReport(staffAActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsFinanceSvc.getCodReport(staffAActor, rangeToday)).rejects.toThrow(E);
  });

  it("FINANCE is denied operational reports (matrix footnote 32), audited", async () => {
    const E = actorErrors.AuthorizationError;
    const before = await deniedCount(fx.financeUser);
    await expect(reportsSvc.getOverviewReport(financeActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getWarehouseReport(financeActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getDriverReport(financeActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getVendorReport(financeActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getDailyReport(financeActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsSvc.getTransferReport(financeActor, rangeToday)).rejects.toThrow(E);
    const after = await deniedCount(fx.financeUser);
    expect(after).toBeGreaterThan(before);
    const rows = await prisma.auditLog.findMany({
      where: { actorId: fx.financeUser, action: "access.denied" },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    expect(
      rows.some((r) => (r.after as { reason?: string } | null)?.reason === "finance_reports_only"),
    ).toBe(true);
    // …while its own surfaces stay open.
    await expect(reportsFinanceSvc.getFinanceReport(financeActor, rangeToday)).resolves.toBeTruthy();
    await expect(reportsFinanceSvc.getCodReport(financeActor, rangeToday)).resolves.toBeTruthy();
  });

  it("ops roles cannot read the finance report without finance.read", async () => {
    const E = actorErrors.AuthorizationError;
    await expect(reportsFinanceSvc.getFinanceReport(waAActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsFinanceSvc.getFinanceReport(vendor1OwnerActor, rangeToday)).rejects.toThrow(E);
    await expect(reportsFinanceSvc.getFinanceReport(riderBActor, rangeToday)).rejects.toThrow(E);
  });
});

describe("controls: scope composition and denials", () => {
  it("WA foreign warehouseId is an audited denial on every scoped report", async () => {
    const E = actorErrors.AuthorizationError;
    const before = await prisma.auditLog.count({
      where: { actorId: waAActor.userId, action: "access.denied", warehouseId: fx.whB },
    });
    await expect(
      reportsSvc.getWarehouseReport(waAActor, { ...rangeToday, warehouseId: fx.whB }),
    ).rejects.toThrow(E);
    await expect(
      reportsSvc.getDailyReport(waAActor, { ...rangeToday, warehouseId: fx.whB }),
    ).rejects.toThrow(E);
    await expect(
      reportsSvc.getTransferReport(waAActor, { ...rangeToday, warehouseId: fx.whB }),
    ).rejects.toThrow(E);
    await expect(
      reportsSvc.getDriverReport(waAActor, { ...rangeToday, warehouseId: fx.whB }),
    ).rejects.toThrow(E);
    await expect(
      reportsFinanceSvc.getCodReport(waAActor, { ...rangeToday, warehouseId: fx.whB }),
    ).rejects.toThrow(E);
    const after = await prisma.auditLog.count({
      where: { actorId: waAActor.userId, action: "access.denied", warehouseId: fx.whB },
    });
    expect(after).toBeGreaterThan(before);
  });

  it("foreign and nonexistent ids are indistinguishable (no existence oracle)", async () => {
    const E = actorErrors.AuthorizationError;
    // A real foreign warehouse and a random uuid fail identically.
    await expect(
      reportsSvc.getWarehouseReport(waAActor, { ...rangeToday, warehouseId: randomUUID() }),
    ).rejects.toThrow(E);
    // A vendor asking for a random vendor id gets the same
    // AuthorizationError as for a real foreign vendor.
    await expect(
      reportsSvc.getVendorReport(vendor1OwnerActor, { ...rangeToday, vendorId: randomUUID() }),
    ).rejects.toThrow(E);
    await expect(
      reportsSvc.getVendorReport(vendor1OwnerActor, { ...rangeToday, vendorId: fx.vendor2 }),
    ).rejects.toThrow(E);
  });

  it("WA warehouse report contains only own warehouses", async () => {
    const report = await reportsSvc.getWarehouseReport(waAActor, rangeToday);
    expect(report.rows.map((r) => r.warehouseId)).toEqual([fx.whA]);
  });

  it("WA COD report cohort is batch-scoped to own warehouses", async () => {
    const reportA = await reportsFinanceSvc.getCodReport(waAActor, rangeToday);
    expect(reportA.warehouses.map((r) => r.key)).toEqual([fx.whA]);
    expect(reportA.totals.collectedPaisa).toBe("70000"); // J2 only
    const reportB = await reportsFinanceSvc.getCodReport(waBActor, rangeToday);
    expect(reportB.warehouses.map((r) => r.key)).toEqual([fx.whB]);
    expect(reportB.totals.collectedPaisa).toBe("155555"); // J1 + J3
    // Per-rider rows are home-filtered: B's WA sees riderB only.
    expect(reportB.riders.map((r) => r.key)).toEqual([fx.riderBProfile]);
  });

  it("vendor is pinned to its own vendor report row", async () => {
    const report = await reportsSvc.getVendorReport(vendor1OwnerActor, rangeToday);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].vendorId).toBe(fx.vendor1);
    expect(report.rows[0].bookings).toBe(2); // J1 + J3
    await expect(
      reportsFinanceSvc.getCodReport(vendor1OwnerActor, { ...rangeToday, vendorId: fx.vendor2 }),
    ).rejects.toThrow(actorErrors.AuthorizationError);
    const own = await reportsFinanceSvc.getCodReport(vendor1OwnerActor, rangeToday);
    expect(own.totals.collectedPaisa).toBe("155555"); // J1 + J3 collections
  });

  it("rider self report is pinned to the actor's driver profile", async () => {
    const E = actorErrors.AuthorizationError;
    await expect(
      reportsSvc.getDriverSelfReport(riderBActor, { ...rangeToday, driverId: fx.riderAProfile }),
    ).rejects.toThrow(E);
    await expect(
      reportsFinanceSvc.getCodReport(riderBActor, { ...rangeToday, driverId: fx.riderAProfile }),
    ).rejects.toThrow(E);
    await expect(reportsSvc.getDriverReport(riderBActor, rangeToday)).rejects.toThrow(E);
    const own = await reportsSvc.getDriverSelfReport(riderBActor, rangeToday);
    expect(own.rows).toHaveLength(1);
    expect(own.rows[0].driverId).toBe(fx.riderBProfile);
    expect(own.rows[0].codCollectedPaisa).toBe("100000");
    const linehaul = await reportsSvc.getDriverSelfReport(linehaulAActor, rangeToday);
    expect(linehaul.rows).toHaveLength(1);
  });

  it("driver report home-scoping mirrors the Phase 7 F2 rider-position law", async () => {
    // WA-A manages riderA (homed A): his row carries ALL his
    // collections, exactly like getRiderCodPosition — including the
    // 55555 he collected on B's batch in J3.
    const drivers = await reportsSvc.getDriverReport(waAActor, rangeToday);
    const riderARow = drivers.rows.find((r) => r.driverId === fx.riderAProfile);
    expect(riderARow).toBeTruthy();
    expect(riderARow!.codCollectedPaisa).toBe("125555"); // 70000 (A) + 55555 (B)
    // WA-B does not manage riderA, so he is absent from B's report
    // (B's own linehaul driver legitimately appears with trip rows).
    const driversB = await reportsSvc.getDriverReport(waBActor, rangeToday);
    expect(driversB.rows.map((r) => r.driverId)).toContain(fx.riderBProfile);
    expect(driversB.rows.map((r) => r.driverId)).not.toContain(fx.riderAProfile);
  });

  it("COD report agrees with the Phase 7 rider position to the paisa", async () => {
    const report = await reportsFinanceSvc.getCodReport(adminActor, rangeToday);
    const rowA = report.riders.find((r) => r.key === fx.riderAProfile)!;
    const rowB = report.riders.find((r) => r.key === fx.riderBProfile)!;
    const posA = await remittancesSvc.getRiderCodPosition(adminActor, fx.riderAProfile);
    const posB = await remittancesSvc.getRiderCodPosition(adminActor, fx.riderBProfile);
    // Corrected control (reviewer's own diagnosis, Phase 9 fix
    // batch): the report's outstanding is collected − verified from
    // the collection rows, which equals the position's OWN breakdown
    // awaiting + in-open. It is NOT ledgerOwedPaisa: the DRIVER_CASH
    // ledger account only moves at remittance submission, so the
    // ledger figure excludes cash collected but not yet submitted
    // (riderA submitted nothing, so his ledger-owed is 0 while he
    // physically holds 125555). The original assertion equated the
    // two different quantities.
    expect(rowA.outstandingPaisa).toBe(
      (
        BigInt(posA.awaitingRemittanceTotalPaisa) + BigInt(posA.inOpenRemittancePaisa)
      ).toString(),
    );
    expect(rowA.awaitingRemittancePaisa).toBe(posA.awaitingRemittanceTotalPaisa);
    expect(rowA.remittedVerifiedPaisa).toBe(posA.verifiedRemittedPaisa);
    expect(rowB.outstandingPaisa).toBe(posB.ledgerOwedPaisa);
    expect(rowB.remittedVerifiedPaisa).toBe("100000");
    expect(rowB.outstandingPaisa).toBe("0");
  });

  it("CSV export equals the scoped JSON report (warehouse scope)", async () => {
    const { csv } = await reportsExportSvc.buildReportCsv(waAActor, "warehouses", rangeToday);
    expect(csv).toContain(fx.whA ? "P9R Alpha" : "");
    expect(csv).not.toContain("P9R Beta");
    const foreign = await reportsExportSvc
      .buildReportCsv(waAActor, "warehouses", { ...rangeToday, warehouseId: fx.whB })
      .catch((e: unknown) => e);
    expect(foreign).toBeInstanceOf(actorErrors.AuthorizationError);
  });
});

describe("controls: figure integrity", () => {
  it("Kathmandu-midnight boundary: JS ranges and SQL daily series agree", async () => {
    const v3 = { vendorId: fx.vendor3 };
    const todayOnly = await reportsSvc.getOverviewReport(adminActor, {
      from: todayStr,
      to: todayStr,
      ...v3,
    });
    expect(todayOnly.bookings).toBe(1); // B1 at exactly 00:00:00.000 NPT
    const yesterdayOnly = await reportsSvc.getOverviewReport(adminActor, {
      from: yesterdayStr,
      to: yesterdayStr,
      ...v3,
    });
    expect(yesterdayOnly.bookings).toBe(1); // B2 at 23:59:59.999 NPT
    const both = await reportsSvc.getOverviewReport(adminActor, {
      from: yesterdayStr,
      to: todayStr,
      ...v3,
    });
    expect(both.bookings).toBe(2); // no double count, no gap
    expect(both.dailySeries).toEqual([
      { date: yesterdayStr, bookings: 1, delivered: 0 },
      { date: todayStr, bookings: 1, delivered: 0 },
    ]);
  });

  it("range validation: from > to and > 366 days are rejected", async () => {
    await expect(
      reportsSvc.getOverviewReport(adminActor, { from: todayStr, to: yesterdayStr }),
    ).rejects.toThrow();
    await expect(
      reportsSvc.getOverviewReport(adminActor, { from: "2025-01-01", to: "2026-12-31" }),
    ).rejects.toThrow();
  });

  it("empty range yields true zeros and null rates (never NaN)", async () => {
    const report = await reportsSvc.getOverviewReport(adminActor, {
      from: "2020-01-01",
      to: "2020-01-02",
    });
    expect(report.bookings).toBe(0);
    expect(report.delivered).toBe(0);
    expect(report.onTimePercent).toBeNull();
    expect(report.returnRatePercent).toBeNull();
    expect(report.avgDeliveryMinutes).toBeNull();
    expect(JSON.stringify(report)).not.toContain("NaN");
  });

  it("no-membership WA gets empty scoped reports (warehouse + daily)", async () => {
    const noMember = { ...waAActor, warehouseIds: [], membershipRoles: [] };
    const warehouses = await reportsSvc.getWarehouseReport(noMember, rangeToday);
    expect(warehouses.rows).toEqual([]);
    const daily = await reportsSvc.getDailyReport(noMember, rangeToday);
    expect(daily.bookings).toBe(0);
    expect(daily.invoicedTotalPaisa).toBeNull();
    const drivers = await reportsSvc.getDriverReport(noMember, rangeToday);
    expect(drivers.rows).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Findings — each test FAILS on the unfixed code; the failure is the
// live proof. Assertions state the secure/correct expectation.
// ---------------------------------------------------------------------------

describe("finding F1: overview delivered attribution contradicts the stated rule", () => {
  it("overview with a warehouse filter counts deliveries by the delivery (batch) warehouse, like every other report", async () => {
    const warehouseReport = await reportsSvc.getWarehouseReport(adminActor, {
      ...rangeToday,
      warehouseId: fx.whB,
    });
    expect(warehouseReport.rows).toHaveLength(1);
    expect(warehouseReport.rows[0].delivered).toBe(2); // J1 + J3, both delivered from B batches

    const overview = await reportsSvc.getOverviewReport(adminActor, {
      ...rangeToday,
      warehouseId: fx.whB,
    });
    // The overview's own COD section uses batch attribution under the
    // same filter (control):
    expect(overview.cod.collectedPaisa).toBe("155555");
    // Secure/correct expectation: the delivered count in the SAME
    // payload uses the SAME attribution the service header documents
    // ("deliveries and their COD to the DELIVERY warehouse").
    expect(overview.delivered).toBe(2);
  });
});

describe("finding F2: finance report counts CANCELLED invoices as invoiced revenue", () => {
  it("finance invoiced total excludes a voided (CANCELLED) invoice, as the overview does", async () => {
    // Delta-based (bla_test is shared with other suites): voiding the
    // fixture invoice must reduce BOTH reports' invoiced totals by
    // exactly its amount.
    const total = BigInt(fx.invoice2Total);
    const financeBefore = await reportsFinanceSvc.getFinanceReport(financeActor, rangeToday);
    const overviewBefore = await reportsSvc.getOverviewReport(adminActor, rangeToday);

    await invoicesSvc.voidInvoice(financeActor, fx.invoice2, { reason: "P9R review void" });
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: fx.invoice2 } });
    expect(row.status).toBe("CANCELLED");

    const financeAfter = await reportsFinanceSvc.getFinanceReport(financeActor, rangeToday);
    const overviewAfter = await reportsSvc.getOverviewReport(adminActor, rangeToday);
    // Control: the overview excludes the voided invoice.
    expect(
      BigInt(overviewBefore.invoiced.totalPaisa) - BigInt(overviewAfter.invoiced.totalPaisa),
    ).toBe(total);
    // Expectation: the finance report's headline invoiced total agrees.
    expect(
      BigInt(financeBefore.invoiced.totalPaisa) - BigInt(financeAfter.invoiced.totalPaisa),
    ).toBe(total);
  });
});

describe("finding F3: finance report vendorId filter is silently partial", () => {
  it("a vendor-filtered finance report does not leak other vendors' remittance totals", async () => {
    const filtered = await reportsFinanceSvc.getFinanceReport(financeActor, {
      ...rangeToday,
      vendorId: fx.vendor2,
    });
    // Control: the COD section IS vendor-scoped (vendor2 = J2 only).
    expect(filtered.codReconciliation.expectedPaisa).toBe("70000");
    expect(filtered.codReconciliation.collectedPaisa).toBe("70000");
    // The only remittance in the dataset belongs to vendor1's
    // collections (riderB / J1). Under a vendor2 filter the
    // remittances-by-status section must be empty.
    expect(
      filtered.codReconciliation.remittancesByStatus.every((g) => g.count === 0),
    ).toBe(true);
  });
});

describe("finding F4: CSV export is open to spreadsheet formula injection", () => {
  it("a vendor name starting with '=' is neutralised in the vendors CSV", async () => {
    const payload = `=2+2-P9R${RUN}`;
    const original = await prisma.vendor.findUniqueOrThrow({ where: { id: fx.vendor1 } });
    await prisma.vendor.update({
      where: { id: fx.vendor1 },
      data: { businessName: payload },
    });
    try {
      const { csv } = await reportsExportSvc.buildReportCsv(adminActor, "vendors", rangeToday);
      const line = csv.split("\r\n").find((l) => l.includes(payload));
      console.log("CSV injection evidence line:", line);
      // Secure expectation: the cell must not begin with a formula
      // trigger (=, +, -, @) when the CSV is opened in a spreadsheet.
      expect(line).toBeTruthy();
      expect(line!.startsWith("=")).toBe(false);
    } finally {
      await prisma.vendor.update({
        where: { id: fx.vendor1 },
        data: { businessName: original.businessName },
      });
    }
  });
});

describe("finding F5: transfer report breaks for a warehouse admin with zero memberships", () => {
  it("getTransferReport returns an empty report instead of a raw SQL error", async () => {
    const noMember = { ...waAActor, warehouseIds: [], membershipRoles: [] };
    const report = await reportsSvc.getTransferReport(noMember, rangeToday);
    expect(report.rows).toEqual([]);
  });
});
