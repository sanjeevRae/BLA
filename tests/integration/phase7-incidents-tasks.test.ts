import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 7 (V2) integration tests — incidents + tasks scope:
 *
 *  - Driver incident reporting (service scope rules): riders and
 *    line-haul drivers report against their OWN delivery
 *    assignments / trips / manifested packages despite holding no
 *    warehouse memberships; other drivers are denied (audited).
 *  - Driver visibility: a reporter sees their own incidents in
 *    list + detail, never another driver's.
 *  - Incident → follow-up task (incident.manage, staff assignee,
 *    default title, warehouse inheritance).
 *  - Auto-incident verification: transfer excess, transfer
 *    missing-at-finish (TRANSFER_SHORTAGE), custody short-count
 *    (HANDOVER_DISCREPANCY) — each fires exactly once.
 *  - Task state machine: BLOCKED requires a reason (persisted as a
 *    comment); illegal jumps refused; assignee-only work;
 *    second-pair-of-eyes verification; CLOSED only from VERIFIED;
 *    the full happy walk.
 *
 * Fixture warehouses are SHARED across runs (WH-ZP7 codes,
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
const email = (label: string) => `p7-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);
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
let custodySvc: typeof import("@/server/services/custody");
let incidentsSvc: typeof import("@/server/services/incidents");
let tasksSvc: typeof import("@/server/services/tasks");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
let staffBActor: Awaited<ReturnType<typeof actorFor>>;
let linehaulActor: Awaited<ReturnType<typeof actorFor>>;
let rider1Actor: Awaited<ReturnType<typeof actorFor>>;
let rider2Actor: Awaited<ReturnType<typeof actorFor>>;
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

async function bookOne(destDistrict: string = fx.districtB) {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId: fx.vendor,
    sender: { name: "P7 Sender", phone: phone(42), email: null },
    recipient: {
      name: "P7 Recipient",
      phone: phone(101),
      addressLine: "Lakeside Street 1",
      city: "Town",
      district: destDistrict,
      province: "Bagmati",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId: fx.whA },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa: "0",
    items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
  });
  const shipment = booking.shipments[0];
  const pkg = shipment.packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId, shipmentId: shipment.id };
}

/** Receive + inspect + put away at A (stocked, not dispatch-ready). */
async function stockAtA(parcel: { packageId: string; trackingId: string }) {
  await inventorySvc.receivePackage(staffAActor, {
    warehouseId: fx.whA,
    trackingId: parcel.trackingId,
  });
  await inventorySvc.moveToInspection(staffAActor, parcel.packageId);
  await inventorySvc.startInspection(staffAActor, parcel.packageId);
  await inventorySvc.recordInspection(staffAActor, {
    packageId: parcel.packageId,
    condition: "GOOD",
    actualWeightKg: 2,
  });
  await inventorySvc.putAwayPackage(staffAActor, parcel.packageId, fx.locStoA);
}

async function readyAtA(parcel: { packageId: string; trackingId: string }) {
  await stockAtA(parcel);
  await inventorySvc.markReadyForDispatch(staffAActor, parcel.packageId);
}

/** Manifest + crew + load + dispatch + depart + arrive for the
 *  given ready parcels on a fresh A→B transfer. */
async function runTransferToArrival(
  parcels: { packageId: string; trackingId: string }[],
) {
  const transfer = await transfersSvc.createTransfer(waAActor, {
    originWarehouseId: fx.whA,
    destinationWarehouseId: fx.whB,
  });
  const added = await transfersSvc.addTransferItems(
    waAActor,
    transfer.id,
    parcels.map((p) => p.packageId),
  );
  expect(added.rejected).toEqual([]);
  await transfersSvc.generateManifest(waAActor, transfer.id);
  const crewed = await transfersSvc.assignTransferCrew(waAActor, {
    transferId: transfer.id,
    driverId: fx.linehaulProfile,
    vehicleId: fx.vehicle,
  });
  let lastLoaded: Awaited<ReturnType<typeof transfersSvc.loadTransferPackage>> | null = null;
  for (const p of parcels) {
    lastLoaded = await transfersSvc.loadTransferPackage(waAActor, transfer.id, {
      trackingId: p.trackingId,
      idempotencyKey: `p7-load-${RUN}-${p.trackingId}`,
    });
  }
  expect(lastLoaded!.allLoaded).toBe(true);
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
  const tripId = dispatched.tripId ?? crewed.tripId!;
  await tripsSvc.departTrip(linehaulActor, tripId);
  await tripsSvc.arriveTrip(linehaulActor, tripId);
  return { transfer, tripId };
}

async function receiveAndClose(
  transferId: string,
  parcels: { packageId: string; trackingId: string }[],
) {
  for (const p of parcels) {
    const scan = await transfersSvc.scanDestinationPackage(waBActor, transferId, {
      trackingId: p.trackingId,
      idempotencyKey: `p7-unload-${RUN}-${p.trackingId}`,
    });
    expect(scan.kind).toBe("RECEIVED_SCAN");
    await transfersSvc.completePackageReceiving(waBActor, transferId, {
      packageId: p.packageId,
      condition: "GOOD",
    });
  }
  await transfersSvc.finishReceiving(waBActor, transferId);
  await transfersSvc.reconcileTransfer(waBActor, transferId);
  await transfersSvc.closeTransfer(waBActor, transferId);
}

/** Full journey: a parcel ends RECEIVED_AT_DESTINATION at B. */
async function atDestination() {
  const parcel = await bookOne();
  await readyAtA(parcel);
  const { transfer } = await runTransferToArrival([parcel]);
  await receiveAndClose(transfer.id, [parcel]);
  const pkg = await prisma.package.findUniqueOrThrow({ where: { id: parcel.packageId } });
  expect(pkg.operationalStatus).toBe("RECEIVED_AT_DESTINATION");
  expect(pkg.currentWarehouseId).toBe(fx.whB);
  return parcel;
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
  custodySvc = await import("@/server/services/custody");
  incidentsSvc = await import("@/server/services/incidents");
  tasksSvc = await import("@/server/services/tasks");
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

  const vendor = await vendorsSvc.createVendor(adminActor, {
    businessName: `P7 Vendor ${RUN}`,
    contactName: "P7 Contact",
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
      vendorId: vendor.id,
      vendorRole: "OWNER",
      isActive: true,
      invitedById: fx.adminUser,
    },
  });

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
  staffBActor = await actorFor(fx.staffB);

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
  expect(linehaulActor.driverId).toBe(fx.linehaulProfile);
  // Drivers hold NO warehouse memberships in these fixtures — their
  // incident scope must come from their work links alone.
  expect(linehaulActor.warehouseIds).toEqual([]);

  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P7 TRK ${RUN.slice(-6)}`.toUpperCase(),
    type: "TRUCK",
    capacityKg: 5000,
    homeWarehouseId: fx.whA,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  fx.vehicle = vehicle.id;

  fx.rider1User = await makeUser("rider1", "RIDER");
  const rider1 = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.rider1User,
    homeWarehouseId: fx.whB,
    licenseNumber: `LIC-P7-R1-${RUN}`,
    licenseCategory: "A",
    licenseExpiry: "2030-01-01",
    capabilities: ["DELIVERY"],
  });
  fx.rider1Profile = rider1.id;
  rider1Actor = await actorFor(fx.rider1User);
  expect(rider1Actor.driverId).toBe(fx.rider1Profile);
  expect(rider1Actor.warehouseIds).toEqual([]);

  fx.rider2User = await makeUser("rider2", "RIDER");
  const rider2 = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.rider2User,
    homeWarehouseId: fx.whB,
    licenseNumber: `LIC-P7-R2-${RUN}`,
    licenseCategory: "A",
    licenseExpiry: "2030-01-01",
    capabilities: ["DELIVERY"],
  });
  fx.rider2Profile = rider2.id;
  rider2Actor = await actorFor(fx.rider2User);
}, 240_000);

