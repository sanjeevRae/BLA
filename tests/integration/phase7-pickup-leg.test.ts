import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 7 vendor-pickup leg (docs/delivery-workflow.md §2) against
 * the local bla_test database: a RIDER_PICKUP booking produces a
 * BOOKED package at the origin warehouse with no stock and no
 * custody; only a PICKUP batch can take it (pickup.assign gate,
 * Order.pickupMethod eligibility); the assigned rider collects it
 * (PICKUP_ASSIGNED → PICKUP_IN_PROGRESS → PICKED_UP, rider custody,
 * no OTP, vendor notified); the origin receiving scan
 * (inventory.receivePackage) lands it at RECEIVED_AT_ORIGIN with
 * warehouse custody + stock, from where the normal
 * inspection/put-away/ready flow runs; a failed pickup flags
 * PICKUP_FAILED and the WA reschedules onto a new PICKUP batch,
 * which clears the flag; a WAREHOUSE_DROPOFF package is refused by
 * PICKUP batches.
 *
 * Fixtures mirror deliveries.test.ts: shared find-or-create
 * warehouses (WH-ZP7P codes), per-run unique users/vendor/bookings.
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
const email = (label: string) => `p7pk-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);
const TODAY = new Date().toISOString().slice(0, 10);

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let inventorySvc: typeof import("@/server/services/inventory");
let driversSvc: typeof import("@/server/services/drivers");
let deliveriesSvc: typeof import("@/server/services/deliveries");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let waActor: Awaited<ReturnType<typeof actorFor>>;
let riderActor: Awaited<ReturnType<typeof actorFor>>;
let rider2Actor: Awaited<ReturnType<typeof actorFor>>;
let serviceCode: string;
let vendorAddressId: string;

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
      fullName: `P7PK ${label}`,
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

/** A RIDER_PICKUP booking: recipient in the origin district, so the
 *  origin warehouse is also the destination (LAST_MILE). */
async function bookPickup(): Promise<{ packageId: string; trackingId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId: fx.vendor,
    sender: { name: "P7PK Sender", phone: phone(42), email: null },
    recipient: {
      name: "P7PK Recipient",
      phone: phone(101),
      addressLine: "Origin Street 1",
      city: "P7PK Origin (shared fixture)",
      district: fx.district,
      province: "Bagmati",
    },
    pickup: { method: "RIDER_PICKUP" as const, vendorAddressId },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
  });
  const pkg = booking.shipments[0].packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId };
}

async function bookDropoff(): Promise<{ packageId: string; trackingId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId: fx.vendor,
    sender: { name: "P7PK Sender", phone: phone(43), email: null },
    recipient: {
      name: "P7PK Recipient",
      phone: phone(102),
      addressLine: "Origin Street 2",
      city: "P7PK Origin (shared fixture)",
      district: fx.district,
      province: "Bagmati",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: fx.wh },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
  });
  const pkg = booking.shipments[0].packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId };
}

async function openCustody(packageId: string) {
  return prisma.packageCustody.findFirst({ where: { packageId, endedAt: null } });
}

async function openRecord(packageId: string) {
  return prisma.inventoryRecord.findFirst({ where: { packageId, releasedAt: null } });
}

async function makeBatch(riderUserId: string, kind: "PICKUP" | "DELIVERY") {
  return deliveriesSvc.createDeliveryBatch(waActor, {
    warehouseId: fx.wh,
    riderUserId,
    batchDate: TODAY,
    kind,
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
  driversSvc = await import("@/server/services/drivers");
  deliveriesSvc = await import("@/server/services/deliveries");
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

  fx.district = "P7PK Origin District";
  const wh = await ensureWarehouse("WH-ZP7P-01", "P7PK Origin (shared fixture)", fx.district);
  fx.wh = wh.id;
  fx.locSto = wh.locations.STORAGE;

  serviceCode = `P7PK${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P7PK Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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
    businessName: `P7PK Vendor ${RUN}`,
    contactName: "P7PK Contact",
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
  const address = await vendorsSvc.addVendorAddress(adminActor, fx.vendor, {
    kind: "PICKUP",
    addressLine1: "Pickup Road 1",
    city: "P7PK Origin (shared fixture)",
    district: fx.district,
    province: "Bagmati",
    approve: true,
  });
  vendorAddressId = address.id;

  fx.waUser = await makeUser("wa", "WAREHOUSE_ADMIN");
  await addMembership(fx.waUser, fx.wh, "WAREHOUSE_ADMIN");
  waActor = await actorFor(fx.waUser);

  for (const label of ["rider", "rider2"] as const) {
    const userId = await makeUser(label, "RIDER");
    const profile = await driversSvc.createDriverProfile(adminActor, {
      userId,
      homeWarehouseId: fx.wh,
      licenseNumber: `LIC-P7PK-${label}-${RUN}`.toUpperCase(),
      licenseCategory: "B",
      licenseExpiry: "2030-01-01",
      capabilities: ["DELIVERY", "PICKUP"],
    });
    fx[`${label}User`] = userId;
    fx[`${label}Profile`] = profile.id;
  }
  riderActor = await actorFor(fx.riderUser);
  rider2Actor = await actorFor(fx.rider2User);
  expect(riderActor.driverId).toBe(fx.riderProfile);
}, 240_000);

