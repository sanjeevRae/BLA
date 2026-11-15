import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  hasPermission,
  type ActorContext,
} from "@/lib/auth/actor";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { transitionPackageInTx } from "@/server/services/package-lifecycle";
import {
  auditAccessDenied,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import { auditOps, isUnscoped } from "@/server/services/warehouse-ops-shared";
import { assertTransferReadable } from "@/server/services/transfers";

/**
 * Line-haul trips (docs/driver-workflow.md §5, docs/database-schema.md
 * §7). A Trip is created from its Transfer at crew assignment and
 * carries the movement: dispatch (transfer service) → departure →
 * checkpoints/delay → arrival. Manual TripStop checkpoints are the
 * progress mechanism; no step depends on GPS.
 *
 * The assigned driver acts on their own trip (trip.update_progress,
 * assignment-scoped); warehouse oversight comes from the origin WA
 * (departure side) and destination WA (arrival side). The driver can
 * never perform destination receiving — that action does not exist
 * here (transfer-workflow.md §8).
 */

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface TripStopView {
  id: string;
  sequence: number;
  label: string;
  latitude: string | null;
  longitude: string | null;
  passedAt: string | null;
  recordedByName: string;
  notes: string | null;
  createdAt: string;
}

export interface TripView {
  id: string;
  tripNumber: string;
  status: string;
  transferId: string;
  transferNumber: string;
  originWarehouseId: string;
  originWarehouseCode: string;
  destinationWarehouseId: string;
  destinationWarehouseCode: string;
  driverId: string;
  driverName: string;
  driverUserId: string;
  vehicleId: string;
  vehicleRegistration: string;
  plannedDepartureAt: string | null;
  actualDepartureAt: string | null;
  expectedArrivalAt: string | null;
  actualArrivalAt: string | null;
  packageCount: number;
  packages: { packageId: string; trackingId: string; packageStatus: string; itemStatus: string }[];
  stops: TripStopView[];
  createdAt: string;
}

const tripInclude = {
  transfer: {
    include: {
      originWarehouse: { select: { code: true } },
      destinationWarehouse: { select: { code: true } },
      items: {
        include: {
          package: { select: { trackingId: true, operationalStatus: true } },
        },
        orderBy: { createdAt: "asc" as const },
      },
    },
  },
  driver: { include: { user: { select: { fullName: true } } } },
  vehicle: { select: { registration: true } },
  stops: {
    include: { recordedBy: { select: { fullName: true } } },
    orderBy: { sequence: "asc" as const },
  },
} satisfies Prisma.TripInclude;

type TripRow = Prisma.TripGetPayload<{ include: typeof tripInclude }>;

function toTripView(row: TripRow): TripView {
  return {
    id: row.id,
    tripNumber: row.tripNumber,
    status: row.status,
    transferId: row.transferId,
    transferNumber: row.transfer.transferNumber,
    originWarehouseId: row.transfer.originWarehouseId,
    originWarehouseCode: row.transfer.originWarehouse.code,
    destinationWarehouseId: row.transfer.destinationWarehouseId,
    destinationWarehouseCode: row.transfer.destinationWarehouse.code,
    driverId: row.driverId,
    driverName: row.driver.user.fullName,
    driverUserId: row.driver.userId,
    vehicleId: row.vehicleId,
    vehicleRegistration: row.vehicle.registration,
    plannedDepartureAt: row.plannedDepartureAt?.toISOString() ?? null,
    actualDepartureAt: row.actualDepartureAt?.toISOString() ?? null,
    expectedArrivalAt: row.expectedArrivalAt?.toISOString() ?? null,
    actualArrivalAt: row.actualArrivalAt?.toISOString() ?? null,
    packageCount: row.transfer.items.length,
    packages: row.transfer.items.map((item) => ({
      packageId: item.packageId,
      trackingId: item.package.trackingId,
      packageStatus: item.package.operationalStatus,
      itemStatus: item.itemStatus,
    })),
    stops: row.stops.map((stop) => ({
      id: stop.id,
      sequence: stop.sequence,
      label: stop.label,
      latitude: stop.latitude?.toString() ?? null,
      longitude: stop.longitude?.toString() ?? null,
      passedAt: stop.passedAt?.toISOString() ?? null,
      recordedByName: stop.recordedBy.fullName,
      notes: stop.notes,
      createdAt: stop.createdAt.toISOString(),
    })),
    createdAt: row.createdAt.toISOString(),
  };
}

async function loadTripOr404(tripId: string): Promise<TripRow> {
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    include: tripInclude,
  });
  if (!trip) throw new NotFoundError("Trip not found");
  return trip;
}

