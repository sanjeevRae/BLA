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
    // Convergent, race-safe sync: the integration suites upsert these
    // same catalog rows in parallel against the shared test database,
    // and seed-safety re-runs this seed as a subprocess alongside them.
    // A delete-all + create-all pair raced with those upserts (a row
    // re-created inside the delete→create window made createMany throw
    // P2002). Insert-missing-first never throws on rows a concurrent
    // writer just created, and the follow-up delete removes only the
    // grants the catalog no longer lists — the final set is unchanged.
    await prisma.rolePermission.createMany({ data: grants, skipDuplicates: true });
    await prisma.rolePermission.deleteMany({
      where: {
        roleId,
        permissionId: { notIn: grants.map((g) => g.permissionId) },
      },
    });
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
  await seedPhase3(superAdmin.id);
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

/**
 * True only when DATABASE_URL targets a local dev/test database
 * (Phase 2 review P2-6): the test warehouse admins are local fixtures
 * with a shared env password and must never be created anywhere else.
 */
function targetsLocalDatabase(): boolean {
  const raw = process.env.DATABASE_URL;
  if (!raw) return false;
  try {
    const url = new URL(raw);
    const hostOk = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    const nameOk = url.pathname === "/bla_dev" || url.pathname === "/bla_test";
    return hostOk && nameOk;
  } catch {
    return false;
  }
}

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

  // P2-6: test accounts are local-only, create-only fixtures. Against a
  // non-local database the seed refuses to create them at all; against a
  // local one, an existing test account is left exactly as it is —
  // re-running the seed never resets its password or reactivates it
  // (the F11 super-admin protection, extended to the test admins).
  if (!targetsLocalDatabase()) {
    console.log(
      "Refusing to seed test warehouse admin accounts: DATABASE_URL does " +
        "not target a local database (localhost/127.0.0.1 + bla_dev/bla_test).",
    );
  } else {
    const testPassword = process.env.SEED_TEST_WA_PASSWORD;
    if (!testPassword) {
      throw new Error("SEED_TEST_WA_PASSWORD must be set (see prisma/.env).");
    }
    for (const testAdmin of TEST_WAREHOUSE_ADMINS) {
      const warehouseId = warehouseIdByCode.get(testAdmin.warehouseCode);
      if (!warehouseId) throw new Error(`Warehouse missing after upsert: ${testAdmin.warehouseCode}`);
      let user = await prisma.user.findUnique({ where: { email: testAdmin.email } });
      if (!user) {
        user = await prisma.user.create({
          data: {
            email: testAdmin.email,
            fullName: testAdmin.fullName,
            passwordHash: await hash(testPassword, 10),
            status: "ACTIVE",
            emailVerifiedAt: new Date(),
          },
        });
      } else {
        console.log(
          `Test warehouse admin ${testAdmin.email} already exists — leaving password and status untouched.`,
        );
      }
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
    console.log(`Seeded ${TEST_WAREHOUSE_ADMINS.length} test warehouse admins (create-only).`);
  }

  console.log(`Seeded ${REAL_WAREHOUSES.length} warehouses with standard zones.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

/**
 * Phase 3 seed: reference data + local demo fixtures.
 * - Shipping services (STANDARD / EXPRESS).
 * - District → warehouse routing: one ServiceArea per seeded
 *   warehouse's district (Kathmandu, Kaski, Chitwan, Lalitpur).
 * - A catch-all STANDARD PricingRule (tariffs are configuration rows,
 *   never code — spec §6.3): NPR 150 base + NPR 50 per billable kg.
 * - An APPROVED demo vendor with an approved pickup address, an origin
 *   assignment, and an owner login (vendor.owner@bla.test), plus a
 *   PENDING vendor for the verification queue.
 * - A customer login (customer@bla.test) linked to a Customer record.
 * Demo logins share the local test password from SEED_TEST_WA_PASSWORD.
 * The demo vendor/customer fixtures are created ONLY against a local
 * database (targetsLocalDatabase, P3-3 — the P2-6 guard); the
 * reference data above them is seeded everywhere. All idempotent.
 */
async function seedPhase3(superAdminId: string): Promise<void> {
  const standard = await prisma.shippingService.upsert({
    where: { code: "STANDARD" },
    update: { isActive: true },
    create: { code: "STANDARD", name: "Standard Delivery", estimatedDaysMin: 1, estimatedDaysMax: 3 },
  });
  await prisma.shippingService.upsert({
    where: { code: "EXPRESS" },
    update: { isActive: true },
    create: { code: "EXPRESS", name: "Express Delivery", estimatedDaysMin: 1, estimatedDaysMax: 1 },
  });

  const warehouses = await prisma.warehouse.findMany({
    select: { id: true, code: true, district: true, city: true, province: true },
  });
  const warehouseByCode = new Map(warehouses.map((w) => [w.code, w]));
  const areaDefs = [
    { name: "Kathmandu Metro", warehouseCode: "WH-KTM-01" },
    { name: "Pokhara Valley", warehouseCode: "WH-PKR-01" },
    { name: "Chitwan Valley", warehouseCode: "WH-CHT-01" },
    { name: "Lalitpur Metro", warehouseCode: "WH-LTP-01" },
  ];
  for (const def of areaDefs) {
    const warehouse = warehouseByCode.get(def.warehouseCode);
    if (!warehouse) continue;
    await prisma.serviceArea.upsert({
      where: { district_name: { district: warehouse.district, name: def.name } },
      update: { servingWarehouseId: warehouse.id, isActive: true },
      create: {
        name: def.name,
        district: warehouse.district,
        city: warehouse.city,
        province: warehouse.province,
        servingWarehouseId: warehouse.id,
      },
    });
  }

  const catchAll = await prisma.pricingRule.findFirst({
    where: {
      shippingServiceId: standard.id,
      originServiceAreaId: null,
      destinationServiceAreaId: null,
      isActive: true,
    },
  });
  if (!catchAll) {
    await prisma.pricingRule.create({
      data: {
        shippingServiceId: standard.id,
        baseRatePaisa: BigInt(15000),
        perKgRatePaisa: BigInt(5000),
        volumetricDivisor: 5000,
        createdById: superAdminId,
      },
    });
  }

  // P3-3: the demo vendor organisation and the demo logins below are
  // local-only fixtures with a shared env password — the same guard
  // the Phase 2 test warehouse admins use (P2-6). Against any other
  // database the seed stops after the reference data above: an
  // APPROVED vendor owned by a known-password account, and a customer
  // login linked to a Customer record, must never appear elsewhere.
  if (!targetsLocalDatabase()) {
    console.log(
      "Refusing to seed Phase 3 demo vendor/customer accounts: DATABASE_URL does " +
        "not target a local database (localhost/127.0.0.1 + bla_dev/bla_test).",
    );
    console.log("Seeded Phase 3 reference data only.");
    return;
  }
  const testPassword = process.env.SEED_TEST_WA_PASSWORD;
  if (!testPassword) {
    throw new Error("SEED_TEST_WA_PASSWORD must be set (see prisma/.env).");
  }
  const passwordHash = await hash(testPassword, 12);

  let vendor = await prisma.vendor.findFirst({
    where: { businessName: "Himalaya Handicrafts (test)" },
  });
  if (!vendor) {
    vendor = await prisma.vendor.create({
      data: {
        businessName: "Himalaya Handicrafts (test)",
        registrationNumber: "TEST-REG-001",
        contactName: "Vendor Owner (test)",
        email: "vendor.owner@bla.test",
        phone: "9779851000001",
        verificationStatus: "APPROVED",
        verifiedById: superAdminId,
        verifiedAt: new Date(),
        createdById: superAdminId,
      },
    });
  }
  const ktm = warehouseByCode.get("WH-KTM-01");
  if (ktm) {
    const existingAddress = await prisma.vendorAddress.findFirst({
      where: { vendorId: vendor.id, kind: "PICKUP" },
    });
    if (!existingAddress) {
      await prisma.vendorAddress.create({
        data: {
          vendorId: vendor.id,
          kind: "PICKUP",
          addressLine1: "Thamel Marg 12",
          city: "Kathmandu",
          district: "Kathmandu",
          province: "Bagmati",
          contactName: "Vendor Owner (test)",
          contactPhone: "9779851000001",
          isApproved: true,
          approvedById: superAdminId,
        },
      });
    }
    await prisma.vendorWarehouseAssignment.upsert({
      where: { vendorId_warehouseId_kind: { vendorId: vendor.id, warehouseId: ktm.id, kind: "ORIGIN" } },
      update: { isActive: true },
      create: { vendorId: vendor.id, warehouseId: ktm.id, kind: "ORIGIN", assignedById: superAdminId },
    });
  }
  const vendorOwner = await prisma.user.upsert({
    where: { email: "vendor.owner@bla.test" },
    update: {},
    create: {
      email: "vendor.owner@bla.test",
      fullName: "Vendor Owner (test)",
      passwordHash,
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });
  const vendorRoleRow = await prisma.role.findUnique({ where: { code: "VENDOR" } });
  if (vendorRoleRow) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: vendorOwner.id, roleId: vendorRoleRow.id } },
      update: {},
      create: { userId: vendorOwner.id, roleId: vendorRoleRow.id, assignedById: superAdminId },
    });
  }
  await prisma.vendorUser.upsert({
    where: { vendorId_userId: { vendorId: vendor.id, userId: vendorOwner.id } },
    update: { isActive: true, vendorRole: "OWNER" },
    create: { vendorId: vendor.id, userId: vendorOwner.id, vendorRole: "OWNER", invitedById: superAdminId },
  });

  const pendingVendor = await prisma.vendor.findFirst({
    where: { businessName: "Pending Traders (test)" },
  });
  if (!pendingVendor) {
    await prisma.vendor.create({
      data: {
        businessName: "Pending Traders (test)",
        contactName: "Pending Contact (test)",
        email: "pending.vendor@bla.test",
        phone: "9779851000002",
        verificationStatus: "PENDING_VERIFICATION",
        createdById: superAdminId,
      },
    });
  }

  const customerUser = await prisma.user.upsert({
    where: { email: "customer@bla.test" },
    update: {},
    create: {
      email: "customer@bla.test",
      fullName: "Demo Customer (test)",
      passwordHash,
      status: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });
  const customerRoleRow = await prisma.role.findUnique({ where: { code: "CUSTOMER" } });
  if (customerRoleRow) {
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: customerUser.id, roleId: customerRoleRow.id } },
      update: {},
      create: { userId: customerUser.id, roleId: customerRoleRow.id, assignedById: superAdminId },
    });
  }
  await prisma.customer.upsert({
    where: { normalizedPhone: "9779812345678" },
    update: { userId: customerUser.id },
    create: {
      fullName: "Demo Customer (test)",
      phone: "9812345678",
      normalizedPhone: "9779812345678",
      email: "customer@bla.test",
      userId: customerUser.id,
      createdById: superAdminId,
    },
  });

  console.log("Seeded Phase 3 reference data, demo vendor and demo customer.");
}