// Shared across (i)–(iii): the first collected parcel flows on into
// the receiving test.
let firstParcel: { packageId: string; trackingId: string };
let secondParcel: { packageId: string; trackingId: string };
let pickupBatchId: string;

describe("(i) assignment: only a PICKUP batch can take a BOOKED rider-pickup package", () => {
  it("books BOOKED at origin with no stock/custody; DELIVERY rejects, PICKUP accepts", async () => {
    firstParcel = await bookPickup();
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: firstParcel.packageId } });
    expect(pkg.operationalStatus).toBe("BOOKED");
    expect(pkg.currentWarehouseId).toBe(fx.wh);
    expect(await openRecord(firstParcel.packageId)).toBeNull();
    expect(await openCustody(firstParcel.packageId)).toBeNull();
    const order = await prisma.order.findUniqueOrThrow({ where: { id: pkg.orderId } });
    expect(order.pickupMethod).toBe("RIDER_PICKUP");

    // Eligible lists: pickup list has it, delivery list does not.
    const pickupEligible = await deliveriesSvc.listEligiblePickupPackages(waActor, fx.wh, {
      pageSize: 100,
    });
    expect(pickupEligible.items.map((i) => i.packageId)).toContain(firstParcel.packageId);
    const deliveryEligible = await deliveriesSvc.listEligibleDeliveryPackages(waActor, fx.wh, {
      pageSize: 100,
    });
    expect(deliveryEligible.items.map((i) => i.packageId)).not.toContain(firstParcel.packageId);

    // A DELIVERY batch cannot take it (no stock, not ready).
    const deliveryBatch = await makeBatch(fx.riderUser, "DELIVERY");
    const rejectedAdd = await deliveriesSvc.addBatchPackages(waActor, deliveryBatch.id, {
      packageIds: [firstParcel.packageId],
    });
    expect(rejectedAdd.added).toEqual([]);
    expect(rejectedAdd.rejected).toHaveLength(1);

    // The delivery collection entry point refuses a PICKUP-less flow:
    // confirmPickupCollection on a DELIVERY batch is a validation error.
    await expect(
      deliveriesSvc.confirmPickupCollection(riderActor, deliveryBatch.id, { trackingIds: [] }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);

    // A PICKUP batch takes it and moves it to PICKUP_ASSIGNED.
    const pickupBatch = await makeBatch(fx.riderUser, "PICKUP");
    pickupBatchId = pickupBatch.id;
    const added = await deliveriesSvc.addBatchPackages(waActor, pickupBatch.id, {
      packageIds: [firstParcel.packageId],
    });
    expect(added.rejected).toEqual([]);
    expect(added.added).toHaveLength(1);
    expect(added.added[0].kind).toBe("PICKUP");
    const after = await prisma.package.findUniqueOrThrow({ where: { id: firstParcel.packageId } });
    expect(after.operationalStatus).toBe("PICKUP_ASSIGNED");
    // Still no stock/custody — collection has not happened yet.
    expect(await openRecord(firstParcel.packageId)).toBeNull();
    expect(await openCustody(firstParcel.packageId)).toBeNull();

    // Rider home surfaces the PICKUP batch generically. (The empty
    // DELIVERY batch is cancelled first — getRiderHomeToday's
    // current batch is the earliest still-open batch of the day.)
    await deliveriesSvc.cancelBatch(waActor, deliveryBatch.id);
    const riderBatches = await deliveriesSvc.listRiderBatches(riderActor, { date: TODAY });
    expect(riderBatches.map((b) => b.id)).toContain(pickupBatchId);
    expect(riderBatches.find((b) => b.id === pickupBatchId)?.kind).toBe("PICKUP");
    const home = await deliveriesSvc.getRiderHomeToday(riderActor, TODAY);
    expect(home.currentBatch?.batch.id).toBe(pickupBatchId);
    expect(home.assigned).toBe(1);
    expect(home.remaining).toBe(1);
  });
});

