import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  hasPermission,
  requirePermission,
  type ActorContext,
} from "@/lib/auth/actor";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import type { RoleCode } from "@/lib/permissions/catalog";
import {
  STANDARD_ZONES,
  WAREHOUSE_CODE_PATTERN,
  WAREHOUSE_TYPES,
  ZONE_KINDS,
  buildStorageFullCode,
  defaultOperatingHours,
  normalizeSegment,
  standardZoneCodeForKind,
  type WarehouseStatus,
} from "@/lib/warehouses/codes";

/**
 * WarehouseService (docs/warehouse-workflow.md, docs/database-schema.md §2,
 * docs/role-permission-matrix.md §4.1, docs/security-architecture.md §3.3).
 *
 * Every function takes the ActorContext first and checks its permission as
 * the first statement. Warehouse-scoped actors (no `warehouse.read_all`)
 * are confined to their active memberships: the scope is applied INSIDE
 * every query, a client-supplied warehouse id is never trusted, and every
 * denial — missing permission or out-of-scope warehouse — writes an
 * `access.denied` AuditLog row (security doc §3.4) before throwing.
 */

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface WarehouseAddressView {
  addressLine1: string;
  addressLine2: string | null;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
}

export interface WarehouseHoursView {
  dayOfWeek: number;
  opensAt: number | null;
  closesAt: number | null;
  isClosed: boolean;
}

export interface WarehouseView {
  id: string;
  code: string;
  name: string;
  type: string;
  district: string;
  city: string;
  province: string;
  country: string;
  contactPhone: string | null;
  email: string | null;
  managerUserId: string | null;
  capacityPackages: number | null;
  capacityWeightKg: string | null;
  status: string;
  address: WarehouseAddressView | null;
  hours: WarehouseHoursView[];
  memberCount: number;
  zoneCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WarehouseMemberView {
  membershipId: string;
  userId: string;
  email: string;
  fullName: string;
  userStatus: string;
  roleCode: string;
  isPrimary: boolean;
  assignedAt: string;
}

export interface StorageLocationView {
  id: string;
  rack: string;
  shelf: string | null;
  bin: string | null;
  fullCode: string;
  capacityPackages: number | null;
  isActive: boolean;
}

export interface WarehouseZoneView {
  id: string;
  warehouseId: string;
  code: string;
  name: string;
  kind: string;
  capacityPackages: number | null;
  isActive: boolean;
  locations: StorageLocationView[];
}

// ---------------------------------------------------------------------------
// Denial auditing + scope guards (security doc §3.4)
// ---------------------------------------------------------------------------

async function auditDenied(
  actor: ActorContext,
  attempted: { warehouseId?: string | null; entityId?: string | null; reason: string },
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "access.denied",
      entityType: "Warehouse",
      entityId: attempted.entityId ?? attempted.warehouseId ?? null,
      warehouseId: attempted.warehouseId ?? null,
      after: { reason: attempted.reason },
    },
  });
}

/** requirePermission + an audit row when the permission is missing. */
async function requirePermAudited(
  actor: ActorContext,
  permission: string,
  warehouseId?: string | null,
): Promise<void> {
  try {
    requirePermission(actor, permission);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      await auditDenied(actor, {
        warehouseId: warehouseId ?? null,
        reason: `missing_permission:${permission}`,
      });
    }
    throw error;
  }
}

/** True when the actor may see every warehouse (SA/AD/finance/support). */
function isUnscoped(actor: ActorContext): boolean {
  return hasPermission(actor, "warehouse.read_all");
}

/**
 * Assert the warehouse is inside the actor's scope. Unscoped actors pass;
 * scoped actors must hold an active membership. Denials are audited and
 * thrown as 403 (the warehouse directory itself is not secret; its
 * internals are scope-protected — security doc §3.4).
 */
async function assertWarehouseInScope(
  actor: ActorContext,
  warehouseId: string,
): Promise<void> {
  if (isUnscoped(actor)) return;
  if (actor.warehouseIds.includes(warehouseId)) return;
  await auditDenied(actor, { warehouseId, reason: "warehouse_out_of_scope" });
  throw new AuthorizationError("Warehouse is outside your assigned scope");
}

/**
 * Scoped actors may only mutate an ACTIVE warehouse. Setup of a
 * not-yet-active (or deactivated) warehouse is done by Admin/Super Admin;
 * a deactivated warehouse therefore rejects its own admin's operations
 * until it is reactivated (docs/warehouse-workflow.md §2, §6). The denial
 * is audit-logged like every other scoped denial (§3.4, review P2-8).
 */
async function assertScopedMutationAllowed(
  actor: ActorContext,
  warehouse: { id: string; status: string },
): Promise<void> {
  if (isUnscoped(actor)) return;
  if (warehouse.status !== "ACTIVE") {
    await auditDenied(actor, {
      warehouseId: warehouse.id,
      reason: "warehouse_not_active",
    });
    throw new DomainValidationError(
      "Warehouse is not active — operational changes are read-only until an Admin reactivates it",
    );
  }
}

