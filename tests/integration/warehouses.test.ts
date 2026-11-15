import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

// `server-only` throws outside a React Server Component environment; the
// services under test are server-only code, so stub the marker module.
vi.mock("server-only", () => ({}));

// Point the app at bla_test BEFORE the service layer is imported (same
// pattern as verify-credentials.test.ts). Refuse to run anywhere else.
function readDevDatabaseUrl(): string {
  for (const file of [".env.local", "prisma/.env"]) {
    try {
      const text = readFileSync(path.resolve(process.cwd(), file), "utf8");
      const match = text.match(/^DATABASE_URL=(.+)$/m);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    } catch {
      // try the next file
    }
  }
  throw new Error("DATABASE_URL not found in .env.local or prisma/.env");
}

const devUrl = readDevDatabaseUrl();
if (new URL(devUrl).pathname !== "/bla_dev") {
  throw new Error(
    "Integration tests require DATABASE_URL to target bla_dev (it is rewritten to bla_test).",
  );
}
const marker = "/bla_dev";
const idx = devUrl.lastIndexOf(marker);
process.env.DATABASE_URL =
  devUrl.slice(0, idx) + "/bla_test" + devUrl.slice(idx + marker.length);

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const email = (label: string) => `${label}-${RUN}@test.local`;
const pair = String(Date.now() % 90 + 10); // two digits for warehouse codes
const CODE_A = `WH-TSA-${pair}`;
const CODE_B = `WH-TSB-${pair}`;
const CODE_C = `WH-TSC-${pair}`;

let prisma: PrismaClient;
let svc: typeof import("@/server/services/warehouses");
let errors: typeof import("@/lib/errors");
let actorLib: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let codes: typeof import("@/lib/warehouses/codes");

let adminId: string;
let aAdminId: string;
let bAdminId: string;
let staffId: string;
let noMemberId: string;
let whA: string;
let whB: string;

/** Build an ActorContext exactly the way getActorContext does — from the
 *  current DB state — so membership changes take effect immediately. */
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
    vendorId: null,
    vendorRole: null,
    driverId: null,
    customerId: null,
    landingPath: catalog.landingPathForRoles(roles as never[]),
  };
}

