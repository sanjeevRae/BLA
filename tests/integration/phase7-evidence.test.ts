import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 7 integration tests — POD evidence integrity (audit item
 * M-10 disposition) against the local bla_test database.
 *
 * confirmDelivery now accepts optional photoFileId /
 * signatureFileId evidence references. Each provided reference is
 * stored (trimmed) on the ProofOfDelivery together with the
 * SHA-256 hash of the stored value, and the hash is bound to the
 * package in DeliveryEvidenceBinding inside the delivery
 * transaction:
 *  (i)   a delivery with a photo reference succeeds; the POD
 *        carries the ref + a 64-char hex hash and a binding row
 *        points at package / assignment / POD;
 *  (ii)  a SECOND package reusing the same reference is refused
 *        with DomainValidationError and stays UNDELIVERED (status,
 *        assignment and POD absence all asserted — the whole
 *        transaction rolled back);
 *  (iii) the same-package (supersede / re-delivery) branch of the
 *        binding check does not self-conflict and never duplicates
 *        the binding — tested at the binding-check level, because
 *        no live supersede flow exists to drive it end-to-end:
 *        nothing in the codebase ever sets ProofOfDelivery.
 *        supersededById, confirmDelivery status-gates DELIVERED
 *        packages out, and the one-valid-POD partial unique index
 *        (phase6_hardening) forbids a second live POD per package.
 *        The exported bindDeliveryEvidence helper IS the exact
 *        code confirmDelivery runs in its transaction, so the
 *        same-package branch is exercised directly;
 *  (iv)  signature references bind the same way, and the binding
 *        hash is globally unique ACROSS kinds: the identical
 *        string presented as a signature for package A and a photo
 *        for package B conflicts (conservative, intended);
 *  (v)   a delivery with no evidence references behaves exactly as
 *        before (regression).
 *
 * Fixtures mirror deliveries.test.ts: shared WH-ZP6 warehouses
 * (find-or-create), per-run users / vendor / bookings.
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
const email = (label: string) => `p7e-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);
const RECIPIENT_PHONE = phone(101);
const TODAY = new Date().toISOString().slice(0, 10);
const sha256Hex = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");
const evidenceRef = (label: string) => `evidence://pod/${RUN}/${label}`;

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let inventorySvc: typeof import("@/server/services/inventory");
let transfersSvc: typeof import("@/server/services/transfers");
let tripsSvc: typeof import("@/server/services/trips");
let driversSvc: typeof import("@/server/services/drivers");
let vehiclesSvc: typeof import("@/server/services/vehicles");
let deliveriesSvc: typeof import("@/server/services/deliveries");
let errors: typeof import("@/lib/errors");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
let linehaulActor: Awaited<ReturnType<typeof actorFor>>;
let riderAActor: Awaited<ReturnType<typeof actorFor>>;
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
      fullName: `P7E ${label}`,
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

async function bookOne(): Promise<{ packageId: string; trackingId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId: fx.vendor,
    sender: { name: "P7E Sender", phone: phone(42), email: null },
    recipient: {
      name: "P7E Recipient",
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
    items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
  });
  const pkg = booking.shipments[0].packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId };
}

/** Full chain: book at A → receive/inspect/put-away/ready at A →
 *  transfer A→B → destination receive → RECEIVED_AT_DESTINATION at B. */
