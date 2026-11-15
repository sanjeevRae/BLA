import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 9 integration tests (docs: implementation-roadmap Phase 9 —
 * "reports agree with the underlying operational records") against
 * the local bla_test database.
 *
 * A small, fully-known dataset is built end-to-end through the real
 * services (bookings → warehouse ops → transfers → deliveries → COD
 * remittance → invoice → settlement), and every report figure is
 * asserted against the hand-computed value for that dataset.
 *
 * Dataset (all journeys run "today", Kathmandu):
 *   P1  vendor1  A→B  COD 100000  delivered at B
 *   P2  vendor1  A→B  COD  50000  delivered at B
 *   P3  vendor1  A→B  COD      0  delivered at B
 *   P5  vendor2  A→B  COD  20000  1 failed attempt, then delivered at B
 *   P4  vendor2  B→A  COD  70000  delivered at A
 *   P6  vendor1  A→B  COD      0  received + stored at A only
 *   P7  vendor2  B→A  COD      0  travels to A, stays in stock at A
 *   Remittance: riderB remits P1+P2 (150000), finance verifies exact.
 *   Invoice vendor1 = P1+P2+P3 shipment charges; settlement pays
 *   150000 − charges to vendor1. Invoice vendor2 = P4+P5 charges,
 *   left outstanding with dueAt backdated 40 days (ageing fixture).
 *
 * Fixture warehouses are PER-RUN unique (WH-ZP9-<random> codes and
 * per-run districts) so warehouse-level aggregates are exact on
 * every run; users/vendors are per-run unique as in earlier suites.
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
const email = (label: string) => `p9-${label}-${RUN}@bla.test`;
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
let remittancesSvc: typeof import("@/server/services/cod-remittances");
let invoicesSvc: typeof import("@/server/services/invoices");
let settlementsSvc: typeof import("@/server/services/settlements");
let reportsSvc: typeof import("@/server/services/reports");
let reportsFinanceSvc: typeof import("@/server/services/reports-finance");
let reportsExportSvc: typeof import("@/server/services/reports-export");
let reportsDomain: typeof import("@/lib/reports/domain");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let financeActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
let vendor1OwnerActor: Awaited<ReturnType<typeof actorFor>>;
let vendor2OwnerActor: Awaited<ReturnType<typeof actorFor>>;
let riderBActor: Awaited<ReturnType<typeof actorFor>>;
let serviceCode: string;
let rangeToday: { from: string; to: string };
/** Shipment charge snapshots (paisa) read back from the records. */
const charges: Record<string, bigint> = {};

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
      fullName: `P9 ${label}`,
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

/** Per-run unique warehouse: draw WH-ZP9-<nn> codes until one is
 *  free, with a per-run district so routing is unambiguous. */
