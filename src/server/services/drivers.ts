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
  DRIVER_CAPABILITIES,
  DRIVER_EMPLOYMENT_STATUSES,
} from "@/lib/transfers/domain";
import {
  auditAccessDenied,
  isUniqueViolation,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import {
  assertWarehouseScope,
  auditOps,
  isUnscoped,
  loadWarehouseOr404,
} from "@/server/services/warehouse-ops-shared";

/**
 * Driver profiles (docs/database-schema.md §7, docs/driver-workflow.md
 * §1–§3). The profile is the operational record; the login identity is
 * the linked User (1:1). Employment status is manager-set;
 * availability is written only by assignment services from real work.
 * Suspending or deactivating a driver revokes their sessions
 * immediately (Scenario 17), mirroring the vendor-suspension pattern.
 */

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface DriverView {
  id: string;
  userId: string;
  fullName: string;
  email: string;
  phone: string | null;
  userStatus: string;
  roles: string[];
  homeWarehouseId: string;
  homeWarehouseCode: string;
  licenseNumber: string;
  licenseCategory: string | null;
  licenseExpiry: string;
  licenseExpired: boolean;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  employmentStatus: string;
  availabilityStatus: string;
  capabilities: string[];
  currentTripId: string | null;
  createdAt: string;
}

type DriverRow = Prisma.DriverGetPayload<{
  include: {
    user: { include: { roles: { include: { role: { select: { code: true } } } } } };
    homeWarehouse: { select: { code: true } };
    capabilities: true;
  };
}>;

export const driverInclude = {
  user: {
    include: { roles: { include: { role: { select: { code: true } } } } },
  },
  homeWarehouse: { select: { code: true } },
  capabilities: true,
} satisfies Prisma.DriverInclude;

function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function isExpiredDate(d: Date): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  return day.getTime() < today.getTime();
}

function toDriverView(row: DriverRow): DriverView {
  return {
    id: row.id,
    userId: row.userId,
    fullName: row.user.fullName,
    email: row.user.email,
    phone: row.user.phone,
    userStatus: row.user.status,
    roles: row.user.roles.map((r) => r.role.code),
    homeWarehouseId: row.homeWarehouseId,
    homeWarehouseCode: row.homeWarehouse.code,
    licenseNumber: row.licenseNumber,
    licenseCategory: row.licenseCategory,
    licenseExpiry: dateOnly(row.licenseExpiry),
    licenseExpired: isExpiredDate(row.licenseExpiry),
    emergencyContactName: row.emergencyContactName,
    emergencyContactPhone: row.emergencyContactPhone,
    employmentStatus: row.employmentStatus,
    availabilityStatus: row.availabilityStatus,
    capabilities: row.capabilities.map((c) => c.capability).sort(),
    currentTripId: row.currentTripId,
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadDriverOr404(driverId: string): Promise<DriverRow> {
  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    include: driverInclude,
  });
  if (!driver) throw new NotFoundError("Driver profile not found");
  return driver;
}

/** Scoped actors (WA) manage only drivers home-based in their scope. */
async function assertDriverScope(
  actor: ActorContext,
  driver: { homeWarehouseId: string },
  driverId?: string,
): Promise<void> {
  if (isUnscoped(actor)) return;
  if (actor.driverId && driverId && actor.driverId === driverId) return;
  await assertWarehouseScope(actor, driver.homeWarehouseId, "Driver", driverId);
}

// ---------------------------------------------------------------------------
// Create / update
// ---------------------------------------------------------------------------

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Dates use YYYY-MM-DD")
  // Phase 10 slice 2 (P5-8): the regex alone accepts impossible
  // dates (2026-02-30), which `new Date(...)` silently rolled over
  // or turned into a raw 500 downstream. Require a real calendar
  // date.
  .refine((value) => {
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(Date.UTC(y!, m! - 1, d!));
    return (
      date.getUTCFullYear() === y &&
      date.getUTCMonth() === m! - 1 &&
      date.getUTCDate() === d
    );
  }, "Dates must be real calendar dates");

export const createDriverSchema = z.object({
  userId: z.string().uuid(),
  homeWarehouseId: z.string().uuid(),
  licenseNumber: z.string().min(1).max(60),
  licenseCategory: z.string().max(30).optional().nullable(),
  licenseExpiry: dateString,
  emergencyContactName: z.string().max(120).optional().nullable(),
  emergencyContactPhone: z.string().max(30).optional().nullable(),
  capabilities: z.array(z.enum(DRIVER_CAPABILITIES)).min(1),
});
export type CreateDriverInput = z.input<typeof createDriverSchema>;

