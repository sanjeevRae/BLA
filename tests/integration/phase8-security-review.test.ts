import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 8 SECURITY REVIEW PoCs (independent review of HEAD 3955300).
 *
 * Assertions encode the SECURE expectation (the documented /
 * earlier-phase-fixed behaviour). A FAILING test is a proven
 * finding; a passing test is a verified control. Fixtures mirror
 * tests/integration/phase8-operations.test.ts with R8 prefixes
 * (WH-ZR8-*) so suites never interfere; users/vendors/bookings are
 * per-run unique.
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
const email = (label: string) => `p8r-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);
const RECIPIENT_PHONE = phone(101);
const TODAY = new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
let support2Actor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
let linehaulActor: Awaited<ReturnType<typeof actorFor>>;
let riderAActor: Awaited<ReturnType<typeof actorFor>>;
let vendorOwnerActor: Awaited<ReturnType<typeof actorFor>>;
let vendor2OwnerActor: Awaited<ReturnType<typeof actorFor>>;
let customerActor: Awaited<ReturnType<typeof actorFor>>;
let serviceCode: string;

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
      fullName: `P8R ${label}`,
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
    sender: { name: "P8R Sender", phone: phone(42), email: null },
    recipient: {
      name: "P8R Recipient",
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
    idempotencyKey: `p8r-load-${RUN}-${parcel.trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(linehaulActor, tripId);
  await tripsSvc.arriveTrip(linehaulActor, tripId);
  const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
    trackingId: parcel.trackingId,
    idempotencyKey: `p8r-unload-${RUN}-${parcel.trackingId}`,
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
  incidentsSvc = await import("@/server/services/incidents");
  tasksSvc = await import("@/server/services/tasks");
  ticketsSvc = await import("@/server/services/support-tickets");
  notificationsSvc = await import("@/server/services/notifications");
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
  fx.financeUser = await makeUser("finance", "FINANCE");
  financeActor = await actorFor(fx.financeUser);
  fx.supportUser = await makeUser("support", "SUPPORT");
  supportActor = await actorFor(fx.supportUser);
  fx.support2User = await makeUser("support2", "SUPPORT");
  support2Actor = await actorFor(fx.support2User);

  fx.districtA = "R8Alpha District";
  fx.districtB = "R8Beta District";
  fx.districtC = "R8Gamma District";
  const a = await ensureWarehouse("WH-ZR8-01", "R8 Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  const b = await ensureWarehouse("WH-ZR8-02", "R8 Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;
  const c = await ensureWarehouse("WH-ZR8-03", "R8 Gamma (shared fixture)", fx.districtC);
  fx.whC = c.id;

  serviceCode = `R8STD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "R8 Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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
      businessName: `P8R Vendor ${label} ${RUN}`,
      contactName: "P8R Contact",
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

  fx.customerUser = await makeUser("customer", "CUSTOMER");
  const customer = await prisma.customer.create({
    data: {
      fullName: "P8R Recipient",
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
  waAActor = await actorFor(fx.waA);
  staffAActor = await actorFor(fx.staffA);
  waBActor = await actorFor(fx.waB);

  fx.linehaulUser = await makeUser("linehaul", "LINEHAUL_DRIVER");
  const linehaul = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.linehaulUser,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P8R-LH-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.linehaulProfile = linehaul.id;
  linehaulActor = await actorFor(fx.linehaulUser);
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P8R TRK ${RUN.slice(-6)}`.toUpperCase(),
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
    licenseNumber: `LIC-P8R-RA-${RUN}`,
    licenseCategory: "A",
    licenseExpiry: "2030-01-01",
    capabilities: ["DELIVERY"],
  });
  fx.riderAProfile = riderProfile.id;
  riderAActor = await actorFor(fx.riderAUser);
  expect(riderAActor.driverId).toBe(fx.riderAProfile);
}, 240_000);

// ---------------------------------------------------------------------------
// 1. P6-R1 closure — enumerate EVERY non-recipient surface for the code
// ---------------------------------------------------------------------------

