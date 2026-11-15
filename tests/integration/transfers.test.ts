import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 5 integration tests (docs: implementation-roadmap Phase 5,
 * transfer-workflow, inventory-and-custody, package-lifecycle) against
 * the local bla_test database: the full origin → destination transfer
 * (book → receive → inspect → sort → ready → transfer → manifest →
 * load → dispatch → depart → arrive → receive → reconcile → close),
 * custody chain warehouse → driver → warehouse, manifest freezing,
 * crew assignment blockers, partial-load dispatch refusal, exception
 * arrivals, idempotent arrival scans, missing-package reconciliation
 * block + late-scan recovery, and cancellation release.
 *
 * Fixture warehouses are SHARED across runs (WH-ZP5 codes, find-or-
 * create) like the Phase 3/4 suites; users/vendors/bookings/vehicles
 * are per-run unique so repeated runs never collide.
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
const email = (label: string) => `p5-${label}-${RUN}@bla.test`;
const phone = (n: number) =>
  `97798${String(n % 1000).padStart(3, "0")}${RUN_NUM}`.slice(0, 13);

let prisma: import("@prisma/client").PrismaClient;
let bookingsSvc: typeof import("@/server/services/bookings");
let vendorsSvc: typeof import("@/server/services/vendors");
let inventorySvc: typeof import("@/server/services/inventory");
let transfersSvc: typeof import("@/server/services/transfers");
let tripsSvc: typeof import("@/server/services/trips");
let driversSvc: typeof import("@/server/services/drivers");
let vehiclesSvc: typeof import("@/server/services/vehicles");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
let staffBActor: Awaited<ReturnType<typeof actorFor>>;
let driverActor: Awaited<ReturnType<typeof actorFor>>;
let serviceCode: string;

/** Mirror of getActorContext (permissions.ts) incl. Phase 5 driver link. */
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
      fullName: `P5 ${label}`,
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
  originWarehouseId: string,
  destDistrict: string,
  codAmountPaisa = "0",
): Promise<{ packageId: string; trackingId: string }> {
  const booking = await bookingsSvc.createBooking(adminActor, {
    vendorId: fx.vendor,
    sender: { name: "P5 Sender", phone: phone(42), email: null },
    recipient: {
      name: "P5 Recipient",
      phone: phone(101),
      addressLine: "Some Street 1",
      city: "Town",
      district: destDistrict,
      province: "Bagmati",
    },
    pickup: { method: "WAREHOUSE_DROPOFF" as const, originWarehouseId },
    shippingServiceCode: serviceCode,
    paymentMethod: "CASH" as const,
    codAmountPaisa,
    items: [{ description: "Parcel", quantity: 1, weightKg: 1.0 }],
  });
  const pkg = booking.shipments[0].packages[0];
  return { packageId: pkg.id, trackingId: pkg.trackingId };
}

/** Full Phase 4 chain: book → receive → inspect → put away → ready. */
async function readyOne(
  destDistrict: string,
  codAmountPaisa = "0",
): Promise<{ packageId: string; trackingId: string }> {
  const { packageId, trackingId } = await bookOne(fx.whA, destDistrict, codAmountPaisa);
  await inventorySvc.receivePackage(staffAActor, {
    warehouseId: fx.whA,
    trackingId,
  });
  await inventorySvc.moveToInspection(staffAActor, packageId);
  await inventorySvc.startInspection(staffAActor, packageId);
  await inventorySvc.recordInspection(staffAActor, {
    packageId,
    condition: "GOOD",
    actualWeightKg: 2,
  });
  await inventorySvc.putAwayPackage(staffAActor, packageId, fx.locStoA);
  const ready = await inventorySvc.markReadyForDispatch(staffAActor, packageId);
  expect(ready.operationalStatus).toBe("READY_FOR_DISPATCH");
  return { packageId, trackingId };
}

async function openCustody(packageId: string) {
  return prisma.packageCustody.findFirst({ where: { packageId, endedAt: null } });
}

async function openRecords(warehouseId: string, packageIds: string[]) {
  return prisma.inventoryRecord.count({
    where: { warehouseId, packageId: { in: packageIds }, releasedAt: null },
  });
}