/** Progress actors: the assigned driver, or a warehouse member of the
 *  relevant side (origin for departure, destination for arrival), or
 *  an unscoped overseer. */
function isTripProgressActor(
  actor: ActorContext,
  trip: TripRow,
  side: "origin" | "destination" | "any",
): boolean {
  if (isUnscoped(actor)) return true;
  if (actor.driverId && trip.driverId === actor.driverId) return true;
  if (side === "origin") return actor.warehouseIds.includes(trip.transfer.originWarehouseId);
  if (side === "destination") {
    return actor.warehouseIds.includes(trip.transfer.destinationWarehouseId);
  }
  return (
    actor.warehouseIds.includes(trip.transfer.originWarehouseId) ||
    actor.warehouseIds.includes(trip.transfer.destinationWarehouseId)
  );
}

async function assertProgressScope(
  actor: ActorContext,
  trip: TripRow,
  side: "origin" | "destination" | "any",
): Promise<void> {
  if (isTripProgressActor(actor, trip, side)) return;
  await auditAccessDenied(actor, "Trip", {
    entityId: trip.id,
    reason: "trip_progress_out_of_scope",
  });
  throw new AuthorizationError("You are not assigned to this trip and do not oversee either end of it");
}

// ---------------------------------------------------------------------------
// Departure / arrival — the package-carrying transitions
// ---------------------------------------------------------------------------

export async function departTrip(
  actor: ActorContext,
  tripId: string,
): Promise<TripView> {
  await requirePermAudited(actor, "trip.update_progress", "Trip");
  const trip = await loadTripOr404(tripId);
  await assertProgressScope(actor, trip, "origin");
  if (trip.status !== "DISPATCHED") {
    throw new ConflictError(`Only a DISPATCHED trip can depart (current: ${trip.status})`);
  }
  const transfer = trip.transfer;
  await prisma.$transaction(async (tx) => {
    for (const item of transfer.items) {
      await transitionPackageInTx(tx, actor, item.packageId, "IN_TRANSIT", {
        warehouseId: transfer.originWarehouseId,
        transferId: transfer.id,
        tripId: trip.id,
        notes: `Trip ${trip.tripNumber} departed ${transfer.originWarehouse.code}`,
      });
      await tx.transferItem.update({
        where: { id: item.id },
        data: { itemStatus: "IN_TRANSIT" },
      });
    }
    await tx.trip.update({
      where: { id: trip.id },
      data: { status: "IN_TRANSIT", actualDepartureAt: new Date() },
    });
    await tx.transfer.update({
      where: { id: transfer.id },
      data: { status: "IN_TRANSIT" },
    });
  });
  await auditOps(actor, "trip.departed", "Trip", trip.id, {
    warehouseId: transfer.originWarehouseId,
    after: { transferId: transfer.id, packageCount: transfer.items.length },
  });
  return toTripView(await loadTripOr404(tripId));
}

export async function arriveTrip(
  actor: ActorContext,
  tripId: string,
): Promise<TripView> {
  await requirePermAudited(actor, "trip.update_progress", "Trip");
  const trip = await loadTripOr404(tripId);
  await assertProgressScope(actor, trip, "destination");
  if (trip.status !== "IN_TRANSIT" && trip.status !== "DELAYED") {
    throw new ConflictError(`Only an IN_TRANSIT trip can record arrival (current: ${trip.status})`);
  }
  const transfer = trip.transfer;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const item of transfer.items) {
      // Only packages still on the truck transition; a package whose
      // state moved on (e.g. resolved mid-trip) is left untouched.
      if (item.package.operationalStatus !== "IN_TRANSIT") continue;
      await transitionPackageInTx(tx, actor, item.packageId, "ARRIVED_AT_DESTINATION", {
        warehouseId: transfer.destinationWarehouseId,
        transferId: transfer.id,
        tripId: trip.id,
        notes: `Trip ${trip.tripNumber} arrived at ${transfer.destinationWarehouse.code}`,
      });
    }
    await tx.trip.update({
      where: { id: trip.id },
      data: { status: "ARRIVED", actualArrivalAt: now },
    });
    await tx.transfer.update({
      where: { id: transfer.id },
      data: { status: "ARRIVED", arrivedAt: now },
    });
  });
  await auditOps(actor, "trip.arrived", "Trip", trip.id, {
    warehouseId: transfer.destinationWarehouseId,
    after: { transferId: transfer.id },
  });
  return toTripView(await loadTripOr404(tripId));
}