describe("P6-R1 closure — no non-recipient surface exposes the code", () => {
  it("notification lists of every other actor, mark-read on the recipient row, and the audit log never contain the code", async () => {
    const { packageId, assignment, batch } = await outForDelivery(fx.vendor);
    const code = await recipientOtp(assignment.id);
    expect(code).toMatch(/^\d{6}$/);

    // Every staff/vendor actor's own notification list: no code.
    for (const [label, actor] of [
      ["rider", riderAActor],
      ["waB", waBActor],
      ["waA", waAActor],
      ["staffA", staffAActor],
      ["admin", adminActor],
      ["support", supportActor],
      ["finance", financeActor],
      ["vendorOwner", vendorOwnerActor],
    ] as const) {
      const list = await notificationsSvc.listMyNotifications(actor, { pageSize: 100 });
      expect(JSON.stringify(list), `${label} notification list leaks the code`).not.toContain(code);
      const otpList = await notificationsSvc.listMyNotifications(actor, {
        pageSize: 100,
        category: "DELIVERY_OTP" as never,
      });
      expect(otpList.items, `${label} can list DELIVERY_OTP rows`).toHaveLength(0);
    }
    // V2 Phase 2 (H-3): CUSTOMER now holds notification.read_own, so
    // the customer-recipient CAN list their own inbox — the closure
    // property is that the recipient (userId-NULL) TRACKING row and
    // its code never surface in it.
    const customerList = await notificationsSvc.listMyNotifications(customerActor, {
      pageSize: 100,
    });
    expect(JSON.stringify(customerList), "customer notification list leaks the code").not.toContain(code);
    const customerOtpList = await notificationsSvc.listMyNotifications(customerActor, {
      pageSize: 100,
      category: "DELIVERY_OTP" as never,
    });
    expect(customerOtpList.items, "customer can list DELIVERY_OTP rows").toHaveLength(0);

    // Nobody but the (userId-NULL) recipient addressing can mark the
    // TRACKING row read — rider and even admin are refused + audited.
    const trackingNote = await prisma.notification.findFirstOrThrow({
      where: {
        category: "DELIVERY_OTP",
        channel: "TRACKING",
        entityType: "DeliveryAssignment",
        entityId: assignment.id,
      },
    });
    await expect(
      notificationsSvc.markNotificationRead(riderAActor, trackingNote.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      notificationsSvc.markNotificationRead(adminActor, trackingNote.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // The customer-recipient (who now holds notification.read_own)
    // is refused on ownership: the TRACKING row is not theirs.
    await expect(
      notificationsSvc.markNotificationRead(customerActor, trackingNote.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const denial = await prisma.auditLog.findFirst({
      where: {
        action: "access.denied",
        entityType: "Notification",
        entityId: trackingNote.id,
        actorId: fx.riderAUser,
      },
    });
    expect(denial).not.toBeNull();

    // Audit payloads written around pickup contain no code either.
    const auditRows = await prisma.auditLog.findMany({
      where: { entityId: { in: [assignment.id, packageId, batch.id] } },
    });
    expect(auditRows.length).toBeGreaterThan(0);
    expect(JSON.stringify(auditRows)).not.toContain(code);
  }, 240_000);

  it("an expired OTP yields no code in the detailed view and cannot deliver", async () => {
    const { trackingId, assignment } = await outForDelivery(fx.vendor);
    const code = await recipientOtp(assignment.id);
    await prisma.deliveryAssignment.update({
      where: { id: assignment.id },
      data: { otpExpiresAt: new Date(Date.now() - 60_000) },
    });
    const view = await packagesSvc.getDetailedTracking(trackingId, RECIPIENT_PHONE);
    expect(view.deliveryCode).toBeNull();
    await expect(
      deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
        receivedByName: "P8R Recipient",
        otpCode: code,
      }),
    ).rejects.toThrow(/expired/i);
  }, 240_000);

  it("a locked OTP yields no code in the detailed view and the real code is refused", async () => {
    const { trackingId, assignment } = await outForDelivery(fx.vendor);
    const code = await recipientOtp(assignment.id);
    // OTP_MAX_FAILURES = 3 wrong entries lock the code (P6-R2 holds).
    for (let i = 0; i < 3; i++) {
      await expect(
        deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
          receivedByName: "P8R Recipient",
          otpCode: wrongOtpFor(code),
        }),
      ).rejects.toThrow(/incorrect|locked/i);
    }
    const view = await packagesSvc.getDetailedTracking(trackingId, RECIPIENT_PHONE);
    expect(view.deliveryCode).toBeNull();
    await expect(
      deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
        receivedByName: "P8R Recipient",
        otpCode: code,
      }),
    ).rejects.toThrow(/locked/i);
  }, 240_000);

  it("after delivery the detailed view no longer exposes the code", async () => {
    const { trackingId, assignment } = await outForDelivery(fx.vendor);
    const code = await recipientOtp(assignment.id);
    const delivered = await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P8R Recipient",
      otpCode: code,
    });
    expect(JSON.stringify(delivered)).not.toContain(code);
    const view = await packagesSvc.getDetailedTracking(trackingId, RECIPIENT_PHONE);
    expect(view.status).toBe("DELIVERED");
    expect(view.deliveryCode).toBeNull();
  }, 240_000);
});