async function makeWarehouse(
  label: string,
  capacityPackages: number,
): Promise<{ id: string; code: string; district: string; locations: Record<string, string> }> {
  const district = `P9${label} District ${RUN}`;
  let warehouse: { id: string; code: string } | null = null;
  for (let attempt = 0; attempt < 40 && !warehouse; attempt += 1) {
    const nn = String(Math.floor(Math.random() * 90) + 10);
    const code = `WH-ZP9-${nn}`;
    const existing = await prisma.warehouse.findUnique({ where: { code } });
    if (existing) continue;
    warehouse = await prisma.warehouse.create({
      data: {
        code,
        name: `P9 ${label} ${RUN}`,
        type: "REGIONAL",
        status: "ACTIVE",
        district,
        city: `P9 ${label}`,
        province: "Bagmati",
        country: "Nepal",
        capacityPackages,
      },
    });
  }
  if (!warehouse) throw new Error("could not allocate a fixture warehouse code");
  await prisma.serviceArea.create({
    data: {
      name: `P9 ${label} Area ${RUN}`,
      district,
      city: `P9 ${label}`,
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
): Promise<{ packageId: string; trackingId: string; shipmentId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId,
    sender: { name: "P9 Sender", phone: phone(42), email: null },
    recipient: {
      name: "P9 Recipient",
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
  const row = await prisma.shipment.findUniqueOrThrow({ where: { id: shipment.id } });
  charges[pkg.trackingId] = row.shippingChargePaisa;
  return { packageId: pkg.id, trackingId: pkg.trackingId, shipmentId: shipment.id };
}

/** Book at `from` → warehouse ops at `from` → transfer → destination
 *  receiving → RECEIVED_AT_DESTINATION at `to`. */
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
    idempotencyKey: `p9-load-${RUN}-${parcel.trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(from.wa, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(from.linehaul, tripId);
  await tripsSvc.arriveTrip(from.linehaul, tripId);
  const scan = await transfersSvc.scanDestinationPackage(to.wa, transfer.id, {
    trackingId: parcel.trackingId,
    idempotencyKey: `p9-unload-${RUN}-${parcel.trackingId}`,
  });
  expect(scan.kind).toBe("RECEIVED_SCAN");
  await transfersSvc.completePackageReceiving(to.wa, transfer.id, {
    packageId: parcel.packageId,
    condition: "GOOD",
  });
  await transfersSvc.finishReceiving(to.wa, transfer.id);
  await transfersSvc.reconcileTransfer(to.wa, transfer.id);
  await transfersSvc.closeTransfer(to.wa, transfer.id);
  const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
  expect(pkg.operationalStatus).toBe("RECEIVED_AT_DESTINATION");
  expect(pkg.currentWarehouseId).toBe(to.wh);
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

/** Assign + pick up + deliver a parcel that sits at `side`'s
 *  warehouse, optionally recording one failed attempt first. */
async function deliverAt(
  side: Side,
  parcel: { packageId: string; trackingId: string },
  codAmountPaisa: string,
  failFirst = false,
) {
  const batch = await deliveriesSvc.createDeliveryBatch(side.wa, {
    warehouseId: side.wh,
    riderUserId: side.riderUser,
    batchDate: TODAY,
    kind: "DELIVERY",
  });
  const added = await deliveriesSvc.addBatchPackages(side.wa, batch.id, {
    packageIds: [parcel.packageId],
  });
  expect(added.rejected).toEqual([]);
  expect(added.added).toHaveLength(1);
  const assignment = added.added[0];
  const pickup = await deliveriesSvc.confirmPickup(side.rider, batch.id, {
    trackingIds: [parcel.trackingId],
  });
  expect(pickup.failed).toEqual([]);
  if (failFirst) {
    const attempt = await deliveriesSvc.recordDeliveryAttempt(side.rider, assignment.id, {
      result: "RECIPIENT_UNAVAILABLE",
      notes: "Recipient not at home",
    });
    expect(attempt.failedAttempts).toBe(1);
    expect(attempt.returnRequest).toBeNull();
  }
  const delivered = await deliveriesSvc.confirmDelivery(side.rider, assignment.id, {
    receivedByName: "P9 Recipient",
    relationshipToRecipient: "Self",
    otpCode: await recipientOtp(assignment.id),
    codCollectedPaisa: codAmountPaisa,
  });
  return { ...parcel, batch, assignment, delivered };
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
  remittancesSvc = await import("@/server/services/cod-remittances");
  invoicesSvc = await import("@/server/services/invoices");
  settlementsSvc = await import("@/server/services/settlements");
  reportsSvc = await import("@/server/services/reports");
  reportsFinanceSvc = await import("@/server/services/reports-finance");
  reportsExportSvc = await import("@/server/services/reports-export");
  reportsDomain = await import("@/lib/reports/domain");
  errors = await import("@/lib/errors");
  actorErrors = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");

  rangeToday = (() => {
    const today = reportsDomain.kathmanduToday();
    return { from: today, to: today };
  })();

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
  fx.financeUser = await makeUser("finance", "FINANCE");
  financeActor = await actorFor(fx.financeUser);

  const a = await makeWarehouse("Alpha", 10);
  fx.whA = a.id;
  fx.codeA = a.code;
  fx.districtA = a.district;
  const b = await makeWarehouse("Beta", 20);
  fx.whB = b.id;
  fx.codeB = b.code;
  fx.districtB = b.district;

  serviceCode = `P9STD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P9 Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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
      businessName: `P9 Vendor ${label} ${RUN}`,
      contactName: "P9 Contact",
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
  fx.vendor1OwnerUser = await makeUser("vendor1Owner", "VENDOR");
  await prisma.vendorUser.create({
    data: { userId: fx.vendor1OwnerUser, vendorId: fx.vendor1, vendorRole: "OWNER", isActive: true, invitedById: fx.adminUser },
  });
  vendor1OwnerActor = await actorFor(fx.vendor1OwnerUser);
  fx.vendor2OwnerUser = await makeUser("vendor2Owner", "VENDOR");
  await prisma.vendorUser.create({
    data: { userId: fx.vendor2OwnerUser, vendorId: fx.vendor2, vendorRole: "OWNER", isActive: true, invitedById: fx.adminUser },
  });
  vendor2OwnerActor = await actorFor(fx.vendor2OwnerUser);

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
      licenseNumber: `LIC-P9-LH${label}-${RUN}`,
      licenseCategory: "C",
      licenseExpiry: "2030-01-01",
      capabilities: ["LINEHAUL"],
    });
    const vehicle = await vehiclesSvc.createVehicle(adminActor, {
      registration: `P9 TRK${label} ${RUN.slice(-6)}`.toUpperCase(),
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
      licenseNumber: `LIC-P9-R${label}-${RUN}`,
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
  riderBActor = sideB.rider;

  // --- The dataset -------------------------------------------------
  const p1 = await journey(sideA, sideB, fx.vendor1, "100000");
  fx.t1 = p1.trackingId;
  const d1 = await deliverAt(sideB, p1, "100000");
  const p2 = await journey(sideA, sideB, fx.vendor1, "50000");
  fx.t2 = p2.trackingId;
  const d2 = await deliverAt(sideB, p2, "50000");
  const p3 = await journey(sideA, sideB, fx.vendor1, "0");
  fx.t3 = p3.trackingId;
  await deliverAt(sideB, p3, "0");
  const p5 = await journey(sideA, sideB, fx.vendor2, "20000");
  fx.t5 = p5.trackingId;
  await deliverAt(sideB, p5, "20000", true);
  const p4 = await journey(sideB, sideA, fx.vendor2, "70000");
  fx.t4 = p4.trackingId;
  await deliverAt(sideA, p4, "70000");

  // P6: vendor1 parcel received and stored at A, never dispatched.
  const p6 = await bookOne(sideA, sideB, fx.vendor1, "0");
  await inventorySvc.receivePackage(sideA.staff, { warehouseId: sideA.wh, trackingId: p6.trackingId });
  await inventorySvc.moveToInspection(sideA.staff, p6.packageId);
  await inventorySvc.startInspection(sideA.staff, p6.packageId);
  await inventorySvc.recordInspection(sideA.staff, {
    packageId: p6.packageId,
    condition: "GOOD",
    actualWeightKg: 2,
  });
  await inventorySvc.putAwayPackage(sideA.staff, p6.packageId, sideA.locSto);
  fx.p6 = p6.packageId;

  // P7: vendor2 parcel travels B→A and stays in stock at A.
  const p7 = await journey(sideB, sideA, fx.vendor2, "0");
  fx.p7 = p7.packageId;

  // Remittance: riderB hands over P1+P2 exactly; finance verifies.
  const coll1 = await prisma.deliveryCodCollection.findUniqueOrThrow({
    where: { packageId: p1.packageId },
  });
  const coll2 = await prisma.deliveryCodCollection.findUniqueOrThrow({
    where: { packageId: p2.packageId },
  });
  const remittance = await remittancesSvc.submitRemittance(riderBActor, {
    collectionIds: [coll1.id, coll2.id],
    declaredAmountPaisa: "150000",
    method: "CASH",
  });
  const verified = await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
    countedAmountPaisa: "150000",
  });
  expect(verified.status).toBe("VERIFIED");
  void d1;
  void d2;

  // Invoices: vendor1 (P1+P2+P3 charges), vendor2 (P4+P5 charges).
  const invoice1 = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId: fx.vendor1 });
  expect(invoice1).not.toBeNull();
  fx.invoice1 = invoice1!.id;
  fx.invoice1Total = invoice1!.totalPaisa;
  const invoice2 = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId: fx.vendor2 });
  expect(invoice2).not.toBeNull();
  fx.invoice2 = invoice2!.id;
  fx.invoice2Total = invoice2!.totalPaisa;
  // Ageing fixture: vendor2's invoice fell due 40 days ago.
  await prisma.invoice.update({
    where: { id: fx.invoice2 },
    data: { dueAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
  });

  // Settlement: vendor1's verified COD minus its invoice charges.
  const prepared = await settlementsSvc.prepareSettlement(financeActor, {
    vendorId: fx.vendor1,
    deductions: [],
  });
  fx.settlement1 = prepared.id;
  fx.settlement1Net = prepared.netPayablePaisa;
  await settlementsSvc.approveSettlement(adminActor, prepared.id);
  const paid = await settlementsSvc.paySettlement(financeActor, prepared.id, {
    method: "BANK_TRANSFER",
    transactionRef: `P9-SETTLE-${RUN}`,
  });
  expect(paid.status).toBe("SETTLED");
}, 600_000);