// ---------------------------------------------------------------------------
// Checkpoints, delay, resume
// ---------------------------------------------------------------------------

export const checkpointSchema = z.object({
  label: z.string().min(1).max(200),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});
export type CheckpointInput = z.input<typeof checkpointSchema>;

export async function recordCheckpoint(
  actor: ActorContext,
  tripId: string,
  input: CheckpointInput,
): Promise<TripView> {
  const data = parse(checkpointSchema, input);
  await requirePermAudited(actor, "trip.update_progress", "Trip");
  const trip = await loadTripOr404(tripId);
  await assertProgressScope(actor, trip, "any");
  if (!["IN_TRANSIT", "DELAYED", "ARRIVED"].includes(trip.status)) {
    throw new ConflictError(`Checkpoints are recorded while the trip is moving (current: ${trip.status})`);
  }
  await prisma.$transaction(async (tx) => {
    // Sequence is derived from the stop rows in this transaction
    // (P4-1); the (tripId, sequence) unique index backstops races.
    const count = await tx.tripStop.count({ where: { tripId } });
    await tx.tripStop.create({
      data: {
        tripId,
        sequence: count + 1,
        label: data.label,
        latitude: data.latitude != null ? new Prisma.Decimal(data.latitude) : null,
        longitude: data.longitude != null ? new Prisma.Decimal(data.longitude) : null,
        passedAt: new Date(),
        recordedById: actor.userId,
        notes: data.notes ?? null,
      },
    });
  });
  return toTripView(await loadTripOr404(tripId));
}

export const delaySchema = z.object({
  reason: z.string().min(1).max(500),
  revisedExpectedArrivalAt: z.string().datetime().optional().nullable(),
});
export type DelayInput = z.input<typeof delaySchema>;

export async function reportTripDelay(
  actor: ActorContext,
  tripId: string,
  input: DelayInput,
): Promise<TripView> {
  const data = parse(delaySchema, input);
  await requirePermAudited(actor, "trip.update_progress", "Trip");
  const trip = await loadTripOr404(tripId);
  await assertProgressScope(actor, trip, "any");
  if (trip.status !== "IN_TRANSIT" && trip.status !== "DELAYED") {
    throw new ConflictError(`Only a moving trip can report a delay (current: ${trip.status})`);
  }
  const revised = data.revisedExpectedArrivalAt
    ? new Date(data.revisedExpectedArrivalAt)
    : null;
  await prisma.$transaction(async (tx) => {
    const count = await tx.tripStop.count({ where: { tripId } });
    await tx.tripStop.create({
      data: {
        tripId,
        sequence: count + 1,
        label: `Delay reported: ${data.reason}`,
        passedAt: new Date(),
        recordedById: actor.userId,
        notes: data.reason,
      },
    });
    await tx.trip.update({
      where: { id: tripId },
      data: {
        status: "DELAYED",
        ...(revised ? { expectedArrivalAt: revised } : {}),
      },
    });
    if (revised) {
      // Expected arrival revisions are timestamped + attributed
      // (workflow §7 rule 4): the audit row below is the attribution.
      await tx.transfer.update({
        where: { id: trip.transferId },
        data: { expectedArrivalAt: revised },
      });
    }
  });
  await auditOps(actor, "trip.delayed", "Trip", tripId, {
    warehouseId: trip.transfer.originWarehouseId,
    after: { reason: data.reason, revisedExpectedArrivalAt: revised?.toISOString() ?? null },
  });
  return toTripView(await loadTripOr404(tripId));
}

