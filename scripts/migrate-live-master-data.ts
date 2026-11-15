/**
 * Live master-data migration: legacy `public` schema → new `app`
 * schema (Phase 10 slice 2; docs/deployment-guide.md §4 runbook).
 *
 * WHAT IT MOVES (idempotently, keyed by natural keys throughout):
 *   - the permission catalog (roles, permissions, grants) — the
 *     reference data every other row references;
 *   - the company chart of accounts + the SystemSetting rows
 *     (create-only, mirroring prisma/seed.ts);
 *   - the 4 real warehouses with their PRIMARY addresses, the 7
 *     standard zones and default operating hours (Sun–Fri
 *     09:00–18:00, Sat closed). District/type/province/capacity are
 *     backfilled from the same configuration the local seed carries
 *     — the legacy table never had those columns (Phase 2 backfill);
 *   - the 4 vehicles (type/status vocabulary mapped, see below);
 *   - the shipping-service catalog (STANDARD / EXPRESS), the 4
 *     district service areas;
 *   - the 1 customer (+ its delivery address), unlinked.
 *
 * USERS MODE (--with-users) additionally moves the people:
 *   - the 9 legacy accounts become PASSWORD-LESS shell Users
 *     (passwordHash NULL — login is impossible until the account is
 *     claimed). Legacy password hashes are NOT exportable and are
 *     never read by this script. Each shell gets a PENDING
 *     UserInvitation (SHA-256 token hash stored, 7-day expiry —
 *     the platform TTL); accepting the invitation sets the user's
 *     own password and grants the role, through the normal Phase 2
 *     flow. Shells hold NO roles before acceptance.
 *   - warehouse memberships (5) are created directly from the
 *     legacy rows;
 *   - driver profiles (4) are created for the driver accounts.
 *     Legacy has no licence-expiry data: the profile is created
 *     with the sentinel expiry 1970-01-01 — visibly expired, so
 *     every assignment guard blocks the driver until a human
 *     enters the real date. Legacy `driver_type` ("micro") is a
 *     vehicle class, not a capability; profiles get the last-mile
 *     capabilities PICKUP + DELIVERY and the RIDER role.
 *   - vehicles get their default driver (legacy drivers.vehicle_id);
 *   - the customer record is linked to its account;
 *   - the catch-all STANDARD PricingRule is created with
 *     createdBy = the designated Super Admin (PricingRule.createdById
 *     is NOT NULL, which is why the tariff lands in users mode).
 *
 * SUPER ADMIN: the first Super Admin is a human designation, never
 * an inference. --with-users REFUSES to run without
 * --super-admin-email, and the address must be one of the legacy
 * accounts being migrated. The designee's invitation is for
 * SUPER_ADMIN (their legacy role can be granted additionally from
 * the Users module after acceptance). Nothing is ever auto-promoted.
 *
 * MODES:
 *   (default)            dry-run: reads source + target, prints the
 *                        plan, writes nothing.
 *   --apply              execute the plan through Prisma
 *                        (DATABASE_URL selects the target).
 *   --sql-out <file>     render the NON-USER plan as idempotent SQL
 *                        for the Supabase Management API / SQL
 *                        Editor route (used when no database
 *                        password is available — see the runbook).
 *                        Refuses to combine with --with-users:
 *                        invitation tokens are secrets and never
 *                        travel through SQL files.
 *
 * SOURCE: the LIVE legacy schema, read through the Supabase
 * Management API (SUPABASE_ACCESS_TOKEN + project ref from
 * SUPABASE_URL in .env). The script reads ONLY the six master-data
 * tables listed in loadLegacy().
 *
 * Re-running is safe: every write is an upsert / create-if-absent,
 * established user accounts (password set, or roles beyond a shell)
 * are never touched, and the summary reports created vs skipped.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Prisma, PrismaClient } from "@prisma/client";

import { normalizePhone } from "@/lib/bookings/phone";
import { COMPANY_ACCOUNTS } from "@/lib/finance/domain";
import {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  type RoleCode,
} from "@/lib/permissions/catalog";
import { STANDARD_ZONES, defaultOperatingHours } from "@/lib/warehouses/codes";

// ---------------------------------------------------------------------------
// Env bootstrap (.env first for the Supabase token, then .env.local
// for DATABASE_URL; process env always wins).
// ---------------------------------------------------------------------------
function loadEnvFile(path: string): void {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2]!.trim().replace(/^["']|["']$/g, "");
    }
  }
}
loadEnvFile(join(__dirname, "..", ".env"));
loadEnvFile(join(__dirname, "..", ".env.local"));

// ---------------------------------------------------------------------------
// Legacy source rows (public schema, read via the Management API)
// ---------------------------------------------------------------------------
interface LegacyWarehouse {
  id: string;
  code: string;
  name: string;
  address: string;
  city: string;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  is_active: boolean;
}
interface LegacyUser {
  id: string;
  email: string;
  full_name: string;
  phone: string | null;
  role: string;
  is_active: boolean;
}
interface LegacyDriver {
  id: string;
  user_id: string;
  warehouse_id: string;
  vehicle_id: string | null;
  name: string;
  phone: string | null;
  license_number: string;
  is_available: boolean;
}
interface LegacyVehicle {
  id: string;
  warehouse_id: string;
  registration: string;
  type: string;
  capacity_kg: string | null;
  is_active: boolean;
  status: string | null;
}
interface LegacyMembership {
  user_id: string;
  warehouse_id: string;
  role_purpose: string;
  is_active: boolean;
  revoked_at: string | null;
}
interface LegacyCustomer {
  id: string;
  user_id: string | null;
  name: string;
  email: string | null;
  phone: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
}

async function mgmtQuery<T>(sql: string): Promise<T[]> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  const url = process.env.SUPABASE_URL;
  if (!token || !url) {
    throw new Error("SUPABASE_ACCESS_TOKEN and SUPABASE_URL must be set (repo .env) to read the live legacy schema");
  }
  const ref = new URL(url).hostname.split(".")[0];
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    throw new Error(`Management API query failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as T[];
}

interface LegacyData {
  warehouses: LegacyWarehouse[];
  users: LegacyUser[];
  drivers: LegacyDriver[];
  vehicles: LegacyVehicle[];
  memberships: LegacyMembership[];
  customers: LegacyCustomer[];
}

async function loadLegacy(): Promise<LegacyData> {
  const [warehouses, users, drivers, vehicles, memberships, customers] = await Promise.all([
    mgmtQuery<LegacyWarehouse>(
      `SELECT id, code, name, address, city, postal_code, latitude, longitude, is_active FROM public.warehouses ORDER BY code`,
    ),
    mgmtQuery<LegacyUser>(
      `SELECT id, email, full_name, phone, role, is_active FROM public.users ORDER BY created_at`,
    ),
    mgmtQuery<LegacyDriver>(
      `SELECT id, user_id, warehouse_id, vehicle_id, name, phone, license_number, is_available FROM public.drivers ORDER BY created_at`,
    ),
    mgmtQuery<LegacyVehicle>(
      `SELECT id, warehouse_id, registration, type, capacity_kg, is_active, status FROM public.vehicles ORDER BY created_at`,
    ),
    mgmtQuery<LegacyMembership>(
      `SELECT user_id, warehouse_id, role_purpose, is_active, revoked_at FROM public.warehouse_memberships ORDER BY created_at`,
    ),
    mgmtQuery<LegacyCustomer>(
      `SELECT id, user_id, name, email, phone, address_line1, address_line2, city, state, postal_code, latitude, longitude FROM public.customers ORDER BY created_at`,
    ),
  ]);
  return { warehouses, users, drivers, vehicles, memberships, customers };
}

// ---------------------------------------------------------------------------
// Mapping configuration (mirrors prisma/seed.ts — the seed derived
// these from the same live rows in Phase 2/3; keep the two in sync).
// ---------------------------------------------------------------------------
const WAREHOUSE_BACKFILL: Record<
  string,
  { type: string; district: string; province: string; capacityPackages: number }
> = {
  "WH-KTM-01": { type: "MAIN", district: "Kathmandu", province: "Bagmati", capacityPackages: 5000 },
  "WH-PKR-01": { type: "REGIONAL", district: "Kaski", province: "Gandaki", capacityPackages: 3000 },
  "WH-CHT-01": { type: "REGIONAL", district: "Chitwan", province: "Bagmati", capacityPackages: 2000 },
  "WH-LTP-01": { type: "LOCAL_HUB", district: "Lalitpur", province: "Bagmati", capacityPackages: 1500 },
};

const SERVICE_AREAS: { name: string; warehouseCode: string }[] = [
  { name: "Kathmandu Metro", warehouseCode: "WH-KTM-01" },
  { name: "Pokhara Valley", warehouseCode: "WH-PKR-01" },
  { name: "Chitwan Valley", warehouseCode: "WH-CHT-01" },
  { name: "Lalitpur Metro", warehouseCode: "WH-LTP-01" },
];

const SHIPPING_SERVICES = [
  { code: "STANDARD", name: "Standard Delivery", estimatedDaysMin: 1, estimatedDaysMax: 3 },
  { code: "EXPRESS", name: "Express Delivery", estimatedDaysMin: 1, estimatedDaysMax: 1 },
] as const;

/** Catch-all STANDARD tariff — the seed's configuration values. */
const CATCH_ALL_TARIFF = { baseRatePaisa: BigInt(15000), perKgRatePaisa: BigInt(5000), volumetricDivisor: 5000 };

