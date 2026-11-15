import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  hasPermission,
  type ActorContext,
} from "@/lib/auth/actor";
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
} from "@/lib/errors";
import {
  VEHICLE_INSPECTION_STATUSES,
  VEHICLE_MAINTENANCE_KINDS,
  VEHICLE_TYPES,
} from "@/lib/transfers/domain";
import { isExpiredDate } from "@/server/services/drivers";
import {
  auditAccessDenied,
  isUniqueViolation,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import { auditOps, loadWarehouseOr404 } from "@/server/services/warehouse-ops-shared";

/**
 * Fleet vehicles (docs/database-schema.md §7, docs/driver-workflow.md
 * §4). Assignment rules are enforced here and re-checked by the
 * transfer service at assignment and dispatch: expired insurance or
 * registration, a failed/expired inspection, or a non-AVAILABLE
 * status each block assignment with the exact reason named.
 */

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface VehicleView {
  id: string;
  registration: string;
  type: string;
  capacityKg: string | null;
  capacityVolumeM3: string | null;
  homeWarehouseId: string | null;
  homeWarehouseCode: string | null;
  status: string;
  insuranceExpiry: string | null;
  registrationExpiry: string | null;
  inspectionStatus: string;
  assignedDriverId: string | null;
  assignedDriverName: string | null;
  assignmentBlockers: string[];
  createdAt: string;
}

type VehicleRow = Prisma.VehicleGetPayload<{
  include: {
    homeWarehouse: { select: { code: true } };
    assignedDriver: { include: { user: { select: { fullName: true } } } };
  };
}>;

export const vehicleInclude = {
  homeWarehouse: { select: { code: true } },
  assignedDriver: { include: { user: { select: { fullName: true } } } },
} satisfies Prisma.VehicleInclude;

function dateOnly(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * Why this vehicle cannot be put on a trip right now (empty = it
 * can). Expiry/validity blockers only — the "already on another
 * trip" check needs trip state and lives in the transfer service.
 */
export function vehicleAssignmentBlockers(vehicle: {
  status: string;
  insuranceExpiry: Date | null;
  registrationExpiry: Date | null;
  inspectionStatus: string;
}): string[] {
  const blockers: string[] = [];
  if (vehicle.status !== "AVAILABLE") {
    blockers.push(`Vehicle status is ${vehicle.status} — only AVAILABLE vehicles can be assigned`);
  }
  if (vehicle.insuranceExpiry && isExpiredDate(vehicle.insuranceExpiry)) {
    blockers.push("Vehicle insurance has expired");
  }
  if (vehicle.registrationExpiry && isExpiredDate(vehicle.registrationExpiry)) {
    blockers.push("Vehicle registration has expired");
  }
  if (vehicle.inspectionStatus === "EXPIRED") {
    blockers.push("Vehicle inspection has expired");
  }
  return blockers;
}

function toVehicleView(row: VehicleRow): VehicleView {
  return {
    id: row.id,
    registration: row.registration,
    type: row.type,
    capacityKg: row.capacityKg?.toString() ?? null,
    capacityVolumeM3: row.capacityVolumeM3?.toString() ?? null,
    homeWarehouseId: row.homeWarehouseId,
    homeWarehouseCode: row.homeWarehouse?.code ?? null,
    status: row.status,
    insuranceExpiry: dateOnly(row.insuranceExpiry),
    registrationExpiry: dateOnly(row.registrationExpiry),
    inspectionStatus: row.inspectionStatus,
    assignedDriverId: row.assignedDriverId,
    assignedDriverName: row.assignedDriver?.user.fullName ?? null,
    assignmentBlockers: vehicleAssignmentBlockers(row),
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadVehicleOr404(vehicleId: string): Promise<VehicleRow> {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    include: vehicleInclude,
  });
  if (!vehicle) throw new NotFoundError("Vehicle not found");
  return vehicle;
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates use YYYY-MM-DD")
  // Phase 10 slice 2 (P5-8): same impossible-date guard as the
  // driver schemas — 2026-02-30 must fail validation, not become
  // an Invalid Date that 500s at insert time.
  .refine((value) => {
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(Date.UTC(y!, m! - 1, d!));
    return (
      date.getUTCFullYear() === y &&
      date.getUTCMonth() === m! - 1 &&
      date.getUTCDate() === d
    );
  }, "Dates must be real calendar dates")
  .optional()
  .nullable();

export const createVehicleSchema = z.object({
  registration: z.string().min(2).max(40),
  type: z.enum(VEHICLE_TYPES),
  capacityKg: z.number().positive().max(100000).optional().nullable(),
  capacityVolumeM3: z.number().positive().max(1000).optional().nullable(),
  homeWarehouseId: z.string().uuid().optional().nullable(),
  insuranceExpiry: dateString,
  registrationExpiry: dateString,
  inspectionStatus: z.enum(VEHICLE_INSPECTION_STATUSES).default("VALID"),
  assignedDriverId: z.string().uuid().optional().nullable(),
});
export type CreateVehicleInput = z.input<typeof createVehicleSchema>;

function dateOrNull(value: string | null | undefined): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

export async function createVehicle(
  actor: ActorContext,
  input: CreateVehicleInput,
): Promise<VehicleView> {
  const data = parse(createVehicleSchema, input);
  await requirePermAudited(actor, "vehicle.manage", "Vehicle");
  if (data.homeWarehouseId) await loadWarehouseOr404(data.homeWarehouseId);
  if (data.assignedDriverId) {
    const driver = await prisma.driver.findUnique({ where: { id: data.assignedDriverId } });
    if (!driver) throw new NotFoundError("Driver profile not found");
  }
  let vehicle: VehicleRow;
  try {
    const created = await prisma.vehicle.create({
      data: {
        registration: data.registration.trim(),
        type: data.type,
        capacityKg:
          data.capacityKg != null ? new Prisma.Decimal(data.capacityKg) : null,
        capacityVolumeM3:
          data.capacityVolumeM3 != null
            ? new Prisma.Decimal(data.capacityVolumeM3)
            : null,
        homeWarehouseId: data.homeWarehouseId ?? null,
        insuranceExpiry: dateOrNull(data.insuranceExpiry),
        registrationExpiry: dateOrNull(data.registrationExpiry),
        inspectionStatus: data.inspectionStatus,
        assignedDriverId: data.assignedDriverId ?? null,
      },
    });
    vehicle = await loadVehicleOr404(created.id);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        `A vehicle with registration ${data.registration.trim()} already exists`,
      );
    }
    throw error;
  }
  await auditOps(actor, "vehicle.create", "Vehicle", vehicle.id, {
    after: { registration: vehicle.registration, type: vehicle.type },
  });
  return toVehicleView(vehicle);
}

export const updateVehicleSchema = z.object({
  vehicleId: z.string().uuid(),
  type: z.enum(VEHICLE_TYPES).optional(),
  capacityKg: z.number().positive().max(100000).optional().nullable(),
  capacityVolumeM3: z.number().positive().max(1000).optional().nullable(),
  homeWarehouseId: z.string().uuid().optional().nullable(),
  insuranceExpiry: dateString,
  registrationExpiry: dateString,
  inspectionStatus: z.enum(VEHICLE_INSPECTION_STATUSES).optional(),
});
export type UpdateVehicleInput = z.input<typeof updateVehicleSchema>;

export async function updateVehicle(
  actor: ActorContext,
  input: UpdateVehicleInput,
): Promise<VehicleView> {
  const data = parse(updateVehicleSchema, input);
  await requirePermAudited(actor, "vehicle.manage", "Vehicle");
  const vehicle = await loadVehicleOr404(data.vehicleId);
  if (data.homeWarehouseId) await loadWarehouseOr404(data.homeWarehouseId);
  await prisma.vehicle.update({
    where: { id: vehicle.id },
    data: {
      ...(data.type ? { type: data.type } : {}),
      ...(data.capacityKg !== undefined
        ? {
            capacityKg:
              data.capacityKg != null ? new Prisma.Decimal(data.capacityKg) : null,
          }
        : {}),
      ...(data.capacityVolumeM3 !== undefined
        ? {
            capacityVolumeM3:
              data.capacityVolumeM3 != null
                ? new Prisma.Decimal(data.capacityVolumeM3)
                : null,
          }
        : {}),
      ...(data.homeWarehouseId !== undefined
        ? { homeWarehouseId: data.homeWarehouseId }
        : {}),
      ...(data.insuranceExpiry !== undefined
        ? { insuranceExpiry: dateOrNull(data.insuranceExpiry) }
        : {}),
      ...(data.registrationExpiry !== undefined
        ? { registrationExpiry: dateOrNull(data.registrationExpiry) }
        : {}),
      ...(data.inspectionStatus ? { inspectionStatus: data.inspectionStatus } : {}),
    },
  });
  await auditOps(actor, "vehicle.update", "Vehicle", vehicle.id);
  return toVehicleView(await loadVehicleOr404(vehicle.id));
}

/** Set the vehicle's default driver (vehicle.assign). This is the
 *  standing default, not a trip assignment — trips name their own
 *  driver on the transfer. */
export async function assignVehicleDriver(
  actor: ActorContext,
  vehicleId: string,
  driverId: string | null,
): Promise<VehicleView> {
  await requirePermAudited(actor, "vehicle.assign", "Vehicle");
  const vehicle = await loadVehicleOr404(vehicleId);
  if (driverId) {
    const driver = await prisma.driver.findUnique({ where: { id: driverId } });
    if (!driver) throw new NotFoundError("Driver profile not found");
  }
  await prisma.vehicle.update({
    where: { id: vehicle.id },
    data: { assignedDriverId: driverId },
  });
  await auditOps(actor, "vehicle.assign_driver", "Vehicle", vehicle.id, {
    after: { assignedDriverId: driverId },
  });
  return toVehicleView(await loadVehicleOr404(vehicle.id));
}

/** Manual status changes. ON_TRIP is never set by hand — it is a
 *  consequence of dispatch (and cleared when the trip completes). */
export async function setVehicleStatus(
  actor: ActorContext,
  vehicleId: string,
  status: "AVAILABLE" | "ASSIGNED" | "MAINTENANCE" | "OFFLINE",
): Promise<VehicleView> {
  await requirePermAudited(actor, "vehicle.manage", "Vehicle");
  const vehicle = await loadVehicleOr404(vehicleId);
  if (vehicle.status === "ON_TRIP") {
    throw new ConflictError(
      "Vehicle is on a trip — its status clears when the trip completes",
    );
  }
  await prisma.vehicle.update({ where: { id: vehicle.id }, data: { status } });
  await auditOps(actor, "vehicle.status", "Vehicle", vehicle.id, {
    before: { status: vehicle.status },
    after: { status },
  });
  return toVehicleView(await loadVehicleOr404(vehicle.id));
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export interface VehicleMaintenanceView {
  id: string;
  vehicleId: string;
  kind: string;
  scheduledAt: string;
  completedAt: string | null;
  costPaisa: string | null;
  notes: string | null;
  nextDueAt: string | null;
  recordedByName: string;
  createdAt: string;
}

export const recordMaintenanceSchema = z.object({
  vehicleId: z.string().uuid(),
  kind: z.enum(VEHICLE_MAINTENANCE_KINDS),
  scheduledAt: z.string().datetime(),
  completedAt: z.string().datetime().optional().nullable(),
  costPaisa: z
    .string()
    .regex(/^\d+$/, "Cost must be integer paisa")
    .optional()
    .nullable(),
  notes: z.string().max(1000).optional().nullable(),
  nextDueAt: z.string().datetime().optional().nullable(),
});
export type RecordMaintenanceInput = z.input<typeof recordMaintenanceSchema>;

export async function recordVehicleMaintenance(
  actor: ActorContext,
  input: RecordMaintenanceInput,
): Promise<VehicleMaintenanceView> {
  const data = parse(recordMaintenanceSchema, input);
  await requirePermAudited(actor, "vehicle.manage", "Vehicle");
  const vehicle = await loadVehicleOr404(data.vehicleId);
  const row = await prisma.vehicleMaintenance.create({
    data: {
      vehicleId: vehicle.id,
      kind: data.kind,
      scheduledAt: new Date(data.scheduledAt),
      completedAt: data.completedAt ? new Date(data.completedAt) : null,
      costPaisa: data.costPaisa ? BigInt(data.costPaisa) : null,
      notes: data.notes ?? null,
      nextDueAt: data.nextDueAt ? new Date(data.nextDueAt) : null,
      recordedById: actor.userId,
    },
    include: { recordedBy: { select: { fullName: true } } },
  });
  await auditOps(actor, "vehicle.maintenance_recorded", "Vehicle", vehicle.id, {
    after: { kind: data.kind, maintenanceId: row.id },
  });
  return {
    id: row.id,
    vehicleId: row.vehicleId,
    kind: row.kind,
    scheduledAt: row.scheduledAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    costPaisa: row.costPaisa?.toString() ?? null,
    notes: row.notes,
    nextDueAt: row.nextDueAt?.toISOString() ?? null,
    recordedByName: row.recordedBy.fullName,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listVehicleMaintenance(
  actor: ActorContext,
  vehicleId: string,
): Promise<VehicleMaintenanceView[]> {
  if (!hasPermission(actor, "vehicle.manage") && !hasPermission(actor, "vehicle.assign")) {
    await auditAccessDenied(actor, "Vehicle", {
      entityId: vehicleId,
      reason: "missing_permission:vehicle.read",
    });
    throw new AuthorizationError("Missing required permission to read vehicles");
  }
  await loadVehicleOr404(vehicleId);
  const rows = await prisma.vehicleMaintenance.findMany({
    where: { vehicleId },
    include: { recordedBy: { select: { fullName: true } } },
    orderBy: { scheduledAt: "desc" },
    take: 100,
  });
  return rows.map((row) => ({
    id: row.id,
    vehicleId: row.vehicleId,
    kind: row.kind,
    scheduledAt: row.scheduledAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    costPaisa: row.costPaisa?.toString() ?? null,
    notes: row.notes,
    nextDueAt: row.nextDueAt?.toISOString() ?? null,
    recordedByName: row.recordedBy.fullName,
    createdAt: row.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListVehiclesQuery {
  status?: string;
  homeWarehouseId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listVehicles(
  actor: ActorContext,
  query: ListVehiclesQuery = {},
): Promise<{ items: VehicleView[]; total: number; page: number; pageSize: number; totalPages: number }> {
  if (
    !hasPermission(actor, "vehicle.manage") &&
    !hasPermission(actor, "vehicle.assign") &&
    !hasPermission(actor, "transfer.create")
  ) {
    await auditAccessDenied(actor, "Vehicle", {
      reason: "missing_permission:vehicle.read",
    });
    throw new AuthorizationError("Missing required permission to read vehicles");
  }
  // Vehicles are fleet data (no per-warehouse scope in the matrix);
  // filters and search compose with explicit AND (P3-1).
  const conditions: Prisma.VehicleWhereInput[] = [];
  if (query.status) conditions.push({ status: query.status });
  if (query.homeWarehouseId) conditions.push({ homeWarehouseId: query.homeWarehouseId });
  const term = query.search?.trim();
  if (term) {
    conditions.push({
      OR: [
        { registration: { contains: term, mode: "insensitive" } },
        { type: { contains: term, mode: "insensitive" } },
      ],
    });
  }
  const where: Prisma.VehicleWhereInput =
    conditions.length > 0 ? { AND: conditions } : {};
  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  const [total, rows] = await Promise.all([
    prisma.vehicle.count({ where }),
    prisma.vehicle.findMany({
      where,
      include: vehicleInclude,
      orderBy: { registration: "asc" },
      skip,
      take,
    }),
  ]);
  return { items: rows.map(toVehicleView), ...pageMeta(total, page, pageSize) };
}

export async function getVehicle(
  actor: ActorContext,
  vehicleId: string,
): Promise<VehicleView> {
  if (!hasPermission(actor, "vehicle.manage") && !hasPermission(actor, "vehicle.assign")) {
    await auditAccessDenied(actor, "Vehicle", {
      entityId: vehicleId,
      reason: "missing_permission:vehicle.read",
    });
    throw new AuthorizationError("Missing required permission to read vehicles");
  }
  return toVehicleView(await loadVehicleOr404(vehicleId));
}

/** Guard used before a vehicle may be put on a transfer: throws a
 *  DomainValidationError naming every blocker. */
export function assertVehicleAssignable(vehicle: {
  status: string;
  insuranceExpiry: Date | null;
  registrationExpiry: Date | null;
  inspectionStatus: string;
}): void {
  const blockers = vehicleAssignmentBlockers(vehicle);
  if (blockers.length > 0) {
    throw new DomainValidationError(blockers.join("; "));
  }
}
