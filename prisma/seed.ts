import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
} from "../src/lib/permissions/catalog";
import {
  STANDARD_ZONES,
  defaultOperatingHours,
} from "../src/lib/warehouses/codes";

/**
 * Development seed (idempotent):
 * - all roles and the permission catalog from docs/role-permission-matrix.md
 *   (via src/lib/permissions/catalog.ts, the single source of truth);
 * - role -> permission mappings, rebuilt from the catalog on every run;
 * - one Super Admin from SEED_SUPER_ADMIN_EMAIL / SEED_SUPER_ADMIN_PASSWORD.
 *
 * No demo operational accounts are seeded (docs/security-architecture.md
 * §11 #14). The super admin is created ONLY if no account with that email
 * exists: re-running the seed never overwrites an existing account's
 * password hash or status, so it cannot silently reactivate a suspended
 * super admin or reset their password to the env value.
 */
const prisma = new PrismaClient();

async function main(): Promise<void> {
  for (const role of ROLES) {
    await prisma.role.upsert({
      where: { code: role.code },
      update: { name: role.name, description: role.description, isSystem: true, isActive: true },
      create: {
        code: role.code,
        name: role.name,
        description: role.description,
        isSystem: true,
        isActive: true,
      },
    });
  }

  for (const permission of PERMISSIONS) {
    await prisma.permission.upsert({
      where: { code: permission.code },
      update: { name: permission.name, module: permission.module },
      create: { code: permission.code, name: permission.name, module: permission.module },
    });
  }

  const roleRows = await prisma.role.findMany();
  const permissionRows = await prisma.permission.findMany();
  const roleIdByCode = new Map(roleRows.map((r) => [r.code, r.id]));
  const permissionIdByCode = new Map(permissionRows.map((p) => [p.code, p.id]));

  for (const role of ROLES) {
    const roleId = roleIdByCode.get(role.code);
    if (!roleId) throw new Error(`Role missing after upsert: ${role.code}`);
    const grants = ROLE_PERMISSIONS[role.code].map((code) => {
      const permissionId = permissionIdByCode.get(code);
      if (!permissionId) throw new Error(`Permission missing after upsert: ${code}`);
      return { roleId, permissionId };
    });
    await prisma.rolePermission.deleteMany({ where: { roleId } });
    await prisma.rolePermission.createMany({ data: grants });
  }

  const email = process.env.SEED_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  const fullName = process.env.SEED_SUPER_ADMIN_NAME ?? "Super Admin";
  if (!email || !password) {
    throw new Error(
      "SEED_SUPER_ADMIN_EMAIL and SEED_SUPER_ADMIN_PASSWORD must be set (see .env.local).",
    );
  }

  const existingSuperAdmin = await prisma.user.findUnique({ where: { email } });
  let superAdmin = existingSuperAdmin;
  if (!superAdmin) {
    const passwordHash = await hash(password, 10);
    superAdmin = await prisma.user.create({
      data: {
        email,
        fullName,
        passwordHash,
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
    });
  } else {
    console.log(
      `Super admin ${email} already exists — leaving password and status untouched.`,
    );
  }

  const superAdminRoleId = roleIdByCode.get("SUPER_ADMIN");
  if (!superAdminRoleId) throw new Error("SUPER_ADMIN role missing after upsert");
  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: superAdmin.id, roleId: superAdminRoleId } },
    update: {},
    create: { userId: superAdmin.id, roleId: superAdminRoleId },
  });

  console.log(
    `Seeded ${ROLES.length} roles, ${PERMISSIONS.length} permissions, ` +
      `super admin ${email}.`,
  );

  await seedWarehouses(roleIdByCode);
}

/**
 * Phase 2 seed: the four REAL warehouses from the live legacy system
 * (public.warehouses, read via the Supabase Management API on
 * 2026-11-15), with the district backfilled as a first-class field
 * (Kathmandu · Kaski for Pokhara · Chitwan · Lalitpur — the Phase 3c
 * gap closed in the new model), their PRIMARY addresses, the seven
 * standard zones, and default operating hours (Sun–Fri 09:00–18:00,
 * Sat closed). Plus two local-only test Warehouse Admins — one for
 * Kathmandu (warehouse A) and one for Pokhara (warehouse B) — used by
 * the warehouse-isolation tests and smoke runs. Their shared password
 * comes from SEED_TEST_WA_PASSWORD (local env only, never a real
 * credential).
 */
const REAL_WAREHOUSES = [
  {
    code: "WH-KTM-01",
    name: "Kathmandu Central Hub",
    type: "MAIN",
    district: "Kathmandu",
    city: "Kathmandu",
    province: "Bagmati",
    addressLine1: "New Road, Kathmandu",
    postalCode: "44600",
    latitude: 27.7172,
    longitude: 85.324,
    capacityPackages: 5000,
  },
  {
    code: "WH-PKR-01",
    name: "Pokhara Regional Hub",
    type: "REGIONAL",
    district: "Kaski",
    city: "Pokhara",
    province: "Gandaki",
    addressLine1: "Chipledhunga, Pokhara",
    postalCode: "33700",
    latitude: 28.2096,
    longitude: 83.9856,
    capacityPackages: 3000,
  },
  {
    code: "WH-CHT-01",
    name: "Chitwan Warehouse",
    type: "REGIONAL",
    district: "Chitwan",
    city: "Bharatpur",
    province: "Bagmati",
    addressLine1: "Narayangarh, Chitwan",
    postalCode: "44200",
    latitude: 27.6841,
    longitude: 84.4339,
    capacityPackages: 2000,
  },
  {
    code: "WH-LTP-01",
    name: "Lalitpur Depot",
    type: "LOCAL_HUB",
    district: "Lalitpur",
    city: "Lalitpur",
    province: "Bagmati",
    addressLine1: "Pulchowk, Lalitpur",
    postalCode: "44700",
    latitude: 27.6651,
    longitude: 85.3232,
    capacityPackages: 1500,
  },
] as const;