/** The actor's membership role in one warehouse, or null (P2-4). */
function membershipRoleIn(actor: ActorContext, warehouseId: string): RoleCode | null {
  return (
    actor.membershipRoles.find((m) => m.warehouseId === warehouseId)?.roleCode ?? null
  );
}

/**
 * Scoped MUTATIONS require the actor to be a Warehouse Admin OF THAT
 * warehouse — or an unscoped actor (Phase 2 review P2-4). Membership
 * presence plus a global WA role is not enough: a user who is WA of
 * warehouse A but only staff of warehouse B must not mutate B. Reads
 * stay presence-based (assertWarehouseInScope). Denials are audited.
 */
async function assertScopedAdminMutation(
  actor: ActorContext,
  warehouseId: string,
): Promise<void> {
  if (isUnscoped(actor)) return;
  if (membershipRoleIn(actor, warehouseId) === "WAREHOUSE_ADMIN") return;
  await auditDenied(actor, {
    warehouseId,
    reason: "scoped_mutation_requires_warehouse_admin",
  });
  throw new AuthorizationError(
    "Only a Warehouse Admin of this warehouse can make that change",
  );
}

async function audit(
  actor: ActorContext,
  action: string,
  warehouseId: string,
  after?: Prisma.InputJsonValue,
  before?: Prisma.InputJsonValue,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action,
      entityType: "Warehouse",
      entityId: warehouseId,
      warehouseId,
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Loading + view mapping
// ---------------------------------------------------------------------------

const warehouseInclude = {
  addresses: true,
  hours: { orderBy: { dayOfWeek: "asc" as const } },
  _count: { select: { memberships: { where: { revokedAt: null } }, zones: true } },
};

type WarehouseRow = Prisma.WarehouseGetPayload<{ include: typeof warehouseInclude }>;

function toView(row: WarehouseRow): WarehouseView {
  const primary = row.addresses.find((a) => a.kind === "PRIMARY") ?? row.addresses[0];
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    district: row.district,
    city: row.city,
    province: row.province,
    country: row.country,
    contactPhone: row.contactPhone,
    email: row.email,
    managerUserId: row.managerUserId,
    capacityPackages: row.capacityPackages,
    capacityWeightKg: row.capacityWeightKg ? row.capacityWeightKg.toString() : null,
    status: row.status,
    address: primary
      ? {
          addressLine1: primary.addressLine1,
          addressLine2: primary.addressLine2,
          postalCode: primary.postalCode,
          latitude: primary.latitude ? primary.latitude.toString() : null,
          longitude: primary.longitude ? primary.longitude.toString() : null,
        }
      : null,
    hours: row.hours.map((h) => ({
      dayOfWeek: h.dayOfWeek,
      opensAt: h.opensAt,
      closesAt: h.closesAt,
      isClosed: h.isClosed,
    })),
    memberCount: row._count.memberships,
    zoneCount: row._count.zones,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadWarehouse(id: string): Promise<WarehouseRow> {
  const row = await prisma.warehouse.findUnique({ where: { id }, include: warehouseInclude });
  if (!row) throw new NotFoundError(`Warehouse not found: ${id}`);
  return row;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new DomainValidationError(
      first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input",
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Warehouses: create / read / update / activate / deactivate
// ---------------------------------------------------------------------------

const hoursSchema = z.array(
  z.object({
    dayOfWeek: z.number().int().min(0).max(6),
    opensAt: z.number().int().min(0).max(1439).nullable(),
    closesAt: z.number().int().min(0).max(1439).nullable(),
    isClosed: z.boolean(),
  }),
);

const addressSchema = z.object({
  addressLine1: z.string().min(1).max(200),
  addressLine2: z.string().max(200).optional().nullable(),
  postalCode: z.string().max(12).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
});

export const createWarehouseSchema = z.object({
  code: z
    .string()
    .regex(WAREHOUSE_CODE_PATTERN, "Code must look like WH-KTM-01")
    .describe("Warehouse code"),
  name: z.string().min(2).max(120),
  type: z.enum(WAREHOUSE_TYPES),
  district: z.string().min(1).max(80),
  city: z.string().min(1).max(80),
  province: z.string().min(1).max(80),
  country: z.string().length(2).default("NP"),
  contactPhone: z.string().max(30).optional().nullable(),
  email: z.string().email().optional().nullable(),
  capacityPackages: z.number().int().positive().optional().nullable(),
  capacityWeightKg: z.number().positive().optional().nullable(),
  managerUserId: z.string().uuid().optional().nullable(),
  address: addressSchema,
  hours: hoursSchema.optional(),
});
// z.input: fields with defaults (country) are optional for callers.
export type CreateWarehouseInput = z.input<typeof createWarehouseSchema>;

export async function createWarehouse(
  actor: ActorContext,
  input: CreateWarehouseInput,
): Promise<WarehouseView> {
  await requirePermAudited(actor, "warehouse.create");
  const data = parse(createWarehouseSchema, input);

  const existing = await prisma.warehouse.findUnique({ where: { code: data.code } });
  if (existing) {
    throw new ConflictError(
      `Warehouse code ${data.code} is already used by ${existing.name}`,
    );
  }
  if (data.managerUserId) {
    const manager = await prisma.user.findUnique({ where: { id: data.managerUserId } });
    if (!manager || manager.status !== "ACTIVE") {
      throw new DomainValidationError("Warehouse manager must be an existing active user");
    }
  }

  const hours = data.hours ?? defaultOperatingHours();
  const created = await prisma.$transaction(async (tx) => {
    const warehouse = await tx.warehouse.create({
      data: {
        code: data.code,
        name: data.name,
        type: data.type,
        district: data.district,
        city: data.city,
        province: data.province,
        country: data.country,
        contactPhone: data.contactPhone ?? null,
        email: data.email ?? null,
        capacityPackages: data.capacityPackages ?? null,
        capacityWeightKg:
          data.capacityWeightKg != null ? new Prisma.Decimal(data.capacityWeightKg) : null,
        managerUserId: data.managerUserId ?? null,
        status: "INACTIVE",
        addresses: {
          create: {
            kind: "PRIMARY",
            addressLine1: data.address.addressLine1,
            addressLine2: data.address.addressLine2 ?? null,
            city: data.city,
            district: data.district,
            province: data.province,
            postalCode: data.address.postalCode ?? null,
            latitude:
              data.address.latitude != null ? new Prisma.Decimal(data.address.latitude) : null,
            longitude:
              data.address.longitude != null ? new Prisma.Decimal(data.address.longitude) : null,
          },
        },
        hours: { create: hours },
        zones: {
          create: STANDARD_ZONES.map((z) => ({ code: z.code, name: z.name, kind: z.kind })),
        },
      },
    });
    return warehouse;
  });

  await audit(actor, "warehouse.create", created.id, {
    code: created.code,
    name: created.name,
    district: created.district,
    status: created.status,
  });
  return toView(await loadWarehouse(created.id));
}

export interface ListWarehousesQuery {
  page?: number;
  pageSize?: number;
  status?: string;
  search?: string;
}

export interface ListWarehousesResult {
  items: WarehouseView[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Minimal ACTIVE-warehouse directory for form selects (booking drop-off
 * choices, vendor assignment pickers). Any authenticated actor may read
 * this reference data — it carries no operational detail (name, code,
 * city, district only), unlike the scoped warehouse module reads.
 */
export async function listWarehouseDirectory(): Promise<
  { id: string; code: string; name: string; city: string; district: string }[]
> {
  return prisma.warehouse.findMany({
    where: { status: "ACTIVE" },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, city: true, district: true },
  });
}

export async function listWarehouses(
  actor: ActorContext,
  query: ListWarehousesQuery = {},
): Promise<ListWarehousesResult> {
  if (!hasPermission(actor, "warehouse.read_all") && !hasPermission(actor, "warehouse.read_assigned")) {
    await auditDenied(actor, { reason: "missing_permission:warehouse.read" });
    throw new AuthorizationError("Missing required permission: warehouse.read_all or warehouse.read_assigned");
  }
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));

  // Scope is applied INSIDE the query (security doc §3.3): scoped actors
  // can only ever receive their own memberships' warehouses.
  const where: Prisma.WarehouseWhereInput = {};
  if (!isUnscoped(actor)) {
    where.id = { in: actor.warehouseIds };
  }
  if (query.status) where.status = query.status;
  if (query.search) {
    const term = query.search.trim();
    if (term) {
      where.OR = [
        { name: { contains: term, mode: "insensitive" } },
        { code: { contains: term, mode: "insensitive" } },
        { city: { contains: term, mode: "insensitive" } },
        { district: { contains: term, mode: "insensitive" } },
      ];
    }
  }

  const [total, rows] = await Promise.all([
    prisma.warehouse.count({ where }),
    prisma.warehouse.findMany({
      where,
      include: warehouseInclude,
      orderBy: { code: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  return {
    items: rows.map(toView),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getWarehouse(
  actor: ActorContext,
  warehouseId: string,
): Promise<WarehouseView> {
  if (!hasPermission(actor, "warehouse.read_all") && !hasPermission(actor, "warehouse.read_assigned")) {
    await auditDenied(actor, { warehouseId, reason: "missing_permission:warehouse.read" });
    throw new AuthorizationError("Missing required permission: warehouse.read_all or warehouse.read_assigned");
  }
  const row = await loadWarehouse(warehouseId);
  await assertWarehouseInScope(actor, row.id);
  return toView(row);
}

export const updateWarehouseSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  type: z.enum(WAREHOUSE_TYPES).optional(),
  district: z.string().min(1).max(80).optional(),
  city: z.string().min(1).max(80).optional(),
  province: z.string().min(1).max(80).optional(),
  contactPhone: z.string().max(30).optional().nullable(),
  email: z.string().email().optional().nullable(),
  capacityPackages: z.number().int().positive().optional().nullable(),
  capacityWeightKg: z.number().positive().optional().nullable(),
  managerUserId: z.string().uuid().optional().nullable(),
  address: addressSchema.partial().optional(),
  hours: hoursSchema.optional(),
});
export type UpdateWarehouseInput = z.infer<typeof updateWarehouseSchema>;

/** Fields a warehouse-scoped actor (WA) may edit on their own warehouse:
 *  operational contact + capacity + hours only (workflow §1). District,
 *  name and type change routing/identity — Admin/Super Admin only. */
const SCOPED_EDITABLE_FIELDS = new Set([
  "contactPhone",
  "email",
  "capacityPackages",
  "capacityWeightKg",
  "hours",
]);

export async function updateWarehouse(
  actor: ActorContext,
  warehouseId: string,
  input: UpdateWarehouseInput,
): Promise<WarehouseView> {
  const row = await loadWarehouse(warehouseId);
  await requirePermAudited(actor, "warehouse.update", warehouseId);
  await assertWarehouseInScope(actor, warehouseId);
  const data = parse(updateWarehouseSchema, input);

  if (!isUnscoped(actor)) {
    await assertScopedAdminMutation(actor, warehouseId);
    await assertScopedMutationAllowed(actor, row);
    const forbidden = Object.keys(data).filter(
      (key) => data[key as keyof typeof data] !== undefined && !SCOPED_EDITABLE_FIELDS.has(key),
    );
    if (forbidden.length > 0) {
      await auditDenied(actor, {
        warehouseId,
        reason: `scoped_field_edit:${forbidden.join(",")}`,
      });
      throw new AuthorizationError(
        `Warehouse Admins cannot change: ${forbidden.join(", ")} (Admin/Super Admin only)`,
      );
    }
  }
  if (data.managerUserId) {
    const manager = await prisma.user.findUnique({ where: { id: data.managerUserId } });
    if (!manager || manager.status !== "ACTIVE") {
      throw new DomainValidationError("Warehouse manager must be an existing active user");
    }
  }

  const before = {
    name: row.name,
    type: row.type,
    district: row.district,
    city: row.city,
    province: row.province,
    contactPhone: row.contactPhone,
    email: row.email,
    capacityPackages: row.capacityPackages,
    managerUserId: row.managerUserId,
  };

  await prisma.$transaction(async (tx) => {
    await tx.warehouse.update({
      where: { id: warehouseId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.type !== undefined ? { type: data.type } : {}),
        ...(data.district !== undefined ? { district: data.district } : {}),
        ...(data.city !== undefined ? { city: data.city } : {}),
        ...(data.province !== undefined ? { province: data.province } : {}),
        ...(data.contactPhone !== undefined ? { contactPhone: data.contactPhone } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.capacityPackages !== undefined
          ? { capacityPackages: data.capacityPackages }
          : {}),
        ...(data.capacityWeightKg !== undefined
          ? {
              capacityWeightKg:
                data.capacityWeightKg != null
                  ? new Prisma.Decimal(data.capacityWeightKg)
                  : null,
            }
          : {}),
        ...(data.managerUserId !== undefined ? { managerUserId: data.managerUserId } : {}),
      },
    });
    if (data.address) {
      await tx.warehouseAddress.updateMany({
        where: { warehouseId, kind: "PRIMARY" },
        data: {
          ...(data.address.addressLine1 !== undefined
            ? { addressLine1: data.address.addressLine1 }
            : {}),
          ...(data.address.addressLine2 !== undefined
            ? { addressLine2: data.address.addressLine2 }
            : {}),
          ...(data.address.postalCode !== undefined
            ? { postalCode: data.address.postalCode }
            : {}),
          ...(data.address.latitude !== undefined
            ? {
                latitude:
                  data.address.latitude != null
                    ? new Prisma.Decimal(data.address.latitude)
                    : null,
              }
            : {}),
          ...(data.address.longitude !== undefined
            ? {
                longitude:
                  data.address.longitude != null
                    ? new Prisma.Decimal(data.address.longitude)
                    : null,
              }
            : {}),
        },
      });
    }
    if (data.hours) {
      await tx.warehouseOperatingHours.deleteMany({ where: { warehouseId } });
      await tx.warehouseOperatingHours.createMany({
        data: data.hours.map((h) => ({ warehouseId, ...h })),
      });
    }
  });

  const updated = await loadWarehouse(warehouseId);
  await audit(
    actor,
    "warehouse.update",
    warehouseId,
    {
      name: updated.name,
      type: updated.type,
      district: updated.district,
      city: updated.city,
      province: updated.province,
      contactPhone: updated.contactPhone,
      email: updated.email,
      capacityPackages: updated.capacityPackages,
      managerUserId: updated.managerUserId,
    },
    before,
  );
  return toView(updated);
}

/**
 * Blockers that prevent deactivation (workflow §6). Phase 4 wires the
 * inventory/custody checks the Phase 2 review required: a warehouse
 * still holding parcels — open InventoryRecords or open WAREHOUSE
 * custodies — cannot be deactivated. Transfer and trip checks join
 * here in Phase 5.
 */
export async function collectDeactivationBlockers(
  warehouseId: string,
): Promise<string[]> {
  const [openInventory, openCustodies] = await Promise.all([
    prisma.inventoryRecord.count({ where: { warehouseId, releasedAt: null } }),
    prisma.packageCustody.count({
      where: { warehouseId, custodianType: "WAREHOUSE", endedAt: null },
    }),
  ]);
  const blockers: string[] = [];
  if (openInventory > 0) {
    blockers.push(
      `${openInventory} package(s) still in stock (open inventory records)`,
    );
  }
  if (openCustodies > 0) {
    blockers.push(
      `${openCustodies} package(s) still in this warehouse's custody`,
    );
  }
  return blockers;
}

export async function setWarehouseStatus(
  actor: ActorContext,
  warehouseId: string,
  target: Extract<WarehouseStatus, "ACTIVE" | "INACTIVE">,
  reason?: string,
): Promise<WarehouseView> {
  const row = await loadWarehouse(warehouseId);

  if (target === "ACTIVE") {
    await requirePermAudited(actor, "warehouse.update", warehouseId);
    if (!isUnscoped(actor)) {
      await auditDenied(actor, { warehouseId, reason: "activation_requires_admin" });
      throw new AuthorizationError("Only Admin/Super Admin can activate a warehouse");
    }
    if (row.status === "ACTIVE") {
      throw new DomainValidationError("Warehouse is already active");
    }
    // A warehouse cannot be activated without a Warehouse Admin
    // (workflow §2 step 4, §8).
    const adminMemberships = await prisma.warehouseMembership.count({
      where: {
        warehouseId,
        revokedAt: null,
        role: { code: "WAREHOUSE_ADMIN" },
        user: { status: "ACTIVE" },
      },
    });
    if (adminMemberships === 0) {
      throw new DomainValidationError(
        "Cannot activate: no active Warehouse Admin is assigned to this warehouse",
      );
    }
  } else {
    await requirePermAudited(actor, "warehouse.deactivate", warehouseId);
    if (!isUnscoped(actor)) {
      await auditDenied(actor, { warehouseId, reason: "deactivation_requires_admin" });
      throw new AuthorizationError("Only Admin/Super Admin can deactivate a warehouse");
    }
    if (row.status !== "ACTIVE") {
      throw new DomainValidationError("Only an active warehouse can be deactivated");
    }
    const blockers = await collectDeactivationBlockers(warehouseId);
    if (blockers.length > 0) {
      throw new DomainValidationError(`Cannot deactivate: ${blockers.join("; ")}`);
    }
  }

  await prisma.warehouse.update({ where: { id: warehouseId }, data: { status: target } });
  await audit(actor, target === "ACTIVE" ? "warehouse.activate" : "warehouse.deactivate", warehouseId, {
    status: target,
    ...(reason ? { reason } : {}),
  }, { status: row.status });
  return toView(await loadWarehouse(warehouseId));
}

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

export const assignMemberSchema = z.object({
  email: z.string().email().max(254),
  roleCode: z.enum(["WAREHOUSE_ADMIN", "WAREHOUSE_STAFF"]),
});
export type AssignMemberInput = z.infer<typeof assignMemberSchema>;

export async function listMembers(
  actor: ActorContext,
  warehouseId: string,
): Promise<WarehouseMemberView[]> {
  const row = await loadWarehouse(warehouseId);
  // P2-11: the member roster is operational data — warehouse.read_all
  // (Finance/Support directory access) no longer opens it. Holders of
  // assign_staff or read_assigned only.
  if (
    !hasPermission(actor, "warehouse.assign_staff") &&
    !hasPermission(actor, "warehouse.read_assigned")
  ) {
    await auditDenied(actor, { warehouseId, reason: "missing_permission:members.read" });
    throw new AuthorizationError("Missing required permission to view warehouse members");
  }
  await assertWarehouseInScope(actor, row.id);
  const memberships = await prisma.warehouseMembership.findMany({
    where: { warehouseId, revokedAt: null },
    include: { user: true, role: true },
    orderBy: { assignedAt: "asc" },
  });
  return memberships.map((m) => ({
    membershipId: m.id,
    userId: m.userId,
    email: m.user.email,
    fullName: m.user.fullName,
    userStatus: m.user.status,
    roleCode: m.role.code,
    isPrimary: m.isPrimary,
    assignedAt: m.assignedAt.toISOString(),
  }));
}

export async function assignMember(
  actor: ActorContext,
  warehouseId: string,
  input: AssignMemberInput,
): Promise<WarehouseMemberView> {
  const row = await loadWarehouse(warehouseId);
  await requirePermAudited(actor, "warehouse.assign_staff", warehouseId);
  await assertWarehouseInScope(actor, warehouseId);
  const data = parse(assignMemberSchema, input);

  if (!isUnscoped(actor)) {
    await assertScopedAdminMutation(actor, warehouseId);
    await assertScopedMutationAllowed(actor, row);
    // A Warehouse Admin staffs their own warehouse with staff only —
    // appointing another Warehouse Admin is an Admin decision (§5).
    if (data.roleCode !== "WAREHOUSE_STAFF") {
      await auditDenied(actor, {
        warehouseId,
        reason: "scoped_assign_admin_role",
      });
      throw new AuthorizationError(
        "Warehouse Admins can only assign Warehouse Staff to their own warehouse",
      );
    }
  }

  const email = data.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) throw new NotFoundError(`No user account exists for ${email}`);
  if (user.status !== "ACTIVE") {
    throw new DomainValidationError(`User ${email} is not active and cannot be assigned`);
  }
  const role = await prisma.role.findUnique({ where: { code: data.roleCode } });
  if (!role) throw new DomainValidationError(`Unknown role: ${data.roleCode}`);

  // P2-5: the duplicate check runs INSIDE the transaction, and the
  // partial unique index on active (userId, warehouseId, roleId) is the
  // database backstop — a racing assign surfaces as P2002 and is
  // translated to the same ConflictError.
  let membership;
  try {
    membership = await prisma.$transaction(async (tx) => {
      const existing = await tx.warehouseMembership.findFirst({
        where: { userId: user.id, warehouseId, revokedAt: null },
      });
      if (existing) {
        throw new ConflictError(`${email} is already an active member of this warehouse`);
      }
      const hasAnyMembership = await tx.warehouseMembership.count({
        where: { userId: user.id, revokedAt: null },
      });
      const created = await tx.warehouseMembership.create({
        data: {
          userId: user.id,
          warehouseId,
          roleId: role.id,
          isPrimary: hasAnyMembership === 0,
          assignedById: actor.userId,
        },
      });
      // The membership role is also the user's global role for landing and
      // permission resolution (Phase 1 model: permissions come from
      // UserRole). Grant it if the user does not already hold it.
      await tx.userRole.upsert({
        where: { userId_roleId: { userId: user.id, roleId: role.id } },
        update: {},
        create: { userId: user.id, roleId: role.id, assignedById: actor.userId },
      });
      return created;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ConflictError(`${email} is already an active member of this warehouse`);
    }
    throw error;
  }

  await audit(actor, "warehouse.member_assign", warehouseId, {
    userId: user.id,
    email: user.email,
    roleCode: data.roleCode,
    membershipId: membership.id,
  });
  return {
    membershipId: membership.id,
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    userStatus: user.status,
    roleCode: data.roleCode,
    isPrimary: membership.isPrimary,
    assignedAt: membership.assignedAt.toISOString(),
  };
}

export interface RemoveMemberResult {
  removed: true;
  /** Set when the warehouse is left without an active Warehouse Admin. */
  warning?: string;
}

export async function removeMember(
  actor: ActorContext,
  warehouseId: string,
  membershipId: string,
): Promise<RemoveMemberResult> {
  const row = await loadWarehouse(warehouseId);
  await requirePermAudited(actor, "warehouse.assign_staff", warehouseId);
  await assertWarehouseInScope(actor, warehouseId);

  const membership = await prisma.warehouseMembership.findFirst({
    where: { id: membershipId, warehouseId, revokedAt: null },
    include: { role: true, user: true },
  });
  if (!membership) throw new NotFoundError("Active membership not found");

  if (!isUnscoped(actor)) {
    await assertScopedAdminMutation(actor, warehouseId);
    await assertScopedMutationAllowed(actor, row);
    if (membership.role.code !== "WAREHOUSE_STAFF") {
      await auditDenied(actor, { warehouseId, reason: "scoped_remove_admin_role" });
      throw new AuthorizationError(
        "Warehouse Admins can only remove Warehouse Staff from their own warehouse",
      );
    }
  }

  let warning: string | undefined;
  await prisma.$transaction(async (tx) => {
    // P2-7: serialize concurrent removals for the same user. Without the
    // row lock, two parallel removals could each count the other's
    // still-active membership and both skip the global-role cleanup,
    // stranding a UserRole with no membership behind it.
    await tx.$queryRaw`SELECT "id" FROM "app"."User" WHERE "id" = ${membership.userId} FOR UPDATE`;
    await tx.warehouseMembership.update({
      where: { id: membershipId },
      data: { revokedAt: new Date(), revokedById: actor.userId },
    });
    // If the user holds no other active membership carrying this role,
    // the global role goes too — removal takes effect on the next
    // request (matrix §4.1 rule 5).
    const remaining = await tx.warehouseMembership.count({
      where: { userId: membership.userId, roleId: membership.roleId, revokedAt: null },
    });
    if (remaining === 0) {
      await tx.userRole.deleteMany({
        where: { userId: membership.userId, roleId: membership.roleId },
      });
    }
  });

  if (membership.role.code === "WAREHOUSE_ADMIN" && row.status === "ACTIVE") {
    const remainingAdmins = await prisma.warehouseMembership.count({
      where: {
        warehouseId,
        revokedAt: null,
        role: { code: "WAREHOUSE_ADMIN" },
        user: { status: "ACTIVE" },
      },
    });
    if (remainingAdmins === 0) {
      warning = "Warehouse has no active admin";
    }
  }

  await audit(actor, "warehouse.member_remove", warehouseId, {
    userId: membership.userId,
    email: membership.user.email,
    roleCode: membership.role.code,
    membershipId,
    ...(warning ? { warning } : {}),
  });
  return { removed: true, ...(warning ? { warning } : {}) };
}

// ---------------------------------------------------------------------------
// Zones and storage locations
// ---------------------------------------------------------------------------

function toZoneView(
  zone: Prisma.WarehouseZoneGetPayload<{ include: { locations: true } }>,
): WarehouseZoneView {
  return {
    id: zone.id,
    warehouseId: zone.warehouseId,
    code: zone.code,
    name: zone.name,
    kind: zone.kind,
    capacityPackages: zone.capacityPackages,
    isActive: zone.isActive,
    locations: zone.locations.map((l) => ({
      id: l.id,
      rack: l.rack,
      shelf: l.shelf,
      bin: l.bin,
      fullCode: l.fullCode,
      capacityPackages: l.capacityPackages,
      isActive: l.isActive,
    })),
  };
}

export async function listZones(
  actor: ActorContext,
  warehouseId: string,
): Promise<WarehouseZoneView[]> {
  const row = await loadWarehouse(warehouseId);
  if (!hasPermission(actor, "warehouse.read_all") && !hasPermission(actor, "warehouse.read_assigned")) {
    await auditDenied(actor, { warehouseId, reason: "missing_permission:warehouse.read" });
    throw new AuthorizationError("Missing required permission: warehouse.read_all or warehouse.read_assigned");
  }
  await assertWarehouseInScope(actor, row.id);
  const zones = await prisma.warehouseZone.findMany({
    where: { warehouseId },
    include: { locations: { orderBy: { fullCode: "asc" } } },
    orderBy: { code: "asc" },
  });
  return zones.map(toZoneView);
}

export const createZoneSchema = z.object({
  code: z
    .string()
    .regex(/^[A-Z0-9-]{2,20}$/, "Zone code must be uppercase letters, digits and dashes")
    .optional(),
  name: z.string().min(1).max(80),
  kind: z.enum(ZONE_KINDS),
  capacityPackages: z.number().int().positive().optional().nullable(),
});
export type CreateZoneInput = z.infer<typeof createZoneSchema>;

export async function createZone(
  actor: ActorContext,
  warehouseId: string,
  input: CreateZoneInput,
): Promise<WarehouseZoneView> {
  const row = await loadWarehouse(warehouseId);
  await requirePermAudited(actor, "warehouse.manage_locations", warehouseId);
  await assertWarehouseInScope(actor, warehouseId);
  await assertScopedAdminMutation(actor, warehouseId);
  await assertScopedMutationAllowed(actor, row);
  const data = parse(createZoneSchema, input);
  const code = data.code ?? standardZoneCodeForKind(data.kind);

  const existing = await prisma.warehouseZone.findUnique({
    where: { warehouseId_code: { warehouseId, code } },
  });
  if (existing) {
    throw new ConflictError(`Zone code ${code} already exists in this warehouse`);
  }
  const zone = await prisma.warehouseZone.create({
    data: {
      warehouseId,
      code,
      name: data.name,
      kind: data.kind,
      capacityPackages: data.capacityPackages ?? null,
    },
    include: { locations: true },
  });
  await audit(actor, "warehouse.zone_create", warehouseId, {
    zoneId: zone.id,
    code: zone.code,
    kind: zone.kind,
  });
  return toZoneView(zone);
}

export const updateZoneSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  capacityPackages: z.number().int().positive().optional().nullable(),
  isActive: z.boolean().optional(),
});
export type UpdateZoneInput = z.infer<typeof updateZoneSchema>;

export async function updateZone(
  actor: ActorContext,
  zoneId: string,
  input: UpdateZoneInput,
): Promise<WarehouseZoneView> {
  const zone = await prisma.warehouseZone.findUnique({
    where: { id: zoneId },
    include: { warehouse: true },
  });
  if (!zone) throw new NotFoundError(`Zone not found: ${zoneId}`);
  await requirePermAudited(actor, "warehouse.manage_locations", zone.warehouseId);
  await assertWarehouseInScope(actor, zone.warehouseId);
  await assertScopedAdminMutation(actor, zone.warehouseId);
  await assertScopedMutationAllowed(actor, zone.warehouse);
  const data = parse(updateZoneSchema, input);

  const updated = await prisma.warehouseZone.update({
    where: { id: zoneId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.capacityPackages !== undefined
        ? { capacityPackages: data.capacityPackages }
        : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
    include: { locations: { orderBy: { fullCode: "asc" } } },
  });
  await audit(actor, "warehouse.zone_update", zone.warehouseId, {
    zoneId,
    code: zone.code,
    isActive: updated.isActive,
  });
  return toZoneView(updated);
}

export const createLocationSchema = z.object({
  rack: z.string().min(1).max(12),
  shelf: z.string().max(12).optional().nullable(),
  bin: z.string().max(12).optional().nullable(),
  capacityPackages: z.number().int().positive().optional().nullable(),
});
export type CreateLocationInput = z.infer<typeof createLocationSchema>;

export async function createStorageLocation(
  actor: ActorContext,
  zoneId: string,
  input: CreateLocationInput,
): Promise<StorageLocationView> {
  const zone = await prisma.warehouseZone.findUnique({
    where: { id: zoneId },
    include: { warehouse: true },
  });
  if (!zone) throw new NotFoundError(`Zone not found: ${zoneId}`);
  await requirePermAudited(actor, "warehouse.manage_locations", zone.warehouseId);
  await assertWarehouseInScope(actor, zone.warehouseId);
  await assertScopedAdminMutation(actor, zone.warehouseId);
  await assertScopedMutationAllowed(actor, zone.warehouse);
  const data = parse(createLocationSchema, input);

  let fullCode: string;
  let rack: string;
  let shelf: string | null;
  let bin: string | null;
  try {
    rack = normalizeSegment(data.rack, "RACK");
    shelf = data.shelf ? normalizeSegment(data.shelf, "SHELF") : null;
    bin = data.bin ? normalizeSegment(data.bin, "BIN") : null;
    fullCode = buildStorageFullCode({
      warehouseCode: zone.warehouse.code,
      zoneCode: zone.code,
      rack,
      shelf,
      bin,
    });
  } catch (error) {
    throw new DomainValidationError(error instanceof Error ? error.message : "Invalid location");
  }

  const existing = await prisma.storageLocation.findUnique({ where: { fullCode } });
  if (existing) {
    throw new ConflictError(`Storage location ${fullCode} already exists`);
  }
  const location = await prisma.storageLocation.create({
    data: {
      zoneId,
      rack,
      shelf,
      bin,
      fullCode,
      capacityPackages: data.capacityPackages ?? null,
    },
  });
  await audit(actor, "warehouse.location_create", zone.warehouseId, {
    locationId: location.id,
    fullCode,
    zoneCode: zone.code,
  });
  return {
    id: location.id,
    rack: location.rack,
    shelf: location.shelf,
    bin: location.bin,
    fullCode: location.fullCode,
    capacityPackages: location.capacityPackages,
    isActive: location.isActive,
  };
}

export const updateLocationSchema = z.object({
  capacityPackages: z.number().int().positive().optional().nullable(),
  isActive: z.boolean().optional(),
});
export type UpdateLocationInput = z.infer<typeof updateLocationSchema>;

export async function updateStorageLocation(
  actor: ActorContext,
  locationId: string,
  input: UpdateLocationInput,
): Promise<StorageLocationView> {
  const location = await prisma.storageLocation.findUnique({
    where: { id: locationId },
    include: { zone: { include: { warehouse: true } } },
  });
  if (!location) throw new NotFoundError(`Storage location not found: ${locationId}`);
  const warehouseId = location.zone.warehouseId;
  await requirePermAudited(actor, "warehouse.manage_locations", warehouseId);
  await assertWarehouseInScope(actor, warehouseId);
  await assertScopedAdminMutation(actor, warehouseId);
  await assertScopedMutationAllowed(actor, location.zone.warehouse);
  const data = parse(updateLocationSchema, input);

  const updated = await prisma.storageLocation.update({
    where: { id: locationId },
    data: {
      ...(data.capacityPackages !== undefined
        ? { capacityPackages: data.capacityPackages }
        : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
  });
  await audit(actor, "warehouse.location_update", warehouseId, {
    locationId,
    fullCode: updated.fullCode,
    isActive: updated.isActive,
  });
  return {
    id: updated.id,
    rack: updated.rack,
    shelf: updated.shelf,
    bin: updated.bin,
    fullCode: updated.fullCode,
    capacityPackages: updated.capacityPackages,
    isActive: updated.isActive,
  };
}