const SYSTEM_SETTINGS: { key: string; value: unknown; description: string }[] = [
  {
    key: "session.idle_timeout.staff_hours",
    value: 24,
    description: "Session idle timeout (hours) for staff consoles — security doc §2.",
  },
  {
    key: "session.idle_timeout.privileged_hours",
    value: 12,
    description: "Session idle timeout (hours) for privileged roles (SUPER_ADMIN, ADMIN, FINANCE) — security doc §2.",
  },
  {
    key: "auth.mfa_required_for_privileged",
    value: true,
    description:
      "When true, SUPER_ADMIN and ADMIN accounts must enrol in TOTP MFA at first login and pass a TOTP challenge at every login — security doc §2.",
  },
];

/** Legacy role → new role. `dispatcher` has no counterpart in the
 *  new model; dispatch work sits with warehouse staff, so the
 *  account migrates as WAREHOUSE_STAFF (documented in the runbook). */
const LEGACY_ROLE_MAP: Record<string, RoleCode> = {
  admin: "ADMIN",
  warehouse_admin: "WAREHOUSE_ADMIN",
  dispatcher: "WAREHOUSE_STAFF",
  driver: "RIDER",
  customer: "CUSTOMER",
};

const VEHICLE_TYPE_MAP: Record<string, string> = {
  bike: "BIKE",
  car: "CAR",
  van: "VAN",
  truck: "TRUCK",
  pickup: "PICKUP",
};

/** Sentinel licence expiry for migrated drivers (see header). */
const LICENCE_EXPIRY_SENTINEL = new Date("1970-01-01T00:00:00.000Z");
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashInvitationToken(rawToken: string): string {
  // Mirrors src/server/services/invitations.ts (SHA-256 hex).
  return createHash("sha256").update(rawToken).digest("hex");
}

// ---------------------------------------------------------------------------
// Execution (Prisma). Every step is idempotent; `apply=false` performs
// the reads and counts what WOULD be created.
// ---------------------------------------------------------------------------
type Summary = { created: Record<string, number>; skipped: Record<string, number> };
function bump(summary: Summary, bucket: "created" | "skipped", key: string): void {
  summary[bucket][key] = (summary[bucket][key] ?? 0) + 1;
}
function note(summary: Summary, bucket: "created" | "skipped", key: string, label: string): void {
  bump(summary, bucket, key);
  console.log(`  [${bucket === "created" ? "create" : "skip  "}] ${key}: ${label}`);
}

const prisma = new PrismaClient();

