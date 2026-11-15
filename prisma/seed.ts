import { PrismaClient } from "@prisma/client";
import { hash } from "bcryptjs";

import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
} from "../src/lib/permissions/catalog";

/**
 * Development seed (idempotent):
 * - all roles and the permission catalog from docs/role-permission-matrix.md
 *   (via src/lib/permissions/catalog.ts, the single source of truth);
 * - role -> permission mappings, rebuilt from the catalog on every run;
 * - one Super Admin from SEED_SUPER_ADMIN_EMAIL / SEED_SUPER_ADMIN_PASSWORD.
 *
 * No demo operational accounts are seeded (docs/security-architecture.md
 * §11 #14). Re-running the seed refreshes the seeded super admin's
 * password hash from the env value — local development only.
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

  const passwordHash = await hash(password, 10);
  const superAdmin = await prisma.user.upsert({
    where: { email },
    update: { fullName, passwordHash, status: "ACTIVE", emailVerifiedAt: new Date() },
    create: {
      email,
      fullName,
      passwordHash,
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });

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
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
