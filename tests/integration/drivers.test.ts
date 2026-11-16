import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Phase 2 V2 (E) — direct service coverage for drivers + vehicles
 * (src/server/services/drivers.ts, vehicles.ts) against bla_test.
 *
 * The fleet admin pages read through listDrivers / getDriver /
 * listAssignableDrivers / listDriverCandidates / listVehicles /
 * getVehicle / listVehicleMaintenance; until now those reads were
 * only exercised indirectly through transfer/delivery journeys.
 * These tests pin them directly: profile creation + the duplicate
 * guard, licence updates, employment-status and expired-licence
 * assignment blockers, warehouse scoping (WA sees own-warehouse
 * drivers only, a rider sees only self), search composing with
 * scope (P3-1), audited cross-scope denial, the candidate picker,
 * and the vehicle lifecycle (create → blockers → driver assignment
 * → status → maintenance history).
 *
 * Fixture warehouses are per-suite (WH-QD2-* codes, find-or-create);
 * users/drivers/vehicles are per-run unique.
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
const email = (label: string) => `p2d-${label}-${RUN}@bla.test`;

let prisma: import("@prisma/client").PrismaClient;
let driversSvc: typeof import("@/server/services/drivers");
let vehiclesSvc: typeof import("@/server/services/vehicles");
let errors: typeof import("@/lib/errors");
let actorErrors: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

const fx: Record<string, string> = {};
let adminActor: Awaited<ReturnType<typeof actorFor>>;
let waAActor: Awaited<ReturnType<typeof actorFor>>;
let waBActor: Awaited<ReturnType<typeof actorFor>>;

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

async function makeUser(
  label: string,
  roleCode: string,
  fullName?: string,
): Promise<string> {
  const { hash } = await import("bcryptjs");
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: fullName ?? `P2D ${label} ${RUN}`,
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

async function ensureWarehouse(code: string, name: string, district: string): Promise<string> {
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
    await prisma.warehouse.update({
      where: { id: warehouse.id },
      data: { status: "ACTIVE" },
    });
  }
  return warehouse.id;
}

async function makeDriver(
  label: string,
  opts: {
    roleCode?: string;
    homeWarehouseId: string;
    capabilities: string[];
    licenseExpiry?: string;
    fullName?: string;
  },
) {
  const userId = await makeUser(label, opts.roleCode ?? "RIDER", opts.fullName);
  const profile = await driversSvc.createDriverProfile(adminActor, {
    userId,
    homeWarehouseId: opts.homeWarehouseId,
    licenseNumber: `LIC-P2D-${label}-${RUN}`,
    licenseCategory: "A",
    licenseExpiry: opts.licenseExpiry ?? "2030-01-01",
    capabilities: opts.capabilities as never,
  });
  return { userId, profile };
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

  fx.whA = await ensureWarehouse("WH-QD2-01", "P2D Alpha", "P2D Alpha District");
  fx.whB = await ensureWarehouse("WH-QD2-02", "P2D Beta", "P2D Beta District");

  fx.waA = await makeUser("waA", "WAREHOUSE_ADMIN");
  await addMembership(fx.waA, fx.whA, "WAREHOUSE_ADMIN");
  fx.waB = await makeUser("waB", "WAREHOUSE_ADMIN");
  await addMembership(fx.waB, fx.whB, "WAREHOUSE_ADMIN");
  waAActor = await actorFor(fx.waA);
  waBActor = await actorFor(fx.waB);
}, 120_000);

