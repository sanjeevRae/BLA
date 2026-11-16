import "server-only";

import { Prisma, type DriverLocationPing, type TrackingSession } from "@prisma/client";
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
  RateLimitError,
} from "@/lib/errors";
import {
  computeFreshness,
  resolveTrackingConfig,
  toTrackingClientConfig,
  TRACKING_CONFIG_SETTING_KEY,
  type TrackingClientConfig,
  type TrackingConfig,
} from "@/lib/tracking/config";
import {
  ACTIVE_BATCH_STATUSES_FOR_TRACKING,
  ACTIVE_TRIP_STATUSES_FOR_TRACKING,
  TERMINAL_BATCH_STATUSES,
  TERMINAL_TRIP_STATUSES,
  type TrackingEndReason,
} from "@/lib/tracking/domain";
import {
  auditAccessDenied,
  isUniqueViolation,
  isUniqueViolationOn,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import { auditOps, isUnscoped } from "@/server/services/warehouse-ops-shared";

/**
 * Driver-side GPS tracking WRITE path (Phase 3 V2): session
 * lifecycle (start / pause / resume / stop), the location-ping
 * ingest transaction, assignment-completion auto-end hooks, and the
 * maintenance sweeps (abandoned-session expiry, ping retention).
 * Live-operations READS live in a separate service.
 *
 * Concurrency: every session mutation takes the TrackingSession row
 * lock (SELECT … FOR UPDATE) inside its transaction, so a ping can
 * never slip in after a stop/pause/auto-end has committed, and vice
 * versa. The one-active-session-per-driver partial unique index is
 * the race backstop for concurrent starts.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Load the tracking config: the SystemSetting override row merged
 *  over TRACKING_CONFIG_DEFAULTS. Never cached — an operator's edit
 *  takes effect on the next call. */
export async function loadTrackingConfig(): Promise<TrackingConfig> {
  const row = await prisma.systemSetting.findUnique({
    where: { key: TRACKING_CONFIG_SETTING_KEY },
  });
  return resolveTrackingConfig(row?.value);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface TrackingSessionView {
  id: string;
  driverId: string;
  tripId: string | null;
  deliveryBatchId: string | null;
  trackingType: string;
  originWarehouseId: string;
  destinationWarehouseId: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
  startReason: string;
  endReason: string | null;
  permissionAcknowledgedAt: string;
  createdAt: string;
  updatedAt: string;
}

export function toTrackingSessionView(row: TrackingSession): TrackingSessionView {
  return {
    id: row.id,
    driverId: row.driverId,
    tripId: row.tripId,
    deliveryBatchId: row.deliveryBatchId,
    trackingType: row.trackingType,
    originWarehouseId: row.originWarehouseId,
    destinationWarehouseId: row.destinationWarehouseId,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    startReason: row.startReason,
    endReason: row.endReason,
    permissionAcknowledgedAt: row.permissionAcknowledgedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface LocationPingView {
  id: string;
  trackingSessionId: string;
  driverId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
  recordedAt: string;
  receivedAt: string;
  sequenceId: number;
  source: string;
  createdAt: string;
}

export function toLocationPingView(row: DriverLocationPing): LocationPingView {
  return {
    id: row.id,
    trackingSessionId: row.trackingSessionId,
    driverId: row.driverId,
    latitude: row.latitude,
    longitude: row.longitude,
    accuracyMeters: row.accuracyMeters,
    speedMetersPerSecond: row.speedMetersPerSecond,
    headingDegrees: row.headingDegrees,
    recordedAt: row.recordedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    sequenceId: row.sequenceId,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface PostLocationPingResult {
  deduplicated: boolean;
  ping: LocationPingView;
  freshnessState: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

/** Lock the TrackingSession row for the duration of the caller's
 *  transaction — the serialisation point shared by pings, stops,
 *  pauses and auto-ends. */
async function lockSessionRow(tx: Tx, sessionId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "app"."TrackingSession" WHERE "id" = ${sessionId} FOR UPDATE`,
  );
}

async function loadSessionOr404(sessionId: string): Promise<TrackingSession> {
  if (!sessionId) {
    throw new DomainValidationError("trackingSessionId is required");
  }
  const session = await prisma.trackingSession.findUnique({
    where: { id: sessionId },
  });
  if (!session) throw new NotFoundError("Tracking session not found");
  return session;
}

/** Mark the driver's current-location snapshot OFFLINE when it
 *  points at the given session (runs inside the caller's tx). */
async function markSnapshotOfflineInTx(
  tx: Tx,
  driverId: string,
  sessionId: string,
): Promise<void> {
  const snapshot = await tx.driverCurrentLocation.findUnique({
    where: { driverId },
    select: { trackingSessionId: true },
  });
  if (snapshot && snapshot.trackingSessionId === sessionId) {
    await tx.driverCurrentLocation.update({
      where: { driverId },
      data: { freshnessState: "OFFLINE" },
    });
  }
}

// ---------------------------------------------------------------------------
// Start session
// ---------------------------------------------------------------------------

export const startTrackingSessionSchema = z.object({
  tripId: z.string().min(1).optional(),
  deliveryBatchId: z.string().min(1).optional(),
  permissionAcknowledged: z.boolean(),
});
export type StartTrackingSessionInput = z.input<typeof startTrackingSessionSchema>;

export async function startTrackingSession(
  actor: ActorContext,
  input: unknown,
): Promise<TrackingSessionView> {
  const data = parse(startTrackingSessionSchema, input);
  await requirePermAudited(actor, "tracking.manage_own", "TrackingSession");
  if (!actor.driverId) {
    throw new AuthorizationError("Only drivers can start a tracking session");
  }
  const hasTrip = data.tripId != null;
  const hasBatch = data.deliveryBatchId != null;
  if (hasTrip === hasBatch) {
    throw new DomainValidationError(
      "Exactly one of tripId or deliveryBatchId must be provided",
    );
  }
  if (data.permissionAcknowledged !== true) {
    throw new DomainValidationError(
      "Tracking requires the driver's explicit acknowledgement",
    );
  }

  let trackingType: string;
  let originWarehouseId: string;
  let destinationWarehouseId: string | null;

  if (hasTrip) {
    const trip = await prisma.trip.findUnique({
      where: { id: data.tripId! },
      include: { transfer: true },
    });
    if (!trip) throw new NotFoundError("Trip not found");
    if (trip.driverId !== actor.driverId) {
      await auditAccessDenied(actor, "TrackingSession", {
        entityId: trip.id,
        reason: "tracking_trip_not_assigned_to_driver",
      });
      throw new AuthorizationError("This trip is not assigned to you");
    }
    if (
      !(ACTIVE_TRIP_STATUSES_FOR_TRACKING as readonly string[]).includes(trip.status)
    ) {
      throw new ConflictError(
        `Trip is ${trip.status} — GPS tracking can only run on an active trip`,
      );
    }
    trackingType = "LINEHAUL";
    originWarehouseId = trip.transfer.originWarehouseId;
    destinationWarehouseId = trip.transfer.destinationWarehouseId;
  } else {
    const batch = await prisma.deliveryBatch.findUnique({
      where: { id: data.deliveryBatchId! },
    });
    if (!batch) throw new NotFoundError("Delivery batch not found");
    if (batch.riderId !== actor.driverId) {
      await auditAccessDenied(actor, "TrackingSession", {
        entityId: batch.id,
        reason: "tracking_batch_not_assigned_to_driver",
      });
      throw new AuthorizationError("This batch is not assigned to you");
    }
    if (
      !(ACTIVE_BATCH_STATUSES_FOR_TRACKING as readonly string[]).includes(batch.status)
    ) {
      throw new ConflictError(
        `Batch is ${batch.status} — GPS tracking can only run on an open or in-progress batch`,
      );
    }
    trackingType = batch.kind === "PICKUP" ? "PICKUP" : "DELIVERY";
    originWarehouseId = batch.warehouseId;
    destinationWarehouseId = null;
  }

  const existing = await prisma.trackingSession.findFirst({
    where: { driverId: actor.driverId, status: { in: ["ACTIVE", "PAUSED"] } },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError("You already have an active tracking session");
  }

  const now = new Date();
  let created: TrackingSession;
  try {
    created = await prisma.trackingSession.create({
      data: {
        driverId: actor.driverId,
        tripId: data.tripId ?? null,
        deliveryBatchId: data.deliveryBatchId ?? null,
        trackingType,
        originWarehouseId,
        destinationWarehouseId,
        status: "ACTIVE",
        startReason: "DRIVER",
        permissionAcknowledgedAt: now,
      },
    });
  } catch (error) {
    if (isUniqueViolationOn(error, "TrackingSession_one_active_per_driver")) {
      throw new ConflictError("You already have an active tracking session");
    }
    throw error;
  }

  await auditOps(actor, "tracking.session_started", "TrackingSession", created.id, {
    warehouseId: originWarehouseId,
    after: {
      trackingType,
      tripId: data.tripId ?? null,
      deliveryBatchId: data.deliveryBatchId ?? null,
    },
  });
  return toTrackingSessionView(created);
}

// ---------------------------------------------------------------------------
// Location ping ingest
// ---------------------------------------------------------------------------

export const postLocationPingSchema = z.object({
  trackingSessionId: z.string().min(1),
  latitude: z.number(),
  longitude: z.number(),
  accuracyMeters: z.number(),
  speedMetersPerSecond: z.number().nullable().optional(),
  headingDegrees: z.number().nullable().optional(),
  recordedAt: z.string().min(1),
  // The column is a Postgres int4: bound the value here so an
  // out-of-range sequence is a clean 400, not a raw DB error
  // (Phase 3 security review F-3).
  sequenceId: z.number().int().min(0).max(2147483647),
  // Accepted so legacy clients keep working, but NEVER trusted:
  // identity always comes from the authenticated actor. A value
  // that disagrees with the actor is audit-logged and ignored.
  driverId: z.string().optional(),
});
export type PostLocationPingInput = z.input<typeof postLocationPingSchema>;

export async function postLocationPing(
  actor: ActorContext,
  input: unknown,
): Promise<PostLocationPingResult> {
  const data = parse(postLocationPingSchema, input);

  await requirePermAudited(actor, "tracking.manage_own", "TrackingSession");
  if (!actor.driverId) {
    throw new AuthorizationError("Only drivers can report locations");
  }
  const driverId = actor.driverId;
  const config = await loadTrackingConfig();
  const now = new Date();

  // -- Pre-transaction validation (device payload sanity) -----------
  if (!Number.isFinite(data.latitude) || data.latitude < -90 || data.latitude > 90) {
    throw new DomainValidationError("latitude must be between -90 and 90");
  }
  if (!Number.isFinite(data.longitude) || data.longitude < -180 || data.longitude > 180) {
    throw new DomainValidationError("longitude must be between -180 and 180");
  }
  if (
    !Number.isFinite(data.accuracyMeters) ||
    data.accuracyMeters <= 0 ||
    data.accuracyMeters > config.maxAccuracyMeters
  ) {
    throw new DomainValidationError(
      `accuracyMeters must be greater than 0 and at most ${config.maxAccuracyMeters}`,
    );
  }
  if (
    data.speedMetersPerSecond != null &&
    (!Number.isFinite(data.speedMetersPerSecond) || data.speedMetersPerSecond < 0)
  ) {
    throw new DomainValidationError("speedMetersPerSecond must be 0 or greater");
  }
  if (
    data.headingDegrees != null &&
    (!Number.isFinite(data.headingDegrees) ||
      data.headingDegrees < 0 ||
      data.headingDegrees > 360)
  ) {
    throw new DomainValidationError("headingDegrees must be between 0 and 360");
  }
  const recordedAt = new Date(data.recordedAt);
  if (Number.isNaN(recordedAt.getTime())) {
    throw new DomainValidationError("recordedAt must be a valid ISO datetime");
  }
  if (
    recordedAt.getTime() >
    now.getTime() + config.futureTimestampToleranceSeconds * 1000
  ) {
    throw new DomainValidationError("recordedAt is too far in the future");
  }

  // -- Ownership pre-check (audited denial) --------------------------
  // The authoritative re-check happens under the row lock inside the
  // transaction; this pre-check exists so a foreign-session ping is
  // audit-logged even though the transaction would roll back.
  const preSession = await prisma.trackingSession.findUnique({
    where: { id: data.trackingSessionId },
  });
  if (!preSession) throw new NotFoundError("Tracking session not found");
  if (preSession.driverId !== driverId) {
    await auditAccessDenied(actor, "TrackingSession", {
      entityId: data.trackingSessionId,
      reason: "tracking_session_not_owned",
    });
    throw new AuthorizationError("This tracking session belongs to another driver");
  }

  // Identity mismatch: log it, then continue as the actor — the
  // supplied driverId never influences identity, scoping or
  // storage. Written only AFTER the permission and ownership
  // checks above: an actor who cannot legitimately ping must not
  // be able to mint append-only audit rows at will (Phase 3
  // security review F-4).
  if (data.driverId != null && data.driverId !== driverId) {
    await prisma.auditLog.create({
      data: {
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        action: "tracking.identity_mismatch",
        entityType: "TrackingSession",
        entityId: data.trackingSessionId,
        after: { suppliedDriverId: data.driverId },
      },
    });
  }

  // -- The ingest transaction ----------------------------------------
  // Order: lock session → re-verify ownership/status → assignment
  // still active → pre-start tolerance → duplicate sequence →
  // identical-coordinates dedupe → rate limit → snapshot tie-break
  // state read → insert ping → conditional snapshot upsert.
  return prisma.$transaction(async (tx) => {
    // (a) Lock the session row — serialises against stop/pause/
    // auto-end, which take the same lock.
    await lockSessionRow(tx, data.trackingSessionId);

    // (b) Reload under the lock; ownership re-verified (authoritative).
    const session = await tx.trackingSession.findUnique({
      where: { id: data.trackingSessionId },
    });
    if (!session) throw new NotFoundError("Tracking session not found");
    if (session.driverId !== driverId) {
      throw new AuthorizationError("This tracking session belongs to another driver");
    }

    // (c) Only an ACTIVE session accepts pings — this is what makes
    // pings after stop/pause/auto-end fail, race-free.
    if (session.status !== "ACTIVE") {
      throw new ConflictError("Tracking session is not active");
    }

    // (d) The assignment must still be in a trackable state.
    if (session.tripId) {
      const trip = await tx.trip.findUnique({
        where: { id: session.tripId },
        select: { status: true },
      });
      if (
        !trip ||
        !(ACTIVE_TRIP_STATUSES_FOR_TRACKING as readonly string[]).includes(trip.status)
      ) {
        throw new ConflictError("The trip is no longer active for tracking");
      }
    } else if (session.deliveryBatchId) {
      const batch = await tx.deliveryBatch.findUnique({
        where: { id: session.deliveryBatchId },
        select: { status: true },
      });
      if (
        !batch ||
        !(ACTIVE_BATCH_STATUSES_FOR_TRACKING as readonly string[]).includes(batch.status)
      ) {
        throw new ConflictError("The batch is no longer active for tracking");
      }
    }

    // (e) Device clock sanity against the session start.
    const earliestRecordedAt =
      session.startedAt.getTime() - config.preStartToleranceSeconds * 1000;
    if (recordedAt.getTime() < earliestRecordedAt) {
      throw new DomainValidationError(
        "recordedAt is before the tracking session started",
      );
    }

    // Snapshot freshness for deduplicated returns (no writes happen
    // on those paths, so freshness is read, not recomputed blindly).
    const dedupFreshness = async (): Promise<string> => {
      const snapshot = await tx.driverCurrentLocation.findUnique({
        where: { driverId },
        select: { lastReceivedAt: true },
      });
      return computeFreshness({
        sessionStatus: session.status,
        lastReceivedAt: snapshot?.lastReceivedAt ?? null,
        now,
        config,
      });
    };

    // (f) Duplicate sequence — idempotent replay, no writes.
    const duplicate = await tx.driverLocationPing.findUnique({
      where: {
        trackingSessionId_sequenceId: {
          trackingSessionId: data.trackingSessionId,
          sequenceId: data.sequenceId,
        },
      },
    });
    if (duplicate) {
      return {
        deduplicated: true,
        ping: toLocationPingView(duplicate),
        freshnessState: await dedupFreshness(),
      };
    }

    // Last accepted ping for this session (server-clock order).
    const last = await tx.driverLocationPing.findFirst({
      where: { trackingSessionId: data.trackingSessionId },
      orderBy: [{ receivedAt: "desc" }, { sequenceId: "desc" }],
    });

    // (g) Identical coordinates — stationary device re-reporting;
    // deduplicated with no writes.
    if (last && data.latitude === last.latitude && data.longitude === last.longitude) {
      return {
        deduplicated: true,
        ping: toLocationPingView(last),
        freshnessState: await dedupFreshness(),
      };
    }

    // (h) Rate limit on the server receive clock.
    if (
      last &&
      now.getTime() - last.receivedAt.getTime() < config.minPingIntervalSeconds * 1000
    ) {
      throw new RateLimitError(
        `Location updates are limited to one every ${config.minPingIntervalSeconds} seconds`,
      );
    }

    // Snapshot tie-break state, read BEFORE the insert: whether the
    // incoming fix is newer than the snapshot, and — for an equal
    // recordedAt — the sequenceId of the ping that set the snapshot
    // (the max sequence at the snapshot's recordedAt on the
    // snapshot's own session). Reading after the insert would find
    // the new ping itself and the tie-break could never win.
    const snapshot = await tx.driverCurrentLocation.findUnique({
      where: { driverId },
    });
    let snapshotShouldUpdate = false;
    if (!snapshot) {
      snapshotShouldUpdate = true;
    } else if (snapshot.trackingSessionId !== session.id) {
      // The snapshot belongs to a superseded (ended) session.
      // SequenceIds are per-session and restart, so they are not
      // comparable across sessions: the live session's fix wins on
      // an equal recordedAt, and only a strictly older fix loses
      // (Phase 3 security review F-2).
      snapshotShouldUpdate =
        recordedAt.getTime() >= snapshot.lastRecordedAt.getTime();
    } else if (recordedAt.getTime() > snapshot.lastRecordedAt.getTime()) {
      snapshotShouldUpdate = true;
    } else if (recordedAt.getTime() === snapshot.lastRecordedAt.getTime()) {
      const snapshotPing = await tx.driverLocationPing.findFirst({
        where: {
          trackingSessionId: snapshot.trackingSessionId,
          recordedAt: snapshot.lastRecordedAt,
        },
        orderBy: { sequenceId: "desc" },
        select: { sequenceId: true },
      });
      if (snapshotPing && data.sequenceId > snapshotPing.sequenceId) {
        snapshotShouldUpdate = true;
      }
    }

    // (i) Insert the ping (server receive clock stamped here).
    const ping = await tx.driverLocationPing.create({
      data: {
        trackingSessionId: data.trackingSessionId,
        driverId,
        latitude: data.latitude,
        longitude: data.longitude,
        accuracyMeters: data.accuracyMeters,
        speedMetersPerSecond: data.speedMetersPerSecond ?? null,
        headingDegrees: data.headingDegrees ?? null,
        recordedAt,
        receivedAt: now,
        sequenceId: data.sequenceId,
        source: "BROWSER",
      },
    });

    // (j) Snapshot upsert — only when the incoming fix is newer
    // than what the snapshot already holds (out-of-order device
    // replays must not rewind the live position).
    let freshnessState: string;
    if (snapshotShouldUpdate) {
      freshnessState = computeFreshness({
        sessionStatus: "ACTIVE",
        lastReceivedAt: now,
        now,
        config,
      });
      const snapshotData = {
        trackingSessionId: session.id,
        latitude: data.latitude,
        longitude: data.longitude,
        accuracyMeters: data.accuracyMeters,
        lastRecordedAt: recordedAt,
        lastReceivedAt: now,
        freshnessState,
        activeTripId: session.tripId,
        activeBatchId: session.deliveryBatchId,
      };
      await tx.driverCurrentLocation.upsert({
        where: { driverId },
        create: { driverId, ...snapshotData },
        update: snapshotData,
      });
    } else {
      freshnessState = computeFreshness({
        sessionStatus: session.status,
        lastReceivedAt: snapshot?.lastReceivedAt ?? null,
        now,
        config,
      });
    }

    return { deduplicated: false, ping: toLocationPingView(ping), freshnessState };
  });
}

// ---------------------------------------------------------------------------
// Stop / pause / resume
// ---------------------------------------------------------------------------

/**
 * Stop a session. Two modes:
 * - Driver stop: the owning driver with tracking.manage_own.
 * - Supervisor stop: an operations.live_view holder who is unscoped
 *   or a member of the session's origin/destination warehouse;
 *   always writes the extra `tracking.session_stopped_supervisor`
 *   audit row alongside the generic stop audit.
 */
export async function stopTrackingSession(
  actor: ActorContext,
  sessionId: string,
): Promise<TrackingSessionView> {
  const session = await loadSessionOr404(sessionId);

  const isOwner = actor.driverId != null && session.driverId === actor.driverId;
  let endReason: TrackingEndReason;
  let isSupervisorStop = false;
  if (isOwner) {
    await requirePermAudited(actor, "tracking.manage_own", "TrackingSession");
    endReason = "DRIVER";
  } else if (hasPermission(actor, "operations.live_view")) {
    const inScope =
      isUnscoped(actor) ||
      actor.warehouseIds.includes(session.originWarehouseId) ||
      (session.destinationWarehouseId != null &&
        actor.warehouseIds.includes(session.destinationWarehouseId));
    if (!inScope) {
      await auditAccessDenied(actor, "TrackingSession", {
        entityId: sessionId,
        warehouseId: session.originWarehouseId,
        reason: "tracking_stop_out_of_scope",
      });
      throw new AuthorizationError(
        "This tracking session is outside your warehouse scope",
      );
    }
    endReason = "SUPERVISOR";
    isSupervisorStop = true;
  } else {
    await auditAccessDenied(actor, "TrackingSession", {
      entityId: sessionId,
      reason: "tracking_stop_not_authorized",
    });
    throw new AuthorizationError("You are not authorized to stop this tracking session");
  }

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    await lockSessionRow(tx, sessionId);
    const fresh = await tx.trackingSession.findUnique({ where: { id: sessionId } });
    if (!fresh) throw new NotFoundError("Tracking session not found");
    if (fresh.status !== "ACTIVE" && fresh.status !== "PAUSED") {
      throw new ConflictError(`Tracking session is ${fresh.status} — it cannot be stopped`);
    }
    const row = await tx.trackingSession.update({
      where: { id: sessionId },
      data: { status: "ENDED", endedAt: now, endReason },
    });
    await markSnapshotOfflineInTx(tx, fresh.driverId, sessionId);
    return row;
  });

  await auditOps(actor, "tracking.session_stopped", "TrackingSession", sessionId, {
    warehouseId: session.originWarehouseId,
    after: { endReason },
  });
  if (isSupervisorStop) {
    await auditOps(
      actor,
      "tracking.session_stopped_supervisor",
      "TrackingSession",
      sessionId,
      {
        warehouseId: session.originWarehouseId,
        after: { endReason, driverId: session.driverId },
      },
    );
  }
  return toTrackingSessionView(updated);
}

/** Owner-driver only: ACTIVE → PAUSED under the row lock. Pings are
 *  rejected while PAUSED (the ingest gate requires ACTIVE). */
export async function pauseTrackingSession(
  actor: ActorContext,
  sessionId: string,
): Promise<TrackingSessionView> {
  await requirePermAudited(actor, "tracking.manage_own", "TrackingSession");
  if (!actor.driverId) {
    throw new AuthorizationError("Only drivers can pause their tracking session");
  }
  const session = await loadSessionOr404(sessionId);
  if (session.driverId !== actor.driverId) {
    await auditAccessDenied(actor, "TrackingSession", {
      entityId: sessionId,
      reason: "tracking_session_not_owned",
    });
    throw new AuthorizationError("This tracking session belongs to another driver");
  }
  const updated = await prisma.$transaction(async (tx) => {
    await lockSessionRow(tx, sessionId);
    const fresh = await tx.trackingSession.findUnique({ where: { id: sessionId } });
    if (!fresh) throw new NotFoundError("Tracking session not found");
    if (fresh.status !== "ACTIVE") {
      throw new ConflictError(`Only an ACTIVE session can be paused (current: ${fresh.status})`);
    }
    const row = await tx.trackingSession.update({
      where: { id: sessionId },
      data: { status: "PAUSED" },
    });
    await markSnapshotOfflineInTx(tx, fresh.driverId, sessionId);
    return row;
  });
  await auditOps(actor, "tracking.session_paused", "TrackingSession", sessionId, {
    warehouseId: session.originWarehouseId,
  });
  return toTrackingSessionView(updated);
}

/** Owner-driver only: PAUSED → ACTIVE under the row lock. */
export async function resumeTrackingSession(
  actor: ActorContext,
  sessionId: string,
): Promise<TrackingSessionView> {
  await requirePermAudited(actor, "tracking.manage_own", "TrackingSession");
  if (!actor.driverId) {
    throw new AuthorizationError("Only drivers can resume their tracking session");
  }
  const session = await loadSessionOr404(sessionId);
  if (session.driverId !== actor.driverId) {
    await auditAccessDenied(actor, "TrackingSession", {
      entityId: sessionId,
      reason: "tracking_session_not_owned",
    });
    throw new AuthorizationError("This tracking session belongs to another driver");
  }
  let updated: TrackingSession;
  try {
    updated = await prisma.$transaction(async (tx) => {
      await lockSessionRow(tx, sessionId);
      const fresh = await tx.trackingSession.findUnique({ where: { id: sessionId } });
      if (!fresh) throw new NotFoundError("Tracking session not found");
      if (fresh.status !== "PAUSED") {
        throw new ConflictError(`Only a PAUSED session can be resumed (current: ${fresh.status})`);
      }
      // Re-validate the assignment under the lock (Phase 4
      // security review F1): a session whose trip/batch reached a
      // terminal state while paused — via any path that did not
      // run the auto-end hook — must not be resurrected. The ping
      // gate would refuse its locations anyway; resume refuses
      // first so the driver is not left holding a zombie ACTIVE
      // session that blocks a legitimate start.
      if (fresh.tripId) {
        const trip = await tx.trip.findUnique({
          where: { id: fresh.tripId },
          select: { status: true },
        });
        if (
          !trip ||
          !(ACTIVE_TRIP_STATUSES_FOR_TRACKING as readonly string[]).includes(trip.status)
        ) {
          throw new ConflictError("The trip is no longer active for tracking");
        }
      } else if (fresh.deliveryBatchId) {
        const batch = await tx.deliveryBatch.findUnique({
          where: { id: fresh.deliveryBatchId },
          select: { status: true },
        });
        if (
          !batch ||
          !(ACTIVE_BATCH_STATUSES_FOR_TRACKING as readonly string[]).includes(batch.status)
        ) {
          throw new ConflictError("The batch is no longer active for tracking");
        }
      }
      const row = await tx.trackingSession.update({
        where: { id: sessionId },
        data: { status: "ACTIVE" },
      });
      return row;
    });
  } catch (error) {
    // Any unique violation inside this transaction is the
    // one-active-session partial index firing on the UPDATE path
    // (its P2002 metadata does not name the index the way the
    // INSERT path does — Phase 3 security review F-1); the update
    // touches nothing else unique. Translate it to the same 409
    // the start path returns instead of leaking a raw Prisma error.
    if (isUniqueViolation(error)) {
      throw new ConflictError("You already have an active tracking session");
    }
    throw error;
  }
  await auditOps(actor, "tracking.session_resumed", "TrackingSession", sessionId, {
    warehouseId: session.originWarehouseId,
  });
  return toTrackingSessionView(updated);
}

// ---------------------------------------------------------------------------
// Own tracking state (Phase 4 driver panel)
// ---------------------------------------------------------------------------

/** An assignment the actor could start tracking right now. Own
 *  data only: the assignment belongs to the actor's driver profile
 *  by construction of the queries below. No package, recipient, or
 *  other-driver fields are included. */
export interface OwnTrackingAssignmentSummary {
  kind: "TRIP" | "BATCH";
  tripId: string | null;
  deliveryBatchId: string | null;
  trackingType: string;
  label: string;
  originWarehouseCode: string;
  originWarehouseName: string;
  destinationWarehouseCode: string | null;
  destinationWarehouseName: string | null;
  status: string;
  packageCount: number;
  completedCount: number | null;
}

export interface OwnTrackingLastPing {
  recordedAt: string;
  receivedAt: string;
  accuracyMeters: number;
  freshnessState: string;
}

export interface OwnTrackingState {
  /** The actor's most recent session in any state, or null. The
   *  panel derives its display from this plus eligibility: an
   *  ACTIVE/PAUSED session is live; an ENDED one is shown with its
   *  end reason unless a fresh assignment is waiting to start. */
  session: TrackingSessionView | null;
  /** Summary of the live (ACTIVE/PAUSED) session's own assignment,
   *  when that assignment is still in a trackable state. */
  sessionAssignment: OwnTrackingAssignmentSummary | null;
  eligibleAssignments: OwnTrackingAssignmentSummary[];
  lastPing: OwnTrackingLastPing | null;
  clientConfig: TrackingClientConfig;
}

/**
 * Everything the driver/rider tracking panel needs, for the actor
 * and nobody else: identity comes from the authenticated session
 * (actor.driverId), every query is keyed by it, and the response
 * carries no other driver's data and no recipient PII.
 */
export async function getOwnTrackingState(
  actor: ActorContext,
): Promise<OwnTrackingState> {
  await requirePermAudited(actor, "tracking.manage_own", "TrackingSession");
  const config = await loadTrackingConfig();
  const clientConfig = toTrackingClientConfig(config);
  if (!actor.driverId) {
    return {
      session: null,
      sessionAssignment: null,
      eligibleAssignments: [],
      lastPing: null,
      clientConfig,
    };
  }
  const driverId = actor.driverId;
  const now = new Date();

  const session = await prisma.trackingSession.findFirst({
    where: { driverId },
    orderBy: { startedAt: "desc" },
  });
  const liveSession =
    session && (session.status === "ACTIVE" || session.status === "PAUSED")
      ? session
      : null;

  const [trips, batches] = await Promise.all([
    prisma.trip.findMany({
      where: {
        driverId,
        status: { in: [...ACTIVE_TRIP_STATUSES_FOR_TRACKING] },
      },
      include: {
        transfer: {
          include: {
            originWarehouse: { select: { code: true, name: true } },
            destinationWarehouse: { select: { code: true, name: true } },
            _count: { select: { items: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.deliveryBatch.findMany({
      where: {
        riderId: driverId,
        status: { in: [...ACTIVE_BATCH_STATUSES_FOR_TRACKING] },
      },
      include: {
        warehouse: { select: { code: true, name: true } },
        assignments: { select: { completedAt: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const eligibleAssignments: OwnTrackingAssignmentSummary[] = [];
  let sessionAssignment: OwnTrackingAssignmentSummary | null = null;
  for (const trip of trips) {
    const summary: OwnTrackingAssignmentSummary = {
      kind: "TRIP",
      tripId: trip.id,
      deliveryBatchId: null,
      trackingType: "LINEHAUL",
      label: trip.tripNumber,
      originWarehouseCode: trip.transfer.originWarehouse.code,
      originWarehouseName: trip.transfer.originWarehouse.name,
      destinationWarehouseCode: trip.transfer.destinationWarehouse.code,
      destinationWarehouseName: trip.transfer.destinationWarehouse.name,
      status: trip.status,
      packageCount: trip.transfer._count.items,
      completedCount: null,
    };
    if (liveSession && liveSession.tripId === trip.id) sessionAssignment = summary;
    else eligibleAssignments.push(summary);
  }
  for (const batch of batches) {
    const summary: OwnTrackingAssignmentSummary = {
      kind: "BATCH",
      tripId: null,
      deliveryBatchId: batch.id,
      trackingType: batch.kind === "PICKUP" ? "PICKUP" : "DELIVERY",
      label: `${batch.warehouse.code} · ${batch.batchDate.toISOString().slice(0, 10)}`,
      originWarehouseCode: batch.warehouse.code,
      originWarehouseName: batch.warehouse.name,
      destinationWarehouseCode: null,
      destinationWarehouseName: null,
      status: batch.status,
      packageCount: batch.assignments.length,
      completedCount: batch.assignments.filter((a) => a.completedAt !== null).length,
    };
    if (liveSession && liveSession.deliveryBatchId === batch.id) {
      sessionAssignment = summary;
    } else {
      eligibleAssignments.push(summary);
    }
  }

  let lastPing: OwnTrackingLastPing | null = null;
  if (session) {
    const snapshot = await prisma.driverCurrentLocation.findUnique({
      where: { driverId },
    });
    if (snapshot && snapshot.trackingSessionId === session.id) {
      lastPing = {
        recordedAt: snapshot.lastRecordedAt.toISOString(),
        receivedAt: snapshot.lastReceivedAt.toISOString(),
        accuracyMeters: snapshot.accuracyMeters,
        freshnessState: computeFreshness({
          sessionStatus: session.status,
          lastReceivedAt: snapshot.lastReceivedAt,
          now,
          config,
        }),
      };
    }
  }

  return {
    session: session ? toTrackingSessionView(session) : null,
    sessionAssignment,
    eligibleAssignments,
    lastPing,
    clientConfig,
  };
}

// ---------------------------------------------------------------------------
// Assignment-completion auto-end hook (called inside the caller's tx)
// ---------------------------------------------------------------------------

/**
 * End every ACTIVE/PAUSED session bound to the given assignment.
 * Runs inside the caller's transaction (transfer receiving /
 * cancellation, batch close / cancel) and takes the same session
 * row lock as the ping path, so an in-flight ping either lands
 * before the end or fails the ACTIVE gate after it. Safe no-op when
 * no session exists.
 */
export async function endTrackingSessionsInTx(
  tx: Tx,
  target: { tripId?: string; deliveryBatchId?: string },
  endReason: "ASSIGNMENT_COMPLETED" | "ASSIGNMENT_CANCELLED" | "REASSIGNED",
): Promise<void> {
  if (!target.tripId && !target.deliveryBatchId) return;
  const sessions = await tx.trackingSession.findMany({
    where: {
      ...(target.tripId ? { tripId: target.tripId } : {}),
      ...(target.deliveryBatchId ? { deliveryBatchId: target.deliveryBatchId } : {}),
      status: { in: ["ACTIVE", "PAUSED"] },
    },
    select: { id: true, driverId: true },
  });
  if (sessions.length === 0) return;
  const now = new Date();
  for (const candidate of sessions) {
    await lockSessionRow(tx, candidate.id);
    const fresh = await tx.trackingSession.findUnique({
      where: { id: candidate.id },
      select: { status: true, driverId: true },
    });
    if (!fresh || (fresh.status !== "ACTIVE" && fresh.status !== "PAUSED")) continue;
    await tx.trackingSession.update({
      where: { id: candidate.id },
      data: { status: "ENDED", endedAt: now, endReason },
    });
    await markSnapshotOfflineInTx(tx, fresh.driverId, candidate.id);
  }
}

// ---------------------------------------------------------------------------
// Maintenance sweeps
// ---------------------------------------------------------------------------

/**
 * End abandoned sessions: ACTIVE/PAUSED sessions whose assignment
 * is terminal, or whose last activity (session start, latest ping
 * receive time, or the live snapshot's receive time) is older than
 * the configured abandonment window. Each session ends in its own
 * transaction under the row lock, with a system AuditLog row
 * (actorId null). Returns the number of sessions ended.
 *
 * With `dryRun: true` nothing is written: the return value is the
 * number of sessions that WOULD have been ended.
 */
export async function expireAbandonedTrackingSessions(
  now: Date = new Date(),
  options: { dryRun?: boolean } = {},
): Promise<number> {
  const config = await loadTrackingConfig();
  const cutoff = now.getTime() - config.abandonedSessionMinutes * 60 * 1000;
  const candidates = await prisma.trackingSession.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] } },
  });
  let ended = 0;
  for (const session of candidates) {
    // Assignment terminal?
    let assignmentTerminal = false;
    if (session.tripId) {
      const trip = await prisma.trip.findUnique({
        where: { id: session.tripId },
        select: { status: true },
      });
      assignmentTerminal =
        !trip || (TERMINAL_TRIP_STATUSES as readonly string[]).includes(trip.status);
    } else if (session.deliveryBatchId) {
      const batch = await prisma.deliveryBatch.findUnique({
        where: { id: session.deliveryBatchId },
        select: { status: true },
      });
      assignmentTerminal =
        !batch ||
        (TERMINAL_BATCH_STATUSES as readonly string[]).includes(batch.status);
    }

    // Last activity on the server clock.
    let lastActivity = session.startedAt.getTime();
    const lastPing = await prisma.driverLocationPing.findFirst({
      where: { trackingSessionId: session.id },
      orderBy: { receivedAt: "desc" },
      select: { receivedAt: true },
    });
    if (lastPing) {
      lastActivity = Math.max(lastActivity, lastPing.receivedAt.getTime());
    }
    const snapshot = await prisma.driverCurrentLocation.findUnique({
      where: { driverId: session.driverId },
      select: { trackingSessionId: true, lastReceivedAt: true },
    });
    if (snapshot && snapshot.trackingSessionId === session.id) {
      lastActivity = Math.max(lastActivity, snapshot.lastReceivedAt.getTime());
    }
    const abandoned = lastActivity < cutoff;
    if (!assignmentTerminal && !abandoned) continue;

    if (options.dryRun) {
      ended += 1;
      continue;
    }

    const didEnd = await prisma.$transaction(async (tx) => {
      await lockSessionRow(tx, session.id);
      const fresh = await tx.trackingSession.findUnique({
        where: { id: session.id },
        select: { status: true, driverId: true },
      });
      if (!fresh || (fresh.status !== "ACTIVE" && fresh.status !== "PAUSED")) {
        return false;
      }
      await tx.trackingSession.update({
        where: { id: session.id },
        data: { status: "ENDED", endedAt: now, endReason: "EXPIRED" },
      });
      await markSnapshotOfflineInTx(tx, fresh.driverId, session.id);
      await tx.auditLog.create({
        data: {
          actorId: null,
          actorRole: null,
          action: "tracking.session_expired",
          entityType: "TrackingSession",
          entityId: session.id,
          warehouseId: session.originWarehouseId,
          after: {
            endReason: "EXPIRED",
            assignmentTerminal,
            lastActivityAt: new Date(lastActivity).toISOString(),
          },
        },
      });
      return true;
    });
    if (didEnd) ended += 1;
  }
  return ended;
}

/**
 * Retention sweep: delete location pings received longer ago than
 * the configured retention window. Sessions and current-location
 * snapshots are never touched.
 *
 * With `dryRun: true` nothing is deleted: `deleted` reports the
 * number of pings that WOULD have been deleted (the same
 * `receivedAt < threshold` match the real sweep uses, so a ping
 * exactly at the threshold age is kept in both modes).
 */
export async function pruneExpiredLocationPings(
  now: Date = new Date(),
  options: { dryRun?: boolean } = {},
): Promise<{ deleted: number }> {
  const config = await loadTrackingConfig();
  const threshold = new Date(now.getTime() - config.retentionDays * 24 * 60 * 60 * 1000);
  if (options.dryRun) {
    const count = await prisma.driverLocationPing.count({
      where: { receivedAt: { lt: threshold } },
    });
    return { deleted: count };
  }
  const result = await prisma.driverLocationPing.deleteMany({
    where: { receivedAt: { lt: threshold } },
  });
  return { deleted: result.count };
}