export async function resumeTrip(
  actor: ActorContext,
  tripId: string,
): Promise<TripView> {
  await requirePermAudited(actor, "trip.update_progress", "Trip");
  const trip = await loadTripOr404(tripId);
  await assertProgressScope(actor, trip, "any");
  if (trip.status !== "DELAYED") {
    throw new ConflictError(`Only a DELAYED trip can resume (current: ${trip.status})`);
  }
  await prisma.trip.update({ where: { id: tripId }, data: { status: "IN_TRANSIT" } });
  await auditOps(actor, "trip.resumed", "Trip", tripId, {
    warehouseId: trip.transfer.originWarehouseId,
  });
  return toTripView(await loadTripOr404(tripId));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getTrip(actor: ActorContext, tripId: string): Promise<TripView> {
  if (
    !hasPermission(actor, "trip.read_assigned") &&
    !hasPermission(actor, "transfer.read_all") &&
    !hasPermission(actor, "transfer.read_warehouse")
  ) {
    await auditAccessDenied(actor, "Trip", {
      entityId: tripId,
      reason: "missing_permission:trip.read",
    });
    throw new AuthorizationError("Missing required permission to read trips");
  }
  const trip = await loadTripOr404(tripId);
  await assertTransferReadable(actor, {
    id: trip.transferId,
    originWarehouseId: trip.transfer.originWarehouseId,
    destinationWarehouseId: trip.transfer.destinationWarehouseId,
    driverId: trip.driverId,
  });
  return toTripView(trip);
}

export interface ListTripsQuery {
  status?: string;
  driverId?: string;
  mine?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listTrips(
  actor: ActorContext,
  query: ListTripsQuery = {},
): Promise<{ items: TripView[]; total: number; page: number; pageSize: number; totalPages: number }> {
  if (
    !hasPermission(actor, "trip.read_assigned") &&
    !hasPermission(actor, "transfer.read_all") &&
    !hasPermission(actor, "transfer.read_warehouse")
  ) {
    await auditAccessDenied(actor, "Trip", { reason: "missing_permission:trip.read" });
    throw new AuthorizationError("Missing required permission to read trips");
  }
  // Scope composes with explicit AND (P3-1).
  const conditions: Prisma.TripWhereInput[] = [];
  const readAll = hasPermission(actor, "transfer.read_all");
  if (!readAll) {
    const scopeOr: Prisma.TripWhereInput[] = [
      { transfer: { originWarehouseId: { in: actor.warehouseIds } } },
      { transfer: { destinationWarehouseId: { in: actor.warehouseIds } } },
    ];
    if (actor.driverId) scopeOr.push({ driverId: actor.driverId });
    conditions.push({ OR: scopeOr });
  }
  if (query.mine) {
    if (!actor.driverId) {
      return { items: [], ...pageMeta(0, query.page ?? 1, query.pageSize ?? 25) };
    }
    conditions.push({ driverId: actor.driverId });
  }
  if (query.driverId) conditions.push({ driverId: query.driverId });
  if (query.status) conditions.push({ status: query.status });
  const where: Prisma.TripWhereInput =
    conditions.length > 0 ? { AND: conditions } : {};

  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  const [total, rows] = await Promise.all([
    prisma.trip.count({ where }),
    prisma.trip.findMany({
      where,
      include: tripInclude,
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
  ]);
  return { items: rows.map(toTripView), ...pageMeta(total, page, pageSize) };
}

/** The driver's own current trip (the LD dashboard's centrepiece):
 *  the newest non-terminal trip assigned to them, or null. */
export async function getMyActiveTrip(actor: ActorContext): Promise<TripView | null> {
  if (!actor.driverId) return null;
  const trip = await prisma.trip.findFirst({
    where: {
      driverId: actor.driverId,
      status: {
        in: ["ASSIGNED", "LOADING", "DISPATCHED", "IN_TRANSIT", "DELAYED", "ARRIVED", "UNLOADING", "INCIDENT"],
      },
    },
    include: tripInclude,
    orderBy: { createdAt: "desc" },
  });
  return trip ? toTripView(trip) : null;
}