// ---------------------------------------------------------------------------

describe("overview report — figures reconcile with the records", () => {
  it("vendor1 filter: bookings, deliveries, invoicing and COD are exact", async () => {
    const report = await reportsSvc.getOverviewReport(adminActor, {
      ...rangeToday,
      vendorId: fx.vendor1,
    });
    expect(report.bookings).toBe(4);
    expect(report.packagesBooked).toBe(4);
    expect(report.delivered).toBe(3);
    expect(report.failedAttempts).toBe(0);
    expect(report.returnsCreated).toBe(0);
    expect(report.returnRatePercent).toBe(0);
    expect(report.onTimePercent).toBe(100);
    expect(report.lateDeliveries).toBe(0);
    expect(report.invoiced.count).toBe(1);
    expect(report.invoiced.totalPaisa).toBe(fx.invoice1Total);
    expect(report.cod.expectedPaisa).toBe("150000");
    expect(report.cod.collectedPaisa).toBe("150000");
    // Everything vendor1's riders collected has been verified into
    // clearing — nothing is still owed by a rider.
    expect(report.cod.outstandingWithRidersPaisa).toBe("0");
    expect(report.outstanding.openInvoices).toBe(0);
    expect(report.outstanding.outstandingPaisa).toBe("0");
    const todayRow = report.dailySeries.find((d) => d.date === rangeToday.from);
    expect(todayRow?.bookings).toBe(4);
    expect(todayRow?.delivered).toBe(3);
  });

  it("vendor2 filter: delivered 2, COD 90000 still with riders, invoice outstanding", async () => {
    const report = await reportsSvc.getOverviewReport(adminActor, {
      ...rangeToday,
      vendorId: fx.vendor2,
    });
    expect(report.bookings).toBe(3);
    expect(report.delivered).toBe(2);
    expect(report.failedAttempts).toBe(1);
    expect(report.deliveryAttempts).toBe(3);
    expect(report.cod.expectedPaisa).toBe("90000");
    expect(report.cod.collectedPaisa).toBe("90000");
    expect(report.cod.outstandingWithRidersPaisa).toBe("90000");
    expect(report.outstanding.openInvoices).toBe(1);
    expect(report.outstanding.outstandingPaisa).toBe(fx.invoice2Total);
  });

  it("invoice totals equal the shipment charge snapshots (the Phase 9 reconciliation)", () => {
    // Each booking priced at base 15000 + 5000 × 1 kg billable = 20000.
    for (const t of [fx.t1, fx.t2, fx.t3, fx.t4, fx.t5]) {
      expect(charges[t]).toBe(BigInt(20000));
    }
    expect(BigInt(fx.invoice1Total)).toBe(
      charges[fx.t1] + charges[fx.t2] + charges[fx.t3],
    );
    expect(BigInt(fx.invoice2Total)).toBe(charges[fx.t4] + charges[fx.t5]);
    // Settlement net = verified COD − invoiced charges, exactly.
    expect(BigInt(fx.settlement1Net)).toBe(BigInt(150000) - BigInt(fx.invoice1Total));
  });

  it("empty range returns true zeros and null rates", async () => {
    const report = await reportsSvc.getOverviewReport(adminActor, {
      from: "2020-01-01",
      to: "2020-01-02",
      vendorId: fx.vendor1,
    });
    expect(report.bookings).toBe(0);
    expect(report.delivered).toBe(0);
    expect(report.returnRatePercent).toBeNull();
    expect(report.onTimePercent).toBeNull();
    expect(report.avgDeliveryMinutes).toBeNull();
    expect(report.cod.expectedPaisa).toBe("0");
    expect(report.cod.collectedPaisa).toBe("0");
    expect(report.dailySeries).toHaveLength(2);
    expect(report.dailySeries.every((d) => d.bookings === 0 && d.delivered === 0)).toBe(true);
  });
});