// ---------------------------------------------------------------------------

describe("driver incident reporting (Phase 7 scope rules)", () => {
  it("a rider reports via their own delivery assignment; warehouse derives from the batch", async () => {
    const parcel = await atDestination();
    const batch = await deliveriesSvc.createDeliveryBatch(waBActor, {
      warehouseId: fx.whB,
      riderUserId: fx.rider1User,
      batchDate: TODAY,
      kind: "DELIVERY",
    });
    const added = await deliveriesSvc.addBatchPackages(waBActor, batch.id, {
      packageIds: [parcel.packageId],
    });
    expect(added.rejected).toEqual([]);
    const assignment = added.added[0];
    expect(assignment.status).toBe("PENDING");
    fx.assignmentId = assignment.id;
    fx.riderPackageId = parcel.packageId;

    const view = await incidentsSvc.createIncident(rider1Actor, {
      category: "DELIVERY_FAILURE",
      description: "Recipient's gate is locked and phone unreachable",
      deliveryAssignmentId: assignment.id,
      packageId: parcel.packageId,
    });
    expect(view.status).toBe("REPORTED");
    expect(view.deliveryAssignmentId).toBe(assignment.id);
    expect(view.packageId).toBe(parcel.packageId);
    expect(view.warehouseId).toBe(fx.whB);
    expect(view.reporterId).toBe(fx.rider1User);
    fx.riderIncident = view.id;

    // Assignment link alone implies the package.
    const inferred = await incidentsSvc.createIncident(rider1Actor, {
      category: "INCORRECT_ADDRESS",
      description: "Address on the label does not match the street",
      deliveryAssignmentId: assignment.id,
    });
    expect(inferred.packageId).toBe(parcel.packageId);
    expect(inferred.warehouseId).toBe(fx.whB);
  }, 180_000);

  it("a rider reports via the package link alone (active assignment bypasses warehouse membership)", async () => {
    // rider1Actor.warehouseIds is [] (asserted in beforeAll): the
    // pre-Phase-7 warehouse-membership check denied exactly this.
    const view = await incidentsSvc.createIncident(rider1Actor, {
      category: "DAMAGED_PACKAGE",
      description: "Corner crushed while loading the bike",
      packageId: fx.riderPackageId,
    });
    expect(view.warehouseId).toBe(fx.whB);
    expect(view.packageId).toBe(fx.riderPackageId);
  });

  it("another driver is denied the same assignment and package links (audited)", async () => {
    await expect(
      incidentsSvc.createIncident(rider2Actor, {
        category: "DELIVERY_FAILURE",
        description: "Trying to report on someone else's assignment",
        deliveryAssignmentId: fx.assignmentId,
        packageId: fx.riderPackageId,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      incidentsSvc.createIncident(rider2Actor, {
        category: "DAMAGED_PACKAGE",
        description: "Trying to report on someone else's package",
        packageId: fx.riderPackageId,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // The line-haul driver holds no delivery assignment either.
    await expect(
      incidentsSvc.createIncident(linehaulActor, {
        category: "DELIVERY_FAILURE",
        description: "Line-haul driver reaching for a rider assignment",
        deliveryAssignmentId: fx.assignmentId,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    const denial = await prisma.auditLog.findFirst({
      where: {
        action: "access.denied",
        entityType: "Incident",
        actorId: fx.rider2User,
      },
    });
    expect(denial).not.toBeNull();
  });

  it("a line-haul driver reports at trip level and via a manifested package; warehouse derives from the transfer origin", async () => {
    const parcel = await bookOne();
    await readyAtA(parcel);
    const { transfer, tripId } = await runTransferToArrival([parcel]);
    fx.tripId = tripId;

    const tripView = await incidentsSvc.createIncident(linehaulActor, {
      category: "DRIVER_BREAKDOWN",
      description: "Engine overheating past Mugling, stopped safely",
      tripId,
    });
    expect(tripView.tripId).toBe(tripId);
    expect(tripView.warehouseId).toBe(fx.whA);
    fx.linehaulIncident = tripView.id;

    // Package link alone: the package is manifested on the driver's
    // own active trip — no warehouse membership is involved.
    const pkgView = await incidentsSvc.createIncident(linehaulActor, {
      category: "DAMAGED_PACKAGE",
      description: "One carton is leaking after the breakdown stop",
      packageId: parcel.packageId,
    });
    expect(pkgView.packageId).toBe(parcel.packageId);

    // A rider cannot attach the line-haul driver's trip.
    await expect(
      incidentsSvc.createIncident(rider1Actor, {
        category: "DRIVER_BREAKDOWN",
        description: "Rider reaching for a line-haul trip",
        tripId,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    // Free the driver + vehicle for the journeys below.
    await receiveAndClose(transfer.id, [parcel]);
  }, 180_000);
});

describe("driver incident visibility", () => {
  it("a reporter sees their own incidents in list and detail — and no other driver's", async () => {
    const riderList = await incidentsSvc.listIncidents(rider1Actor, { pageSize: 100 });
    expect(riderList.items.map((i) => i.id)).toContain(fx.riderIncident);
    expect(riderList.items.map((i) => i.id)).not.toContain(fx.linehaulIncident);

    const own = await incidentsSvc.getIncident(rider1Actor, fx.riderIncident);
    expect(own.id).toBe(fx.riderIncident);
    // Staff reporters keep the full view of their own reports.
    expect(own.reporterName).toBe("P7 rider1");

    await expect(
      incidentsSvc.getIncident(rider1Actor, fx.linehaulIncident),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      incidentsSvc.getIncident(rider2Actor, fx.riderIncident),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);

    const lhList = await incidentsSvc.listIncidents(linehaulActor, { pageSize: 100 });
    expect(lhList.items.map((i) => i.id)).toContain(fx.linehaulIncident);
    expect(lhList.items.map((i) => i.id)).not.toContain(fx.riderIncident);
    const lhOwn = await incidentsSvc.getIncident(linehaulActor, fx.linehaulIncident);
    expect(lhOwn.tripId).toBe(fx.tripId);
  });
});

// ---------------------------------------------------------------------------

describe("incident follow-up tasks", () => {
  it("creates a task linked to the incident with the default title and the incident's warehouse", async () => {
    const incident = await prisma.incident.findUniqueOrThrow({ where: { id: fx.riderIncident } });
    const created = await incidentsSvc.createIncidentFollowUpTask(adminActor, fx.riderIncident, {
      assigneeId: fx.staffB,
    });
    expect(created.title).toBe(`Follow up incident ${incident.incidentNumber}`);
    expect(created.relatedIncidentId).toBe(fx.riderIncident);
    expect(created.warehouseId).toBe(fx.whB);
    expect(created.assigneeId).toBe(fx.staffB);
    expect(created.status).toBe("ASSIGNED");

    const task = await tasksSvc.getTask(staffBActor, created.id);
    expect(task.relatedIncidentId).toBe(fx.riderIncident);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "incident.follow_up_task_created", entityId: fx.riderIncident },
    });
    expect(audit).not.toBeNull();
  });

  it("honours a custom title, priority and due date", async () => {
    const due = new Date(Date.now() + 86_400_000);
    const created = await incidentsSvc.createIncidentFollowUpTask(waBActor, fx.riderIncident, {
      assigneeId: fx.staffB,
      title: "Call the recipient and rebook the delivery",
      priority: "HIGH",
      dueAt: due,
    });
    expect(created.title).toBe("Call the recipient and rebook the delivery");
    expect(created.priority).toBe("HIGH");
    expect(created.dueAt).toBe(due.toISOString());
  });

  it("requires incident.manage and a staff assignee", async () => {
    await expect(
      incidentsSvc.createIncidentFollowUpTask(rider1Actor, fx.riderIncident, {
        assigneeId: fx.staffB,
      }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // A vendor account is not a staff assignee (createTaskInTx rule).
    await expect(
      incidentsSvc.createIncidentFollowUpTask(adminActor, fx.riderIncident, {
        assigneeId: fx.vendorOwnerUser,
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      incidentsSvc.createIncidentFollowUpTask(adminActor, "00000000-0000-4000-8000-000000000000", {
        assigneeId: fx.staffB,
      }),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
  });
});

// ---------------------------------------------------------------------------

describe("task state machine (Phase 7)", () => {
  async function newTask(assigneeId: string = fx.staffB) {
    return tasksSvc.createTask(adminActor, {
      title: `P7 walk ${RUN} ${Math.random().toString(36).slice(2, 8)}`,
      assigneeId,
      warehouseId: fx.whB,
    });
  }

  it("BLOCKED requires a reason; the reason persists as a comment and the state is untouched on refusal", async () => {
    const task = await newTask();
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "ACCEPTED" });
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "IN_PROGRESS" });

    await expect(
      tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "BLOCKED" }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    // Whitespace + two real characters is still not a reason.
    await expect(
      tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "BLOCKED", note: "  ab " }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    const after = await tasksSvc.getTask(staffBActor, task.id);
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.comments).toHaveLength(0);

    const blocked = await tasksSvc.updateTaskStatus(staffBActor, task.id, {
      status: "BLOCKED",
      note: "Waiting on the vendor to confirm the count",
    });
    expect(blocked.status).toBe("BLOCKED");
    const withComment = await tasksSvc.getTask(staffBActor, task.id);
    expect(withComment.comments.map((c) => c.body)).toContain(
      "Waiting on the vendor to confirm the count",
    );
  });

  it("illegal jumps are refused", async () => {
    const task = await newTask();
    // ASSIGNED → SUBMITTED skips the whole working path.
    await expect(
      tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "SUBMITTED" }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "ACCEPTED" });
    // ACCEPTED → VERIFIED skips submission entirely.
    await expect(
      tasksSvc.updateTaskStatus(waBActor, task.id, { status: "VERIFIED" }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "IN_PROGRESS" });
    // IN_PROGRESS → CLOSED skips submit + verify.
    await expect(
      tasksSvc.updateTaskStatus(adminActor, task.id, { status: "CLOSED" }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "SUBMITTED" });
    await tasksSvc.updateTaskStatus(waBActor, task.id, { status: "VERIFIED" });
    // VERIFIED → IN_PROGRESS goes backwards.
    await expect(
      tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "IN_PROGRESS" }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  });

  it("the assignee cannot verify their own task, even holding task.verify", async () => {
    // waB holds task.verify (WAREHOUSE_ADMIN) and is staff, so the
    // task can be assigned to them — the second-pair-of-eyes rule
    // is what must stop the self-verification.
    const task = await newTask(fx.waB);
    await tasksSvc.updateTaskStatus(waBActor, task.id, { status: "ACCEPTED" });
    await tasksSvc.updateTaskStatus(waBActor, task.id, { status: "IN_PROGRESS" });
    await tasksSvc.updateTaskStatus(waBActor, task.id, { status: "SUBMITTED" });
    await expect(
      tasksSvc.updateTaskStatus(waBActor, task.id, { status: "VERIFIED" }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    const verified = await tasksSvc.updateTaskStatus(adminActor, task.id, { status: "VERIFIED" });
    expect(verified.status).toBe("VERIFIED");
  });

  it("only the assignee can accept or submit", async () => {
    const task = await newTask();
    // The creator cannot accept on the assignee's behalf.
    await expect(
      tasksSvc.updateTaskStatus(adminActor, task.id, { status: "ACCEPTED" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // A bystander cannot even reach the transition.
    await expect(
      tasksSvc.updateTaskStatus(staffAActor, task.id, { status: "ACCEPTED" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "ACCEPTED" });
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "IN_PROGRESS" });
    await expect(
      tasksSvc.updateTaskStatus(adminActor, task.id, { status: "SUBMITTED" }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
  });

  it("CLOSED is reachable only from VERIFIED", async () => {
    const task = await newTask();
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "ACCEPTED" });
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "IN_PROGRESS" });
    await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "SUBMITTED" });
    await expect(
      tasksSvc.updateTaskStatus(adminActor, task.id, { status: "CLOSED" }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    await tasksSvc.updateTaskStatus(waBActor, task.id, { status: "VERIFIED" });
    const closed = await tasksSvc.updateTaskStatus(adminActor, task.id, { status: "CLOSED" });
    expect(closed.status).toBe("CLOSED");
    expect(closed.closedAt).not.toBeNull();
  });

  it("the full happy walk: ASSIGNED → ACCEPTED → IN_PROGRESS → BLOCKED → IN_PROGRESS → SUBMITTED → VERIFIED → CLOSED", async () => {
    // DRAFT exists only as the unpublished creation state
    // (createTask publish:false); ASSIGNED is entered by publishing
    // at creation — updateTaskStatus has no DRAFT→ASSIGNED edge.
    const draft = await tasksSvc.createTask(adminActor, {
      title: `P7 draft probe ${RUN}`,
      assigneeId: fx.staffB,
      warehouseId: fx.whB,
      publish: false,
    });
    expect(draft.status).toBe("DRAFT");
    await expect(
      tasksSvc.updateTaskStatus(staffBActor, draft.id, { status: "ACCEPTED" }),
    ).rejects.toBeInstanceOf(errors.ConflictError);

    const task = await newTask();
    expect(task.status).toBe("ASSIGNED");
    expect((await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "ACCEPTED" })).status).toBe("ACCEPTED");
    expect((await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "IN_PROGRESS" })).status).toBe("IN_PROGRESS");
    expect(
      (await tasksSvc.updateTaskStatus(staffBActor, task.id, {
        status: "BLOCKED",
        note: "Depot gate closed for the festival",
      })).status,
    ).toBe("BLOCKED");
    expect((await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "IN_PROGRESS" })).status).toBe("IN_PROGRESS");
    expect((await tasksSvc.updateTaskStatus(staffBActor, task.id, { status: "SUBMITTED" })).status).toBe("SUBMITTED");
    expect((await tasksSvc.updateTaskStatus(waBActor, task.id, { status: "VERIFIED" })).status).toBe("VERIFIED");
    expect((await tasksSvc.updateTaskStatus(adminActor, task.id, { status: "CLOSED" })).status).toBe("CLOSED");
  });
});

// ---------------------------------------------------------------------------

describe("auto-incident verification (Phase 7)", () => {
  it("transfer excess: a destined-here package that is not on the manifest raises TRANSFER_EXCESS exactly once", async () => {
    const stray = await bookOne(fx.districtB);
    await stockAtA(stray);
    const legit = await bookOne();
    await readyAtA(legit);
    const { transfer } = await runTransferToArrival([legit]);

    const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
      trackingId: stray.trackingId,
      idempotencyKey: `p7-excess-${RUN}-${stray.trackingId}`,
    });
    expect(scan.kind).toBe("EXCESS");

    const incidents = await prisma.incident.findMany({
      where: { sourceKey: `transfer-excess:${transfer.id}:${stray.packageId}` },
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].category).toBe("TRANSFER_EXCESS");
    expect(incidents[0].packageId).toBe(stray.packageId);
    expect(incidents[0].transferId).toBe(transfer.id);
    expect(incidents[0].warehouseId).toBe(fx.whB);

    // A repeat scan writes nothing further.
    await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
      trackingId: stray.trackingId,
      idempotencyKey: `p7-excess2-${RUN}-${stray.trackingId}`,
    });
    expect(
      await prisma.incident.count({
        where: { sourceKey: `transfer-excess:${transfer.id}:${stray.packageId}` },
      }),
    ).toBe(1);

    await receiveAndClose(transfer.id, [legit]);
  }, 180_000);

  it("transfer missing-at-finish raises TRANSFER_SHORTAGE, links the item, and never duplicates", async () => {
    const p1 = await bookOne();
    const p2 = await bookOne();
    await readyAtA(p1);
    await readyAtA(p2);
    const { transfer } = await runTransferToArrival([p1, p2]);

    const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
      trackingId: p1.trackingId,
      idempotencyKey: `p7-unload-${RUN}-${p1.trackingId}`,
    });
    expect(scan.kind).toBe("RECEIVED_SCAN");
    await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
      packageId: p1.packageId,
      condition: "GOOD",
    });
    // p2 is never unload-scanned — finishing receiving brands it.
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
    // The category at this link point is TRANSFER_SHORTAGE (the
    // shortage vocabulary), not MISSING_PACKAGE.
    expect(incidents[0].category).toBe("TRANSFER_SHORTAGE");
    expect(incidents[0].packageId).toBe(p2.packageId);
    expect(incidents[0].warehouseId).toBe(fx.whB);

    await transfersSvc.finishReceiving(waBActor, transfer.id);
    expect(
      await prisma.incident.count({ where: { sourceKey: `transfer-item-missing:${item2.id}` } }),
    ).toBe(1);
  }, 180_000);

  it("custody handover closed short raises HANDOVER_DISCREPANCY for the missing line exactly once", async () => {
    const one = await bookOne();
    const two = await bookOne();
    await inventorySvc.receivePackage(staffAActor, {
      warehouseId: fx.whA,
      trackingId: one.trackingId,
    });
    await inventorySvc.receivePackage(staffAActor, {
      warehouseId: fx.whA,
      trackingId: two.trackingId,
    });
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

    await expect(custodySvc.closeHandoverBatch(waAActor, batch.id)).rejects.toBeInstanceOf(
      errors.ConflictError,
    );
    expect(
      await prisma.incident.count({ where: { sourceKey: `handover-dispute:${missingLine!.id}` } }),
    ).toBe(1);
  }, 120_000);
});
