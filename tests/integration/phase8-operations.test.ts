import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 8 integration tests (docs: implementation-roadmap Phase 8,
 * exception-management, delivery-workflow line 112) against the
 * local bla_test database:
 *
 *  - P6-R1 CLOSURE (the acceptance criterion): pickup and
 *    regenerate responses carry NO delivery code; the code is
 *    delivered to the RECIPIENT as a notification and read back
 *    only through the phone-verified detailed tracking view; the
 *    rider cannot self-deliver from API responses alone, and
 *    delivery with the recipient-retrieved code succeeds.
 *  - Incident auto-creation at the prepared link points (COD
 *    discrepancy, disputed handover, transfer shortage, scan-back
 *    displacement, misroute) — idempotent per source event.
 *  - Incident lifecycle authority + MISROUTED clearance through
 *    the resolution workflow.
 *  - Tasks: assignee-only completion, overdue derivation.
 *  - Tickets: cross-vendor isolation (audited), internal notes
 *    hidden from the raiser, support reply notifies the raiser,
 *    escalation into an investigation task, public tracking
 *    complaint.
 *  - Notifications: owner-only mark-read, exact unread counts,
 *    settlement-paid trigger.
 *
 * Fixture warehouses are SHARED across runs (WH-ZP8 codes,
 * find-or-create); users/vendors/bookings are per-run unique.
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
const email = (label: string) => `p8-${label}-${RUN}@bla.test`;
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
let packagesSvc: typeof import("@/server/services/packages");
let custodySvc: typeof import("@/server/services/custody");
let remittancesSvc: typeof import("@/server/services/cod-remittances");
let invoicesSvc: typeof import("@/server/services/invoices");
let settlementsSvc: typeof import("@/server/services/settlements");
let incidentsSvc: typeof import("@/server/services/incidents");
let tasksSvc: typeof import("@/server/services/tasks");
let ticketsSvc: typeof import("@/server/services/support-tickets");
let notificationsSvc: typeof import("@/server/services/notifications");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let financeActor: Awaited<ReturnType<typeof actorFor>>;
let supportActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
let staffBActor: Awaited<ReturnType<typeof actorFor>>;
let waCActor: Awaited<ReturnType<typeof actorFor>>;
let linehaulActor: Awaited<ReturnType<typeof actorFor>>;
let riderAActor: Awaited<ReturnType<typeof actorFor>>;
let vendorOwnerActor: Awaited<ReturnType<typeof actorFor>>;
let vendor2OwnerActor: Awaited<ReturnType<typeof actorFor>>;
let customerActor: Awaited<ReturnType<typeof actorFor>>;
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
      fullName: `P8 ${label}`,
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
  vendorId: string,
  codAmountPaisa = "0",
  destDistrict: string = fx.districtB,
): Promise<{ packageId: string; trackingId: string; shipmentId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId,
    sender: { name: "P8 Sender", phone: phone(42), email: null },
    recipient: {
      name: "P8 Recipient",
      phone: RECIPIENT_PHONE,
      addressLine: "Lakeside Street 1",
      city: "Town",
      district: destDistrict,
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

/** Book at A → receive/inspect/put-away/ready at A → transfer A→B →
 *  destination receive → RECEIVED_AT_DESTINATION at B. */
async function atDestination(vendorId: string, codAmountPaisa = "0") {
  const parcel = await bookOne(vendorId, codAmountPaisa);
  await inventorySvc.receivePackage(staffAActor, { warehouseId: fx.whA, trackingId: parcel.trackingId });
  await inventorySvc.moveToInspection(staffAActor, parcel.packageId);
  await inventorySvc.startInspection(staffAActor, parcel.packageId);
  await inventorySvc.recordInspection(staffAActor, {
    packageId: parcel.packageId,
    condition: "GOOD",
    actualWeightKg: 2,
  });
  await inventorySvc.putAwayPackage(staffAActor, parcel.packageId, fx.locStoA);
  await inventorySvc.markReadyForDispatch(staffAActor, parcel.packageId);

  const transfer = await transfersSvc.createTransfer(waAActor, {
    originWarehouseId: fx.whA,
    destinationWarehouseId: fx.whB,
  });
  const added = await transfersSvc.addTransferItems(waAActor, transfer.id, [parcel.packageId]);
  expect(added.rejected).toEqual([]);
  await transfersSvc.generateManifest(waAActor, transfer.id);
  const crewed = await transfersSvc.assignTransferCrew(waAActor, {
    transferId: transfer.id,
    driverId: fx.linehaulProfile,
    vehicleId: fx.vehicle,
  });
  const loaded = await transfersSvc.loadTransferPackage(waAActor, transfer.id, {
    trackingId: parcel.trackingId,
    idempotencyKey: `p8-load-${RUN}-${parcel.trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(linehaulActor, tripId);
  await tripsSvc.arriveTrip(linehaulActor, tripId);
  const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
    trackingId: parcel.trackingId,
    idempotencyKey: `p8-unload-${RUN}-${parcel.trackingId}`,
  });
  expect(scan.kind).toBe("RECEIVED_SCAN");
  await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
    packageId: parcel.packageId,
    condition: "GOOD",
  });
  await transfersSvc.finishReceiving(waBActor, transfer.id);
  await transfersSvc.reconcileTransfer(waBActor, transfer.id);
  await transfersSvc.closeTransfer(waBActor, transfer.id);
  const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
  expect(pkg.operationalStatus).toBe("RECEIVED_AT_DESTINATION");
  expect(pkg.currentWarehouseId).toBe(fx.whB);
  return parcel;
}

async function outForDelivery(vendorId: string, codAmountPaisa = "0") {
  const parcel = await atDestination(vendorId, codAmountPaisa);
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
  expect(added.added).toHaveLength(1);
  const pickup = await deliveriesSvc.confirmPickup(riderAActor, batch.id, {
    trackingIds: [parcel.trackingId],
  });
  expect(pickup.failed).toEqual([]);
  expect(pickup.taken).toHaveLength(1);
  return { ...parcel, batch, assignment: added.added[0], pickup };
}

/** The recipient's copy of the current delivery code — read from
 *  the recipient-addressed DELIVERY_OTP notification, exactly what
 *  the phone-verified tracking view returns. */
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

const wrongOtpFor = (real: string) => (real === "000000" ? "111111" : "000000");

async function deliverCod(vendorId: string, codAmountPaisa: string) {
  const { assignment, pickup, ...parcel } = await outForDelivery(vendorId, codAmountPaisa);
  void pickup;
  const delivered = await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
    receivedByName: "P8 Recipient",
    relationshipToRecipient: "Self",
    otpCode: await recipientOtp(assignment.id),
    codCollectedPaisa: codAmountPaisa,
  });
  expect(delivered.cod?.status).toBe("MATCHED");
  const collection = await prisma.deliveryCodCollection.findUniqueOrThrow({
    where: { packageId: parcel.packageId },
  });
  return { ...parcel, assignment, collectionId: collection.id };
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
  packagesSvc = await import("@/server/services/packages");
  custodySvc = await import("@/server/services/custody");
  remittancesSvc = await import("@/server/services/cod-remittances");
  invoicesSvc = await import("@/server/services/invoices");
  settlementsSvc = await import("@/server/services/settlements");
  incidentsSvc = await import("@/server/services/incidents");
  tasksSvc = await import("@/server/services/tasks");
  ticketsSvc = await import("@/server/services/support-tickets");
  notificationsSvc = await import("@/server/services/notifications");
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
  fx.financeUser = await makeUser("finance", "FINANCE");
  financeActor = await actorFor(fx.financeUser);
  fx.supportUser = await makeUser("support", "SUPPORT");
  supportActor = await actorFor(fx.supportUser);

  fx.districtA = "P8Alpha District";
  fx.districtB = "P8Beta District";
  fx.districtC = "P8Gamma District";
  const a = await ensureWarehouse("WH-ZP8-01", "P8 Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  const b = await ensureWarehouse("WH-ZP8-02", "P8 Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;
  const c = await ensureWarehouse("WH-ZP8-03", "P8 Gamma (shared fixture)", fx.districtC);
  fx.whC = c.id;

  serviceCode = `P8STD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P8 Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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
      businessName: `P8 Vendor ${label} ${RUN}`,
      contactName: "P8 Contact",
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
  fx.vendor = await makeVendor("one");
  fx.vendor2 = await makeVendor("two");
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
  vendorOwnerActor = await actorFor(fx.vendorOwnerUser);
  fx.vendor2OwnerUser = await makeUser("vendor2Owner", "VENDOR");
  await prisma.vendorUser.create({
    data: {
      userId: fx.vendor2OwnerUser,
      vendorId: fx.vendor2,
      vendorRole: "OWNER",
      isActive: true,
      invitedById: fx.adminUser,
    },
  });
  vendor2OwnerActor = await actorFor(fx.vendor2OwnerUser);

  // The recipient customer holds an account linked to the very
  // phone the bookings use — findOrCreateCustomer reuses this row.
  fx.customerUser = await makeUser("customer", "CUSTOMER");
  const customer = await prisma.customer.create({
    data: {
      fullName: "P8 Recipient",
      phone: RECIPIENT_PHONE,
      normalizedPhone: RECIPIENT_PHONE,
      userId: fx.customerUser,
    },
  });
  fx.customer = customer.id;
  customerActor = await actorFor(fx.customerUser);
  expect(customerActor.customerId).toBe(fx.customer);

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

  fx.linehaulUser = await makeUser("linehaul", "LINEHAUL_DRIVER");
  const linehaul = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.linehaulUser,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P8-LH-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.linehaulProfile = linehaul.id;
  linehaulActor = await actorFor(fx.linehaulUser);
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P8 TRK ${RUN.slice(-6)}`.toUpperCase(),
    type: "TRUCK",
    capacityKg: 5000,
    homeWarehouseId: fx.whA,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  fx.vehicle = vehicle.id;

  fx.riderAUser = await makeUser("riderA", "RIDER");
  const riderProfile = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.riderAUser,
    homeWarehouseId: fx.whB,
    licenseNumber: `LIC-P8-RA-${RUN}`,
    licenseCategory: "A",
    licenseExpiry: "2030-01-01",
    capabilities: ["DELIVERY"],
  });
  fx.riderAProfile = riderProfile.id;
  riderAActor = await actorFor(fx.riderAUser);
  expect(riderAActor.driverId).toBe(fx.riderAProfile);
}, 240_000);

// ---------------------------------------------------------------------------

describe("P6-R1 closure — the delivery code belongs to the recipient", () => {
  it("pickup returns no code; the recipient retrieves it via phone-verified tracking and delivery succeeds with it", async () => {
    const { packageId, trackingId, assignment, pickup } = await outForDelivery(fx.vendor);

    // The pickup response carries OTP state only — no code anywhere.
    expect(pickup.taken[0]).not.toHaveProperty("otp");
    expect(pickup.taken[0].otpGenerated).toBe(true);
    expect(JSON.stringify(pickup)).not.toMatch(/"otp":"?\d{6}/);

    // The code was delivered to the RECIPIENT: a TRACKING-channel
    // notification addressed by phone, plus an honest SMS intent row.
    const trackingNote = await prisma.notification.findFirst({
      where: {
        category: "DELIVERY_OTP",
        channel: "TRACKING",
        entityType: "DeliveryAssignment",
        entityId: assignment.id,
      },
    });
    expect(trackingNote).not.toBeNull();
    expect(trackingNote!.userId).toBeNull();
    expect(trackingNote!.recipientPhone).toBe(RECIPIENT_PHONE);
    expect(trackingNote!.deliveryStatus).toBe("AVAILABLE");
    const code = (trackingNote!.payload as { otpCode: string }).otpCode;
    expect(code).toMatch(/^\d{6}$/);
    const smsNote = await prisma.notification.findFirst({
      where: {
        category: "DELIVERY_OTP",
        channel: "SMS",
        entityType: "DeliveryAssignment",
        entityId: assignment.id,
      },
    });
    expect(smsNote?.deliveryStatus).toBe("NOT_SENT_NO_PROVIDER");
    // …and NEVER to the rider: no DELIVERY_OTP row is addressed to
    // any user, least of all the rider.
    const riderOtpRows = await prisma.notification.count({
      where: { category: "DELIVERY_OTP", userId: { not: null } },
    });
    expect(riderOtpRows).toBe(0);

    // Before pickup the detailed view exposes no code; with the
    // WRONG phone it exposes nothing at all.
    await expect(packagesSvc.getDetailedTracking(trackingId, phone(999))).rejects.toBeInstanceOf(
      errors.NotFoundError,
    );
    // The recipient proves the phone and reads the current code.
    const view = await packagesSvc.getDetailedTracking(trackingId, RECIPIENT_PHONE);
    expect(view.deliveryCode).toBe(code);

    // The rider cannot self-deliver: a guessed code fails…
    await expect(
      deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
        receivedByName: "P8 Recipient",
        otpCode: wrongOtpFor(code),
      }),
    ).rejects.toThrow(/incorrect/i);
    // …and the recipient-retrieved code succeeds.
    const delivered = await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P8 Recipient",
      otpCode: view.deliveryCode!,
    });
    expect(delivered.assignment.status).toBe("COMPLETED");
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.operationalStatus).toBe("DELIVERED");
  }, 180_000);

  it("regeneration returns no code either; only the newest recipient code works", async () => {
    const { assignment } = await outForDelivery(fx.vendor);
    const firstCode = await recipientOtp(assignment.id);

    const regen = await deliveriesSvc.regenerateOtp(riderAActor, assignment.id);
    expect(regen).not.toHaveProperty("otp");
    expect(regen.locked).toBe(false);
    expect(JSON.stringify(regen)).not.toContain(firstCode);

    const pkgRow = await prisma.package.findUniqueOrThrow({ where: { id: assignment.packageId } });
    const view = await packagesSvc.getDetailedTracking(pkgRow.trackingId, RECIPIENT_PHONE);
    const newCode = view.deliveryCode;
    expect(newCode).toMatch(/^\d{6}$/);

    // The superseded code is dead.
    await expect(
      deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
        receivedByName: "P8 Recipient",
        otpCode: firstCode === newCode ? wrongOtpFor(newCode!) : firstCode,
      }),
    ).rejects.toThrow(/incorrect|locked/i);
    const delivered = await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P8 Recipient",
      otpCode: newCode!,
    });
    expect(delivered.assignment.status).toBe("COMPLETED");
  }, 180_000);
});

// ---------------------------------------------------------------------------

describe("incident auto-creation at the Phase 4–7 link points", () => {
  it("COD discrepancy opens exactly one incident, however often verification is attempted", async () => {
    const delivered = await deliverCod(fx.vendor, "500000");
    const remittance = await remittancesSvc.submitRemittance(riderAActor, {
      collectionIds: [delivered.collectionId],
      declaredAmountPaisa: "500000",
      method: "CASH",
    });
    const parked = await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
      countedAmountPaisa: "450000",
    });
    expect(parked.status).toBe("DISCREPANCY");

    const incidents = await prisma.incident.findMany({
      where: { sourceKey: `cod-discrepancy:${remittance.id}` },
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].category).toBe("COD_DISCREPANCY");
    expect(incidents[0].severity).toBe("HIGH");
    expect(incidents[0].remittanceId).toBe(remittance.id);
    expect(incidents[0].status).toBe("REPORTED");
    fx.codIncident = incidents[0].id;

    // Firing the source again is refused by the remittance state
    // guard — and still leaves exactly one incident.
    await expect(
      remittancesSvc.verifyRemittance(financeActor, remittance.id, {
        countedAmountPaisa: "450000",
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    expect(
      await prisma.incident.count({ where: { sourceKey: `cod-discrepancy:${remittance.id}` } }),
    ).toBe(1);

    // The incident fan-out notified the platform team. (The
    // verifying finance user is the incident's reporter and is
    // excluded from their own fan-out by design — the incident is
    // in their queue regardless. Admin receives it because the
    // remittance belongs to a warehouse.)
    const finNote = await prisma.notification.findFirst({
      where: {
        userId: fx.adminUser,
        category: "INCIDENT_CREATED",
        entityType: "Incident",
        entityId: incidents[0].id,
      },
    });
    expect(finNote).not.toBeNull();
  }, 180_000);

  it("raiseIncidentInTx is idempotent per sourceKey under direct retry", async () => {
    const input = {
      sourceKey: `p8-retry-${RUN}`,
      category: "DELAYED_SHIPMENT" as const,
      description: "Retry idempotency probe",
      reporterId: fx.adminUser,
      warehouseId: fx.whA,
    };
    const first = await prisma.$transaction((tx) => incidentsSvc.raiseIncidentInTx(tx, input));
    expect(first.created).toBe(true);
    const second = await prisma.$transaction((tx) => incidentsSvc.raiseIncidentInTx(tx, input));
    expect(second.created).toBe(false);
    expect(second.incidentId).toBe(first.incidentId);
    expect(await prisma.incident.count({ where: { sourceKey: input.sourceKey } })).toBe(1);
  });

  it("a disputed handover opens exactly one HANDOVER_DISCREPANCY incident per missing line", async () => {
    const one = await bookOne(fx.vendor);
    const two = await bookOne(fx.vendor);
    await inventorySvc.receivePackage(staffAActor, { warehouseId: fx.whA, trackingId: one.trackingId });
    await inventorySvc.receivePackage(staffAActor, { warehouseId: fx.whA, trackingId: two.trackingId });
    const batch = await custodySvc.initiateHandover(waAActor, {
      packageIds: [one.packageId, two.packageId],
      toCustodianType: "USER",
      toUserId: fx.staffA,
    });
    await custodySvc.confirmHandoverPackage(staffAActor, {
      batchId: batch.id,
      packageId: one.packageId,
    });
    const closed = await custodySvc.closeHandoverBatch(waAActor, batch.id);
    expect(closed.status).toBe("DISPUTED");
    const missingLine = closed.lines.find((l) => l.packageId === two.packageId);
    expect(missingLine?.status).toBe("MISSING");

    const incidents = await prisma.incident.findMany({
      where: { sourceKey: `handover-dispute:${missingLine!.id}` },
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].category).toBe("HANDOVER_DISCREPANCY");
    expect(incidents[0].packageId).toBe(two.packageId);
    expect(incidents[0].handoverBatchId).toBe(batch.id);
    expect(incidents[0].warehouseId).toBe(fx.whA);
    fx.handoverIncident = incidents[0].id;

    // Closing again is refused (batch already DISPUTED) and the
    // incident count is unchanged.
    await expect(custodySvc.closeHandoverBatch(waAActor, batch.id)).rejects.toBeInstanceOf(
      errors.ConflictError,
    );
    expect(
      await prisma.incident.count({ where: { sourceKey: `handover-dispute:${missingLine!.id}` } }),
    ).toBe(1);
  }, 120_000);

  it("a transfer shortage marks the item MISSING, links its incident, and never duplicates it", async () => {
    const p1 = await bookOne(fx.vendor);
    const p2 = await bookOne(fx.vendor);
    for (const p of [p1, p2]) {
      await inventorySvc.receivePackage(staffAActor, { warehouseId: fx.whA, trackingId: p.trackingId });
      await inventorySvc.moveToInspection(staffAActor, p.packageId);
      await inventorySvc.startInspection(staffAActor, p.packageId);
      await inventorySvc.recordInspection(staffAActor, {
        packageId: p.packageId,
        condition: "GOOD",
        actualWeightKg: 2,
      });
      await inventorySvc.putAwayPackage(staffAActor, p.packageId, fx.locStoA);
      await inventorySvc.markReadyForDispatch(staffAActor, p.packageId);
    }
    const transfer = await transfersSvc.createTransfer(waAActor, {
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
    });
    const added = await transfersSvc.addTransferItems(waAActor, transfer.id, [p1.packageId, p2.packageId]);
    expect(added.rejected).toEqual([]);
    await transfersSvc.generateManifest(waAActor, transfer.id);
    const crewed = await transfersSvc.assignTransferCrew(waAActor, {
      transferId: transfer.id,
      driverId: fx.linehaulProfile,
      vehicleId: fx.vehicle,
    });
    let lastLoaded: Awaited<ReturnType<typeof transfersSvc.loadTransferPackage>> | null = null;
    for (const p of [p1, p2]) {
      lastLoaded = await transfersSvc.loadTransferPackage(waAActor, transfer.id, {
        trackingId: p.trackingId,
        idempotencyKey: `p8-load-${RUN}-${p.trackingId}`,
      });
    }
    // Both manifest packages load at origin — the shortage only
    // appears at destination, where p2 is never unload-scanned.
    expect(lastLoaded!.allLoaded).toBe(true);
    const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
    const tripId = dispatched.tripId ?? crewed.tripId!;
    await tripsSvc.departTrip(linehaulActor, tripId);
    await tripsSvc.arriveTrip(linehaulActor, tripId);
    // Only p1 is unload-scanned; p2 never arrives.
    const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
      trackingId: p1.trackingId,
      idempotencyKey: `p8-unload-${RUN}-${p1.trackingId}`,
    });
    expect(scan.kind).toBe("RECEIVED_SCAN");
    await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
      packageId: p1.packageId,
      condition: "GOOD",
    });
    await transfersSvc.finishReceiving(waBActor, transfer.id);

    const item2 = await prisma.transferItem.findFirstOrThrow({
      where: { transferId: transfer.id, packageId: p2.packageId },
    });
    expect(item2.itemStatus).toBe("MISSING");
    expect(item2.incidentId).not.toBeNull();
    const incidents = await prisma.incident.findMany({
      where: { sourceKey: `transfer-item-missing:${item2.id}` },
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].id).toBe(item2.incidentId);
    expect(incidents[0].category).toBe("TRANSFER_SHORTAGE");
    expect(incidents[0].packageId).toBe(p2.packageId);

    // Finishing receiving again does not duplicate the incident.
    await transfersSvc.finishReceiving(waBActor, transfer.id);
    expect(
      await prisma.incident.count({ where: { sourceKey: `transfer-item-missing:${item2.id}` } }),
    ).toBe(1);
  }, 180_000);

  it("a warehouse scan-back that displaces a rider raises an incident naming the rider and the reason", async () => {
    const { trackingId, assignment } = await outForDelivery(fx.vendor);
    const result = await deliveriesSvc.scanBackPackage(waBActor, {
      warehouseId: fx.whB,
      trackingId,
      reason: "Rider reported a flat tyre",
    });
    expect(result.status).toBe("READY_FOR_DELIVERY");

    const incidents = await prisma.incident.findMany({
      where: { sourceKey: `scan-back:${assignment.id}` },
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].category).toBe("DELIVERY_FAILURE");
    expect(incidents[0].description).toContain("P8 riderA");
    expect(incidents[0].description).toContain("flat tyre");
    expect(incidents[0].deliveryAssignmentId).toBe(assignment.id);
    expect(incidents[0].warehouseId).toBe(fx.whB);
  }, 180_000);

  it("a misrouted package raises WRONG_WAREHOUSE once, and resolving its incident clears the flag", async () => {
    // A parcel destined for warehouse A itself, stocked at A…
    const stray = await bookOne(fx.vendor, "0", fx.districtA);
    await inventorySvc.receivePackage(staffAActor, { warehouseId: fx.whA, trackingId: stray.trackingId });
    await inventorySvc.moveToInspection(staffAActor, stray.packageId);
    await inventorySvc.startInspection(staffAActor, stray.packageId);
    await inventorySvc.recordInspection(staffAActor, {
      packageId: stray.packageId,
      condition: "GOOD",
      actualWeightKg: 2,
    });
    await inventorySvc.putAwayPackage(staffAActor, stray.packageId, fx.locStoA);

    // …while a normal A→B transfer opens its receiving window at B.
    const legit = await bookOne(fx.vendor);
    await inventorySvc.receivePackage(staffAActor, { warehouseId: fx.whA, trackingId: legit.trackingId });
    await inventorySvc.moveToInspection(staffAActor, legit.packageId);
    await inventorySvc.startInspection(staffAActor, legit.packageId);
    await inventorySvc.recordInspection(staffAActor, {
      packageId: legit.packageId,
      condition: "GOOD",
      actualWeightKg: 2,
    });
    await inventorySvc.putAwayPackage(staffAActor, legit.packageId, fx.locStoA);
    await inventorySvc.markReadyForDispatch(staffAActor, legit.packageId);
    const transfer = await transfersSvc.createTransfer(waAActor, {
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
    });
    await transfersSvc.addTransferItems(waAActor, transfer.id, [legit.packageId]);
    await transfersSvc.generateManifest(waAActor, transfer.id);
    const crewed = await transfersSvc.assignTransferCrew(waAActor, {
      transferId: transfer.id,
      driverId: fx.linehaulProfile,
      vehicleId: fx.vehicle,
    });
    await transfersSvc.loadTransferPackage(waAActor, transfer.id, {
      trackingId: legit.trackingId,
      idempotencyKey: `p8-load-${RUN}-${legit.trackingId}`,
    });
    const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
    const tripId = dispatched.tripId ?? crewed.tripId!;
    await tripsSvc.departTrip(linehaulActor, tripId);
    await tripsSvc.arriveTrip(linehaulActor, tripId);

    const wrong = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
      trackingId: stray.trackingId,
      idempotencyKey: `p8-wrong-${RUN}-${stray.trackingId}`,
    });
    expect(wrong.kind).toBe("WRONG_PACKAGE");
    let pkg = await prisma.package.findUniqueOrThrow({ where: { id: stray.packageId } });
    expect(pkg.exceptionStatus).toBe("MISROUTED");

    const incidents = await prisma.incident.findMany({
      where: { sourceKey: `misrouted:${stray.packageId}:${fx.whB}` },
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].category).toBe("WRONG_WAREHOUSE");
    const incidentId = incidents[0].id;

    // A repeat scan writes nothing further.
    await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
      trackingId: stray.trackingId,
      idempotencyKey: `p8-wrong2-${RUN}-${stray.trackingId}`,
    });
    expect(
      await prisma.incident.count({ where: { sourceKey: `misrouted:${stray.packageId}:${fx.whB}` } }),
    ).toBe(1);

    // Work the incident through the full documented workflow.
    await incidentsSvc.acknowledgeIncident(waBActor, incidentId);
    await incidentsSvc.assignIncident(waBActor, incidentId, { assigneeId: fx.staffB });
    const noted = await incidentsSvc.addIncidentNote(staffBActor, incidentId, {
      body: "Parcel located in the B receiving bay; it belongs to a local A delivery.",
    });
    expect(noted.status).toBe("INVESTIGATING");
    await incidentsSvc.proposeIncidentResolution(waBActor, incidentId, {
      resolution: "Parcel will be returned to warehouse A on the next line-haul; flag cleared.",
    });
    // Approval is a second pair of eyes with incident.resolve —
    // Admin approves the warehouse admin's proposal.
    await incidentsSvc.approveIncidentResolution(adminActor, incidentId);
    const resolved = await incidentsSvc.resolveIncident(waBActor, incidentId, {
      clearMisrouted: true,
    });
    expect(resolved.status).toBe("RESOLVED");
    pkg = await prisma.package.findUniqueOrThrow({ where: { id: stray.packageId } });
    expect(pkg.exceptionStatus).toBe("NONE");
    const closedIncident = await incidentsSvc.closeIncident(waBActor, incidentId);
    expect(closedIncident.status).toBe("CLOSED");

    // Finish the legitimate transfer so the line-haul driver and
    // vehicle are free for later journeys in this file.
    const legitScan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
      trackingId: legit.trackingId,
      idempotencyKey: `p8-unload-${RUN}-${legit.trackingId}`,
    });
    expect(legitScan.kind).toBe("RECEIVED_SCAN");
    await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
      packageId: legit.packageId,
      condition: "GOOD",
    });
    await transfersSvc.finishReceiving(waBActor, transfer.id);
    await transfersSvc.reconcileTransfer(waBActor, transfer.id);
    await transfersSvc.closeTransfer(waBActor, transfer.id);
  }, 180_000);
});

// ---------------------------------------------------------------------------

describe("incident authority and scoping", () => {
  it("an unrelated warehouse's admin cannot see the incident (audited); finance sees only finance categories", async () => {
    // The handover incident belongs to warehouse A.
    await expect(incidentsSvc.getIncident(waCActor, fx.handoverIncident)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    const denial = await prisma.auditLog.findFirst({
      where: {
        action: "access.denied",
        entityType: "Incident",
        entityId: fx.handoverIncident,
        actorId: fx.waC,
      },
    });
    expect(denial).not.toBeNull();
    const waCList = await incidentsSvc.listIncidents(waCActor, {});
    expect(waCList.items.map((i) => i.id)).not.toContain(fx.handoverIncident);

    // Finance works the COD discrepancy but not warehouse incidents.
    const finView = await incidentsSvc.getIncident(financeActor, fx.codIncident);
    expect(finView.category).toBe("COD_DISCREPANCY");
    await expect(incidentsSvc.getIncident(financeActor, fx.handoverIncident)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    const finList = await incidentsSvc.listIncidents(financeActor, {});
    expect(finList.items.map((i) => i.id)).toContain(fx.codIncident);
    expect(finList.items.map((i) => i.id)).not.toContain(fx.handoverIncident);

    // Support's queue is customer-facing categories only.
    const supList = await incidentsSvc.listIncidents(supportActor, {});
    expect(supList.items.map((i) => i.id)).not.toContain(fx.codIncident);
  });

  it("severity cannot be set below the category default on a manual report", async () => {
    await expect(
      incidentsSvc.createIncident(waBActor, {
        category: "MISSING_PACKAGE",
        severity: "LOW",
        description: "Trying to understate a missing package",
        warehouseId: fx.whB,
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    const ok = await incidentsSvc.createIncident(waBActor, {
      category: "DELAYED_SHIPMENT",
      description: "Line-haul running two hours late",
      warehouseId: fx.whB,
    });
    expect(ok.severity).toBe("MEDIUM");
    expect(ok.status).toBe("REPORTED");
  });
});

// ---------------------------------------------------------------------------

describe("tasks", () => {
  it("completion is assignee-only; verification is a second pair of eyes; overdue is derived", async () => {
    const task = await tasksSvc.createTask(adminActor, {
      title: `P8 overdue probe ${RUN}`,
      description: "Check the damaged cage count",
      assigneeId: fx.staffB,
      warehouseId: fx.whB,
      dueAt: new Date(Date.now() - 60_000),
    });
    expect(task.status).toBe("ASSIGNED");
    expect(task.overdue).toBe(true);

    const mine = await tasksSvc.listTasks(staffBActor, { queue: "mine" });
    expect(mine.items.map((t) => t.id)).toContain(task.id);
    expect(mine.items.find((t) => t.id === task.id)?.overdue).toBe(true);

    // A bystander cannot even see it, let alone work it.
    await expect(
      tasksSvc.updateTaskStatus(riderAActor, task.id, { status: "ACCEPTED" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "ACCEPTED" });
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "IN_PROGRESS" });
    // The creator cannot submit (complete) the assignee's work.
    await expect(
      tasksSvc.updateTaskStatus(adminActor, task.id, { status: "SUBMITTED" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const submitted = await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "SUBMITTED" });
    expect(submitted.submittedAt).not.toBeNull();
    // Nor can the assignee verify their own submission (warehouse
    // staff hold no task.verify at all; the check is permissioned).
    await expect(
      tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "VERIFIED" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const verified = await tasksSvc.updateTaskStatus(waBActor, task.id, { status: "VERIFIED" });
    expect(verified.verifiedAt).not.toBeNull();
    const closedTask = await tasksSvc.updateTaskStatus(adminActor, task.id, { status: "CLOSED" });
    expect(closedTask.status).toBe("CLOSED");
    // Terminal tasks are never overdue, however old the due date.
    expect(closedTask.overdue).toBe(false);
  });

  it("reassignment requires a reason and re-queues the task for the new assignee", async () => {
    const task = await tasksSvc.createTask(adminActor, {
      title: `P8 reassign probe ${RUN}`,
      assigneeId: fx.staffB,
      warehouseId: fx.whB,
    });
    await expect(
      tasksSvc.reassignTask(adminActor, task.id, { assigneeId: fx.staffA, reason: "no" }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    const moved = await tasksSvc.reassignTask(adminActor, task.id, {
      assigneeId: fx.staffA,
      reason: "Staff B is on leave",
    });
    expect(moved.assigneeId).toBe(fx.staffA);
    expect(moved.status).toBe("ASSIGNED");
    const staffAMine = await tasksSvc.listTasks(staffAActor, { queue: "mine" });
    expect(staffAMine.items.map((t) => t.id)).toContain(task.id);
    // The new assignee was notified.
    const note = await prisma.notification.findFirst({
      where: { userId: fx.staffA, category: "TASK_ASSIGNED", entityId: task.id },
    });
    expect(note).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("support tickets", () => {
  it("vendor isolation is enforced and audited; internal notes never reach the raiser; replies notify", async () => {
    const parcel = await bookOne(fx.vendor);
    const ticket = await ticketsSvc.raiseTicket(vendorOwnerActor, {
      category: "DAMAGE",
      subject: "Parcel arrived with a crushed corner",
      description: "The recipient reports the box was crushed on one corner.",
      packageId: parcel.packageId,
    });
    expect(ticket.status).toBe("OPEN");
    expect(ticket.ticketNumber).toMatch(/^TKT-\d+$/);
    fx.ticket = ticket.id;

    // Support sees it in the inbox; the OTHER vendor sees nothing.
    const inbox = await ticketsSvc.listTickets(supportActor, {});
    expect(inbox.items.map((t) => t.id)).toContain(ticket.id);
    const otherList = await ticketsSvc.listTickets(vendor2OwnerActor, {});
    expect(otherList.items.map((t) => t.id)).not.toContain(ticket.id);
    await expect(ticketsSvc.getTicket(vendor2OwnerActor, ticket.id)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    const denial = await prisma.auditLog.findFirst({
      where: {
        action: "access.denied",
        entityType: "SupportTicket",
        entityId: ticket.id,
        actorId: fx.vendor2OwnerUser,
      },
    });
    expect(denial).not.toBeNull();

    // A support reply reaches the raiser and notifies them.
    await ticketsSvc.replyToTicket(supportActor, ticket.id, {
      body: "We are checking with the destination warehouse.",
    });
    const replyNote = await prisma.notification.findFirst({
      where: { userId: fx.vendorOwnerUser, category: "TICKET_REPLIED", entityId: ticket.id },
    });
    expect(replyNote).not.toBeNull();

    // An internal note exists for staff but NEVER for the raiser.
    await ticketsSvc.replyToTicket(supportActor, ticket.id, {
      body: "INTERNAL: rider says the box was fine at pickup.",
      internal: true,
    });
    const raiserView = await ticketsSvc.getTicket(vendorOwnerActor, ticket.id);
    expect(raiserView.messages.map((m) => m.body)).toContain(
      "We are checking with the destination warehouse.",
    );
    expect(raiserView.messages.map((m) => m.body).join(" ")).not.toContain("INTERNAL");
    const staffView = await ticketsSvc.getTicket(supportActor, ticket.id);
    expect(staffView.messages.map((m) => m.body).join(" ")).toContain("INTERNAL");

    // Resolution notifies the raiser; the raiser closes the ticket.
    await ticketsSvc.resolveTicket(supportActor, ticket.id, {
      resolutionNote: "Replacement arranged with the vendor.",
    });
    const resolvedNote = await prisma.notification.findFirst({
      where: { userId: fx.vendorOwnerUser, category: "TICKET_RESOLVED", entityId: ticket.id },
    });
    expect(resolvedNote).not.toBeNull();
    const closedTicket = await ticketsSvc.closeTicket(vendorOwnerActor, ticket.id);
    expect(closedTicket.status).toBe("CLOSED");
  }, 120_000);

  it("a customer's ticket escalates into an investigation task for the assignee", async () => {
    const parcel = await bookOne(fx.vendor);
    const ticket = await ticketsSvc.raiseTicket(customerActor, {
      category: "NON_RECEIPT",
      subject: "My parcel has not arrived",
      description: "Tracking shows out for delivery since yesterday.",
      packageId: parcel.packageId,
    });
    expect(ticket.customerId).toBe(fx.customer);
    const escalated = await ticketsSvc.escalateTicketToTask(supportActor, ticket.id, {
      assigneeId: fx.staffB,
      note: "Check with the rider and the destination warehouse.",
    });
    expect(escalated.ticket.status).toBe("ESCALATED");
    const task = await prisma.task.findUniqueOrThrow({ where: { id: escalated.taskId } });
    expect(task.relatedTicketId).toBe(ticket.id);
    expect(task.assigneeId).toBe(fx.staffB);
    const staffBMine = await tasksSvc.listTasks(staffBActor, { queue: "mine" });
    expect(staffBMine.items.map((t) => t.id)).toContain(task.id);
  }, 120_000);

  it("the public tracking complaint is phone-verified and lands in the support queue", async () => {
    const parcel = await bookOne(fx.vendor);
    await expect(
      ticketsSvc.raiseTrackingComplaint(parcel.trackingId, {
        phone: phone(999),
        category: "GENERAL",
        subject: "Where is my parcel?",
        description: "It has been a week with no update.",
      }),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    const raised = await ticketsSvc.raiseTrackingComplaint(parcel.trackingId, {
      phone: RECIPIENT_PHONE,
      category: "GENERAL",
      subject: "Where is my parcel?",
      description: "It has been a week with no update.",
    });
    expect(raised.ticketNumber).toMatch(/^TKT-\d+$/);
    const row = await prisma.supportTicket.findUniqueOrThrow({
      where: { ticketNumber: raised.ticketNumber },
    });
    expect(row.customerId).toBe(fx.customer);
    expect(row.packageId).toBe(parcel.packageId);
    const inbox = await ticketsSvc.listTickets(supportActor, {});
    expect(inbox.items.map((t) => t.id)).toContain(row.id);
  }, 120_000);
});

// ---------------------------------------------------------------------------

describe("notifications", () => {
  it("unread counts are exact and mark-read is owner-only", async () => {
    const targetUser = await makeUser("notifyTarget", "WAREHOUSE_STAFF");
    await addMembership(targetUser, fx.whB, "WAREHOUSE_STAFF");
    const targetActor = await actorFor(targetUser);

    await tasksSvc.createTask(adminActor, {
      title: `P8 notify one ${RUN}`,
      assigneeId: targetUser,
      warehouseId: fx.whB,
    });
    await tasksSvc.createTask(adminActor, {
      title: `P8 notify two ${RUN}`,
      assigneeId: targetUser,
      warehouseId: fx.whB,
    });
    expect((await notificationsSvc.getMyUnreadCount(targetActor)).count).toBe(2);
    const list = await notificationsSvc.listMyNotifications(targetActor, {});
    expect(list.unreadCount).toBe(2);
    expect(list.items).toHaveLength(2);

    // Another user cannot mark them read (audited denial).
    await expect(
      notificationsSvc.markNotificationRead(staffBActor, list.items[0].id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    expect((await notificationsSvc.getMyUnreadCount(targetActor)).count).toBe(2);

    await notificationsSvc.markNotificationRead(targetActor, list.items[0].id);
    expect((await notificationsSvc.getMyUnreadCount(targetActor)).count).toBe(1);
    const all = await notificationsSvc.markAllMyNotificationsRead(targetActor);
    expect(all.marked).toBe(1);
    expect((await notificationsSvc.getMyUnreadCount(targetActor)).count).toBe(0);
  });

  it("a paid settlement notifies the vendor's users in the payment transaction", async () => {
    const delivered = await deliverCod(fx.vendor, "500000");
    const remittance = await remittancesSvc.submitRemittance(riderAActor, {
      collectionIds: [delivered.collectionId],
      declaredAmountPaisa: "500000",
      method: "CASH",
    });
    const verified = await remittancesSvc.verifyRemittance(financeActor, remittance.id, {
      countedAmountPaisa: "500000",
    });
    expect(verified.status).toBe("VERIFIED");
    const invoice = await invoicesSvc.generateVendorInvoice(financeActor, { vendorId: fx.vendor });
    expect(invoice).not.toBeNull();
    const prepared = await settlementsSvc.prepareSettlement(financeActor, { vendorId: fx.vendor });
    const approved = await settlementsSvc.approveSettlement(adminActor, prepared.id);
    expect(approved.status).toBe("APPROVED");
    const paid = await settlementsSvc.paySettlement(financeActor, prepared.id, {
      method: "BANK_TRANSFER",
      transactionRef: `P8-SETTLE-${RUN}`,
    });
    expect(paid.status).toBe("SETTLED");
    const note = await prisma.notification.findFirst({
      where: {
        userId: fx.vendorOwnerUser,
        category: "SETTLEMENT_PAID",
        entityType: "VendorSettlement",
        entityId: prepared.id,
      },
    });
    expect(note).not.toBeNull();
  }, 180_000);
});