async function migrateCatalog(apply: boolean, summary: Summary): Promise<void> {
  console.log("Permission catalog:");
  for (const role of ROLES) {
    const existing = await prisma.role.findUnique({ where: { code: role.code } });
    if (existing) bump(summary, "skipped", "roles");
    else {
      note(summary, "created", "roles", role.code);
      if (apply) {
        await prisma.role.create({
          data: { code: role.code, name: role.name, description: role.description, isSystem: true, isActive: true },
        });
      }
    }
  }
  for (const permission of PERMISSIONS) {
    const existing = await prisma.permission.findUnique({ where: { code: permission.code } });
    if (existing) bump(summary, "skipped", "permissions");
    else {
      bump(summary, "created", "permissions");
      if (apply) {
        await prisma.permission.create({
          data: { code: permission.code, name: permission.name, module: permission.module },
        });
      }
    }
  }
  if (apply) {
    // Convergent grant sync, identical to prisma/seed.ts.
    const roleRows = await prisma.role.findMany();
    const permissionRows = await prisma.permission.findMany();
    const roleIdByCode = new Map(roleRows.map((r) => [r.code, r.id]));
    const permissionIdByCode = new Map(permissionRows.map((p) => [p.code, p.id]));
    for (const role of ROLES) {
      const roleId = roleIdByCode.get(role.code)!;
      const grants = ROLE_PERMISSIONS[role.code].map((code) => ({
        roleId,
        permissionId: permissionIdByCode.get(code)!,
      }));
      await prisma.rolePermission.createMany({ data: grants, skipDuplicates: true });
      await prisma.rolePermission.deleteMany({
        where: { roleId, permissionId: { notIn: grants.map((g) => g.permissionId) } },
      });
    }
  }
  console.log("  grants: converged to the catalog (seed-identical sync)");
}

async function migrateReference(apply: boolean, summary: Summary): Promise<void> {
  console.log("Finance chart of accounts + system settings:");
  for (const account of COMPANY_ACCOUNTS) {
    const existing = await prisma.financialAccount.findUnique({ where: { code: account.code } });
    if (existing) bump(summary, "skipped", "financialAccounts");
    else {
      note(summary, "created", "financialAccounts", account.code);
      if (apply) {
        await prisma.financialAccount.create({
          data: { code: account.code, name: account.name, kind: account.kind, ownerType: "COMPANY" },
        });
      }
    }
  }
  for (const setting of SYSTEM_SETTINGS) {
    const existing = await prisma.systemSetting.findUnique({ where: { key: setting.key } });
    if (existing) bump(summary, "skipped", "systemSettings");
    else {
      note(summary, "created", "systemSettings", setting.key);
      if (apply) {
        await prisma.systemSetting.create({
          data: { key: setting.key, value: setting.value as Prisma.InputJsonValue, description: setting.description },
        });
      }
    }
  }
}

interface WarehouseRef {
  id: string;
  code: string;
  district: string;
  city: string;
  province: string;
}

async function migrateWarehouses(
  legacy: LegacyData,
  apply: boolean,
  summary: Summary,
): Promise<{ byLegacyId: Map<string, WarehouseRef>; byCode: Map<string, WarehouseRef> }> {
  console.log("Warehouses (+ addresses, zones, operating hours):");
  const byLegacyId = new Map<string, WarehouseRef>();
  const byCode = new Map<string, WarehouseRef>();
  for (const lw of legacy.warehouses) {
    const backfill = WAREHOUSE_BACKFILL[lw.code];
    if (!backfill) throw new Error(`No backfill configuration for legacy warehouse ${lw.code} — refusing to guess`);
    let warehouse = await prisma.warehouse.findUnique({ where: { code: lw.code } });
    if (!warehouse) {
      note(summary, "created", "warehouses", `${lw.code} ${lw.name}`);
      if (apply) {
        warehouse = await prisma.warehouse.create({
          data: {
            code: lw.code,
            name: lw.name.trim(),
            type: backfill.type,
            district: backfill.district,
            city: lw.city,
            province: backfill.province,
            capacityPackages: backfill.capacityPackages,
            status: lw.is_active ? "ACTIVE" : "INACTIVE",
          },
        });
      }
    } else {
      bump(summary, "skipped", "warehouses");
    }
    const ref: WarehouseRef = {
      id: warehouse?.id ?? `planned:${lw.code}`,
      code: lw.code,
      district: backfill.district,
      city: lw.city,
      province: backfill.province,
    };
    byLegacyId.set(lw.id, ref);
    byCode.set(lw.code, ref);
    if (!apply && !warehouse) {
      // Dry-run against an empty target: children are all planned.
      bump(summary, "created", "warehouseAddresses");
      for (let i = 0; i < STANDARD_ZONES.length; i++) bump(summary, "created", "warehouseZones");
      for (let i = 0; i < 7; i++) bump(summary, "created", "warehouseHours");
      continue;
    }
    const warehouseId = ref.id;
    const address = await prisma.warehouseAddress.findUnique({
      where: { warehouseId_kind: { warehouseId, kind: "PRIMARY" } },
    });
    if (address) bump(summary, "skipped", "warehouseAddresses");
    else {
      note(summary, "created", "warehouseAddresses", `${lw.code} PRIMARY`);
      if (apply) {
        await prisma.warehouseAddress.create({
          data: {
            warehouseId,
            kind: "PRIMARY",
            addressLine1: lw.address,
            city: lw.city,
            district: backfill.district,
            province: backfill.province,
            postalCode: lw.postal_code,
            latitude: lw.latitude !== null ? new Prisma.Decimal(lw.latitude) : null,
            longitude: lw.longitude !== null ? new Prisma.Decimal(lw.longitude) : null,
          },
        });
      }
    }
    for (const zone of STANDARD_ZONES) {
      const existing = await prisma.warehouseZone.findUnique({
        where: { warehouseId_code: { warehouseId, code: zone.code } },
      });
      if (existing) bump(summary, "skipped", "warehouseZones");
      else {
        bump(summary, "created", "warehouseZones");
        if (apply) {
          await prisma.warehouseZone.create({
            data: { warehouseId, code: zone.code, name: zone.name, kind: zone.kind },
          });
        }
      }
    }
    for (const hours of defaultOperatingHours()) {
      const existing = await prisma.warehouseOperatingHours.findUnique({
        where: { warehouseId_dayOfWeek: { warehouseId, dayOfWeek: hours.dayOfWeek } },
      });
      if (existing) bump(summary, "skipped", "warehouseHours");
      else {
        bump(summary, "created", "warehouseHours");
        if (apply) {
          await prisma.warehouseOperatingHours.create({ data: { warehouseId, ...hours } });
        }
      }
    }
  }
  return { byLegacyId, byCode };
}