/** Create a transfer A→B, add the packages, manifest it. */
async function manifestedTransfer(packageIds: string[]) {
  const transfer = await transfersSvc.createTransfer(waAActor, {
    originWarehouseId: fx.whA,
    destinationWarehouseId: fx.whB,
  });
  const added = await transfersSvc.addTransferItems(waAActor, transfer.id, packageIds);
  expect(added.rejected).toEqual([]);
  expect(added.added).toHaveLength(packageIds.length);
  const manifested = await transfersSvc.generateManifest(waAActor, transfer.id);
  expect(manifested.manifest).not.toBeNull();
  return manifested;
}

async function crewedTransfer(packageIds: string[]) {
  const transfer = await manifestedTransfer(packageIds);
  const crewed = await transfersSvc.assignTransferCrew(waAActor, {
    transferId: transfer.id,
    driverId: fx.driverProfile,
    vehicleId: fx.vehicle,
  });
  expect(crewed.tripId).not.toBeNull();
  return crewed;
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

  fx.districtA = "P5Alpha District";
  fx.districtB = "P5Beta District";
  fx.districtC = "P5Gamma District";
  const a = await ensureWarehouse("WH-ZP5-01", "P5 Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  const b = await ensureWarehouse("WH-ZP5-02", "P5 Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;
  fx.locRecB = b.locations.RECEIVING;
  fx.locDmgB = b.locations.DAMAGED;
  const c = await ensureWarehouse("WH-ZP5-03", "P5 Gamma (shared fixture)", fx.districtC);
  fx.whC = c.id;

  serviceCode = `P5STD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P5 Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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
    businessName: `P5 Vendor ${RUN}`,
    contactName: "P5 Contact",
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

  // Warehouse people.
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

  // Drivers: a fully assignable line-haul driver, a role-less profile
  // holder, and a LINEHAUL_DRIVER without the LINEHAUL capability.
  fx.driverUser = await makeUser("driver", "LINEHAUL_DRIVER");
  const driver = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.driverUser,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P5-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.driverProfile = driver.id;
  driverActor = await actorFor(fx.driverUser);
  expect(driverActor.driverId).toBe(fx.driverProfile);

  fx.rolelessUser = await makeUser("roleless", "CUSTOMER");
  const roleless = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.rolelessUser,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P5-RL-${RUN}`,
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.rolelessProfile = roleless.id;

  fx.nocapUser = await makeUser("nocap", "LINEHAUL_DRIVER");
  const nocap = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.nocapUser,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P5-NC-${RUN}`,
    licenseExpiry: "2030-01-01",
    capabilities: ["DELIVERY"],
  });
  fx.nocapProfile = nocap.id;

  // Vehicles: one assignable truck, one in maintenance.
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P5 TRK ${RUN.slice(-6)}`.toUpperCase(),
    type: "TRUCK",
    capacityKg: 5000,
    homeWarehouseId: fx.whA,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  fx.vehicle = vehicle.id;
  const maint = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P5 MNT ${RUN.slice(-6)}`.toUpperCase(),
    type: "VAN",
    capacityKg: 1000,
    homeWarehouseId: fx.whA,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  await vehiclesSvc.setVehicleStatus(adminActor, maint.id, "MAINTENANCE");
  fx.maintVehicle = maint.id;
}, 180_000);

// ---------------------------------------------------------------------------

describe("happy path: full transfer A → B", () => {
  it("runs book → ready → transfer → manifest → load → dispatch → trip → receive → reconcile → close", async () => {
    const p1 = await readyOne(fx.districtB, "25000");
    const p2 = await readyOne(fx.districtB);
    const ids = [p1.packageId, p2.packageId];
    expect(await openRecords(fx.whA, ids)).toBe(2);

    const transfer = await crewedTransfer(ids);
    // Manifest is a frozen snapshot: 2 packages, 2 kg billable each,
    // COD from p1 only.
    expect(transfer.manifest?.packageCount).toBe(2);
    expect(Number(transfer.manifest?.totalWeightKg)).toBe(4);
    expect(transfer.manifest?.totalCodPaisa).toBe("25000");
    for (const id of ids) {
      const pkg = await prisma.package.findUniqueOrThrow({ where: { id } });
      expect(pkg.operationalStatus).toBe("TRANSFER_ASSIGNED");
    }
    // Regenerating a manifest is impossible.
    await expect(transfersSvc.generateManifest(waAActor, transfer.id)).rejects.toBeInstanceOf(
      errors.ConflictError,
    );

    // Load both, then dispatch.
    const load1 = await transfersSvc.loadTransferPackage(waAActor, transfer.id, {
      trackingId: p1.trackingId,
      idempotencyKey: `p5-load-${RUN}-1`,
    });
    expect(load1.alreadyScanned).toBe(false);
    expect(load1.allLoaded).toBe(false);
    const load2 = await transfersSvc.loadTransferPackage(staffAActor, transfer.id, {
      trackingId: p2.trackingId,
      idempotencyKey: `p5-load-${RUN}-2`,
    });
    expect(load2.allLoaded).toBe(true);

    const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
    expect(dispatched.status).toBe("DISPATCHED");
    // Origin inventory released; custody moved warehouse → driver.
    expect(await openRecords(fx.whA, ids)).toBe(0);
    for (const id of ids) {
      const pkg = await prisma.package.findUniqueOrThrow({ where: { id } });
      expect(pkg.operationalStatus).toBe("DISPATCHED");
      const custody = await openCustody(id);
      expect(custody?.custodianType).toBe("USER");
      expect(custody?.custodianUserId).toBe(fx.driverUser);
    }
    const vehicleRow = await prisma.vehicle.findUniqueOrThrow({ where: { id: fx.vehicle } });
    expect(vehicleRow.status).toBe("ON_TRIP");

    // Trip: depart → arrive (driver acts on their own trip).
    const tripId = dispatched.tripId!;
    const departed = await tripsSvc.departTrip(driverActor, tripId);
    expect(departed.status).toBe("IN_TRANSIT");
    for (const id of ids) {
      const pkg = await prisma.package.findUniqueOrThrow({ where: { id } });
      expect(pkg.operationalStatus).toBe("IN_TRANSIT");
    }
    const arrived = await tripsSvc.arriveTrip(driverActor, tripId);
    expect(arrived.status).toBe("ARRIVED");

    // Destination receiving by B's admin: the transfer status rolls
    // up from the item rows — partial after the first package, fully
    // RECEIVED only when every item is accounted for.
    const rollup: string[] = [];
    for (const p of [p1, p2]) {
      const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
        trackingId: p.trackingId,
        idempotencyKey: `p5-unload-${RUN}-${p.trackingId}`,
      });
      expect(scan.kind).toBe("RECEIVED_SCAN");
      expect(scan.alreadyReceived).toBe(false);
      const completed = await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
        packageId: p.packageId,
        condition: "GOOD",
      });
      rollup.push(completed.status);
    }
    expect(rollup).toEqual(["PARTIALLY_RECEIVED", "RECEIVED"]);
    // Custody chain completes: driver → destination warehouse.
    expect(await openRecords(fx.whB, ids)).toBe(2);
    for (const id of ids) {
      const custody = await openCustody(id);
      expect(custody?.custodianType).toBe("WAREHOUSE");
      expect(custody?.warehouseId).toBe(fx.whB);
      const pkg = await prisma.package.findUniqueOrThrow({ where: { id } });
      expect(pkg.operationalStatus).toBe("RECEIVED_AT_DESTINATION");
    }

    const finished = await transfersSvc.finishReceiving(waBActor, transfer.id);
    expect(finished.status).toBe("RECONCILIATION_PENDING");
    // Trip + vehicle + driver released by finishing receiving.
    const tripRow = await prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
    expect(tripRow.status).toBe("COMPLETED");
    const vehicleAfter = await prisma.vehicle.findUniqueOrThrow({ where: { id: fx.vehicle } });
    expect(vehicleAfter.status).toBe("AVAILABLE");
    const driverAfter = await prisma.driver.findUniqueOrThrow({ where: { id: fx.driverProfile } });
    expect(driverAfter.currentTripId).toBeNull();
    expect(driverAfter.availabilityStatus).toBe("AVAILABLE");

    const reconciled = await transfersSvc.reconcileTransfer(waBActor, transfer.id);
    expect(reconciled.status).toBe("RECONCILED");
    const closed = await transfersSvc.closeTransfer(waBActor, transfer.id);
    expect(closed.status).toBe("CLOSED");
  });
});

describe("item selection rules", () => {
  it("rejects not-ready and wrong-destination packages at add time, with reasons", async () => {
    const notReady = await bookOne(fx.whA, fx.districtB);
    await inventorySvc.receivePackage(staffAActor, {
      warehouseId: fx.whA,
      trackingId: notReady.trackingId,
    });
    const wrongDest = await readyOne(fx.districtC);

    const transfer = await transfersSvc.createTransfer(waAActor, {
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
    });
    const result = await transfersSvc.addTransferItems(waAActor, transfer.id, [
      notReady.packageId,
      wrongDest.packageId,
    ]);
    expect(result.added).toEqual([]);
    expect(result.rejected).toHaveLength(2);
    const reasons = result.rejected.map((r) => r.reason).join(" ");
    expect(reasons).toMatch(/READY_FOR_DISPATCH/);
    expect(reasons).toMatch(/destination/i);

    await transfersSvc.cancelTransfer(waAActor, transfer.id, "test cleanup");
  });

  it("rejects a load scan for a package that is not on the manifest", async () => {
    const onTransfer = await readyOne(fx.districtB);
    const outsider = await readyOne(fx.districtB);
    const transfer = await crewedTransfer([onTransfer.packageId]);
    await expect(
      transfersSvc.loadTransferPackage(waAActor, transfer.id, {
        trackingId: outsider.trackingId,
      }),
    ).rejects.toBeInstanceOf(errors.NotFoundError);
    // Clean up: cancel releases the manifested package.
    await transfersSvc.cancelTransfer(waAActor, transfer.id, "test cleanup");
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: onTransfer.packageId } });
    expect(pkg.operationalStatus).toBe("READY_FOR_DISPATCH");
  });

  it("denies loading by another warehouse's staff and audits access.denied", async () => {
    const p = await readyOne(fx.districtB);
    const transfer = await manifestedTransfer([p.packageId]);
    await expect(
      transfersSvc.loadTransferPackage(staffBActor, transfer.id, { trackingId: p.trackingId }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    const audit = await prisma.auditLog.findFirst({
      where: { actorId: fx.staffB, action: "access.denied", entityId: transfer.id },
    });
    expect(audit).not.toBeNull();
    await transfersSvc.cancelTransfer(waAActor, transfer.id, "test cleanup");
  });
});

describe("crew assignment blockers", () => {
  it("rejects a MAINTENANCE vehicle, a role-less driver, a capability-less driver, and a driver already on a trip", async () => {
    const p1 = await readyOne(fx.districtB);
    const t1 = await manifestedTransfer([p1.packageId]);

    await expect(
      transfersSvc.assignTransferCrew(waAActor, {
        transferId: t1.id,
        driverId: fx.driverProfile,
        vehicleId: fx.maintVehicle,
      }),
    ).rejects.toThrow(/MAINTENANCE|not available/i);

    await expect(
      transfersSvc.assignTransferCrew(waAActor, {
        transferId: t1.id,
        driverId: fx.rolelessProfile,
        vehicleId: fx.vehicle,
      }),
    ).rejects.toThrow(/LINEHAUL_DRIVER/);

    await expect(
      transfersSvc.assignTransferCrew(waAActor, {
        transferId: t1.id,
        driverId: fx.nocapProfile,
        vehicleId: fx.vehicle,
      }),
    ).rejects.toThrow(/LINEHAUL/);

    // Assign the good crew to t1, then the same driver cannot crew t2.
    await transfersSvc.assignTransferCrew(waAActor, {
      transferId: t1.id,
      driverId: fx.driverProfile,
      vehicleId: fx.vehicle,
    });
    const p2 = await readyOne(fx.districtB);
    const t2 = await manifestedTransfer([p2.packageId]);
    await expect(
      transfersSvc.assignTransferCrew(waAActor, {
        transferId: t2.id,
        driverId: fx.driverProfile,
        vehicleId: fx.vehicle,
      }),
    ).rejects.toThrow(/trip|vehicle/i);

    await transfersSvc.cancelTransfer(waAActor, t2.id, "test cleanup");
    await transfersSvc.cancelTransfer(waAActor, t1.id, "test cleanup");
  });
});

describe("partial load and item removal", () => {
  it("refuses dispatch on a partial load naming the unscanned package; audited removal then allows dispatch", async () => {
    const p1 = await readyOne(fx.districtB);
    const p2 = await readyOne(fx.districtB);
    const transfer = await crewedTransfer([p1.packageId, p2.packageId]);

    await transfersSvc.loadTransferPackage(waAActor, transfer.id, {
      trackingId: p1.trackingId,
    });
    await expect(transfersSvc.dispatchTransfer(waAActor, transfer.id)).rejects.toThrow(
      p2.trackingId,
    );

    // Remove the unscanned item pre-dispatch: audited, package released.
    const afterRemoval = await transfersSvc.removeTransferItem(
      waAActor,
      transfer.id,
      p2.packageId,
      "Damaged carton found at loading",
    );
    expect(afterRemoval.items).toHaveLength(1);
    // Removing from a MANIFESTED transfer is an audited amendment.
    const audit = await prisma.auditLog.findFirst({
      where: { actorId: fx.waA, action: "transfer.manifest_amended", entityId: transfer.id },
    });
    expect(audit).not.toBeNull();
    const released = await prisma.package.findUniqueOrThrow({ where: { id: p2.packageId } });
    expect(released.operationalStatus).toBe("READY_FOR_DISPATCH");

    const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
    expect(dispatched.status).toBe("DISPATCHED");

    // Complete the trip so driver + vehicle are free for later tests.
    await tripsSvc.departTrip(driverActor, dispatched.tripId!);
    await tripsSvc.arriveTrip(driverActor, dispatched.tripId!);
    await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
      trackingId: p1.trackingId,
    });
    await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
      packageId: p1.packageId,
      condition: "GOOD",
    });
    await transfersSvc.finishReceiving(waBActor, transfer.id);
    await transfersSvc.reconcileTransfer(waBActor, transfer.id);
  });
});

describe("destination exceptions", () => {
  it("takes excess and wrong-warehouse arrivals down the exception path without stocking them", async () => {
    const p = await readyOne(fx.districtB);
    const excess = await readyOne(fx.districtB);
    const wrongDest = await readyOne(fx.districtC);
    const transfer = await crewedTransfer([p.packageId]);
    await transfersSvc.loadTransferPackage(waAActor, transfer.id, { trackingId: p.trackingId });
    const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
    await tripsSvc.departTrip(driverActor, dispatched.tripId!);
    await tripsSvc.arriveTrip(driverActor, dispatched.tripId!);

    const excessScan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
      trackingId: excess.trackingId,
    });
    expect(excessScan.kind).toBe("EXCESS");
    expect(await openRecords(fx.whB, [excess.packageId])).toBe(0);
    const excessPkg = await prisma.package.findUniqueOrThrow({ where: { id: excess.packageId } });
    expect(excessPkg.operationalStatus).toBe("READY_FOR_DISPATCH");

    const wrongScan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
      trackingId: wrongDest.trackingId,
    });
    expect(wrongScan.kind).toBe("WRONG_PACKAGE");
    expect(await openRecords(fx.whB, [wrongDest.packageId])).toBe(0);
    const wrongPkg = await prisma.package.findUniqueOrThrow({ where: { id: wrongDest.packageId } });
    expect(wrongPkg.exceptionStatus).toBe("MISROUTED");
    expect(wrongPkg.operationalStatus).toBe("READY_FOR_DISPATCH");

    // The real package still receives and reconciles cleanly.
    await transfersSvc.scanDestinationPackage(waBActor, transfer.id, { trackingId: p.trackingId });
    await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
      packageId: p.packageId,
      condition: "GOOD",
    });
    await transfersSvc.finishReceiving(waBActor, transfer.id);
    const reconciled = await transfersSvc.reconcileTransfer(waBActor, transfer.id);
    expect(reconciled.status).toBe("RECONCILED");
  });

  it("makes duplicate arrival scans idempotent (same key and new key)", async () => {
    const p = await readyOne(fx.districtB);
    const transfer = await crewedTransfer([p.packageId]);
    await transfersSvc.loadTransferPackage(waAActor, transfer.id, { trackingId: p.trackingId });
    const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
    await tripsSvc.departTrip(driverActor, dispatched.tripId!);
    await tripsSvc.arriveTrip(driverActor, dispatched.tripId!);

    const key = `p5-unload-dup-${RUN}`;
    const first = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
      trackingId: p.trackingId,
      idempotencyKey: key,
    });
    expect(first.alreadyReceived).toBe(false);
    const sameKey = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
      trackingId: p.trackingId,
      idempotencyKey: key,
    });
    expect(sameKey.alreadyReceived).toBe(true);
    const newKey = await transfersSvc.scanDestinationPackage(staffBActor, transfer.id, {
      trackingId: p.trackingId,
      idempotencyKey: `p5-unload-dup2-${RUN}`,
    });
    expect(newKey.alreadyReceived).toBe(true);
    expect(await openRecords(fx.whB, [p.packageId])).toBe(1);
    const scans = await prisma.transferScan.count({
      where: { transferItem: { packageId: p.packageId }, scanType: "UNLOAD" },
    });
    expect(scans).toBe(1);

    await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
      packageId: p.packageId,
      condition: "GOOD",
    });
    await transfersSvc.finishReceiving(waBActor, transfer.id);
    await transfersSvc.reconcileTransfer(waBActor, transfer.id);
  });
});

describe("missing package reconciliation", () => {
  it("blocks clean reconciliation while a package is missing, then recovers via a late scan", async () => {
    const p1 = await readyOne(fx.districtB);
    const p2 = await readyOne(fx.districtB);
    const transfer = await crewedTransfer([p1.packageId, p2.packageId]);
    await transfersSvc.loadTransferPackage(waAActor, transfer.id, { trackingId: p1.trackingId });
    await transfersSvc.loadTransferPackage(waAActor, transfer.id, { trackingId: p2.trackingId });
    const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
    await tripsSvc.departTrip(driverActor, dispatched.tripId!);
    await tripsSvc.arriveTrip(driverActor, dispatched.tripId!);

    // Only p1 is unloaded.
    await transfersSvc.scanDestinationPackage(waBActor, transfer.id, { trackingId: p1.trackingId });
    await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
      packageId: p1.packageId,
      condition: "GOOD",
    });
    const finished = await transfersSvc.finishReceiving(waBActor, transfer.id);
    expect(finished.status).toBe("RECONCILIATION_PENDING");
    expect(finished.reconciliation.missingCount).toBe(1);
    expect(finished.reconciliation.unaccountedTrackingIds).toContain(p2.trackingId);

    // The missing package stays in the driver's custody, flagged.
    const missingPkg = await prisma.package.findUniqueOrThrow({ where: { id: p2.packageId } });
    expect(missingPkg.exceptionStatus).toBe("MISSING");
    expect(missingPkg.operationalStatus).toBe("ARRIVED_AT_DESTINATION");
    const custody = await openCustody(p2.packageId);
    expect(custody?.custodianType).toBe("USER");
    expect(custody?.custodianUserId).toBe(fx.driverUser);
    const exceptionEvent = await prisma.trackingEvent.findFirst({
      where: { packageId: p2.packageId, eventType: "EXCEPTION_RAISED", transferId: transfer.id },
    });
    expect(exceptionEvent).not.toBeNull();

    // Reconciliation refuses and parks the transfer in EXCEPTION.
    await expect(transfersSvc.reconcileTransfer(waBActor, transfer.id)).rejects.toBeInstanceOf(
      errors.ConflictError,
    );
    const blocked = await transfersSvc.getTransfer(waBActor, transfer.id);
    expect(blocked.status).toBe("EXCEPTION");

    // Late scan: the package turns up, the MISSING flag clears, and
    // the transfer reconciles clean.
    const late = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
      trackingId: p2.trackingId,
    });
    expect(late.kind).toBe("RECEIVED_SCAN");
    const foundPkg = await prisma.package.findUniqueOrThrow({ where: { id: p2.packageId } });
    expect(foundPkg.exceptionStatus).toBe("NONE");
    await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
      packageId: p2.packageId,
      condition: "GOOD",
    });
    await transfersSvc.finishReceiving(waBActor, transfer.id);
    const reconciled = await transfersSvc.reconcileTransfer(waBActor, transfer.id);
    expect(reconciled.status).toBe("RECONCILED");
  });

  it("accounts damaged-on-arrival packages and still reconciles clean", async () => {
    const p = await readyOne(fx.districtB);
    const transfer = await crewedTransfer([p.packageId]);
    await transfersSvc.loadTransferPackage(waAActor, transfer.id, { trackingId: p.trackingId });
    const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
    await tripsSvc.departTrip(driverActor, dispatched.tripId!);
    await tripsSvc.arriveTrip(driverActor, dispatched.tripId!);

    await transfersSvc.scanDestinationPackage(waBActor, transfer.id, { trackingId: p.trackingId });
    const completed = await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
      packageId: p.packageId,
      condition: "DAMAGED",
      notes: "Crushed corner, contents rattling",
    });
    expect(completed.reconciliation.damagedCount).toBe(1);
    const pkg = await prisma.package.findUniqueOrThrow({ where: { id: p.packageId } });
    expect(pkg.exceptionStatus).toBe("DAMAGED");
    expect(pkg.operationalStatus).toBe("RECEIVED_AT_DESTINATION");
    // Quarantined into B's DAMAGED zone (Phase 4 damage mechanics).
    const record = await prisma.inventoryRecord.findFirst({
      where: { packageId: p.packageId, releasedAt: null },
    });
    expect(record?.warehouseId).toBe(fx.whB);
    expect(record?.storageLocationId).toBe(fx.locDmgB);

    await transfersSvc.finishReceiving(waBActor, transfer.id);
    const reconciled = await transfersSvc.reconcileTransfer(waBActor, transfer.id);
    expect(reconciled.status).toBe("RECONCILED");
  });
});

describe("driver boundaries", () => {
  it("forbids the line-haul driver from destination receiving and from editing items", async () => {
    const p = await readyOne(fx.districtB);
    const transfer = await crewedTransfer([p.packageId]);
    await transfersSvc.loadTransferPackage(waAActor, transfer.id, { trackingId: p.trackingId });
    const dispatched = await transfersSvc.dispatchTransfer(waAActor, transfer.id);
    await tripsSvc.departTrip(driverActor, dispatched.tripId!);
    await tripsSvc.arriveTrip(driverActor, dispatched.tripId!);

    await expect(
      transfersSvc.scanDestinationPackage(driverActor, transfer.id, { trackingId: p.trackingId }),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    await expect(
      transfersSvc.removeTransferItem(driverActor, transfer.id, p.packageId),
    ).rejects.toBeInstanceOf(actorErrors.AuthorizationError);
    // Warehouse staff also cannot reconcile (destination WA's job).
    await transfersSvc.scanDestinationPackage(waBActor, transfer.id, { trackingId: p.trackingId });
    await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
      packageId: p.packageId,
      condition: "GOOD",
    });
    await transfersSvc.finishReceiving(waBActor, transfer.id);
    await expect(transfersSvc.reconcileTransfer(staffBActor, transfer.id)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    const reconciled = await transfersSvc.reconcileTransfer(waBActor, transfer.id);
    expect(reconciled.status).toBe("RECONCILED");
  });
});

describe("cancellation", () => {
  it("releases packages from a cancelled transfer so they can join a new one", async () => {
    const p = await readyOne(fx.districtB);
    const first = await manifestedTransfer([p.packageId]);
    const held = await prisma.package.findUniqueOrThrow({ where: { id: p.packageId } });
    expect(held.operationalStatus).toBe("TRANSFER_ASSIGNED");
    // And it cannot join a second open transfer while held.
    const second = await transfersSvc.createTransfer(waAActor, {
      originWarehouseId: fx.whA,
      destinationWarehouseId: fx.whB,
    });
    const blocked = await transfersSvc.addTransferItems(waAActor, second.id, [p.packageId]);
    expect(blocked.added).toEqual([]);
    expect(blocked.rejected).toHaveLength(1);

    await transfersSvc.cancelTransfer(waAActor, first.id, "Vehicle broke down");
    const released = await prisma.package.findUniqueOrThrow({ where: { id: p.packageId } });
    expect(released.operationalStatus).toBe("READY_FOR_DISPATCH");

    const rejoined = await transfersSvc.addTransferItems(waAActor, second.id, [p.packageId]);
    expect(rejoined.added).toHaveLength(1);
    await transfersSvc.cancelTransfer(waAActor, second.id, "test cleanup");
  });
});