describe("driver profiles", { timeout: 120_000 }, () => {
  it("createDriverProfile creates the profile and a duplicate is refused", async () => {
    const { userId, profile } = await makeDriver("dup", {
      homeWarehouseId: fx.whA,
      capabilities: ["DELIVERY", "PICKUP"],
    });
    expect(profile.userId).toBe(userId);
    expect(profile.homeWarehouseId).toBe(fx.whA);
    expect(profile.employmentStatus).toBe("ACTIVE");
    expect(profile.licenseExpired).toBe(false);
    expect(profile.capabilities).toEqual(["DELIVERY", "PICKUP"]);

    await expect(
      driversSvc.createDriverProfile(adminActor, {
        userId,
        homeWarehouseId: fx.whA,
        licenseNumber: `LIC-P2D-dup2-${RUN}`,
        licenseExpiry: "2030-01-01",
        capabilities: ["DELIVERY"],
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
    expect(await prisma.driver.count({ where: { userId } })).toBe(1);
  });

  it("updateDriverProfile applies a licence change", async () => {
    const { profile } = await makeDriver("upd", {
      homeWarehouseId: fx.whA,
      capabilities: ["DELIVERY"],
    });
    const updated = await driversSvc.updateDriverProfile(adminActor, {
      driverId: profile.id,
      licenseNumber: `LIC-P2D-upd-NEW-${RUN}`,
      licenseExpiry: "2031-05-05",
      licenseCategory: "B",
    });
    expect(updated.licenseNumber).toBe(`LIC-P2D-upd-NEW-${RUN}`);
    expect(updated.licenseExpiry).toBe("2031-05-05");
    expect(updated.licenseCategory).toBe("B");
    const row = await prisma.driver.findUniqueOrThrow({ where: { id: profile.id } });
    expect(row.licenseNumber).toBe(`LIC-P2D-upd-NEW-${RUN}`);
  });

  it("listDriverCandidates excludes users who already have profiles", async () => {
    // Name sorts early so the candidate is inside the picker's
    // first page even on a shared, accumulated test database.
    const userId = await makeUser("candidate", "RIDER", `AAA P2D candidate ${RUN}`);
    const before = await driversSvc.listDriverCandidates(adminActor);
    expect(before.map((c) => c.userId)).toContain(userId);

    await driversSvc.createDriverProfile(adminActor, {
      userId,
      homeWarehouseId: fx.whA,
      licenseNumber: `LIC-P2D-cand-${RUN}`,
      licenseExpiry: "2030-01-01",
      capabilities: ["DELIVERY"],
    });
    const after = await driversSvc.listDriverCandidates(adminActor);
    expect(after.map((c) => c.userId)).not.toContain(userId);
  });
});

describe("assignment blockers", { timeout: 120_000 }, () => {
  it("a suspended driver gains the Employment status blocker; an expired licence gains the licence blocker", async () => {
    const suspended = await makeDriver("susp", {
      roleCode: "LINEHAUL_DRIVER",
      homeWarehouseId: fx.whA,
      capabilities: ["LINEHAUL"],
    });
    const expired = await makeDriver("expired", {
      roleCode: "LINEHAUL_DRIVER",
      homeWarehouseId: fx.whA,
      capabilities: ["LINEHAUL"],
    });

    // Both start assignable (no blockers).
    let assignable = await driversSvc.listAssignableDrivers(adminActor);
    expect(assignable.find((a) => a.driver.id === suspended.profile.id)?.blockers).toEqual([]);
    expect(assignable.find((a) => a.driver.id === expired.profile.id)?.blockers).toEqual([]);

    const view = await driversSvc.setDriverEmploymentStatus(adminActor, {
      driverId: suspended.profile.id,
      employmentStatus: "SUSPENDED",
      reason: "P2D blocker probe",
    });
    expect(view.employmentStatus).toBe("SUSPENDED");
    expect(view.availabilityStatus).toBe("SUSPENDED");

    // An expired licence cannot be entered through the service
    // (creation/update reject past expiries), so age the row
    // directly — the blocker derivation is what is under test.
    await prisma.driver.update({
      where: { id: expired.profile.id },
      data: { licenseExpiry: new Date("2020-01-01T00:00:00.000Z") },
    });

    assignable = await driversSvc.listAssignableDrivers(adminActor);
    const suspEntry = assignable.find((a) => a.driver.id === suspended.profile.id);
    expect(suspEntry).toBeDefined();
    expect(suspEntry!.blockers.join(" ")).toMatch(/Employment status/);
    const expEntry = assignable.find((a) => a.driver.id === expired.profile.id);
    expect(expEntry).toBeDefined();
    expect(expEntry!.blockers.join(" ")).toMatch(/licence has expired/i);
    // The full driver view agrees the licence is expired.
    const expiredView = await driversSvc.getDriver(adminActor, expired.profile.id);
    expect(expiredView.licenseExpired).toBe(true);
  });
});

describe("driver scoping and search", { timeout: 120_000 }, () => {
  it("WA sees only own-warehouse drivers, a rider sees only self, and search composes with scope", async () => {
    const alphaName = `P2D AlphaDriver ${RUN}`;
    const betaName = `P2D BetaDriver ${RUN}`;
    const alpha = await makeDriver("alpha", {
      homeWarehouseId: fx.whA,
      capabilities: ["DELIVERY"],
      fullName: alphaName,
    });
    const beta = await makeDriver("beta", {
      homeWarehouseId: fx.whB,
      capabilities: ["DELIVERY"],
      fullName: betaName,
    });
    fx.alphaDriver = alpha.profile.id;
    fx.betaDriver = beta.profile.id;
    fx.betaDriverUser = beta.userId;

    const listA = await driversSvc.listDrivers(waAActor, {});
    expect(listA.items.map((d) => d.id)).toContain(alpha.profile.id);
    expect(listA.items.map((d) => d.id)).not.toContain(beta.profile.id);
    const listB = await driversSvc.listDrivers(waBActor, {});
    expect(listB.items.map((d) => d.id)).toContain(beta.profile.id);
    expect(listB.items.map((d) => d.id)).not.toContain(alpha.profile.id);

    // Search narrows, never replaces, scope (P3-1): WA-A searching
    // the foreign driver's exact name gets nothing; searching the
    // own-warehouse driver finds them.
    const foreignSearch = await driversSvc.listDrivers(waAActor, { search: betaName });
    expect(foreignSearch.items).toEqual([]);
    expect(foreignSearch.total).toBe(0);
    const ownSearch = await driversSvc.listDrivers(waAActor, { search: alphaName });
    expect(ownSearch.items.map((d) => d.id)).toContain(alpha.profile.id);

    // A rider actor sees only their own profile.
    const riderActor = await actorFor(beta.userId);
    expect(riderActor.driverId).toBe(beta.profile.id);
    const riderList = await driversSvc.listDrivers(riderActor, {});
    expect(riderList.items.map((d) => d.id)).toEqual([beta.profile.id]);
  });

  it("getDriver across scope is denied and the denial is audited", async () => {
    await expect(driversSvc.getDriver(waBActor, fx.alphaDriver)).rejects.toBeInstanceOf(
      actorErrors.AuthorizationError,
    );
    const denial = await prisma.auditLog.findFirst({
      where: {
        actorId: fx.waB,
        action: "access.denied",
        entityType: "Driver",
        entityId: fx.alphaDriver,
      },
    });
    expect(denial).not.toBeNull();
    // Control: the home-warehouse admin reads the same driver fine.
    const view = await driversSvc.getDriver(waAActor, fx.alphaDriver);
    expect(view.id).toBe(fx.alphaDriver);
    expect(view.homeWarehouseId).toBe(fx.whA);
  });
});

describe("vehicles", { timeout: 120_000 }, () => {
  it("createVehicle, expired-document blockers, driver assignment, status, and maintenance history", async () => {
    const vehicle = await vehiclesSvc.createVehicle(adminActor, {
      registration: `P2D TRK ${RUN}`.toUpperCase(),
      type: "TRUCK",
      capacityKg: 4000,
      homeWarehouseId: fx.whA,
      insuranceExpiry: "2027-06-01",
      registrationExpiry: "2027-06-01",
    });
    expect(vehicle.status).toBe("AVAILABLE");
    expect(vehicle.assignmentBlockers).toEqual([]);
    expect(vehicle.homeWarehouseId).toBe(fx.whA);

    // Expired insurance + registration are flagged as blockers.
    const stale = await vehiclesSvc.createVehicle(adminActor, {
      registration: `P2D OLD ${RUN}`.toUpperCase(),
      type: "VAN",
      capacityKg: 1000,
      homeWarehouseId: fx.whA,
      insuranceExpiry: "2020-01-01",
      registrationExpiry: "2020-06-01",
    });
    expect(stale.assignmentBlockers.join(" ")).toMatch(/insurance has expired/i);
    expect(stale.assignmentBlockers.join(" ")).toMatch(/registration has expired/i);
    const staleView = await vehiclesSvc.getVehicle(adminActor, stale.id);
    expect(staleView.assignmentBlockers.length).toBeGreaterThanOrEqual(2);

    // Standing driver assignment.
    const assigned = await vehiclesSvc.assignVehicleDriver(
      adminActor,
      vehicle.id,
      fx.alphaDriver,
    );
    expect(assigned.assignedDriverId).toBe(fx.alphaDriver);
    expect(assigned.assignedDriverName).toBeTruthy();

    // Status changes by hand (never ON_TRIP).
    const inMaintenance = await vehiclesSvc.setVehicleStatus(
      adminActor,
      vehicle.id,
      "MAINTENANCE",
    );
    expect(inMaintenance.status).toBe("MAINTENANCE");
    expect(inMaintenance.assignmentBlockers.join(" ")).toMatch(/MAINTENANCE/);
    const back = await vehiclesSvc.setVehicleStatus(adminActor, vehicle.id, "AVAILABLE");
    expect(back.status).toBe("AVAILABLE");

    // Maintenance is recorded and listed back.
    const recorded = await vehiclesSvc.recordVehicleMaintenance(adminActor, {
      vehicleId: vehicle.id,
      kind: "REPAIR",
      scheduledAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      costPaisa: "1250000",
      notes: "P2D routine service",
    });
    expect(recorded.vehicleId).toBe(vehicle.id);
    expect(recorded.costPaisa).toBe("1250000");
    const history = await vehiclesSvc.listVehicleMaintenance(adminActor, vehicle.id);
    expect(history.map((h) => h.id)).toContain(recorded.id);
    expect(history.find((h) => h.id === recorded.id)?.kind).toBe("REPAIR");

    // The fleet list finds the vehicle by its registration.
    const list = await vehiclesSvc.listVehicles(adminActor, {
      search: vehicle.registration,
    });
    expect(list.items.map((v) => v.id)).toContain(vehicle.id);
  });
});