async function migrateVehicles(
  legacy: LegacyData,
  warehouses: { byLegacyId: Map<string, WarehouseRef> },
  apply: boolean,
  summary: Summary,
): Promise<Map<string, { id: string; registration: string }>> {
  console.log("Vehicles:");
  const byLegacyId = new Map<string, { id: string; registration: string }>();
  for (const lv of legacy.vehicles) {
    const type = VEHICLE_TYPE_MAP[lv.type.toLowerCase()];
    if (!type) throw new Error(`Unknown legacy vehicle type "${lv.type}" (${lv.registration}) — refusing to guess`);
    const home = warehouses.byLegacyId.get(lv.warehouse_id);
    if (!home) throw new Error(`Vehicle ${lv.registration} references unknown legacy warehouse ${lv.warehouse_id}`);
    let vehicle = await prisma.vehicle.findUnique({ where: { registration: lv.registration } });
    if (!vehicle) {
      note(summary, "created", "vehicles", `${lv.registration} (${type})`);
      if (apply) {
        vehicle = await prisma.vehicle.create({
          data: {
            registration: lv.registration,
            type,
            capacityKg: lv.capacity_kg !== null ? new Prisma.Decimal(lv.capacity_kg) : null,
            homeWarehouseId: home.id,
            status: lv.is_active ? "AVAILABLE" : "OFFLINE",
            inspectionStatus: "VALID",
          },
        });
      }
    } else {
      bump(summary, "skipped", "vehicles");
    }
    byLegacyId.set(lv.id, { id: vehicle?.id ?? `planned:${lv.registration}`, registration: lv.registration });
  }
  return byLegacyId;
}

async function migrateServicesAndAreas(
  warehouses: { byCode: Map<string, WarehouseRef> },
  apply: boolean,
  summary: Summary,
): Promise<{ standardServiceId: string | null }> {
  console.log("Shipping services + service areas:");
  let standardServiceId: string | null = null;
  for (const service of SHIPPING_SERVICES) {
    let row = await prisma.shippingService.findUnique({ where: { code: service.code } });
    if (!row) {
      note(summary, "created", "shippingServices", service.code);
      if (apply) {
        row = await prisma.shippingService.create({
          data: {
            code: service.code,
            name: service.name,
            estimatedDaysMin: service.estimatedDaysMin,
            estimatedDaysMax: service.estimatedDaysMax,
            isActive: true,
          },
        });
      }
    } else {
      bump(summary, "skipped", "shippingServices");
    }
    if (service.code === "STANDARD") standardServiceId = row?.id ?? null;
  }
  for (const def of SERVICE_AREAS) {
    const warehouse = warehouses.byCode.get(def.warehouseCode);
    if (!warehouse) throw new Error(`Service area ${def.name} references unknown warehouse ${def.warehouseCode}`);
    const existing = await prisma.serviceArea.findUnique({
      where: { district_name: { district: warehouse.district, name: def.name } },
    });
    if (existing) bump(summary, "skipped", "serviceAreas");
    else {
      note(summary, "created", "serviceAreas", def.name);
      if (apply) {
        await prisma.serviceArea.create({
          data: {
            name: def.name,
            district: warehouse.district,
            city: warehouse.city,
            province: warehouse.province,
            servingWarehouseId: warehouse.id,
            isActive: true,
          },
        });
      }
    }
  }
  return { standardServiceId };
}

async function migrateCustomers(
  legacy: LegacyData,
  apply: boolean,
  summary: Summary,
): Promise<Map<string, { id: string }>> {
  console.log("Customers:");
  const byLegacyId = new Map<string, { id: string }>();
  for (const lc of legacy.customers) {
    const normalized = normalizePhone(lc.phone);
    let customer = await prisma.customer.findUnique({ where: { normalizedPhone: normalized } });
    if (!customer) {
      note(summary, "created", "customers", lc.name.trim());
      if (apply) {
        customer = await prisma.customer.create({
          data: {
            fullName: lc.name.trim(),
            phone: lc.phone,
            normalizedPhone: normalized,
            email: lc.email,
          },
        });
      }
    } else {
      bump(summary, "skipped", "customers");
    }
    const customerId = customer?.id ?? `planned:${normalized}`;
    byLegacyId.set(lc.id, { id: customerId });
    if (lc.address_line1 && lc.city) {
      const existingAddress = customer
        ? await prisma.customerAddress.findFirst({ where: { customerId, kind: "DELIVERY" } })
        : null;
      if (existingAddress) bump(summary, "skipped", "customerAddresses");
      else {
        note(summary, "created", "customerAddresses", `${lc.name.trim()} DELIVERY`);
        if (apply) {
          await prisma.customerAddress.create({
            data: {
              customerId,
              kind: "DELIVERY",
              addressLine1: lc.address_line1,
              addressLine2: lc.address_line2,
              city: lc.city,
              // Legacy has no district column; the city IS the
              // district for the one migrated customer (Lalitpur).
              district: lc.city,
              province: lc.state ?? "",
              postalCode: lc.postal_code,
              latitude: lc.latitude !== null ? new Prisma.Decimal(lc.latitude) : null,
              longitude: lc.longitude !== null ? new Prisma.Decimal(lc.longitude) : null,
              isDefault: true,
            },
          });
        }
      }
    }
  }
  return byLegacyId;
}

