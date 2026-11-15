import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 5 security-review fix tests (P5-1…P5-6) against the local
 * bla_test database:
 *  (a) P5-1 — concurrent adds of one package to two transfers put it
 *      on exactly ONE open transfer (package-row lock serializes).
 *  (b) P5-2 — concurrent crew assignments of one driver to two
 *      transfers: exactly one succeeds (checks run in-transaction
 *      under driver/vehicle row locks).
 *  (c) P5-3 — finishReceiving does NOT brand an unload-scanned
 *      package MISSING; completing its receiving leaves it
 *      RECEIVED_AT_DESTINATION with exceptionStatus NONE.
 *  (d) P5-4 — a wrong-warehouse scan of a BOOKED-at-origin package
 *      mutates nothing; a genuinely misrouted in-transit package is
 *      flagged exactly once per warehouse (dedupe).
 *  (e) P5-6 — concurrent reconciles: exactly one succeeds and
 *      exactly one transfer.reconciled audit row is written.
 *
 * Fixture warehouses are SHARED across runs (find-or-create) in the
 * WH-ZP5 pattern, but with distinct codes (WH-ZP5-04/05/06) and
 * districts from transfers.test.ts (WH-ZP5-01/02/03) so the two
 * suites never contend; users/vendors/vehicles are per-run unique.
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
const email = (label: string) => `p5f-${label}-${RUN}@bla.test`;
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
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let staffAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;
let driverActor: Awaited<ReturnType<typeof actorFor>>;
let driver2Actor: Awaited<ReturnType<typeof actorFor>>;
let serviceCode: string;