const TEST_WAREHOUSE_ADMINS = [
  { email: "ktm.admin@bla.test", fullName: "KTM Warehouse Admin (test)", warehouseCode: "WH-KTM-01" },
  { email: "pkr.admin@bla.test", fullName: "PKR Warehouse Admin (test)", warehouseCode: "WH-PKR-01" },
] as const;

async function seedWarehouses(
  roleIdByCode: Map<string, string>,
): Promise<void> {
  const warehouseAdminRoleId = roleIdByCode.get("WAREHOUSE_ADMIN");
  if (!warehouseAdminRoleId) throw new Error("WAREHOUSE_ADMIN role missing after upsert");

  const warehouseIdByCode = new Map<string, string>();
  for (const w of REAL_WAREHOUSES) {
    const warehouse = await prisma.warehouse.upsert({
      where: { code: w.code },
      // Status is intentionally not touched on re-seed: a warehouse an
      // admin deactivated in dev stays deactivated.
      update: {
        name: w.name,
        type: w.type,
        district: w.district,
        city: w.city,
        province: w.province,
        capacityPackages: w.capacityPackages,
      },
      create: {
        code: w.code,
        name: w.name,
        type: w.type,
        district: w.district,
        city: w.city,
        province: w.province,
        capacityPackages: w.capacityPackages,
        status: "ACTIVE",
      },
    });
    warehouseIdByCode.set(w.code, warehouse.id);

    await prisma.warehouseAddress.upsert({
      where: { warehouseId_kind: { warehouseId: warehouse.id, kind: "PRIMARY" } },
      update: {
        addressLine1: w.addressLine1,
        city: w.city,
        district: w.district,
        province: w.province,
        postalCode: w.postalCode,
        latitude: w.latitude,
        longitude: w.longitude,
      },
      create: {
        warehouseId: warehouse.id,
        kind: "PRIMARY",
        addressLine1: w.addressLine1,
        city: w.city,
        district: w.district,
        province: w.province,
        postalCode: w.postalCode,
        latitude: w.latitude,
        longitude: w.longitude,
      },
    });

    for (const zone of STANDARD_ZONES) {
      await prisma.warehouseZone.upsert({
        where: { warehouseId_code: { warehouseId: warehouse.id, code: zone.code } },
        update: { name: zone.name, kind: zone.kind },
        create: { warehouseId: warehouse.id, code: zone.code, name: zone.name, kind: zone.kind },
      });
    }
    for (const hours of defaultOperatingHours()) {
      await prisma.warehouseOperatingHours.upsert({
        where: {
          warehouseId_dayOfWeek: { warehouseId: warehouse.id, dayOfWeek: hours.dayOfWeek },
        },
        update: { opensAt: hours.opensAt, closesAt: hours.closesAt, isClosed: hours.isClosed },
        create: { warehouseId: warehouse.id, ...hours },
      });
    }
  }

  const testPassword = process.env.SEED_TEST_WA_PASSWORD;
  if (!testPassword) {
    throw new Error("SEED_TEST_WA_PASSWORD must be set (see prisma/.env).");
  }
  const testPasswordHash = await hash(testPassword, 10);
  for (const testAdmin of TEST_WAREHOUSE_ADMINS) {
    const warehouseId = warehouseIdByCode.get(testAdmin.warehouseCode);
    if (!warehouseId) throw new Error(`Warehouse missing after upsert: ${testAdmin.warehouseCode}`);
    const user = await prisma.user.upsert({
      where: { email: testAdmin.email },
      update: {
        fullName: testAdmin.fullName,
        passwordHash: testPasswordHash,
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
      create: {
        email: testAdmin.email,
        fullName: testAdmin.fullName,
        passwordHash: testPasswordHash,
        status: "ACTIVE",
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: warehouseAdminRoleId } },
      update: {},
      create: { userId: user.id, roleId: warehouseAdminRoleId },
    });
    const activeMembership = await prisma.warehouseMembership.findFirst({
      where: { userId: user.id, warehouseId, revokedAt: null },
    });
    if (!activeMembership) {
      await prisma.warehouseMembership.create({
        data: { userId: user.id, warehouseId, roleId: warehouseAdminRoleId, isPrimary: true },
      });
    }
    await prisma.warehouse.update({
      where: { id: warehouseId },
      data: { managerUserId: user.id },
    });
  }

  console.log(
    `Seeded ${REAL_WAREHOUSES.length} warehouses with standard zones and ` +
      `${TEST_WAREHOUSE_ADMINS.length} test warehouse admins.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