// ---------------------------------------------------------------------------
// Users mode (--with-users): shells + invitations + memberships +
// driver profiles + links + the tariff. See the header for the
// safety rules; established accounts are never touched.
// ---------------------------------------------------------------------------
interface UsersContext {
  warehouses: { byLegacyId: Map<string, WarehouseRef> };
  vehicles: Map<string, { id: string; registration: string }>;
  customers: Map<string, { id: string }>;
  standardServiceId: string | null;
}

async function migrateUsers(
  legacy: LegacyData,
  ctx: UsersContext,
  opts: { apply: boolean; superAdminEmail: string; printTokens: boolean },
  summary: Summary,
): Promise<void> {
  console.log("Users (shells + invitations), memberships, drivers:");
  const designee = legacy.users.find(
    (u) => u.email.trim().toLowerCase() === opts.superAdminEmail,
  );
  if (!designee) {
    throw new Error(
      `--super-admin-email ${opts.superAdminEmail} is not one of the legacy accounts — the designation must name a migrated account`,
    );
  }
  const roleIdByCode = new Map<string, string>();
  for (const role of await prisma.role.findMany()) roleIdByCode.set(role.code, role.id);

  const legacyUserById = new Map(legacy.users.map((u) => [u.id, u]));
  const shellIdByLegacyUserId = new Map<string, string>();
  const established = new Set<string>();

  // Shells first — the designee first of all (their row is the
  // invitedBy actor for every invitation).
  const ordered = [designee, ...legacy.users.filter((u) => u.id !== designee.id)];
  for (const lu of ordered) {
    const email = lu.email.trim().toLowerCase();
    const mapped = LEGACY_ROLE_MAP[lu.role];
    if (!mapped) throw new Error(`Unknown legacy role "${lu.role}" for ${email} — refusing to guess`);
    const existing = await prisma.user.findUnique({
      where: { email },
      include: { roles: { select: { roleId: true } } },
    });
    if (existing && (existing.passwordHash !== null || existing.roles.length > 0)) {
      // P2-2 principle: an established account is never reset,
      // re-roled or re-invited by a migration.
      console.log(`  [skip  ] users: ${email} — established account, untouched`);
      bump(summary, "skipped", "users");
      established.add(lu.id);
      continue;
    }
    if (existing) {
      bump(summary, "skipped", "users");
      shellIdByLegacyUserId.set(lu.id, existing.id);
      continue;
    }
    note(summary, "created", "users", `${email} (shell, invites as ${lu.id === designee.id ? "SUPER_ADMIN" : mapped})`);
    if (opts.apply) {
      const created = await prisma.user.create({
        data: {
          email,
          fullName: lu.full_name.trim(),
          phone: lu.phone,
          passwordHash: null,
          status: "ACTIVE",
        },
      });
      shellIdByLegacyUserId.set(lu.id, created.id);
    } else {
      shellIdByLegacyUserId.set(lu.id, `planned:${email}`);
    }
  }

  const saShellId = shellIdByLegacyUserId.get(designee.id);
  if (!saShellId) {
    throw new Error("The designated Super Admin account was skipped as established — resolve that account manually before running users mode");
  }

  // Invitations (role arrives at acceptance; shells hold no roles).
  const tokens: { email: string; token: string }[] = [];
  for (const lu of legacy.users) {
    if (established.has(lu.id)) continue;
    const email = lu.email.trim().toLowerCase();
    const roleCode: RoleCode = lu.id === designee.id ? "SUPER_ADMIN" : LEGACY_ROLE_MAP[lu.role]!;
    const pending = await prisma.userInvitation.findFirst({
      where: { email, status: "PENDING", expiresAt: { gt: new Date() } },
    });
    if (pending) {
      bump(summary, "skipped", "invitations");
      continue;
    }
    note(summary, "created", "invitations", `${email} → ${roleCode}`);
    if (opts.apply) {
      const roleId = roleIdByCode.get(roleCode);
      if (!roleId) throw new Error(`Role ${roleCode} missing in target — run the catalog step first`);
      const token = randomBytes(32).toString("hex");
      await prisma.userInvitation.create({
        data: {
          email,
          roleId,
          tokenHash: hashInvitationToken(token),
          invitedById: saShellId,
          expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
          status: "PENDING",
        },
      });
      tokens.push({ email, token });
    }
  }

  // Memberships (direct from the legacy rows).
  for (const lm of legacy.memberships) {
    if (!lm.is_active || lm.revoked_at) {
      bump(summary, "skipped", "memberships");
      continue;
    }
    const userId = shellIdByLegacyUserId.get(lm.user_id);
    const warehouse = ctx.warehouses.byLegacyId.get(lm.warehouse_id);
    if (!userId || !warehouse) {
      console.log("  [skip  ] memberships: legacy row references a skipped user or unknown warehouse");
      bump(summary, "skipped", "memberships");
      continue;
    }
    const roleCode: RoleCode =
      lm.role_purpose === "admin"
        ? "WAREHOUSE_ADMIN"
        : lm.role_purpose === "driver_home"
          ? "RIDER"
          : LEGACY_ROLE_MAP[legacyUserById.get(lm.user_id)?.role ?? ""] ?? "WAREHOUSE_STAFF";
    const existingMembership = await prisma.warehouseMembership.findFirst({
      where: { userId, warehouseId: warehouse.id, revokedAt: null },
    });
    if (existingMembership) {
      bump(summary, "skipped", "memberships");
      continue;
    }
    note(summary, "created", "memberships", `${legacyUserById.get(lm.user_id)?.email} @ ${warehouse.code} (${roleCode})`);
    if (opts.apply) {
      const roleId = roleIdByCode.get(roleCode);
      if (!roleId) throw new Error(`Role ${roleCode} missing in target`);
      const primaryCount = await prisma.warehouseMembership.count({
        where: { userId, revokedAt: null },
      });
      await prisma.warehouseMembership.create({
        data: {
          userId,
          warehouseId: warehouse.id,
          roleId,
          isPrimary: primaryCount === 0,
          assignedById: saShellId,
        },
      });
    }
  }

  // Driver profiles + vehicle default drivers.
  const driverIdByLegacyDriverId = new Map<string, string>();
  for (const ld of legacy.drivers) {
    const userId = shellIdByLegacyUserId.get(ld.user_id);
    const home = ctx.warehouses.byLegacyId.get(ld.warehouse_id);
    if (!userId || !home) {
      console.log(`  [skip  ] drivers: ${ld.name} — user or warehouse not migrated`);
      bump(summary, "skipped", "drivers");
      continue;
    }
    const existing = await prisma.driver.findUnique({ where: { userId } });
    if (existing) {
      bump(summary, "skipped", "drivers");
      driverIdByLegacyDriverId.set(ld.id, existing.id);
      continue;
    }
    note(summary, "created", "drivers", `${ld.name} (home ${home.code}, licence expiry = SENTINEL 1970-01-01)`);
    if (opts.apply) {
      const created = await prisma.driver.create({
        data: {
          userId,
          homeWarehouseId: home.id,
          licenseNumber: ld.license_number,
          licenseExpiry: LICENCE_EXPIRY_SENTINEL,
          employmentStatus: "ACTIVE",
          availabilityStatus: ld.is_available ? "AVAILABLE" : "OFF_DUTY",
          capabilities: { create: [{ capability: "PICKUP" }, { capability: "DELIVERY" }] },
        },
      });
      driverIdByLegacyDriverId.set(ld.id, created.id);
    }
  }
  if (opts.apply) {
    for (const ld of legacy.drivers) {
      if (!ld.vehicle_id) continue;
      const driverId = driverIdByLegacyDriverId.get(ld.id);
      const vehicle = ctx.vehicles.get(ld.vehicle_id);
      if (!driverId || !vehicle) continue;
      await prisma.vehicle.updateMany({
        where: { id: vehicle.id, assignedDriverId: null },
        data: { assignedDriverId: driverId },
      });
    }
  }

  // Customer account link.
  for (const lc of legacy.customers) {
    if (!lc.user_id) continue;
    const customer = ctx.customers.get(lc.id);
    const userId = shellIdByLegacyUserId.get(lc.user_id);
    if (!customer || !userId) continue;
    const row = await prisma.customer.findUnique({ where: { id: customer.id }, select: { userId: true } });
    if (row?.userId) {
      bump(summary, "skipped", "customerLinks");
      continue;
    }
    note(summary, "created", "customerLinks", `${lc.name.trim()} → account`);
    if (opts.apply) {
      await prisma.customer.update({ where: { id: customer.id }, data: { userId } });
    }
  }

  // Catch-all tariff (needs a creator — the designated Super Admin).
  if (ctx.standardServiceId) {
    const existingRule = await prisma.pricingRule.findFirst({
      where: {
        shippingServiceId: ctx.standardServiceId,
        originServiceAreaId: null,
        destinationServiceAreaId: null,
        isActive: true,
      },
    });
    if (existingRule) bump(summary, "skipped", "pricingRules");
    else {
      note(summary, "created", "pricingRules", "STANDARD catch-all (seed tariff)");
      if (opts.apply) {
        await prisma.pricingRule.create({
          data: {
            shippingServiceId: ctx.standardServiceId,
            baseRatePaisa: CATCH_ALL_TARIFF.baseRatePaisa,
            perKgRatePaisa: CATCH_ALL_TARIFF.perKgRatePaisa,
            volumetricDivisor: CATCH_ALL_TARIFF.volumetricDivisor,
            createdById: saShellId,
          },
        });
      }
    }
  }

  if (opts.apply) {
    await prisma.auditLog.create({
      data: {
        actorId: saShellId,
        actorRole: "SUPER_ADMIN",
        action: "migration.live_master_data",
        entityType: "Migration",
        entityId: null,
        after: { created: summary.created, skipped: summary.skipped },
      },
    });
  }
  if (tokens.length > 0) {
    if (opts.printTokens) {
      console.log("\nInvitation tokens (distribute over a secure channel; shown once):");
      for (const t of tokens) console.log(`  ${t.email}\t${t.token}`);
    } else {
      console.log(`\n${tokens.length} invitation(s) created. Re-run with --print-tokens at creation time to see the raw tokens, or re-issue from the Users module.`);
    }
  }
}