export async function createDriverProfile(
  actor: ActorContext,
  input: CreateDriverInput,
): Promise<DriverView> {
  const data = parse(createDriverSchema, input);
  await requirePermAudited(actor, "driver.manage", "Driver");
  await loadWarehouseOr404(data.homeWarehouseId);
  await assertWarehouseScope(actor, data.homeWarehouseId, "Driver");

  const user = await prisma.user.findUnique({
    where: { id: data.userId },
    include: { roles: { include: { role: { select: { code: true } } } } },
  });
  if (!user) throw new NotFoundError("User not found");
  if (user.status !== "ACTIVE") {
    throw new DomainValidationError("Driver profiles can only be created for active users");
  }
  // Phase 10 slice 2 (P5-8): a Driver profile on an account without
  // a driver role is dead weight that later confuses assignment —
  // the candidate picker (listDriverCandidates) already only offers
  // LINEHAUL_DRIVER / RIDER accounts; enforce the same rule here so
  // direct API calls cannot bypass it.
  if (
    !user.roles.some((r) => ["LINEHAUL_DRIVER", "RIDER"].includes(r.role.code))
  ) {
    throw new DomainValidationError(
      "Driver profiles can only be created for users holding the LINEHAUL_DRIVER or RIDER role",
    );
  }
  // P5-8: an already-expired licence is a data-entry error at
  // creation time, not something to discover at assignment time.
  if (isExpiredDate(new Date(`${data.licenseExpiry}T00:00:00.000Z`))) {
    throw new DomainValidationError("Driving licence expiry is in the past");
  }
  const existing = await prisma.driver.findUnique({ where: { userId: data.userId } });
  if (existing) {
    throw new ConflictError("This user already has a driver profile");
  }

  let driver: DriverRow;
  try {
    driver = await prisma.$transaction(async (tx) => {
      const created = await tx.driver.create({
        data: {
          userId: data.userId,
          homeWarehouseId: data.homeWarehouseId,
          licenseNumber: data.licenseNumber,
          licenseCategory: data.licenseCategory ?? null,
          licenseExpiry: new Date(`${data.licenseExpiry}T00:00:00.000Z`),
          emergencyContactName: data.emergencyContactName ?? null,
          emergencyContactPhone: data.emergencyContactPhone ?? null,
          capabilities: {
            create: [...new Set(data.capabilities)].map((capability) => ({ capability })),
          },
        },
      });
      return tx.driver.findUniqueOrThrow({
        where: { id: created.id },
        include: driverInclude,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("This user already has a driver profile");
    }
    throw error;
  }

  await auditOps(actor, "driver.create", "Driver", driver.id, {
    warehouseId: data.homeWarehouseId,
    after: { userId: data.userId, capabilities: data.capabilities },
  });
  return toDriverView(driver);
}

export const updateDriverSchema = z.object({
  driverId: z.string().uuid(),
  homeWarehouseId: z.string().uuid().optional(),
  licenseNumber: z.string().min(1).max(60).optional(),
  licenseCategory: z.string().max(30).optional().nullable(),
  licenseExpiry: dateString.optional(),
  emergencyContactName: z.string().max(120).optional().nullable(),
  emergencyContactPhone: z.string().max(30).optional().nullable(),
  capabilities: z.array(z.enum(DRIVER_CAPABILITIES)).min(1).optional(),
});
export type UpdateDriverInput = z.input<typeof updateDriverSchema>;

export async function updateDriverProfile(
  actor: ActorContext,
  input: UpdateDriverInput,
): Promise<DriverView> {
  const data = parse(updateDriverSchema, input);
  await requirePermAudited(actor, "driver.manage", "Driver");
  const driver = await loadDriverOr404(data.driverId);
  await assertDriverScope(actor, driver, driver.id);
  // P5-8: same expired-licence guard as creation.
  if (
    data.licenseExpiry &&
    isExpiredDate(new Date(`${data.licenseExpiry}T00:00:00.000Z`))
  ) {
    throw new DomainValidationError("Driving licence expiry is in the past");
  }
  if (data.homeWarehouseId && data.homeWarehouseId !== driver.homeWarehouseId) {
    await loadWarehouseOr404(data.homeWarehouseId);
    await assertWarehouseScope(actor, data.homeWarehouseId, "Driver", driver.id);
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.driver.update({
      where: { id: driver.id },
      data: {
        ...(data.homeWarehouseId ? { homeWarehouseId: data.homeWarehouseId } : {}),
        ...(data.licenseNumber ? { licenseNumber: data.licenseNumber } : {}),
        ...(data.licenseCategory !== undefined
          ? { licenseCategory: data.licenseCategory }
          : {}),
        ...(data.licenseExpiry
          ? { licenseExpiry: new Date(`${data.licenseExpiry}T00:00:00.000Z`) }
          : {}),
        ...(data.emergencyContactName !== undefined
          ? { emergencyContactName: data.emergencyContactName }
          : {}),
        ...(data.emergencyContactPhone !== undefined
          ? { emergencyContactPhone: data.emergencyContactPhone }
          : {}),
      },
    });
    if (data.capabilities) {
      await tx.driverCapability.deleteMany({ where: { driverId: driver.id } });
      await tx.driverCapability.createMany({
        data: [...new Set(data.capabilities)].map((capability) => ({
          driverId: driver.id,
          capability,
        })),
      });
    }
    return tx.driver.findUniqueOrThrow({
      where: { id: driver.id },
      include: driverInclude,
    });
  });

  await auditOps(actor, "driver.update", "Driver", driver.id, {
    warehouseId: updated.homeWarehouseId,
  });
  return toDriverView(updated);
}

export const setEmploymentStatusSchema = z.object({
  driverId: z.string().uuid(),
  employmentStatus: z.enum(DRIVER_EMPLOYMENT_STATUSES),
  reason: z.string().max(500).optional().nullable(),
});
export type SetEmploymentStatusInput = z.input<typeof setEmploymentStatusSchema>;

export async function setDriverEmploymentStatus(
  actor: ActorContext,
  input: SetEmploymentStatusInput,
): Promise<DriverView> {
  const data = parse(setEmploymentStatusSchema, input);
  await requirePermAudited(actor, "driver.manage", "Driver");
  const driver = await loadDriverOr404(data.driverId);
  await assertDriverScope(actor, driver, driver.id);

  const updated = await prisma.$transaction(async (tx) => {
    // Availability mirrors employment except while a trip is live:
    // an on-trip driver keeps ON_TRIP so the load stays visible
    // (Scenario 17 surfaces the custody for reassignment).
    let availability = driver.availabilityStatus;
    if (data.employmentStatus === "SUSPENDED") availability = "SUSPENDED";
    else if (data.employmentStatus === "INACTIVE") availability = "INACTIVE";
    else if (data.employmentStatus === "ON_LEAVE") availability = "ON_LEAVE";
    else if (
      data.employmentStatus === "ACTIVE" &&
      ["SUSPENDED", "INACTIVE", "ON_LEAVE"].includes(driver.availabilityStatus)
    ) {
      availability = "AVAILABLE";
    }
    await tx.driver.update({
      where: { id: driver.id },
      data: { employmentStatus: data.employmentStatus, availabilityStatus: availability },
    });
    if (
      data.employmentStatus === "SUSPENDED" ||
      data.employmentStatus === "INACTIVE"
    ) {
      // Sessions die with the employment status (Scenario 17).
      await tx.session.deleteMany({ where: { userId: driver.userId } });
    }
    return tx.driver.findUniqueOrThrow({
      where: { id: driver.id },
      include: driverInclude,
    });
  });

  await auditOps(actor, "driver.employment_status", "Driver", driver.id, {
    warehouseId: driver.homeWarehouseId,
    before: { employmentStatus: driver.employmentStatus },
    after: { employmentStatus: data.employmentStatus, reason: data.reason ?? null },
  });
  return toDriverView(updated);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListDriversQuery {
  warehouseId?: string;
  employmentStatus?: string;
  capability?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listDrivers(
  actor: ActorContext,
  query: ListDriversQuery = {},
): Promise<{ items: DriverView[]; total: number; page: number; pageSize: number; totalPages: number }> {
  if (
    !hasPermission(actor, "driver.manage") &&
    !hasPermission(actor, "driver.assign") &&
    !hasPermission(actor, "driver.read_self")
  ) {
    await auditAccessDenied(actor, "Driver", {
      reason: "missing_permission:driver.read",
    });
    throw new AuthorizationError("Missing required permission to read drivers");
  }
  if (query.warehouseId) {
    await assertWarehouseScope(actor, query.warehouseId, "Driver");
  }

  // Scope and search compose with explicit AND (P3-1).
  const conditions: Prisma.DriverWhereInput[] = [];
  if (!isUnscoped(actor)) {
    if (actor.driverId) {
      conditions.push({ id: actor.driverId });
    } else {
      conditions.push({ homeWarehouseId: { in: actor.warehouseIds } });
    }
  }
  if (query.warehouseId) conditions.push({ homeWarehouseId: query.warehouseId });
  if (query.employmentStatus) conditions.push({ employmentStatus: query.employmentStatus });
  if (query.capability) {
    conditions.push({ capabilities: { some: { capability: query.capability } } });
  }
  const term = query.search?.trim();
  if (term) {
    conditions.push({
      OR: [
        { user: { fullName: { contains: term, mode: "insensitive" } } },
        { user: { email: { contains: term, mode: "insensitive" } } },
        { licenseNumber: { contains: term, mode: "insensitive" } },
      ],
    });
  }
  const where: Prisma.DriverWhereInput =
    conditions.length > 0 ? { AND: conditions } : {};

  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  const [total, rows] = await Promise.all([
    prisma.driver.count({ where }),
    prisma.driver.findMany({
      where,
      include: driverInclude,
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
  ]);
  return { items: rows.map(toDriverView), ...pageMeta(total, page, pageSize) };
}

export async function getDriver(
  actor: ActorContext,
  driverId: string,
): Promise<DriverView> {
  if (
    !hasPermission(actor, "driver.manage") &&
    !hasPermission(actor, "driver.assign") &&
    !hasPermission(actor, "driver.read_self")
  ) {
    await auditAccessDenied(actor, "Driver", {
      entityId: driverId,
      reason: "missing_permission:driver.read",
    });
    throw new AuthorizationError("Missing required permission to read drivers");
  }
  const driver = await loadDriverOr404(driverId);
  await assertDriverScope(actor, driver, driver.id);
  return toDriverView(driver);
}

/** Slim picker row for the crew-assignment UI (Phase 10 slice 2,
 *  P5-7): identity + home warehouse only. The full DriverView
 *  carries email, phone, emergency contacts and the licence number —
 *  none of which a dispatcher needs to pick a driver, and all of
 *  which the old listAssignableDrivers leaked for EVERY line-haul
 *  driver in the company regardless of the actor's scope. */
export interface AssignableDriverView {
  id: string;
  fullName: string;
  homeWarehouseId: string;
  homeWarehouseCode: string;
}

/** Drivers eligible for line-haul assignment right now, with the
 *  specific blockers for those who are not (driver-workflow.md §3/§8:
 *  the dispatcher sees WHY a driver cannot be assigned). Used by the
 *  transfer crew-assignment picker; the authoritative check runs
 *  again inside assignTransferCrew.
 *
 *  P5-7: warehouse-scoped actors see only drivers homed at their
 *  warehouses; unscoped actors (dispatcher/admin) see all. */
export async function listAssignableDrivers(
  actor: ActorContext,
): Promise<{ driver: AssignableDriverView; blockers: string[] }[]> {
  await requirePermAudited(actor, "driver.assign", "Driver");
  const rows = await prisma.driver.findMany({
    where: {
      capabilities: { some: { capability: "LINEHAUL" } },
      ...(isUnscoped(actor) ? {} : { homeWarehouseId: { in: actor.warehouseIds } }),
    },
    include: driverInclude,
    orderBy: { createdAt: "asc" },
  });
  const activeTrips = await prisma.trip.findMany({
    where: {
      driverId: { in: rows.map((r) => r.id) },
      status: {
        in: ["PLANNED", "ASSIGNED", "LOADING", "DISPATCHED", "IN_TRANSIT", "DELAYED", "ARRIVED", "UNLOADING", "INCIDENT"],
      },
    },
    select: { driverId: true },
  });
  const busy = new Set(activeTrips.map((t) => t.driverId));
  return rows.map((row) => {
    const blockers: string[] = [];
    if (row.employmentStatus !== "ACTIVE") {
      blockers.push(`Employment status is ${row.employmentStatus}`);
    }
    if (row.user.status !== "ACTIVE") blockers.push("User account is not active");
    if (!row.user.roles.some((r) => r.role.code === "LINEHAUL_DRIVER")) {
      blockers.push("User does not hold the LINEHAUL_DRIVER role");
    }
    if (isExpiredDate(row.licenseExpiry)) blockers.push("Driving licence has expired");
    if (busy.has(row.id)) blockers.push("Already assigned to an active trip");
    return {
      driver: {
        id: row.id,
        fullName: row.user.fullName,
        homeWarehouseId: row.homeWarehouseId,
        homeWarehouseCode: row.homeWarehouse.code,
      },
      blockers,
    };
  });
}

/** Users who can be given a Driver profile: ACTIVE accounts holding a
 *  driver role (LINEHAUL_DRIVER or RIDER) with no profile yet. Feeds
 *  the admin create-profile form (driver.manage). */
export async function listDriverCandidates(
  actor: ActorContext,
): Promise<{ userId: string; fullName: string; email: string; roles: string[] }[]> {
  await requirePermAudited(actor, "driver.manage", "Driver");
  const rows = await prisma.user.findMany({
    where: {
      status: "ACTIVE",
      driverProfile: null,
      roles: { some: { role: { code: { in: ["LINEHAUL_DRIVER", "RIDER"] } } } },
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      roles: { select: { role: { select: { code: true } } } },
    },
    orderBy: { fullName: "asc" },
    take: 200,
  });
  return rows.map((row) => ({
    userId: row.id,
    fullName: row.fullName,
    email: row.email,
    roles: row.roles.map((r) => r.role.code),
  }));
}