describe("(ii) collection: only the assigned rider, shortages stay pending, no OTP", () => {
  it("collects a subset, reports the shortage, then collects the rest", async () => {
    secondParcel = await bookPickup();
    const added = await deliveriesSvc.addBatchPackages(waActor, pickupBatchId, {
      packageIds: [secondParcel.packageId],
    });
    expect(added.rejected).toEqual([]);
    expect(added.added).toHaveLength(1);
    const secondAssignmentId = added.added[0].id;

    // A different rider cannot collect from this batch.
    await expect(
      deliveriesSvc.confirmPickupCollection(rider2Actor, pickupBatchId, {
        trackingIds: [firstParcel.trackingId, secondParcel.trackingId],
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    // Collect only the first parcel: the second is an explicit
    // shortage and stays PICKUP_ASSIGNED + PENDING.
    const partial = await deliveriesSvc.confirmPickupCollection(riderActor, pickupBatchId, {
      trackingIds: [firstParcel.trackingId],
    });
    expect(partial.failed).toEqual([]);
    expect(partial.taken.map((t) => t.trackingId)).toEqual([firstParcel.trackingId]);
    expect(partial.shortages.map((s) => s.trackingId)).toEqual([secondParcel.trackingId]);

    let pkg2 = await prisma.package.findUniqueOrThrow({ where: { id: secondParcel.packageId } });
    expect(pkg2.operationalStatus).toBe("PICKUP_ASSIGNED");
    const asg2 = await prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: secondAssignmentId },
    });
    expect(asg2.status).toBe("PENDING");

    const pkg1 = await prisma.package.findUniqueOrThrow({ where: { id: firstParcel.packageId } });
    expect(pkg1.operationalStatus).toBe("PICKED_UP");
    const custody1 = await openCustody(firstParcel.packageId);
    expect(custody1?.custodianType).toBe("USER");
    expect(custody1?.custodianUserId).toBe(fx.riderUser);
    const asg1 = await prisma.deliveryAssignment.findFirstOrThrow({
      where: { packageId: firstParcel.packageId, kind: "PICKUP" },
    });
    expect(asg1.status).toBe("COMPLETED");
    // No OTP is ever generated for a pickup.
    expect(asg1.otpCodeHash).toBeNull();
    expect(asg1.otpGeneratedAt).toBeNull();

    // History shows both pickup transitions, in order.
    const events = await prisma.trackingEvent.findMany({
      where: { packageId: firstParcel.packageId },
      orderBy: { occurredAt: "asc" },
      select: { newStatus: true },
    });
    const statuses = events.map((e) => e.newStatus);
    expect(statuses.indexOf("PICKUP_IN_PROGRESS")).toBeGreaterThanOrEqual(0);
    expect(statuses.indexOf("PICKUP_IN_PROGRESS")).toBeLessThan(statuses.indexOf("PICKED_UP"));

    // Collect the rest.
    const rest = await deliveriesSvc.confirmPickupCollection(riderActor, pickupBatchId, {
      trackingIds: [secondParcel.trackingId],
    });
    expect(rest.failed).toEqual([]);
    expect(rest.taken.map((t) => t.trackingId)).toEqual([secondParcel.trackingId]);
    expect(rest.shortages).toEqual([]);
    pkg2 = await prisma.package.findUniqueOrThrow({ where: { id: secondParcel.packageId } });
    expect(pkg2.operationalStatus).toBe("PICKED_UP");
    const custody2 = await openCustody(secondParcel.packageId);
    expect(custody2?.custodianType).toBe("USER");
    expect(custody2?.custodianUserId).toBe(fx.riderUser);
    const asg2Done = await prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: secondAssignmentId },
    });
    expect(asg2Done.status).toBe("COMPLETED");
    expect(asg2Done.otpCodeHash).toBeNull();

    // The vendor's users were notified of each collection.
    const notes = await prisma.notification.findMany({
      where: {
        userId: fx.vendorOwnerUser,
        category: "GENERAL",
        entityType: "DeliveryAssignment",
        entityId: { in: [asg1.id, secondAssignmentId] },
      },
    });
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.every((n) => n.title.includes("Pickup collected"))).toBe(true);
  });
});