// ---------------------------------------------------------------------------
// SQL renderer (--sql-out): the NON-USER plan as idempotent SQL for
// the Management-API / SQL-Editor route. All cross-references resolve
// by natural-key subselects, so statements are order-safe within the
// transaction. Grants are additive here (ON CONFLICT DO NOTHING);
// the convergent delete-stale step runs only in the Prisma route.
// ---------------------------------------------------------------------------
function esc(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
function num(value: number | string | null): string {
  return value === null ? "NULL" : String(value);
}

function renderSql(legacy: LegacyData): string {
  const out: string[] = [
    "-- BLA live master-data migration (non-user parts) — generated by",
    "-- scripts/migrate-live-master-data.ts --sql-out. Idempotent: safe",
    "-- to run more than once. Apply inside the app schema.",
    "SET search_path TO app, public;",
    "BEGIN;",
    "",
    "-- Permission catalog ------------------------------------------------",
  ];
  for (const role of ROLES) {
    out.push(
      `INSERT INTO "Role" ("id","code","name","description","isSystem","isActive","createdAt","updatedAt") VALUES (gen_random_uuid(), ${esc(role.code)}, ${esc(role.name)}, ${role.description ? esc(role.description) : "NULL"}, true, true, now(), now()) ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "description" = EXCLUDED."description", "isSystem" = true, "isActive" = true, "updatedAt" = now();`,
    );
  }
  for (const permission of PERMISSIONS) {
    out.push(
      `INSERT INTO "Permission" ("id","code","name","module","createdAt","updatedAt") VALUES (gen_random_uuid(), ${esc(permission.code)}, ${esc(permission.name)}, ${esc(permission.module)}, now(), now()) ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "module" = EXCLUDED."module", "updatedAt" = now();`,
    );
  }
  for (const role of ROLES) {
    for (const code of ROLE_PERMISSIONS[role.code]) {
      out.push(
        `INSERT INTO "RolePermission" ("id","roleId","permissionId") VALUES (gen_random_uuid(), (SELECT "id" FROM "Role" WHERE "code" = ${esc(role.code)}), (SELECT "id" FROM "Permission" WHERE "code" = ${esc(code)})) ON CONFLICT ("roleId","permissionId") DO NOTHING;`,
      );
    }
  }
  out.push("", "-- Chart of accounts + system settings ------------------------------");
  for (const account of COMPANY_ACCOUNTS) {
    out.push(
      `INSERT INTO "FinancialAccount" ("id","code","name","kind","ownerType","currency","isActive","createdAt","updatedAt") VALUES (gen_random_uuid(), ${esc(account.code)}, ${esc(account.name)}, ${esc(account.kind)}, 'COMPANY', 'NPR', true, now(), now()) ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "kind" = EXCLUDED."kind", "updatedAt" = now();`,
    );
  }
  for (const setting of SYSTEM_SETTINGS) {
    out.push(
      `INSERT INTO "SystemSetting" ("key","value","description","createdAt","updatedAt") VALUES (${esc(setting.key)}, ${esc(JSON.stringify(setting.value))}::jsonb, ${esc(setting.description)}, now(), now()) ON CONFLICT ("key") DO NOTHING;`,
    );
  }
  out.push("", "-- Warehouses ---------------------------------------------------------");
  const warehouseCodeByLegacyId = new Map(legacy.warehouses.map((w) => [w.id, w.code]));
  for (const lw of legacy.warehouses) {
    const backfill = WAREHOUSE_BACKFILL[lw.code];
    if (!backfill) throw new Error(`No backfill configuration for legacy warehouse ${lw.code}`);
    const wh = `(SELECT "id" FROM "Warehouse" WHERE "code" = ${esc(lw.code)})`;
    out.push(
      `INSERT INTO "Warehouse" ("id","code","name","type","district","city","province","country","capacityPackages","status","createdAt","updatedAt") VALUES (gen_random_uuid(), ${esc(lw.code)}, ${esc(lw.name.trim())}, ${esc(backfill.type)}, ${esc(backfill.district)}, ${esc(lw.city)}, ${esc(backfill.province)}, 'NP', ${backfill.capacityPackages}, ${lw.is_active ? "'ACTIVE'" : "'INACTIVE'"}, now(), now()) ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "type" = EXCLUDED."type", "district" = EXCLUDED."district", "city" = EXCLUDED."city", "province" = EXCLUDED."province", "capacityPackages" = EXCLUDED."capacityPackages", "updatedAt" = now();`,
      `INSERT INTO "WarehouseAddress" ("id","warehouseId","kind","addressLine1","city","district","province","postalCode","latitude","longitude","createdAt","updatedAt") VALUES (gen_random_uuid(), ${wh}, 'PRIMARY', ${esc(lw.address)}, ${esc(lw.city)}, ${esc(backfill.district)}, ${esc(backfill.province)}, ${lw.postal_code ? esc(lw.postal_code) : "NULL"}, ${num(lw.latitude)}, ${num(lw.longitude)}, now(), now()) ON CONFLICT ("warehouseId","kind") DO UPDATE SET "addressLine1" = EXCLUDED."addressLine1", "city" = EXCLUDED."city", "district" = EXCLUDED."district", "province" = EXCLUDED."province", "postalCode" = EXCLUDED."postalCode", "latitude" = EXCLUDED."latitude", "longitude" = EXCLUDED."longitude", "updatedAt" = now();`,
    );
    for (const zone of STANDARD_ZONES) {
      out.push(
        `INSERT INTO "WarehouseZone" ("id","warehouseId","code","name","kind","isActive","createdAt","updatedAt") VALUES (gen_random_uuid(), ${wh}, ${esc(zone.code)}, ${esc(zone.name)}, ${esc(zone.kind)}, true, now(), now()) ON CONFLICT ("warehouseId","code") DO UPDATE SET "name" = EXCLUDED."name", "kind" = EXCLUDED."kind", "updatedAt" = now();`,
      );
    }
    for (const hours of defaultOperatingHours()) {
      out.push(
        `INSERT INTO "WarehouseOperatingHours" ("id","warehouseId","dayOfWeek","opensAt","closesAt","isClosed") VALUES (gen_random_uuid(), ${wh}, ${hours.dayOfWeek}, ${num(hours.opensAt)}, ${num(hours.closesAt)}, ${hours.isClosed}) ON CONFLICT ("warehouseId","dayOfWeek") DO UPDATE SET "opensAt" = EXCLUDED."opensAt", "closesAt" = EXCLUDED."closesAt", "isClosed" = EXCLUDED."isClosed";`,
      );
    }
  }
  out.push("", "-- Vehicles ------------------------------------------------------------");
  for (const lv of legacy.vehicles) {
    const type = VEHICLE_TYPE_MAP[lv.type.toLowerCase()];
    if (!type) throw new Error(`Unknown legacy vehicle type "${lv.type}" (${lv.registration})`);
    const homeCode = warehouseCodeByLegacyId.get(lv.warehouse_id);
    if (!homeCode) throw new Error(`Vehicle ${lv.registration} references unknown legacy warehouse`);
    out.push(
      `INSERT INTO "Vehicle" ("id","registration","type","capacityKg","homeWarehouseId","status","inspectionStatus","createdAt","updatedAt") VALUES (gen_random_uuid(), ${esc(lv.registration)}, ${esc(type)}, ${num(lv.capacity_kg)}, (SELECT "id" FROM "Warehouse" WHERE "code" = ${esc(homeCode)}), ${lv.is_active ? "'AVAILABLE'" : "'OFFLINE'"}, 'VALID', now(), now()) ON CONFLICT ("registration") DO UPDATE SET "type" = EXCLUDED."type", "capacityKg" = EXCLUDED."capacityKg", "homeWarehouseId" = EXCLUDED."homeWarehouseId", "updatedAt" = now();`,
    );
  }
  out.push("", "-- Shipping services + service areas -----------------------------------");
  for (const service of SHIPPING_SERVICES) {
    out.push(
      `INSERT INTO "ShippingService" ("id","code","name","estimatedDaysMin","estimatedDaysMax","isActive","createdAt","updatedAt") VALUES (gen_random_uuid(), ${esc(service.code)}, ${esc(service.name)}, ${service.estimatedDaysMin}, ${service.estimatedDaysMax}, true, now(), now()) ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name", "estimatedDaysMin" = EXCLUDED."estimatedDaysMin", "estimatedDaysMax" = EXCLUDED."estimatedDaysMax", "isActive" = true, "updatedAt" = now();`,
    );
  }
  for (const def of SERVICE_AREAS) {
    const backfill = WAREHOUSE_BACKFILL[def.warehouseCode];
    if (!backfill) throw new Error(`Service area ${def.name} references unknown warehouse ${def.warehouseCode}`);
    const city = legacy.warehouses.find((w) => w.code === def.warehouseCode)?.city ?? "";
    out.push(
      `INSERT INTO "ServiceArea" ("id","name","district","city","province","servingWarehouseId","isActive","createdAt","updatedAt") VALUES (gen_random_uuid(), ${esc(def.name)}, ${esc(backfill.district)}, ${esc(city)}, ${esc(backfill.province)}, (SELECT "id" FROM "Warehouse" WHERE "code" = ${esc(def.warehouseCode)}), true, now(), now()) ON CONFLICT ("district","name") DO UPDATE SET "servingWarehouseId" = EXCLUDED."servingWarehouseId", "isActive" = true, "updatedAt" = now();`,
    );
  }
  out.push("", "-- Customers (create-only; never overwrite a customer record) ----------");
  for (const lc of legacy.customers) {
    const normalized = normalizePhone(lc.phone);
    out.push(
      `INSERT INTO "Customer" ("id","fullName","phone","normalizedPhone","email","isMerged","createdAt","updatedAt") VALUES (gen_random_uuid(), ${esc(lc.name.trim())}, ${esc(lc.phone)}, ${esc(normalized)}, ${lc.email ? esc(lc.email) : "NULL"}, false, now(), now()) ON CONFLICT ("normalizedPhone") DO NOTHING;`,
    );
    if (lc.address_line1 && lc.city) {
      out.push(
        `INSERT INTO "CustomerAddress" ("id","customerId","kind","addressLine1","addressLine2","city","district","province","postalCode","latitude","longitude","isDefault","createdAt","updatedAt") SELECT gen_random_uuid(), c."id", 'DELIVERY', ${esc(lc.address_line1)}, ${lc.address_line2 ? esc(lc.address_line2) : "NULL"}, ${esc(lc.city)}, ${esc(lc.city)}, ${esc(lc.state ?? "")}, ${lc.postal_code ? esc(lc.postal_code) : "NULL"}, ${num(lc.latitude)}, ${num(lc.longitude)}, true, now(), now() FROM "Customer" c WHERE c."normalizedPhone" = ${esc(normalized)} AND NOT EXISTS (SELECT 1 FROM "CustomerAddress" a WHERE a."customerId" = c."id" AND a."kind" = 'DELIVERY');`,
      );
    }
  }
  out.push("", "COMMIT;", "");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const withUsers = args.includes("--with-users");
  const printTokens = args.includes("--print-tokens");
  const sqlOutIdx = args.indexOf("--sql-out");
  const sqlOut = sqlOutIdx >= 0 ? args[sqlOutIdx + 1]! : null;
  const saIdx = args.indexOf("--super-admin-email");
  const superAdminEmail = saIdx >= 0 ? args[saIdx + 1]!.trim().toLowerCase() : null;

  if (sqlOut && withUsers) {
    throw new Error("--sql-out cannot be combined with --with-users (invitation tokens never travel through SQL files)");
  }
  if (sqlOut && apply) {
    throw new Error("Choose one execution route: --apply (Prisma) or --sql-out (SQL file)");
  }
  if (withUsers && !superAdminEmail) {
    throw new Error("--with-users requires --super-admin-email <address> — the first Super Admin is designated explicitly, never inferred");
  }

  console.log("Reading live legacy master data via the Management API…");
  const legacy = await loadLegacy();
  console.log(
    `Legacy: ${legacy.warehouses.length} warehouses, ${legacy.users.length} users, ` +
      `${legacy.drivers.length} drivers, ${legacy.vehicles.length} vehicles, ` +
      `${legacy.memberships.length} memberships, ${legacy.customers.length} customers.`,
  );

  if (sqlOut) {
    const sql = renderSql(legacy);
    writeFileSync(sqlOut, sql);
    console.log(`Non-user plan rendered to ${sqlOut} (${sql.split("\n").filter((l) => l.startsWith("INSERT")).length} INSERT statements).`);
    console.log("Apply it through the Supabase SQL Editor or the Management API, then verify counts (runbook: docs/deployment-guide.md §4).");
    return;
  }

  const summary: Summary = { created: {}, skipped: {} };
  await migrateCatalog(apply, summary);
  await migrateReference(apply, summary);
  const warehouses = await migrateWarehouses(legacy, apply, summary);
  const vehicles = await migrateVehicles(legacy, warehouses, apply, summary);
  const { standardServiceId } = await migrateServicesAndAreas(warehouses, apply, summary);
  const customers = await migrateCustomers(legacy, apply, summary);

  if (withUsers) {
    await migrateUsers(
      legacy,
      { warehouses, vehicles, customers, standardServiceId },
      { apply, superAdminEmail: superAdminEmail!, printTokens },
      summary,
    );
  } else {
    console.log(
      "\nUsers mode NOT run (default): memberships, driver profiles, the customer account link and the PricingRule tariff wait for --with-users with a designated --super-admin-email.",
    );
  }

  console.log(`\n=== ${apply ? "APPLIED" : "DRY-RUN (nothing written)"} ===`);
  console.log(`Created: ${JSON.stringify(summary.created)}`);
  console.log(`Skipped (already present / untouched): ${JSON.stringify(summary.skipped)}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