describe("date boundaries — Kathmandu days, both ends inclusive", () => {
  it("a booking made today counts today and not yesterday", async () => {
    const vendor3 = await vendorsSvc.createVendor(adminActor, {
      businessName: `P9 Vendor three ${RUN}`,
      contactName: "P9 Contact",
      email: email("vendor-three"),
      phone: phone(12),
      billingPreference: "COD_OFFSET",
      creditLimitPaisa: null,
      registrationNumber: null,
    });
    await vendorsSvc.setVendorVerificationStatus(adminActor, vendor3.id, {
      target: "UNDER_REVIEW",
      notes: null,
    });
    await vendorsSvc.setVendorVerificationStatus(adminActor, vendor3.id, {
      target: "APPROVED",
      notes: null,
    });
    await bookOne(sideA, sideB, vendor3.id, "0");

    const today = await reportsSvc.getOverviewReport(adminActor, {
      ...rangeToday,
      vendorId: vendor3.id,
    });
    expect(today.bookings).toBe(1);
    const yesterday = reportsDomain.addDays(rangeToday.from, -1);
    const yReport = await reportsSvc.getOverviewReport(adminActor, {
      from: yesterday,
      to: yesterday,
      vendorId: vendor3.id,
    });
    expect(yReport.bookings).toBe(0);
    expect(yReport.packagesBooked).toBe(0);
  });
});