async function atDestination(): Promise<{ packageId: string; trackingId: string }> {
  const { packageId, trackingId } = await bookOne();
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
    idempotencyKey: `p7e-load-${RUN}-${trackingId}`,
  });
  expect(loaded.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(linehaulActor, tripId);
  await tripsSvc.arriveTrip(linehaulActor, tripId);
  const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
    trackingId,
    idempotencyKey: `p7e-unload-${RUN}-${trackingId}`,
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
  expect(pkg.currentWarehouseId).toBe(fx.whB);
  return { packageId, trackingId };
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

/** Batch + assign + pickup; returns the parcel out for delivery. */
async function outForDelivery() {
  const parcel = await atDestination();
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
  return {
    ...parcel,
    batch,
    assignment: added.added[0],
    otp: await recipientOtp(pickup.taken[0].assignmentId),
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
  errors = await import("@/lib/errors");
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

  fx.districtA = "P6Alpha District";
  fx.districtB = "P6Beta District";
  const a = await ensureWarehouse("WH-ZP6-01", "P6 Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  const b = await ensureWarehouse("WH-ZP6-02", "P6 Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;

  serviceCode = `P7ESTD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P7E Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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
    businessName: `P7E Vendor ${RUN}`,
    contactName: "P7E Contact",
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
    licenseNumber: `LIC-P7E-LH-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.linehaulProfile = linehaul.id;
  linehaulActor = await actorFor(fx.linehaulUser);
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P7E TRK ${RUN.slice(-6)}`.toUpperCase(),
    type: "TRUCK",
    capacityKg: 5000,
    homeWarehouseId: fx.whA,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  fx.vehicle = vehicle.id;

  const riderUserId = await makeUser("riderA", "RIDER");
  const riderProfile = await driversSvc.createDriverProfile(adminActor, {
    userId: riderUserId,
    homeWarehouseId: fx.whB,
    licenseNumber: `LIC-P7E-RIDER-${RUN}`.toUpperCase(),
    licenseCategory: "B",
    licenseExpiry: "2030-01-01",
    capabilities: ["DELIVERY", "PICKUP"],
  });
  fx.riderAUser = riderUserId;
  fx.riderAProfile = riderProfile.id;
  riderAActor = await actorFor(fx.riderAUser);
  expect(riderAActor.driverId).toBe(fx.riderAProfile);
}, 240_000);

// ---------------------------------------------------------------------------

describe("POD evidence binding (Phase 7, M-10)", () => {
  it("(i) delivery with a photo reference stores ref + SHA-256 hash and creates the binding", async () => {
    const { packageId, assignment, otp } = await outForDelivery();
    const stored = evidenceRef("doorstep-photo.jpg");
    // Surrounding whitespace: the reference is stored trimmed and
    // the hash is taken over the STORED value (documented choice).
    const delivered = await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P7E Recipient",
      otpCode: otp,
      photoFileId: `  ${stored}  `,
    });
    expect(delivered.assignment.status).toBe("COMPLETED");

    const pod = await prisma.proofOfDelivery.findFirstOrThrow({ where: { packageId } });
    expect(pod.id).toBe(delivered.proofOfDeliveryId);
    expect(pod.photoFileId).toBe(stored);
    expect(pod.photoEvidenceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(pod.photoEvidenceHash).toBe(sha256Hex(stored));
    expect(pod.signatureFileId).toBeNull();
    expect(pod.signatureEvidenceHash).toBeNull();

    const binding = await prisma.deliveryEvidenceBinding.findUniqueOrThrow({
      where: { evidenceHash: sha256Hex(stored) },
    });
    expect(binding.evidenceKind).toBe("PHOTO");
    expect(binding.packageId).toBe(packageId);
    expect(binding.assignmentId).toBe(assignment.id);
    expect(binding.proofOfDeliveryId).toBe(pod.id);
    expect(binding.createdById).toBe(fx.riderAUser);
  });

  it("(ii) the same photo reference for a SECOND package is refused and that package stays undelivered", async () => {
    const shared = evidenceRef("shared-photo.jpg");
    const first = await outForDelivery();
    await deliveriesSvc.confirmDelivery(riderAActor, first.assignment.id, {
      receivedByName: "P7E Recipient",
      otpCode: first.otp,
      photoFileId: shared,
    });
    const firstPkg = await prisma.package.findUniqueOrThrow({
      where: { id: first.packageId },
    });
    expect(firstPkg.operationalStatus).toBe("DELIVERED");

    const second = await outForDelivery();
    const attempt = deliveriesSvc.confirmDelivery(riderAActor, second.assignment.id, {
      receivedByName: "P7E Recipient",
      otpCode: second.otp,
      photoFileId: shared,
    });
    await expect(attempt).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      deliveriesSvc.confirmDelivery(riderAActor, second.assignment.id, {
        receivedByName: "P7E Recipient",
        otpCode: second.otp,
        photoFileId: shared,
      }),
    ).rejects.toThrow("This evidence has already been used for another delivery");

    // The whole delivery rolled back: package + assignment
    // unchanged, no POD, no delivered attempt, still one binding.
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: second.packageId } });
    expect(pkg.operationalStatus).toBe("OUT_FOR_DELIVERY");
    expect(pkg.deliveryStatus).toBe("OUT_FOR_DELIVERY");
    const assignmentRow = await prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: second.assignment.id },
    });
    expect(assignmentRow.status).toBe("IN_PROGRESS");
    expect(
      await prisma.proofOfDelivery.count({ where: { packageId: second.packageId } }),
    ).toBe(0);
    expect(
      await prisma.deliveryAttempt.count({
        where: { packageId: second.packageId, result: "DELIVERED" },
      }),
    ).toBe(0);
    expect(
      await prisma.deliveryEvidenceBinding.count({
        where: { evidenceHash: sha256Hex(shared) },
      }),
    ).toBe(1);

    // The refused package can still be delivered with fresh evidence.
    await deliveriesSvc.confirmDelivery(riderAActor, second.assignment.id, {
      receivedByName: "P7E Recipient",
      otpCode: second.otp,
      photoFileId: evidenceRef("second-package-own-photo.jpg"),
    });
    const pkgAfter = await prisma.package.findUniqueOrThrow({
      where: { id: second.packageId },
    });
    expect(pkgAfter.operationalStatus).toBe("DELIVERED");
  });

  it("(iii) same-package re-binding (supersede / re-delivery branch) does not self-conflict or duplicate", async () => {
    const ref = evidenceRef("redelivery-photo.jpg");
    const { packageId, assignment, otp } = await outForDelivery();
    const delivered = await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P7E Recipient",
      otpCode: otp,
      photoFileId: ref,
    });
    const hash = sha256Hex(ref);
    expect(
      await prisma.deliveryEvidenceBinding.count({ where: { evidenceHash: hash } }),
    ).toBe(1);

    // No live supersede flow can drive a second confirmDelivery for
    // this package (see the file header), so the same-package
    // branch is exercised through bindDeliveryEvidence — the exact
    // helper confirmDelivery calls inside its transaction — with
    // the same package / assignment / POD coordinates a superseding
    // POD would carry.
    const created = await prisma.$transaction((tx) =>
      deliveriesSvc.bindDeliveryEvidence(tx, {
        evidenceHash: hash,
        evidenceKind: "PHOTO",
        packageId,
        assignmentId: assignment.id,
        proofOfDeliveryId: delivered.proofOfDeliveryId,
        createdById: fx.riderAUser,
      }),
    );
    expect(created).toBe(false);
    expect(
      await prisma.deliveryEvidenceBinding.count({ where: { evidenceHash: hash } }),
    ).toBe(1);

    // The helper's hash + normalisation contract, pinned directly.
    expect(deliveriesSvc.hashEvidenceReference(ref)).toBe(hash);
    expect(deliveriesSvc.normalizeEvidenceReference(`  ${ref} `)).toBe(ref);
    expect(deliveriesSvc.normalizeEvidenceReference("   ")).toBeNull();
    expect(deliveriesSvc.normalizeEvidenceReference(null)).toBeNull();
    expect(deliveriesSvc.normalizeEvidenceReference(undefined)).toBeNull();
  });

  it("(iv) signature references bind too, and an identical string conflicts across kinds on a different package", async () => {
    const shared = evidenceRef("identical-string");
    const first = await outForDelivery();
    const delivered = await deliveriesSvc.confirmDelivery(riderAActor, first.assignment.id, {
      receivedByName: "P7E Recipient",
      otpCode: first.otp,
      signatureFileId: shared,
    });
    const pod = await prisma.proofOfDelivery.findUniqueOrThrow({
      where: { id: delivered.proofOfDeliveryId },
    });
    expect(pod.signatureFileId).toBe(shared);
    expect(pod.signatureEvidenceHash).toBe(sha256Hex(shared));
    expect(pod.photoFileId).toBeNull();
    const binding = await prisma.deliveryEvidenceBinding.findUniqueOrThrow({
      where: { evidenceHash: sha256Hex(shared) },
    });
    expect(binding.evidenceKind).toBe("SIGNATURE");
    expect(binding.packageId).toBe(first.packageId);

    // The binding hash is globally unique — kind is NOT part of the
    // uniqueness. The same string as a PHOTO for another package
    // still conflicts (conservative, intended behaviour).
    const second = await outForDelivery();
    await expect(
      deliveriesSvc.confirmDelivery(riderAActor, second.assignment.id, {
        receivedByName: "P7E Recipient",
        otpCode: second.otp,
        photoFileId: shared,
      }),
    ).rejects.toThrow("This evidence has already been used for another delivery");
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: second.packageId } });
    expect(pkg.operationalStatus).toBe("OUT_FOR_DELIVERY");
    expect(
      await prisma.proofOfDelivery.count({ where: { packageId: second.packageId } }),
    ).toBe(0);
  });

  it("(v) a delivery without any evidence references succeeds exactly as before", async () => {
    const { packageId, assignment, otp } = await outForDelivery();
    const delivered = await deliveriesSvc.confirmDelivery(riderAActor, assignment.id, {
      receivedByName: "P7E Recipient",
      otpCode: otp,
    });
    expect(delivered.assignment.status).toBe("COMPLETED");
    const pod = await prisma.proofOfDelivery.findUniqueOrThrow({
      where: { id: delivered.proofOfDeliveryId },
    });
    expect(pod.photoFileId).toBeNull();
    expect(pod.signatureFileId).toBeNull();
    expect(pod.photoEvidenceHash).toBeNull();
    expect(pod.signatureEvidenceHash).toBeNull();
    expect(
      await prisma.deliveryEvidenceBinding.count({ where: { packageId } }),
    ).toBe(0);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: packageId } });
    expect(pkg.operationalStatus).toBe("DELIVERED");
  });
});