describe("(iii) receiving: a PICKED_UP parcel lands at RECEIVED_AT_ORIGIN and flows on", () => {
  it("receivePackage closes rider custody, opens stock, and the parcel reaches READY_FOR_DISPATCH", async () => {
    const received = await inventorySvc.receivePackage(waActor, {
      warehouseId: fx.wh,
      trackingId: firstParcel.trackingId,
    });
    expect(received.alreadyReceived).toBe(false);
    expect(received.misrouted).toBe(false);
    expect(received.package.operationalStatus).toBe("RECEIVED_AT_ORIGIN");
    expect(received.inventoryRecordId).not.toBeNull();

    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: firstParcel.packageId } });
    expect(pkg.operationalStatus).toBe("RECEIVED_AT_ORIGIN");
    const custody = await openCustody(firstParcel.packageId);
    expect(custody?.custodianType).toBe("WAREHOUSE");
    expect(custody?.warehouseId).toBe(fx.wh);
    const record = await openRecord(firstParcel.packageId);
    expect(record?.warehouseId).toBe(fx.wh);

    // Normal origin flow from here (smoke): inspection → put-away → ready.
    await inventorySvc.moveToInspection(waActor, firstParcel.packageId);
    await inventorySvc.startInspection(waActor, firstParcel.packageId);
    await inventorySvc.recordInspection(waActor, {
      packageId: firstParcel.packageId,
      condition: "GOOD",
      actualWeightKg: 1,
    });
    await inventorySvc.putAwayPackage(waActor, firstParcel.packageId, fx.locSto);
    const ready = await inventorySvc.markReadyForDispatch(waActor, firstParcel.packageId);
    expect(ready.operationalStatus).toBe("READY_FOR_DISPATCH");
  });
});