describe("warehouse report — scope is enforced in the query, both directions", () => {
  it("warehouse A's admin sees only warehouse A, with A's exact figures", async () => {
    const report = await reportsSvc.getWarehouseReport(waAActor, { ...rangeToday });
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    expect(row.warehouseId).toBe(fx.whA);
    // A received: P1,P2,P3,P5,P6 at origin (5) + P4,P7 at destination (2).
    expect(row.received).toBe(7);
    expect(row.transfersDispatched).toBe(4);
    expect(row.packagesDispatched).toBe(4);
    expect(row.transfersArrived).toBe(2);
    // Only P4 was delivered from A — B's four deliveries never leak in.
    expect(row.delivered).toBe(1);
    expect(row.failedAttempts).toBe(0);
    // P6 stored + P7 in stock = 2 of capacity 10.
    expect(row.currentInventory).toBe(2);
    expect(row.capacityUtilisationPercent).toBe(20);
    expect(row.aging.days0to2).toBe(2);
    expect(row.aging.days3to7).toBe(0);
    expect(row.damagedInStock).toBe(0);
    expect(row.receivingDiscrepancies).toBe(0);
    const staff = new Map(row.staffReceiving.map((s) => [s.fullName, s.received]));
    expect(staff.get("P9 staffA")).toBe(5);
  });

  it("warehouse B's admin sees only warehouse B, with B's exact figures", async () => {
    const report = await reportsSvc.getWarehouseReport(waBActor, { ...rangeToday });
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    expect(row.warehouseId).toBe(fx.whB);
    // B received: P1,P2,P3,P5 at destination (4) + P4,P7 at origin (2).
    expect(row.received).toBe(6);
    expect(row.transfersDispatched).toBe(2);
    expect(row.transfersArrived).toBe(4);
    expect(row.delivered).toBe(4);
    expect(row.failedAttempts).toBe(1);
    // Everything that arrived at B left again — no stock, and A's
    // two in-stock parcels never leak in.
    expect(row.currentInventory).toBe(0);
    expect(row.capacityUtilisationPercent).toBe(0);
  });

  it("admin sees both warehouses with the same figures", async () => {
    const report = await reportsSvc.getWarehouseReport(adminActor, { ...rangeToday });
    const a = report.rows.find((r) => r.warehouseId === fx.whA);
    const b = report.rows.find((r) => r.warehouseId === fx.whB);
    expect(a?.received).toBe(7);
    expect(b?.received).toBe(6);
    expect(a?.delivered).toBe(1);
    expect(b?.delivered).toBe(4);
  });

  it("requesting the other warehouse is an audited denial, not an empty report", async () => {
    await expect(
      reportsSvc.getWarehouseReport(waAActor, { ...rangeToday, warehouseId: fx.whB }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const audit = await prisma.auditLog.findFirst({
      where: {
        actorId: waAActor.userId,
        action: "access.denied",
        warehouseId: fx.whB,
        after: { path: ["reason"], equals: "warehouse_scope_other_warehouse_report" },
      },
    });
    expect(audit).not.toBeNull();
    await expect(
      reportsSvc.getWarehouseReport(waBActor, { ...rangeToday, warehouseId: fx.whA }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("finance is denied operational warehouse reports (footnote 32)", async () => {
    await expect(
      reportsSvc.getWarehouseReport(financeActor, { ...rangeToday }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      reportsSvc.getOverviewReport(financeActor, { ...rangeToday }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });
});

describe("driver reports", () => {
  it("rider B's row is exact: assignments, attempts, COD position", async () => {
    const report = await reportsSvc.getDriverReport(adminActor, { ...rangeToday });
    const row = report.rows.find((r) => r.driverId === sideB.riderProfile);
    expect(row).toBeDefined();
    expect(row!.assigned).toBe(4);
    expect(row!.completed).toBe(4);
    expect(row!.failed).toBe(0);
    // 4 delivered attempts + P5's failed attempt.
    expect(row!.attempts).toBe(5);
    expect(row!.failedAttempts).toBe(1);
    expect(row!.delivered).toBe(4);
    expect(row!.onTimePercent).toBe(100);
    expect(row!.codExpectedPaisa).toBe("170000");
    expect(row!.codCollectedPaisa).toBe("170000");
    expect(row!.codRemittedVerifiedPaisa).toBe("150000");
    expect(row!.codOutstandingPaisa).toBe("20000");
  });

  it("rider A's row and the line-haul trip counts are exact", async () => {
    const report = await reportsSvc.getDriverReport(adminActor, { ...rangeToday });
    const riderA = report.rows.find((r) => r.driverId === sideA.riderProfile);
    expect(riderA!.assigned).toBe(1);
    expect(riderA!.delivered).toBe(1);
    expect(riderA!.codCollectedPaisa).toBe("70000");
    expect(riderA!.codOutstandingPaisa).toBe("70000");
    const lhA = report.rows.find((r) => r.driverId === sideA.linehaulProfile);
    expect(lhA!.trips).toBe(4);
    expect(lhA!.tripsCompleted).toBe(4);
    const lhB = report.rows.find((r) => r.driverId === sideB.linehaulProfile);
    expect(lhB!.trips).toBe(2);
    expect(lhB!.tripsCompleted).toBe(2);
  });

  it("self report: a rider sees exactly their own row", async () => {
    const report = await reportsSvc.getDriverSelfReport(riderBActor, { ...rangeToday });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].driverId).toBe(sideB.riderProfile);
    expect(report.rows[0].delivered).toBe(4);
  });

  it("self report naming another driver is an audited denial", async () => {
    await expect(
      reportsSvc.getDriverSelfReport(riderBActor, {
        ...rangeToday,
        driverId: sideA.riderProfile,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const audit = await prisma.auditLog.findFirst({
      where: {
        actorId: riderBActor.userId,
        action: "access.denied",
        after: { path: ["reason"], equals: "driver_self_report_other_driver" },
      },
    });
    expect(audit).not.toBeNull();
  });

  it("a rider cannot read the all-drivers report", async () => {
    await expect(
      reportsSvc.getDriverReport(riderBActor, { ...rangeToday }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("a warehouse admin's driver report covers only riders homed at their warehouses", async () => {
    const report = await reportsSvc.getDriverReport(waAActor, { ...rangeToday });
    const ids = report.rows.map((r) => r.driverId);
    expect(ids).toContain(sideA.riderProfile);
    expect(ids).toContain(sideA.linehaulProfile);
    expect(ids).not.toContain(sideB.riderProfile);
    expect(ids).not.toContain(sideB.linehaulProfile);
  });
});

describe("vendor reports — own data only", () => {
  it("vendor1's row is exact, including the settled statement figures", async () => {
    const report = await reportsSvc.getVendorReport(vendor1OwnerActor, { ...rangeToday });
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    expect(row.vendorId).toBe(fx.vendor1);
    expect(row.bookings).toBe(4);
    expect(row.packages).toBe(4);
    expect(row.delivered).toBe(3);
    expect(row.deliverySuccessPercent).toBe(100);
    expect(row.chargesInvoicedPaisa).toBe(fx.invoice1Total);
    expect(row.invoicesIssued).toBe(1);
    expect(row.outstandingPaisa).toBe("0");
    expect(row.codExpectedPaisa).toBe("150000");
    expect(row.codCollectedPaisa).toBe("150000");
    expect(row.codSettledPaisa).toBe("150000");
    expect(row.settlementsPaid).toBe(1);
    expect(row.settlementsPaidPaisa).toBe(fx.settlement1Net);
    expect(row.payableBalancePaisa).toBe("0");
  });

  it("vendor2's row is exact: COD collected, nothing settled, invoice outstanding", async () => {
    const report = await reportsSvc.getVendorReport(vendor2OwnerActor, { ...rangeToday });
    expect(report.rows).toHaveLength(1);
    const row = report.rows[0];
    expect(row.bookings).toBe(3);
    expect(row.delivered).toBe(2);
    expect(row.codCollectedPaisa).toBe("90000");
    expect(row.codSettledPaisa).toBe("0");
    expect(row.settlementsPaid).toBe(0);
    expect(row.outstandingPaisa).toBe(fx.invoice2Total);
    expect(row.chargesInvoicedPaisa).toBe(fx.invoice2Total);
  });

  it("a vendor naming another vendor is an audited denial", async () => {
    await expect(
      reportsSvc.getVendorReport(vendor1OwnerActor, {
        ...rangeToday,
        vendorId: fx.vendor2,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const audit = await prisma.auditLog.findFirst({
      where: {
        actorId: vendor1OwnerActor.userId,
        action: "access.denied",
        after: { path: ["reason"], equals: "vendor_scope_other_vendor_report" },
      },
    });
    expect(audit).not.toBeNull();
  });

  it("admin vendor report includes both vendors with the same figures", async () => {
    const report = await reportsSvc.getVendorReport(adminActor, { ...rangeToday });
    const v1 = report.rows.find((r) => r.vendorId === fx.vendor1);
    const v2 = report.rows.find((r) => r.vendorId === fx.vendor2);
    expect(v1?.delivered).toBe(3);
    expect(v2?.delivered).toBe(2);
    expect(v1?.codSettledPaisa).toBe("150000");
    expect(v2?.codSettledPaisa).toBe("0");
  });
});

describe("COD report — reconciles to the paisa under every scope", () => {
  it("driver filter: rider B's cohort is exact and internally consistent", async () => {
    const report = await reportsFinanceSvc.getCodReport(financeActor, {
      ...rangeToday,
      driverId: sideB.riderProfile,
    });
    const t = report.totals;
    expect(t.expectedPaisa).toBe("170000");
    expect(t.collectedPaisa).toBe("170000");
    expect(t.differencePaisa).toBe("0");
    expect(t.mismatchCollections).toBe(0);
    expect(t.remittedVerifiedPaisa).toBe("150000");
    expect(t.awaitingRemittancePaisa).toBe("20000");
    expect(t.inOpenRemittancePaisa).toBe("0");
    expect(t.outstandingPaisa).toBe("20000");
    // Identity: outstanding = awaiting + in-open; collected − verified = outstanding.
    expect(BigInt(t.awaitingRemittancePaisa) + BigInt(t.inOpenRemittancePaisa)).toBe(
      BigInt(t.outstandingPaisa),
    );
    expect(BigInt(t.collectedPaisa) - BigInt(t.remittedVerifiedPaisa)).toBe(
      BigInt(t.outstandingPaisa),
    );
    expect(report.riders).toHaveLength(1);
    expect(report.riders[0].key).toBe(sideB.riderProfile);
    const whB = report.warehouses.find((w) => w.key === fx.whB);
    expect(whB?.collectedPaisa).toBe("170000");
  });

  it("warehouse filter: warehouse A's cohort is rider A's single collection", async () => {
    const report = await reportsFinanceSvc.getCodReport(financeActor, {
      ...rangeToday,
      warehouseId: fx.whA,
    });
    expect(report.totals.expectedPaisa).toBe("70000");
    expect(report.totals.collectedPaisa).toBe("70000");
    expect(report.totals.remittedVerifiedPaisa).toBe("0");
    expect(report.totals.outstandingPaisa).toBe("70000");
    expect(report.riders.map((r) => r.key)).toEqual([sideA.riderProfile]);
  });

  it("warehouse A's admin reads the same scoped cohort; B is an audited denial", async () => {
    const report = await reportsFinanceSvc.getCodReport(waAActor, { ...rangeToday });
    expect(report.totals.collectedPaisa).toBe("70000");
    expect(report.totals.outstandingPaisa).toBe("70000");
    await expect(
      reportsFinanceSvc.getCodReport(waAActor, { ...rangeToday, warehouseId: fx.whB }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("vendor1 reads only its own collections — all verified, nothing outstanding", async () => {
    const report = await reportsFinanceSvc.getCodReport(vendor1OwnerActor, {
      ...rangeToday,
    });
    expect(report.totals.expectedPaisa).toBe("150000");
    expect(report.totals.collectedPaisa).toBe("150000");
    expect(report.totals.remittedVerifiedPaisa).toBe("150000");
    expect(report.totals.outstandingPaisa).toBe("0");
    await expect(
      reportsFinanceSvc.getCodReport(vendor1OwnerActor, {
        ...rangeToday,
        vendorId: fx.vendor2,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("rider B reads their own cohort; naming rider A is denied", async () => {
    const report = await reportsFinanceSvc.getCodReport(riderBActor, { ...rangeToday });
    expect(report.totals.collectedPaisa).toBe("170000");
    expect(report.totals.outstandingPaisa).toBe("20000");
    await expect(
      reportsFinanceSvc.getCodReport(riderBActor, {
        ...rangeToday,
        driverId: sideA.riderProfile,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });
});

describe("finance report", () => {
  it("vendor2 filter: invoiced total, outstanding and the 31–60 day ageing bucket are exact", async () => {
    const report = await reportsFinanceSvc.getFinanceReport(financeActor, {
      ...rangeToday,
      vendorId: fx.vendor2,
    });
    expect(report.invoiced.count).toBe(1);
    expect(report.invoiced.totalPaisa).toBe(fx.invoice2Total);
    expect(report.outstanding.openInvoices).toBe(1);
    expect(report.outstanding.outstandingPaisa).toBe(fx.invoice2Total);
    expect(report.outstanding.ageing.overdue31to60Paisa).toBe(fx.invoice2Total);
    expect(report.outstanding.ageing.notDuePaisa).toBe("0");
    expect(report.outstanding.ageing.overdue1to30Paisa).toBe("0");
    expect(report.codReconciliation.expectedPaisa).toBe("90000");
    expect(report.codReconciliation.collectedPaisa).toBe("90000");
  });

  it("vendor1 filter: settlement paid out, nothing outstanding", async () => {
    const report = await reportsFinanceSvc.getFinanceReport(financeActor, {
      ...rangeToday,
      vendorId: fx.vendor1,
    });
    expect(report.invoiced.totalPaisa).toBe(fx.invoice1Total);
    expect(report.outstanding.outstandingPaisa).toBe("0");
    expect(report.settlements.paidOut.count).toBe(1);
    expect(report.settlements.paidOut.netPayablePaisa).toBe(fx.settlement1Net);
    const settled = report.settlements.byStatus.find((s) => s.status === "SETTLED");
    expect(settled?.count).toBe(1);
    expect(report.codReconciliation.expectedPaisa).toBe("150000");
  });

  it("warehouse admins cannot read the finance report", async () => {
    await expect(
      reportsFinanceSvc.getFinanceReport(waAActor, { ...rangeToday }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });
});

describe("daily + transfer reports", () => {
  it("daily for warehouse B is exact; the invoice line is omitted under warehouse scope", async () => {
    const daily = await reportsSvc.getDailyReport(adminActor, {
      from: rangeToday.from,
      warehouseId: fx.whB,
    });
    expect(daily.date).toBe(rangeToday.from);
    expect(daily.bookings).toBe(2);
    expect(daily.packagesReceived).toBe(6);
    expect(daily.transfersDispatched).toBe(2);
    expect(daily.packagesDispatched).toBe(2);
    expect(daily.delivered).toBe(4);
    expect(daily.failedAttempts).toBe(1);
    expect(daily.codCollectedPaisa).toBe("170000");
    expect(daily.invoicedTotalPaisa).toBeNull();
  });

  it("warehouse B's admin gets the same daily for their own warehouse", async () => {
    const daily = await reportsSvc.getDailyReport(waBActor, { from: rangeToday.from });
    expect(daily.delivered).toBe(4);
    expect(daily.packagesReceived).toBe(6);
  });

  it("transfer routes are exact for both directions", async () => {
    const report = await reportsSvc.getTransferReport(adminActor, { ...rangeToday });
    const ab = report.rows.find(
      (r) => r.originWarehouseId === fx.whA && r.destinationWarehouseId === fx.whB,
    );
    const ba = report.rows.find(
      (r) => r.originWarehouseId === fx.whB && r.destinationWarehouseId === fx.whA,
    );
    expect(ab?.transfers).toBe(4);
    expect(ab?.items).toBe(4);
    expect(ab?.itemsReceived).toBe(4);
    expect(ab?.itemsDiscrepant).toBe(0);
    expect(ab?.byStatus).toEqual([{ status: "CLOSED", count: 4 }]);
    expect(ba?.transfers).toBe(2);
    expect(ba?.itemsReceived).toBe(2);
  });

  it("a warehouse admin's transfer report only touches their warehouses", async () => {
    const report = await reportsSvc.getTransferReport(waAActor, { ...rangeToday });
    expect(report.rows.length).toBeGreaterThan(0);
    for (const row of report.rows) {
      expect(
        row.originWarehouseId === fx.whA || row.destinationWarehouseId === fx.whA,
      ).toBe(true);
    }
  });
});

describe("CSV export — same scoped data as the report", () => {
  it("warehouse export for A contains A's figures and code", async () => {
    const { csv } = await reportsExportSvc.buildReportCsv(adminActor, "warehouses", {
      ...rangeToday,
      warehouseId: fx.whA,
    });
    expect(csv).toContain(fx.codeA);
    expect(csv).not.toContain(fx.codeB);
    const line = csv.split("\r\n").find((l) => l.includes(fx.codeA));
    expect(line).toContain(",7,"); // received = 7
  });

  it("warehouse A's admin exporting warehouse B is denied", async () => {
    await expect(
      reportsExportSvc.buildReportCsv(waAActor, "warehouses", {
        ...rangeToday,
        warehouseId: fx.whB,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("vendor export contains only the vendor's own row", async () => {
    const { csv } = await reportsExportSvc.buildReportCsv(vendor1OwnerActor, "vendors", {
      ...rangeToday,
    });
    expect(csv).toContain(`P9 Vendor one ${RUN}`);
    expect(csv).not.toContain(`P9 Vendor two ${RUN}`);
  });

  it("unknown report names are rejected", async () => {
    await expect(
      reportsExportSvc.buildReportCsv(adminActor, "secrets", { ...rangeToday }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
  });
});

// The return scenario runs LAST: it changes vendor2's return figures
// and warehouse A's failed-attempt count, which the describes above
// assert in their pre-return state.
describe("returns flow into the reports", () => {
  it("a completed vendor2 return moves its success rate and the return rate", async () => {
    const parcel = await journey(sideB, sideA, fx.vendor2, "0");
    const batch = await deliveriesSvc.createDeliveryBatch(sideA.wa, {
      warehouseId: sideA.wh,
      riderUserId: sideA.riderUser,
      batchDate: TODAY,
      kind: "DELIVERY",
    });
    const added = await deliveriesSvc.addBatchPackages(sideA.wa, batch.id, {
      packageIds: [parcel.packageId],
    });
    const assignment = added.added[0];
    await deliveriesSvc.confirmPickup(sideA.rider, batch.id, {
      trackingIds: [parcel.trackingId],
    });
    const attempt = await deliveriesSvc.recordDeliveryAttempt(sideA.rider, assignment.id, {
      result: "REFUSED",
      notes: "Recipient refused the parcel at the door",
    });
    expect(attempt.returnRequest).not.toBeNull();
    const ret = await prisma.returnRequest.findFirstOrThrow({
      where: { packageId: parcel.packageId },
    });
    await returnsSvc.approveReturn(sideA.wa, ret.id, {
      chargeBearer: "VENDOR",
      chargeAmountPaisa: "5000",
    });
    const scan = await deliveriesSvc.scanBackPackage(sideA.staff, {
      warehouseId: sideA.wh,
      trackingId: parcel.trackingId,
    });
    expect(scan.returnRequest?.status).toBe("RECEIVED");
    await returnsSvc.inspectReturn(sideA.staff, ret.id, { condition: "GOOD" });
    const completed = await returnsSvc.completeReturn(sideA.wa, ret.id, {});
    expect(completed.status).toBe("COMPLETED");

    const vendorReport = await reportsSvc.getVendorReport(vendor2OwnerActor, {
      ...rangeToday,
    });
    const row = vendorReport.rows[0];
    expect(row.returnsCreated).toBe(1);
    expect(row.returnsCompleted).toBe(1);
    // delivered 2 of (2 delivered + 1 completed return) outcomes.
    expect(row.deliverySuccessPercent).toBe(66.67);

    const overview = await reportsSvc.getOverviewReport(adminActor, {
      ...rangeToday,
      vendorId: fx.vendor2,
    });
    expect(overview.returnsCreated).toBe(1);
    // 1 return ÷ 2 delivered in the period.
    expect(overview.returnRatePercent).toBe(50);
  });
});