// ---------------------------------------------------------------------------
// 2. Public tracking complaint — the P6-R6 bookkeeping discipline
// ---------------------------------------------------------------------------

describe("public complaint endpoint vs the detailed-tracking lockout (P6-R6)", () => {
  it("CONTROL: the detailed view locks after 5 failures, even for the correct phone", async () => {
    const parcel = await bookOne(fx.vendor);
    for (let i = 0; i < 5; i++) {
      await expect(packagesSvc.getDetailedTracking(parcel.trackingId, phone(999))).rejects.toBeInstanceOf(
        errors.NotFoundError,
      );
    }
    await expect(packagesSvc.getDetailedTracking(parcel.trackingId, RECIPIENT_PHONE)).rejects.toBeInstanceOf(
      errors.NotFoundError,
    );
  }, 120_000);

  it("FINDING CHECK: the complaint endpoint must honour the same lockout", async () => {
    const parcel = await bookOne(fx.vendor);
    for (let i = 0; i < 5; i++) {
      await expect(packagesSvc.getDetailedTracking(parcel.trackingId, phone(999))).rejects.toBeInstanceOf(
        errors.NotFoundError,
      );
    }
    // The tracking code is now locked for the detailed view. The
    // complaint endpoint shares the same second factor, so it must
    // refuse too — otherwise it is an unlocked phone-guessing oracle.
    await expect(
      ticketsSvc.raiseTrackingComplaint(parcel.trackingId, {
        phone: RECIPIENT_PHONE,
        subject: "Where is my parcel",
        description: "It has not arrived yet",
      }),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
  }, 120_000);

  it("FINDING CHECK: malformed tracking codes write nothing (complaint path)", async () => {
    const before = await prisma.trackingAccessAttempt.count();
    await expect(packagesSvc.getDetailedTracking("NOT-A-TRACKING-ID", RECIPIENT_PHONE)).rejects.toBeInstanceOf(
      errors.NotFoundError,
    );
    const afterDetailed = await prisma.trackingAccessAttempt.count();
    expect(afterDetailed).toBe(before); // control: detailed view writes nothing
    await expect(
      ticketsSvc.raiseTrackingComplaint("NOT-A-TRACKING-ID", {
        phone: RECIPIENT_PHONE,
        subject: "Bogus complaint",
        description: "This code does not exist",
      }),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    const afterComplaint = await prisma.trackingAccessAttempt.count();
    expect(afterComplaint).toBe(afterDetailed); // secure expectation: also nothing
  }, 120_000);

  it("documents the complaint fan-out: repeat complaints create a ticket + support fan-out each time", async () => {
    const parcel = await bookOne(fx.vendor);
    const unreadBefore = (await notificationsSvc.getMyUnreadCount(supportActor)).count;
    for (let i = 0; i < 3; i++) {
      const raised = await ticketsSvc.raiseTrackingComplaint(parcel.trackingId, {
        phone: RECIPIENT_PHONE,
        subject: `Complaint ${i + 1}`,
        description: "Raised from the public tracking page",
      });
      expect(raised.ticketNumber).toMatch(/^TKT-/);
    }
    const tickets = await prisma.supportTicket.count({ where: { packageId: parcel.packageId } });
    expect(tickets).toBe(3);
    const unreadAfter = (await notificationsSvc.getMyUnreadCount(supportActor)).count;
    expect(unreadAfter - unreadBefore).toBe(3);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 3. Support tickets — confidentiality controls + terminal-state integrity
// ---------------------------------------------------------------------------

async function holdTicketLock(ticketId: string) {
  let release!: () => void;
  let signalLocked!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const isLocked = new Promise<void>((r) => (signalLocked = r));
  const done = prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "app"."SupportTicket" WHERE "id" = ${ticketId} FOR UPDATE`;
      signalLocked();
      await gate;
      await tx.supportTicket.update({
        where: { id: ticketId },
        data: {
          status: "RESOLVED",
          resolvedAt: new Date(),
          resolvedById: fx.supportUser,
          resolutionNote: "Resolved while another operation was in flight",
        },
      });
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  await isLocked;
  return { release: () => release(), done };
}

describe("support tickets — confidentiality", () => {
  it("internal notes never reach the raiser; another vendor is denied + audited", async () => {
    const parcel = await bookOne(fx.vendor);
    const ticket = await ticketsSvc.raiseTicket(vendorOwnerActor, {
      category: "DAMAGE",
      subject: "Parcel arrived damaged",
      description: "The box was crushed on one side",
      packageId: parcel.packageId,
    });
    await ticketsSvc.replyToTicket(supportActor, ticket.id, {
      body: "INTERNAL-LEDGER: suspect rider mishandling, do not disclose",
      internal: true,
    });
    await ticketsSvc.replyToTicket(supportActor, ticket.id, {
      body: "We are looking into it right away",
    });
    const raiserView = await ticketsSvc.getTicket(vendorOwnerActor, ticket.id);
    expect(JSON.stringify(raiserView)).not.toContain("INTERNAL-LEDGER");
    expect(raiserView.messages.map((m) => m.body)).toContain("We are looking into it right away");
    const staffView = await ticketsSvc.getTicket(supportActor, ticket.id);
    expect(JSON.stringify(staffView)).toContain("INTERNAL-LEDGER");

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
    const vendor2List = await ticketsSvc.listTickets(vendor2OwnerActor, {});
    expect(vendor2List.items.map((t) => t.id)).not.toContain(ticket.id);
  }, 120_000);
});

describe("support tickets — terminal-state integrity", () => {
  it("FINDING CHECK: a follow-up request must not resurrect a CLOSED ticket", async () => {
    const parcel = await bookOne(fx.vendor);
    const ticket = await ticketsSvc.raiseTicket(vendorOwnerActor, {
      category: "NON_RECEIPT",
      subject: "Parcel never arrived",
      description: "Tracking says delivered but I received nothing",
      packageId: parcel.packageId,
    });
    await ticketsSvc.resolveTicket(supportActor, ticket.id, {
      resolutionNote: "Redelivered by hand and confirmed",
    });
    const closed = await ticketsSvc.closeTicket(vendorOwnerActor, ticket.id);
    expect(closed.status).toBe("CLOSED");
    await expect(
      ticketsSvc.requestRedelivery(supportActor, ticket.id, { note: "Customer called again" }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    const after = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("CLOSED");
  }, 120_000);

  it("FINDING CHECK: a staff reply racing a resolve must not resurrect the ticket (P6-R5 pattern)", async () => {
    const parcel = await bookOne(fx.vendor);
    const ticket = await ticketsSvc.raiseTicket(vendorOwnerActor, {
      category: "GENERAL",
      subject: "Question about my parcel",
      description: "Please call me back about this shipment",
      packageId: parcel.packageId,
    });
    const hold = await holdTicketLock(ticket.id);
    const replyPromise = ticketsSvc.replyToTicket(supportActor, ticket.id, {
      body: "Reply written against the pre-resolve snapshot",
    });
    await sleep(700); // the reply is now blocked on the ticket row lock
    hold.release();
    await hold.done;
    await replyPromise.catch(() => undefined); // outcome recorded below either way
    const after = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("RESOLVED");
  }, 120_000);

  it("FINDING CHECK: an assignment racing a resolve must not resurrect the ticket", async () => {
    const parcel = await bookOne(fx.vendor);
    const ticket = await ticketsSvc.raiseTicket(vendorOwnerActor, {
      category: "GENERAL",
      subject: "Another question",
      description: "Following up on the earlier shipment",
      packageId: parcel.packageId,
    });
    const hold = await holdTicketLock(ticket.id);
    const assignPromise = ticketsSvc.assignTicket(supportActor, ticket.id, {
      assigneeId: fx.support2User,
    });
    await sleep(700); // the assignment update is now blocked on the row lock
    hold.release();
    await hold.done;
    await assignPromise.catch(() => undefined);
    const after = await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(after.status).toBe("RESOLVED");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 4. Incidents — link scope, auto-raise idempotency, vendor projection
// ---------------------------------------------------------------------------

describe("incidents — creation link scope", () => {
  it("FINDING CHECK: a vendor must not link an arbitrary transfer (staff warehouse links are checked — control)", async () => {
    // Control: warehouse-scoped staff naming another warehouse IS denied.
    await expect(
      incidentsSvc.createIncident(waAActor, {
        category: "DELAYED_SHIPMENT",
        description: "Trying to file against the beta warehouse",
        warehouseId: fx.whB,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    const transfer = await transfersSvc.createTransfer(waAActor, {
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
    });
    // Secure expectation: the vendor's transfer link is scope-checked
    // like the package/order links are.
    let created: Awaited<ReturnType<typeof incidentsSvc.createIncident>> | null = null;
    let createError: unknown = null;
    try {
      created = await incidentsSvc.createIncident(vendorOwnerActor, {
        category: "DELAYED_SHIPMENT",
        description: "Vendor filing against a transfer it does not own",
        transferId: transfer.id,
      });
    } catch (err) {
      createError = err;
    }
    expect(createError).toBeInstanceOf(actorErrors.AuthorizationError);
    if (created) {
      // Evidence for the report if the gap is present: the incident
      // lands on the destination warehouse and fans out to its admins.
      const waBList = await notificationsSvc.listMyNotifications(waBActor, { pageSize: 100 });
      expect(JSON.stringify(waBList)).toContain(created.incidentNumber);
    }
  }, 120_000);

  it("concurrent auto-raise with one sourceKey yields exactly one incident and no error storm", async () => {
    const sourceKey = `p8r-race-${RUN}`;
    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        prisma.$transaction((tx) =>
          incidentsSvc.raiseIncidentInTx(tx, {
            sourceKey,
            category: "COD_DISCREPANCY",
            description: "Concurrent discrepancy raise (review PoC)",
            reporterId: fx.adminUser,
            warehouseId: fx.whA,
          }),
        ),
      ),
    );
    const rejected = attempts.filter((a) => a.status === "rejected");
    if (rejected.length > 0) {
      console.log(
        "RACE LOSER ERRORS:",
        rejected.map((r) => String((r as PromiseRejectedResult).reason).slice(0, 300)),
      );
    }
    const incidents = await prisma.incident.findMany({ where: { sourceKey } });
    expect(incidents).toHaveLength(1);
    // Secure expectation: losers resolve as created:false (the
    // documented idempotency contract), they do not throw — a throw
    // would roll back the caller's source operation.
    expect(rejected).toHaveLength(0);

    // Sequential retry: created:false, and no second fan-out.
    const notesBefore = await prisma.notification.count({
      where: { entityType: "Incident", entityId: incidents[0].id },
    });
    const retry = await prisma.$transaction((tx) =>
      incidentsSvc.raiseIncidentInTx(tx, {
        sourceKey,
        category: "COD_DISCREPANCY",
        description: "Concurrent discrepancy raise (review PoC)",
        reporterId: fx.adminUser,
        warehouseId: fx.whA,
      }),
    );
    expect(retry.created).toBe(false);
    const notesAfter = await prisma.notification.count({
      where: { entityType: "Incident", entityId: incidents[0].id },
    });
    expect(notesAfter).toBe(notesBefore);
  }, 120_000);

  it("FINDING CHECK: vendors see only the customer-safe summary — internal investigation notes must not be in the vendor's detail view", async () => {
    const parcel = await bookOne(fx.vendor);
    const incident = await incidentsSvc.createIncident(staffAActor, {
      category: "DAMAGED_PACKAGE",
      description: "Parcel arrived with a crushed corner",
      packageId: parcel.packageId,
    });
    await incidentsSvc.addIncidentNote(adminActor, incident.id, {
      body: "INTERNAL-LEDGER: courier suspected of deliberate damage; HR case opened",
    });
    // The vendor may see the incident exists on its own package…
    const vendorList = await incidentsSvc.listIncidents(vendorOwnerActor, {});
    expect(vendorList.items.map((i) => i.id)).toContain(incident.id);
    // …but the detail view must be the customer-safe summary
    // (exception-management.md §4): no internal thread.
    const vendorView = await incidentsSvc.getIncident(vendorOwnerActor, incident.id);
    expect(JSON.stringify(vendorView)).not.toContain("INTERNAL-LEDGER");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 5. Tasks — assignee validation and authority
// ---------------------------------------------------------------------------

describe("tasks — assignee validation", () => {
  let vendorTaskId = "";
  it("FINDING CHECK: a task must not be assignable to a non-staff (vendor) user", async () => {
    let createError: unknown = null;
    try {
      const task = await tasksSvc.createTask(adminActor, {
        title: "P8R internal follow-up",
        description: "Internal operational follow-up details",
        assigneeId: fx.vendorOwnerUser,
        warehouseId: fx.whA,
      });
      vendorTaskId = task.id;
    } catch (err) {
      createError = err;
    }
    expect(vendorOwnerActor.permissions.has("task.update_own")).toBe(false);
    expect(createError).not.toBeNull();
  }, 120_000);

  it("FINDING CHECK: a vendor assignee must not be able to read or work the task", async () => {
    if (!vendorTaskId) {
      // Creation was (correctly) refused — fall back to a direct row
      // so the read/work surface is still exercised.
      const row = await prisma.task.create({
        data: {
          title: "P8R internal follow-up",
          description: "Internal operational follow-up details",
          createdById: fx.adminUser,
          assigneeId: fx.vendorOwnerUser,
          warehouseId: fx.whA,
          status: "ASSIGNED",
          priority: "NORMAL",
        },
      });
      vendorTaskId = row.id;
    }
    await expect(tasksSvc.getTask(vendorOwnerActor, vendorTaskId)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    await expect(
      tasksSvc.updateTaskStatus(vendorOwnerActor, vendorTaskId, { status: "ACCEPTED" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  }, 120_000);

  it("controls: assignee-only completion, cross-warehouse denial, server-side overdue derivation", async () => {
    const task = await tasksSvc.createTask(adminActor, {
      title: "P8R count the damaged shelf",
      description: "Count and photograph the damaged shelf stock",
      assigneeId: fx.staffA,
      warehouseId: fx.whA,
      dueAt: new Date(Date.now() - 3_600_000),
    });
    const view = await tasksSvc.getTask(staffAActor, task.id);
    expect(view.overdue).toBe(true); // derived server-side from dueAt + status
    await tasksSvc.updateTaskStatus(staffAActor, task.id, { status: "ACCEPTED" });
    await tasksSvc.updateTaskStatus(staffAActor, task.id, { status: "IN_PROGRESS" });
    // The creator cannot submit (complete) someone else's task.
    await expect(
      tasksSvc.updateTaskStatus(adminActor, task.id, { status: "SUBMITTED" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // A warehouse-B manager cannot even read a warehouse-A task.
    await expect(tasksSvc.getTask(waBActor, task.id)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    // The assignee cannot verify their own submission — proven with
    // a WA assignee, who DOES hold task.verify, so only the
    // self-verification guard can stop them.
    const waTask = await tasksSvc.createTask(adminActor, {
      title: "P8R recount the returns shelf",
      description: "Recount and reconcile the returns shelf",
      assigneeId: fx.waA,
      warehouseId: fx.whA,
    });
    await tasksSvc.updateTaskStatus(waAActor, waTask.id, { status: "ACCEPTED" });
    await tasksSvc.updateTaskStatus(waAActor, waTask.id, { status: "IN_PROGRESS" });
    await tasksSvc.updateTaskStatus(waAActor, waTask.id, { status: "SUBMITTED" });
    await expect(
      tasksSvc.updateTaskStatus(waAActor, waTask.id, { status: "VERIFIED" }),
    ).rejects.toThrow(/own/i);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 6. Notifications — dedupe resilience and ownership isolation
// ---------------------------------------------------------------------------

describe("notifications — dedupe resilience and ownership", () => {
  it("a dedupe collision inside a host transaction creates nothing and does not roll the host back", async () => {
    const key = `p8r-dedupe-${RUN}`;
    const first = await prisma.$transaction((tx) =>
      notificationsSvc.createNotificationInTx(tx, {
        userId: fx.supportUser,
        category: "GENERAL",
        title: "Dedupe probe",
        body: "First write wins",
        dedupeKey: key,
        channels: ["IN_APP"],
      }),
    );
    expect(first).toBe(1);
    const second = await prisma.$transaction((tx) =>
      notificationsSvc.createNotificationInTx(tx, {
        userId: fx.supportUser,
        category: "GENERAL",
        title: "Dedupe probe",
        body: "Retry of the same event",
        dedupeKey: key,
        channels: ["IN_APP"],
      }),
    );
    expect(second).toBe(0);
    const rows = await prisma.notification.count({ where: { dedupeKey: `${key}:IN_APP` } });
    expect(rows).toBe(1);
  }, 120_000);

  it("mark-read and mark-all are strictly owner-scoped", async () => {
    await prisma.$transaction((tx) =>
      notificationsSvc.createNotificationInTx(tx, {
        userId: fx.supportUser,
        category: "GENERAL",
        title: "For support only",
        body: "Ownership probe",
        dedupeKey: `p8r-own-${RUN}`,
        channels: ["IN_APP"],
      }),
    );
    const note = await prisma.notification.findFirstOrThrow({
      where: { dedupeKey: `p8r-own-${RUN}:IN_APP` },
    });
    const supportUnreadBefore = (await notificationsSvc.getMyUnreadCount(supportActor)).count;
    expect(supportUnreadBefore).toBeGreaterThan(0);
    // Admin cannot mark support's notification read…
    await expect(
      notificationsSvc.markNotificationRead(adminActor, note.id),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // …and admin's mark-all leaves support's unread untouched.
    await notificationsSvc.markAllMyNotificationsRead(adminActor);
    const supportUnreadAfter = (await notificationsSvc.getMyUnreadCount(supportActor)).count;
    expect(supportUnreadAfter).toBe(supportUnreadBefore);
    // The owner can.
    const marked = await notificationsSvc.markNotificationRead(supportActor, note.id);
    expect(marked.readAt).not.toBeNull();
  }, 120_000);
});