describe("(iv) failed pickup: PICKUP_FAILED, WA reschedules, collection succeeds", () => {
  it("records the failure, clears the flag on re-assignment, and collects", async () => {
    const parcel = await bookPickup();
    const batch1 = await makeBatch(fx.riderUser, "PICKUP");
    const added = await deliveriesSvc.addBatchPackages(waActor, batch1.id, {
      packageIds: [parcel.packageId],
    });
    expect(added.rejected).toEqual([]);
    const assignmentId = added.added[0].id;

    // Another rider cannot record the attempt.
    await expect(
      deliveriesSvc.recordPickupAttempt(rider2Actor, assignmentId, {
        reason: "Sender unavailable",
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    const result = await deliveriesSvc.recordPickupAttempt(riderActor, assignmentId, {
      reason: "Sender unavailable — shop closed",
    });
    expect(result.assignment.status).toBe("FAILED");
    expect(result.assignment.failureNote).toBe("Sender unavailable — shop closed");

    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
    expect(pkg.operationalStatus).toBe("PICKUP_ASSIGNED");
    expect(pkg.exceptionStatus).toBe("PICKUP_FAILED");
    const attempt = await prisma.deliveryAttempt.findFirst({
      where: { packageId: parcel.packageId, result: "PICKUP_FAILED" },
    });
    expect(attempt).not.toBeNull();
    const raised = await prisma.trackingEvent.findFirst({
      where: { packageId: parcel.packageId, eventType: "EXCEPTION_RAISED" },
    });
    expect(raised?.notes).toContain("Sender unavailable");
    // WA + vendor were notified of the failure.
    const failNotes = await prisma.notification.findMany({
      where: { entityType: "DeliveryAssignment", entityId: assignmentId, category: "GENERAL" },
    });
    expect(failNotes.some((n) => n.userId === fx.vendorOwnerUser)).toBe(true);
    expect(failNotes.some((n) => n.userId === fx.waUser)).toBe(true);

    // The failed parcel is eligible again (reschedule list).
    const eligible = await deliveriesSvc.listEligiblePickupPackages(waActor, fx.wh, {
      pageSize: 100,
    });
    expect(eligible.items.map((i) => i.packageId)).toContain(parcel.packageId);

    // WA puts it on a new PICKUP batch (second rider): the flag clears.
    const batch2 = await makeBatch(fx.rider2User, "PICKUP");
    const readded = await deliveriesSvc.addBatchPackages(waActor, batch2.id, {
      packageIds: [parcel.packageId],
    });
    expect(readded.rejected).toEqual([]);
    expect(readded.added).toHaveLength(1);
    expect(readded.added[0].kind).toBe("PICKUP");
    const after = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
    expect(after.operationalStatus).toBe("PICKUP_ASSIGNED");
    expect(after.exceptionStatus).toBe("NONE");

    const collected = await deliveriesSvc.confirmPickupCollection(rider2Actor, batch2.id, {
      trackingIds: [parcel.trackingId],
    });
    expect(collected.failed).toEqual([]);
    expect(collected.taken).toHaveLength(1);
    const finalPkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
    expect(finalPkg.operationalStatus).toBe("PICKED_UP");
    const custody = await openCustody(parcel.packageId);
    expect(custody?.custodianUserId).toBe(fx.rider2User);
  });
});

describe("(v) drop-off bookings are not pickups", () => {
  it("a WAREHOUSE_DROPOFF package is rejected by a PICKUP batch and still receives via the BOOKED path", async () => {
    const parcel = await bookDropoff();
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
    expect(pkg.operationalStatus).toBe("BOOKED");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: pkg.orderId } });
    expect(order.pickupMethod).toBe("WAREHOUSE_DROPOFF");

    const eligible = await deliveriesSvc.listEligiblePickupPackages(waActor, fx.wh, {
      pageSize: 100,
    });
    expect(eligible.items.map((i) => i.packageId)).not.toContain(parcel.packageId);

    const batch = await makeBatch(fx.riderUser, "PICKUP");
    const res = await deliveriesSvc.addBatchPackages(waActor, batch.id, {
      packageIds: [parcel.packageId],
    });
    expect(res.added).toEqual([]);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].reason).toMatch(/not a rider-pickup booking/);

    // The counter drop-off path is unchanged: BOOKED → RECEIVED_AT_ORIGIN.
    const received = await inventorySvc.receivePackage(waActor, {
      warehouseId: fx.wh,
      trackingId: parcel.trackingId,
    });
    expect(received.package.operationalStatus).toBe("RECEIVED_AT_ORIGIN");
  });
});