async function makeUser(
  label: string,
  roleCode: string,
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `Test ${label}`,
      passwordHash: await hash("fixture-password", 10),
      status: "ACTIVE",
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role ${roleCode} not seeded in bla_test`);
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user.id;
}

async function addMembership(
  userId: string,
  warehouseId: string,
  roleCode: "WAREHOUSE_ADMIN" | "WAREHOUSE_STAFF",
): Promise<void> {
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  await prisma.warehouseMembership.create({
    data: { userId, warehouseId, roleId: role!.id, isPrimary: true },
  });
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  svc = await import("@/server/services/warehouses");
  errors = await import("@/lib/errors");
  actorLib = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");
  codes = await import("@/lib/warehouses/codes");

  // Role/permission catalog must exist in bla_test (idempotent upserts,
  // same as prisma/seed.ts).
  const permissionIdByCode = new Map<string, string>();
  for (const permission of catalog.PERMISSIONS) {
    const row = await prisma.permission.upsert({
      where: { code: permission.code },
      update: { name: permission.name, module: permission.module },
      create: { code: permission.code, name: permission.name, module: permission.module },
    });
    permissionIdByCode.set(permission.code, row.id);
  }
  for (const roleDef of catalog.ROLES) {
    const role = await prisma.role.upsert({
      where: { code: roleDef.code },
      update: { name: roleDef.name },
      create: { code: roleDef.code, name: roleDef.name },
    });
    for (const code of catalog.ROLE_PERMISSIONS[roleDef.code]) {
      const permissionId = permissionIdByCode.get(code);
      if (!permissionId) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
  }

  adminId = await makeUser("admin", "ADMIN");
  aAdminId = await makeUser("a-admin", "WAREHOUSE_ADMIN");
  bAdminId = await makeUser("b-admin", "WAREHOUSE_ADMIN");
  staffId = await makeUser("staff", "WAREHOUSE_STAFF");
  noMemberId = await makeUser("no-member", "WAREHOUSE_STAFF");

  const mkWarehouse = (code: string, name: string) =>
    prisma.warehouse.create({
      data: {
        code,
        name,
        type: "REGIONAL",
        district: "Kathmandu",
        city: "Kathmandu",
        province: "Bagmati",
        status: "ACTIVE",
      },
    });
  whA = (await mkWarehouse(CODE_A, "Test Warehouse A")).id;
  whB = (await mkWarehouse(CODE_B, "Test Warehouse B")).id;

  await addMembership(aAdminId, whA, "WAREHOUSE_ADMIN");
  await addMembership(bAdminId, whB, "WAREHOUSE_ADMIN");
  await addMembership(staffId, whA, "WAREHOUSE_STAFF");
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("warehouse isolation (Phase 2 acceptance)", () => {
  it("lists only the actor's own warehouses for scoped roles; Admin sees all", async () => {
    const aList = await svc.listWarehouses(await actorFor(aAdminId), {});
    expect(aList.items.map((w) => w.id)).toEqual([whA]);

    const adminList = await svc.listWarehouses(await actorFor(adminId), {
      pageSize: 100,
    });
    expect(adminList.items.map((w) => w.id)).toEqual(expect.arrayContaining([whA, whB]));

    const none = await svc.listWarehouses(await actorFor(noMemberId), {});
    expect(none.items).toEqual([]);
  }, 30_000);

  it("denies a cross-warehouse read (403 per security doc §3.4) AND writes an access.denied audit row", async () => {
    const aAdmin = await actorFor(aAdminId);
    await expect(svc.getWarehouse(aAdmin, whB)).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );

    const audit = await prisma.auditLog.findFirst({
      where: {
        actorId: aAdminId,
        action: "access.denied",
        entityType: "Warehouse",
        entityId: whB,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.warehouseId).toBe(whB);
  }, 30_000);

  it("denies cross-warehouse edit, member list, member assign, and zone create", async () => {
    const aAdmin = await actorFor(aAdminId);
    await expect(
      svc.updateWarehouse(aAdmin, whB, { contactPhone: "9800000000" }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
    await expect(svc.listMembers(aAdmin, whB)).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
    await expect(
      svc.assignMember(aAdmin, whB, {
        email: email("victim"),
        roleCode: "WAREHOUSE_STAFF",
      }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
    await expect(
      svc.createZone(aAdmin, whB, { name: "Sneaky", kind: "STORAGE" }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);

  it("denies a role with no membership entirely", async () => {
    const noMember = await actorFor(noMemberId);
    await expect(svc.getWarehouse(noMember, whA)).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
    await expect(svc.listMembers(noMember, whA)).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
  }, 30_000);

  it("scoped Warehouse Admin edits only operational fields of their own warehouse", async () => {
    const aAdmin = await actorFor(aAdminId);
    const updated = await svc.updateWarehouse(aAdmin, whA, {
      contactPhone: "9801112223",
    });
    expect(updated.contactPhone).toBe("9801112223");

    // Master data (name) is Admin-only: denied even for their own warehouse.
    await expect(
      svc.updateWarehouse(aAdmin, whA, { name: "Renamed" }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);

  it("membership removal revokes access immediately", async () => {
    const admin = await actorFor(adminId);
    const staffUser = await prisma.user.findUnique({ where: { id: staffId } });
    await svc.assignMember(admin, whB, {
      email: staffUser!.email,
      roleCode: "WAREHOUSE_STAFF",
    });
    // Fresh actor context (as the next request would build) sees B.
    expect((await actorFor(staffId)).warehouseIds).toContain(whB);
    await svc.getWarehouse(await actorFor(staffId), whB);

    const members = await svc.listMembers(admin, whB);
    const membership = members.find((m) => m.userId === staffId);
    await svc.removeMember(admin, whB, membership!.membershipId);
    // The very next request no longer resolves B in scope.
    expect((await actorFor(staffId)).warehouseIds).not.toContain(whB);
    await expect(svc.getWarehouse(await actorFor(staffId), whB)).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
  }, 30_000);

  it("a scoped Warehouse Admin cannot grant the Warehouse Admin role", async () => {
    const aAdmin = await actorFor(aAdminId);
    const target = await makeUser("promote-me", "WAREHOUSE_STAFF");
    const targetUser = await prisma.user.findUnique({ where: { id: target } });
    await expect(
      svc.assignMember(aAdmin, whA, {
        email: targetUser!.email,
        roleCode: "WAREHOUSE_ADMIN",
      }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);
});

describe("warehouse lifecycle rules", () => {
  it("create makes an INACTIVE warehouse with 7 standard zones; duplicate code conflicts", async () => {
    const admin = await actorFor(adminId);
    const created = await svc.createWarehouse(admin, {
      code: CODE_C,
      name: "Test Warehouse C",
      type: "LOCAL_HUB",
      district: "Lalitpur",
      city: "Lalitpur",
      province: "Bagmati",
      address: { addressLine1: "Pulchowk" },
    });
    expect(created.status).toBe("INACTIVE");
    const zones = await svc.listZones(admin, created.id);
    expect(zones).toHaveLength(7);

    await expect(
      svc.createWarehouse(admin, {
        code: CODE_C,
        name: "Duplicate",
        type: "LOCAL_HUB",
        district: "Lalitpur",
        city: "Lalitpur",
        province: "Bagmati",
        address: { addressLine1: "Elsewhere" },
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);

    // A Warehouse Admin cannot create warehouses at all.
    await expect(
      svc.createWarehouse(await actorFor(aAdminId), {
        code: `WH-TSD-${pair}`,
        name: "Nope",
        type: "LOCAL_HUB",
        district: "Lalitpur",
        city: "Lalitpur",
        province: "Bagmati",
        address: { addressLine1: "Elsewhere" },
      }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);

  it("activation requires an assigned Warehouse Admin; deactivated warehouses reject scoped operations", async () => {
    const admin = await actorFor(adminId);
    const warehouseC = await prisma.warehouse.findUnique({ where: { code: CODE_C } });

    await expect(svc.setWarehouseStatus(admin, warehouseC!.id, "ACTIVE")).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );

    const cAdminId = await makeUser("c-admin", "WAREHOUSE_ADMIN");
    const cAdminUser = await prisma.user.findUnique({ where: { id: cAdminId } });
    await svc.assignMember(admin, warehouseC!.id, {
      email: cAdminUser!.email,
      roleCode: "WAREHOUSE_ADMIN",
    });
    const activated = await svc.setWarehouseStatus(admin, warehouseC!.id, "ACTIVE");
    expect(activated.status).toBe("ACTIVE");

    // Scoped actors can never activate/deactivate, even their own warehouse.
    await expect(
      svc.setWarehouseStatus(await actorFor(cAdminId), warehouseC!.id, "INACTIVE"),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);

    await svc.setWarehouseStatus(admin, warehouseC!.id, "INACTIVE");
    // Now scoped operations are rejected while the warehouse is inactive.
    await expect(
      svc.updateWarehouse(await actorFor(cAdminId), warehouseC!.id, {
        contactPhone: "9809998887",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      svc.assignMember(await actorFor(cAdminId), warehouseC!.id, {
        email: email("late"),
        roleCode: "WAREHOUSE_STAFF",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
  }, 30_000);

  it("warehouse code is immutable at the database level", async () => {
    await expect(
      prisma.$executeRaw`UPDATE app."Warehouse" SET code = 'WH-XXX-99' WHERE id = ${whA}`,
    ).rejects.toThrow(/immutable/);
  }, 30_000);
});

describe("storage locations", () => {
  it("builds hierarchical full codes and rejects duplicates", async () => {
    expect(
      codes.buildStorageFullCode({
        warehouseCode: CODE_A,
        zoneCode: "ZONE-STO",
        rack: "3",
        shelf: "2",
      }),
    ).toBe(`${CODE_A}/ZONE-STO/RACK-03/SHELF-02`);
    expect(
      codes.buildStorageFullCode({
        warehouseCode: CODE_A,
        zoneCode: "ZONE-STO",
        rack: "RACK-3",
        shelf: "2",
        bin: "BIN-1",
      }),
    ).toBe(`${CODE_A}/ZONE-STO/RACK-03/SHELF-02/BIN-01`);
    expect(codes.STORAGE_FULL_CODE_PATTERN.test(`${CODE_A}/ZONE-STO/RACK-03/SHELF-02`)).toBe(true);
    expect(codes.STORAGE_FULL_CODE_PATTERN.test("ZONE-STO/RACK-03")).toBe(false);

    const aAdmin = await actorFor(aAdminId);
    const zones = await svc.listZones(aAdmin, whA);
    // Warehouse A fixture was created directly, so add the storage zone first.
    const zone =
      zones.find((z) => z.kind === "STORAGE") ??
      (await svc.createZone(aAdmin, whA, { name: "Storage", kind: "STORAGE" }));
    const location = await svc.createStorageLocation(aAdmin, zone.id, {
      rack: "3",
      shelf: "2",
    });
    expect(location.fullCode).toBe(`${CODE_A}/${zone.code}/RACK-03/SHELF-02`);
    await expect(
      svc.createStorageLocation(aAdmin, zone.id, { rack: "3", shelf: "2" }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  }, 30_000);
});