const ACTIVE_TRIP_STATUSES = [
  "PLANNED",
  "ASSIGNED",
  "LOADING",
  "DISPATCHED",
  "IN_TRANSIT",
  "DELAYED",
  "ARRIVED",
  "UNLOADING",
];

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
      fullName: `P5F ${label}`,
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
    sender: { name: "P5F Sender", phone: phone(42), email: null },
    recipient: {
      name: "P5F Recipient",
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

async function openRecords(warehouseId: string, packageIds: string[]) {
  return prisma.inventoryRecord.count({
    where: { warehouseId, packageId: { in: packageIds }, releasedAt: null },
  });
}

/** Create a transfer A→dest, add the packages, manifest it. */
async function manifestedTransfer(
  packageIds: string[],
  destinationWarehouseId: string,
) {
  const transfer = await transfersSvc.createTransfer(waAActor, {
    originWarehouseId: fx.whA,
    destinationWarehouseId,
  });
  const added = await transfersSvc.addTransferItems(waAActor, transfer.id, packageIds);
  expect(added.rejected).toEqual([]);
  expect(added.added).toHaveLength(packageIds.length);
  const manifested = await transfersSvc.generateManifest(waAActor, transfer.id);
  expect(manifested.manifest).not.toBeNull();
  return manifested;
}

async function crewedTransfer(
  packageIds: string[],
  destinationWarehouseId: string,
  driverId: string,
  vehicleId: string,
) {
  const transfer = await manifestedTransfer(packageIds, destinationWarehouseId);
  const crewed = await transfersSvc.assignTransferCrew(waAActor, {
    transferId: transfer.id,
    driverId,
    vehicleId,
  });
  expect(crewed.tripId).not.toBeNull();
  return crewed;
}

/** Load + dispatch + depart + arrive; returns the dispatched view. */
async function dispatchedAndArrived(
  transferId: string,
  packages: { trackingId: string }[],
  driver: Awaited<ReturnType<typeof actorFor>>,
) {
  for (const p of packages) {
    await transfersSvc.loadTransferPackage(waAActor, transferId, {
      trackingId: p.trackingId,
    });
  }
  const dispatched = await transfersSvc.dispatchTransfer(waAActor, transferId);
  await tripsSvc.departTrip(driver, dispatched.tripId!);
  const arrived = await tripsSvc.arriveTrip(driver, dispatched.tripId!);
  expect(arrived.status).toBe("ARRIVED");
  return dispatched;
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

  fx.districtA = "P5Fix Alpha District";
  fx.districtB = "P5Fix Beta District";
  fx.districtC = "P5Fix Gamma District";
  const a = await ensureWarehouse("WH-ZP5-04", "P5Fix Alpha (shared fixture)", fx.districtA);
  fx.whA = a.id;
  fx.locStoA = a.locations.STORAGE;
  const b = await ensureWarehouse("WH-ZP5-05", "P5Fix Beta (shared fixture)", fx.districtB);
  fx.whB = b.id;
  const c = await ensureWarehouse("WH-ZP5-06", "P5Fix Gamma (shared fixture)", fx.districtC);
  fx.whC = c.id;

  serviceCode = `P5FSTD${RUN.slice(-5)}`.toUpperCase();
  const service = await prisma.shippingService.create({
    data: { code: serviceCode, name: "P5F Standard (test)", estimatedDaysMin: 1, estimatedDaysMax: 3 },
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
    businessName: `P5F Vendor ${RUN}`,
    contactName: "P5F Contact",
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

  waAActor = await actorFor(fx.waA);
  staffAActor = await actorFor(fx.staffA);
  waBActor = await actorFor(fx.waB);

  // Two fully assignable line-haul drivers.
  fx.driverUser = await makeUser("driver", "LINEHAUL_DRIVER");
  const driver = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.driverUser,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P5F-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.driverProfile = driver.id;
  driverActor = await actorFor(fx.driverUser);
  expect(driverActor.driverId).toBe(fx.driverProfile);

  fx.driver2User = await makeUser("driver2", "LINEHAUL_DRIVER");
  const driver2 = await driversSvc.createDriverProfile(adminActor, {
    userId: fx.driver2User,
    homeWarehouseId: fx.whA,
    licenseNumber: `LIC-P5F2-${RUN}`,
    licenseCategory: "C",
    licenseExpiry: "2030-01-01",
    capabilities: ["LINEHAUL"],
  });
  fx.driver2Profile = driver2.id;
  driver2Actor = await actorFor(fx.driver2User);
  expect(driver2Actor.driverId).toBe(fx.driver2Profile);

  // Two assignable vehicles.
  const vehicle = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P5F TRK ${RUN.slice(-6)}`.toUpperCase(),
    type: "TRUCK",
    capacityKg: 5000,
    homeWarehouseId: fx.whA,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  fx.vehicle = vehicle.id;
  const vehicle2 = await vehiclesSvc.createVehicle(adminActor, {
    registration: `P5F VN2 ${RUN.slice(-6)}`.toUpperCase(),
    type: "VAN",
    capacityKg: 5000,
    homeWarehouseId: fx.whA,
    insuranceExpiry: "2027-06-01",
    registrationExpiry: "2027-06-01",
  });
  fx.vehicle2 = vehicle2.id;
}, 180_000);

// ---------------------------------------------------------------------------

describe("P5-1: concurrent adds of one package to two transfers", () => {
  it(
    "puts the package on exactly one open transfer; the loser is rejected cleanly (3 attempts)",
    async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const p = await readyOne(fx.districtB);
        const t1 = await transfersSvc.createTransfer(waAActor, {
          originWarehouseId: fx.whA,
          destinationWarehouseId: fx.whB,
        });
        const t2 = await transfersSvc.createTransfer(waAActor, {
          originWarehouseId: fx.whA,
          destinationWarehouseId: fx.whB,
        });

        const [r1, r2] = await Promise.all([
          transfersSvc.addTransferItems(waAActor, t1.id, [p.packageId]),
          transfersSvc.addTransferItems(waAActor, t2.id, [p.packageId]),
        ]);

        // Exactly one winner; the loser got the clean per-item
        // rejection, not a raw error and not a silent second add.
        const addedCounts = [r1.added.length, r2.added.length].sort();
        expect(addedCounts).toEqual([0, 1]);
        const loser = r1.added.length === 0 ? r1 : r2;
        expect(loser.rejected).toHaveLength(1);
        expect(loser.rejected[0].reason).toMatch(/Already on open transfer/);
        const itemRows = await prisma.transferItem.count({
          where: { packageId: p.packageId },
        });
        expect(itemRows).toBe(1);

        await transfersSvc.cancelTransfer(waAActor, t1.id, "test cleanup");
        await transfersSvc.cancelTransfer(waAActor, t2.id, "test cleanup");
      }
    },
    120_000,
  );
});

describe("P5-2: concurrent crew assignment of one driver", () => {
  it(
    "lets exactly one assignment succeed; the driver ends with exactly one active trip (3 attempts)",
    async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const p1 = await readyOne(fx.districtB);
        const p2 = await readyOne(fx.districtB);
        const t1 = await manifestedTransfer([p1.packageId], fx.whB);
        const t2 = await manifestedTransfer([p2.packageId], fx.whB);

        const results = await Promise.allSettled([
          transfersSvc.assignTransferCrew(waAActor, {
            transferId: t1.id,
            driverId: fx.driverProfile,
            vehicleId: fx.vehicle,
          }),
          transfersSvc.assignTransferCrew(waAActor, {
            transferId: t2.id,
            driverId: fx.driverProfile,
            vehicleId: fx.vehicle2,
          }),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        const reason = (rejected[0] as PromiseRejectedResult).reason;
        expect(reason).toBeInstanceOf(errors.DomainValidationError);
        expect(String(reason.message)).toMatch(/already assigned to active trip/);

        const activeTrips = await prisma.trip.count({
          where: {
            driverId: fx.driverProfile,
            status: { in: ACTIVE_TRIP_STATUSES },
          },
        });
        expect(activeTrips).toBe(1);

        // Cleanup frees the driver for the next attempt.
        await transfersSvc.cancelTransfer(waAActor, t1.id, "test cleanup");
        await transfersSvc.cancelTransfer(waAActor, t2.id, "test cleanup");
        const after = await prisma.trip.count({
          where: {
            driverId: fx.driverProfile,
            status: { in: ACTIVE_TRIP_STATUSES },
          },
        });
        expect(after).toBe(0);
      }
    },
    120_000,
  );
});

describe("P5-3: finishReceiving must not brand scanned packages MISSING", () => {
  it(
    "leaves an unload-scanned package completable and flag-free, then reconciles clean",
    async () => {
      const p = await readyOne(fx.districtB);
      const transfer = await crewedTransfer(
        [p.packageId],
        fx.whB,
        fx.driverProfile,
        fx.vehicle,
      );
      await dispatchedAndArrived(transfer.id, [p], driverActor);

      // Unload-scan the package: it is now physically at B, in
      // RECEIVING_INSPECTION, but its receiving is not yet complete.
      const scan = await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
        trackingId: p.trackingId,
        idempotencyKey: `p5f-unload-${RUN}-c`,
      });
      expect(scan.kind).toBe("RECEIVED_SCAN");
      const scanned = await prisma.package.findUniqueOrThrow({ where: { id: p.packageId } });
      expect(scanned.operationalStatus).toBe("RECEIVING_INSPECTION");

      // Finishing receiving now must NOT brand it MISSING (the
      // pre-fix code did, with a false "in the driver's custody"
      // exception event, and the flag could never be cleared).
      const finished = await transfersSvc.finishReceiving(waBActor, transfer.id);
      expect(finished.reconciliation.missingCount).toBe(0);
      const afterFinish = await prisma.package.findUniqueOrThrow({
        where: { id: p.packageId },
      });
      expect(afterFinish.exceptionStatus).toBe("NONE");
      const item = await prisma.transferItem.findFirstOrThrow({
        where: { transferId: transfer.id, packageId: p.packageId },
      });
      expect(item.itemStatus).not.toBe("MISSING");
      const falseEvents = await prisma.trackingEvent.count({
        where: {
          packageId: p.packageId,
          eventType: "EXCEPTION_RAISED",
          transferId: transfer.id,
        },
      });
      expect(falseEvents).toBe(0);

      // Completing the receiving works and leaves no stale flag.
      const completed = await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
        packageId: p.packageId,
        condition: "GOOD",
      });
      expect(completed.reconciliation.receivedCount).toBe(1);
      const done = await prisma.package.findUniqueOrThrow({ where: { id: p.packageId } });
      expect(done.operationalStatus).toBe("RECEIVED_AT_DESTINATION");
      expect(done.exceptionStatus).toBe("NONE");

      await transfersSvc.finishReceiving(waBActor, transfer.id);
      const reconciled = await transfersSvc.reconcileTransfer(waBActor, transfer.id);
      expect(reconciled.status).toBe("RECONCILED");
    },
    60_000,
  );
});

describe("P5-4: wrong-warehouse scans are state-gated and deduped", () => {
  it(
    "mutates nothing for a BOOKED-at-origin package, and flags a genuinely misrouted package exactly once",
    async () => {
      // Receiving context: an arrived A→B transfer at B.
      const pB = await readyOne(fx.districtB);
      const tB = await crewedTransfer([pB.packageId], fx.whB, fx.driverProfile, fx.vehicle);
      await dispatchedAndArrived(tB.id, [pB], driverActor);

      // (1) A package destined for C that is still BOOKED at origin:
      // scanning it at B observes a wrong package but must not
      // mutate it in any way.
      const booked = await bookOne(fx.whA, fx.districtC);
      const bookedBefore = await prisma.package.findUniqueOrThrow({
        where: { id: booked.packageId },
      });
      expect(bookedBefore.operationalStatus).toBe("BOOKED");
      expect(bookedBefore.exceptionStatus).toBe("NONE");
      const scan1 = await transfersSvc.scanDestinationPackage(waBActor, tB.id, {
        trackingId: booked.trackingId,
      });
      expect(scan1.kind).toBe("WRONG_PACKAGE");
      const bookedAfter = await prisma.package.findUniqueOrThrow({
        where: { id: booked.packageId },
      });
      expect(bookedAfter.exceptionStatus).toBe("NONE");
      expect(bookedAfter.operationalStatus).toBe("BOOKED");
      const bookedEvents = await prisma.trackingEvent.count({
        where: { packageId: booked.packageId, eventType: "EXCEPTION_RAISED" },
      });
      expect(bookedEvents).toBe(0);
      expect(await openRecords(fx.whB, [booked.packageId])).toBe(0);

      // (2) A genuinely misrouted package: manifested A→C, dispatched
      // and arrived at C (status ARRIVED_AT_DESTINATION). Scanned at
      // B it is flagged MISROUTED — exactly once, however often B
      // scans it.
      const pMis = await readyOne(fx.districtC);
      const tC = await crewedTransfer(
        [pMis.packageId],
        fx.whC,
        fx.driver2Profile,
        fx.vehicle2,
      );
      await dispatchedAndArrived(tC.id, [pMis], driver2Actor);
      const misBefore = await prisma.package.findUniqueOrThrow({
        where: { id: pMis.packageId },
      });
      expect(misBefore.operationalStatus).toBe("ARRIVED_AT_DESTINATION");
      expect(misBefore.exceptionStatus).toBe("NONE");

      const scan2 = await transfersSvc.scanDestinationPackage(waBActor, tB.id, {
        trackingId: pMis.trackingId,
      });
      expect(scan2.kind).toBe("WRONG_PACKAGE");
      const flagged = await prisma.package.findUniqueOrThrow({
        where: { id: pMis.packageId },
      });
      expect(flagged.exceptionStatus).toBe("MISROUTED");
      const eventsAfterFirst = await prisma.trackingEvent.count({
        where: {
          packageId: pMis.packageId,
          eventType: "EXCEPTION_RAISED",
          warehouseId: fx.whB,
        },
      });
      expect(eventsAfterFirst).toBe(1);

      const scan3 = await transfersSvc.scanDestinationPackage(waBActor, tB.id, {
        trackingId: pMis.trackingId,
      });
      expect(scan3.kind).toBe("WRONG_PACKAGE");
      const eventsAfterSecond = await prisma.trackingEvent.count({
        where: {
          packageId: pMis.packageId,
          eventType: "EXCEPTION_RAISED",
          warehouseId: fx.whB,
        },
      });
      expect(eventsAfterSecond).toBe(1);
      const wrongScanAudits = await prisma.auditLog.count({
        where: {
          action: "transfer.wrong_package_scan",
          entityId: tB.id,
          after: { path: ["packageId"], equals: pMis.packageId },
        },
      });
      expect(wrongScanAudits).toBe(1);
      // The misrouted package was never stocked at B.
      expect(await openRecords(fx.whB, [pMis.packageId])).toBe(0);

      // Cleanup: receive B's own package and reconcile T_B (frees
      // driver 1 + vehicle 1). T_C stays arrived at C with driver 2 —
      // no later test uses driver 2.
      await transfersSvc.scanDestinationPackage(waBActor, tB.id, {
        trackingId: pB.trackingId,
      });
      await transfersSvc.completePackageReceiving(waBActor, tB.id, {
        packageId: pB.packageId,
        condition: "GOOD",
      });
      await transfersSvc.finishReceiving(waBActor, tB.id);
      const reconciled = await transfersSvc.reconcileTransfer(waBActor, tB.id);
      expect(reconciled.status).toBe("RECONCILED");
    },
    60_000,
  );
});

describe("P5-6: concurrent reconciles claim exactly once", () => {
  it(
    "one reconcile succeeds, the other conflicts cleanly, and exactly one transfer.reconciled audit exists",
    async () => {
      const p = await readyOne(fx.districtB);
      const transfer = await crewedTransfer(
        [p.packageId],
        fx.whB,
        fx.driverProfile,
        fx.vehicle,
      );
      await dispatchedAndArrived(transfer.id, [p], driverActor);
      await transfersSvc.scanDestinationPackage(waBActor, transfer.id, {
        trackingId: p.trackingId,
      });
      await transfersSvc.completePackageReceiving(waBActor, transfer.id, {
        packageId: p.packageId,
        condition: "GOOD",
      });
      const finished = await transfersSvc.finishReceiving(waBActor, transfer.id);
      expect(finished.status).toBe("RECONCILIATION_PENDING");

      const results = await Promise.allSettled([
        transfersSvc.reconcileTransfer(waBActor, transfer.id),
        transfersSvc.reconcileTransfer(waBActor, transfer.id),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(
        (fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value.status,
      ).toBe("RECONCILED");
      const reason = (rejected[0] as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(errors.ConflictError);

      const audits = await prisma.auditLog.count({
        where: { action: "transfer.reconciled", entityId: transfer.id },
      });
      expect(audits).toBe(1);
      const row = await prisma.transfer.findUniqueOrThrow({ where: { id: transfer.id } });
      expect(row.status).toBe("RECONCILED");
    },
    60_000,
  );
});
