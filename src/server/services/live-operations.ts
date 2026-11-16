import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  hasPermission,
  type ActorContext,
} from "@/lib/auth/actor";
import { NotFoundError } from "@/lib/errors";
import {
  computeFreshness,
  type TrackingConfig,
} from "@/lib/tracking/config";
import type { FreshnessState } from "@/lib/tracking/domain";
import {
  auditAccessDenied,
  requirePermAudited,
} from "@/server/services/scoping";
import { loadTrackingConfig } from "@/server/services/tracking";
import { isUnscoped } from "@/server/services/warehouse-ops-shared";

/**
 * Live operations — the Phase 3 (V2) GPS read path for the ops
 * console. Lists the drivers currently being tracked (plus sessions
 * that ended inside the recent window) with their latest known
 * position, and serves the per-session package detail.
 *
 * Data source rule: positions come ONLY from the DriverCurrentLocation
 * snapshot projection (one row per driver, upserted per accepted
 * ping). The append-only DriverLocationPing ledger is never queried
 * here — live views read the projection, history reads the ledger.
 *
 * Scope rule: `operations.live_view` (SUPER_ADMIN / ADMIN /
 * WAREHOUSE_ADMIN) gates every read, denials audited. Global actors
 * (warehouse.read_all) see every session; scoped actors see only
 * sessions whose origin OR destination warehouse is one of their
 * memberships. A requested warehouse filter is intersected with that
 * authority — it can narrow, never widen.
 *
 * Privacy rule: the detail view exposes package tracking ids and
 * statuses ONLY — no recipient names, phones, addresses, or
 * per-package COD. Batch COD totals appear only for actors holding
 * finance.read or cod.read, and the field is ABSENT (not null) when
 * the actor may not see it.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Tracking config loader is shared with the write path:
 *  loadTrackingConfig from services/tracking (SystemSetting override
 *  merged over the defaults in src/lib/tracking/config.ts). */

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export type LiveOpsScope = { global: true } | { warehouseIds: string[] };

/**
 * The permission gate + scope for every live-operations read.
 * Throws (audited) AuthorizationError when the actor lacks
 * operations.live_view. Global actors get `{ global: true }`;
 * everyone else is scoped to their active warehouse memberships.
 */
export async function liveOpsScope(actor: ActorContext): Promise<LiveOpsScope> {
  await requirePermAudited(actor, "operations.live_view", "LiveOperation");
  if (isUnscoped(actor)) return { global: true };
  return { warehouseIds: [...actor.warehouseIds] };
}

function inScope(
  scope: LiveOpsScope,
  originWarehouseId: string,
  destinationWarehouseId: string | null,
): boolean {
  if ("global" in scope) return true;
  return (
    scope.warehouseIds.includes(originWarehouseId) ||
    (destinationWarehouseId !== null &&
      scope.warehouseIds.includes(destinationWarehouseId))
  );
}

/** The session-scope OR condition for list queries (scoped actors). */
function scopeCondition(scope: LiveOpsScope): Prisma.TrackingSessionWhereInput | null {
  if ("global" in scope) return null;
  return {
    OR: [
      { originWarehouseId: { in: scope.warehouseIds } },
      { destinationWarehouseId: { in: scope.warehouseIds } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface LiveOperationWarehouseView {
  warehouseId: string;
  code: string;
  name: string;
}

export interface LiveOperationLocationView {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  lastRecordedAt: string;
  lastReceivedAt: string;
}

export interface LiveOperationItem {
  trackingSessionId: string;
  driverId: string;
  driverName: string;
  trackingType: string;
  sessionStatus: string;
  tripId: string | null;
  tripNumber: string | null;
  deliveryBatchId: string | null;
  batchKind: string | null;
  origin: LiveOperationWarehouseView;
  destination: LiveOperationWarehouseView | null;
  vehicleRegistration: string | null;
  packageCount: number;
  /** Batch sessions only; null for trips. */
  deliveredCount: number | null;
  /** Batch sessions only; null for trips. */
  remainingCount: number | null;
  /** Batch sessions only, and only when the actor holds finance.read
   *  or cod.read — the key is absent from the object otherwise. */
  codCollectedPaisa?: string;
  location: LiveOperationLocationView | null;
  freshnessState: FreshnessState;
}

export type LiveOperationPackageView =
  | {
      packageId: string;
      trackingId: string;
      packageStatus: string;
      itemStatus: string;
    }
  | {
      packageId: string;
      trackingId: string;
      packageStatus: string;
      assignmentStatus: string;
    };

export interface LiveOperationDetail extends LiveOperationItem {
  packages: LiveOperationPackageView[];
}

// ---------------------------------------------------------------------------
// Row loading
// ---------------------------------------------------------------------------

const warehouseSelect = {
  select: { id: true, code: true, name: true },
} as const;

const liveSessionInclude = {
  driver: { include: { user: { select: { fullName: true } } } },
  originWarehouse: warehouseSelect,
  destinationWarehouse: warehouseSelect,
  trip: {
    include: {
      transfer: {
        include: {
          originWarehouse: warehouseSelect,
          destinationWarehouse: warehouseSelect,
          items: {
            include: {
              package: { select: { trackingId: true, operationalStatus: true } },
            },
            orderBy: { createdAt: "asc" as const },
          },
        },
      },
      vehicle: { select: { registration: true } },
    },
  },
  deliveryBatch: {
    include: {
      warehouse: warehouseSelect,
      assignments: {
        include: {
          package: { select: { trackingId: true, operationalStatus: true } },
        },
        orderBy: [{ routeSequence: "asc" as const }, { createdAt: "asc" as const }],
      },
    },
  },
  currentLocations: {
    select: {
      latitude: true,
      longitude: true,
      accuracyMeters: true,
      lastRecordedAt: true,
      lastReceivedAt: true,
    },
  },
} satisfies Prisma.TrackingSessionInclude;

type LiveSessionRow = Prisma.TrackingSessionGetPayload<{
  include: typeof liveSessionInclude;
}>;

/** Assignment statuses that still owe the rider a visit — the same
 *  remaining-work definition as the delivery day summary
 *  (deliveries.ts getRiderDaySummary counts COMPLETED as delivered). */
const REMAINING_ASSIGNMENT_STATUSES: ReadonlySet<string> = new Set([
  "PENDING",
  "ACCEPTED",
  "IN_PROGRESS",
]);

function toWarehouseView(row: {
  id: string;
  code: string;
  name: string;
}): LiveOperationWarehouseView {
  return { warehouseId: row.id, code: row.code, name: row.name };
}

function toItem(
  row: LiveSessionRow,
  now: Date,
  config: TrackingConfig,
  codByBatchId: ReadonlyMap<string, bigint> | null,
): LiveOperationItem {
  // The snapshot projection holds at most one row per driver; the
  // relation scopes it to THIS session, so a driver who has since
  // started a newer session yields no snapshot here.
  const snapshot = row.currentLocations[0] ?? null;

  let origin: LiveOperationWarehouseView;
  let destination: LiveOperationWarehouseView | null;
  let packageCount: number;
  let deliveredCount: number | null = null;
  let remainingCount: number | null = null;

  if (row.trip) {
    origin = toWarehouseView(row.trip.transfer.originWarehouse);
    destination = toWarehouseView(row.trip.transfer.destinationWarehouse);
    packageCount = row.trip.transfer.items.length;
  } else if (row.deliveryBatch) {
    origin = toWarehouseView(row.deliveryBatch.warehouse);
    destination = null;
    const assignments = row.deliveryBatch.assignments;
    packageCount = assignments.length;
    deliveredCount = assignments.filter((a) => a.status === "COMPLETED").length;
    remainingCount = assignments.filter((a) =>
      REMAINING_ASSIGNMENT_STATUSES.has(a.status),
    ).length;
  } else {
    // Defensive: a session with neither assignment attached (the
    // schema permits the pair of FKs to both be null mid-creation).
    origin = toWarehouseView(row.originWarehouse);
    destination = row.destinationWarehouse
      ? toWarehouseView(row.destinationWarehouse)
      : null;
    packageCount = 0;
  }

  const item: LiveOperationItem = {
    trackingSessionId: row.id,
    driverId: row.driverId,
    driverName: row.driver.user.fullName,
    trackingType: row.trackingType,
    sessionStatus: row.status,
    tripId: row.tripId,
    tripNumber: row.trip?.tripNumber ?? null,
    deliveryBatchId: row.deliveryBatchId,
    batchKind: row.deliveryBatch?.kind ?? null,
    origin,
    destination,
    vehicleRegistration: row.trip?.vehicle.registration ?? null,
    packageCount,
    deliveredCount,
    remainingCount,
    location: snapshot
      ? {
          latitude: snapshot.latitude,
          longitude: snapshot.longitude,
          accuracyMeters: snapshot.accuracyMeters,
          lastRecordedAt: snapshot.lastRecordedAt.toISOString(),
          lastReceivedAt: snapshot.lastReceivedAt.toISOString(),
        }
      : null,
    freshnessState: computeFreshness({
      sessionStatus: row.status,
      lastReceivedAt: snapshot?.lastReceivedAt ?? null,
      now,
      config,
    }),
  };

  // COD: batch sessions only, permitted actors only — absent key
  // (never null) when the actor may not see money.
  if (row.deliveryBatchId && codByBatchId) {
    item.codCollectedPaisa = (
      codByBatchId.get(row.deliveryBatchId) ?? BigInt(0)
    ).toString();
  }
  return item;
}

/** Sum DeliveryCodCollection.collectedPaisa per batch in ONE grouped
 *  query. Returns null when the actor may not read COD at all, which
 *  is what keeps the field absent from every item. */
async function loadCodByBatchId(
  actor: ActorContext,
  batchIds: string[],
): Promise<Map<string, bigint> | null> {
  const mayReadCod =
    hasPermission(actor, "finance.read") || hasPermission(actor, "cod.read");
  if (!mayReadCod || batchIds.length === 0) return null;
  const rows = await prisma.deliveryCodCollection.groupBy({
    by: ["batchId"],
    where: { batchId: { in: batchIds } },
    _sum: { collectedPaisa: true },
  });
  const map = new Map<string, bigint>();
  for (const row of rows) {
    if (row.batchId) map.set(row.batchId, row._sum.collectedPaisa ?? BigInt(0));
  }
  return map;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export interface ListLiveOperationsQuery {
  warehouseId?: string;
}

export async function listLiveOperations(
  actor: ActorContext,
  query: ListLiveOperationsQuery = {},
): Promise<{ items: LiveOperationItem[]; total: number }> {
  const scope = await liveOpsScope(actor);
  const config = await loadTrackingConfig();
  const now = new Date();

  // A requested warehouse outside a scoped actor's authority yields
  // an empty board — the filter intersects scope, it never widens it.
  if (
    query.warehouseId &&
    !("global" in scope) &&
    !scope.warehouseIds.includes(query.warehouseId)
  ) {
    return { items: [], total: 0 };
  }

  const conditions: Prisma.TrackingSessionWhereInput[] = [
    {
      OR: [
        { status: { in: ["ACTIVE", "PAUSED"] } },
        {
          status: "ENDED",
          endedAt: {
            gte: new Date(now.getTime() - config.recentWindowMinutes * 60_000),
          },
        },
      ],
    },
  ];
  const scopeCond = scopeCondition(scope);
  if (scopeCond) conditions.push(scopeCond);
  if (query.warehouseId) {
    conditions.push({
      OR: [
        { originWarehouseId: query.warehouseId },
        { destinationWarehouseId: query.warehouseId },
      ],
    });
  }

  const rows = await prisma.trackingSession.findMany({
    where: { AND: conditions },
    include: liveSessionInclude,
  });

  const codByBatchId = await loadCodByBatchId(
    actor,
    rows
      .map((row) => row.deliveryBatchId)
      .filter((id): id is string => id !== null),
  );

  // Order: live sessions first (ACTIVE, then PAUSED) by the freshest
  // snapshot first (no snapshot sorts last), then recent ENDED by
  // endedAt desc. lastReceivedAt lives on the snapshot, not the
  // session, so the ordering is applied here rather than in SQL.
  const statusRank = (status: string): number =>
    status === "ACTIVE" ? 0 : status === "PAUSED" ? 1 : 2;
  const decorated = rows.map((row) => ({
    item: toItem(row, now, config, codByBatchId),
    rank: statusRank(row.status),
    lastReceivedAt: row.currentLocations[0]?.lastReceivedAt ?? null,
    endedAt: row.endedAt,
  }));
  decorated.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank === 2) {
      return (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0);
    }
    if (a.lastReceivedAt && b.lastReceivedAt) {
      return b.lastReceivedAt.getTime() - a.lastReceivedAt.getTime();
    }
    if (a.lastReceivedAt) return -1;
    if (b.lastReceivedAt) return 1;
    return 0;
  });

  const items = decorated.map((d) => d.item);
  return { items, total: items.length };
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

export async function getLiveOperationDetail(
  actor: ActorContext,
  trackingSessionId: string,
): Promise<LiveOperationDetail> {
  const scope = await liveOpsScope(actor);
  const config = await loadTrackingConfig();
  const now = new Date();

  const row = await prisma.trackingSession.findUnique({
    where: { id: trackingSessionId },
    include: liveSessionInclude,
  });
  if (!row) throw new NotFoundError("Tracking session not found");

  if (!inScope(scope, row.originWarehouseId, row.destinationWarehouseId)) {
    await auditAccessDenied(actor, "LiveOperation", {
      entityId: row.id,
      reason: "live_operation_out_of_scope",
    });
    throw new AuthorizationError(
      "This live operation is outside your assigned scope",
    );
  }

  const codByBatchId = row.deliveryBatchId
    ? await loadCodByBatchId(actor, [row.deliveryBatchId])
    : null;
  const item = toItem(row, now, config, codByBatchId);

  // Packages: tracking ids + statuses ONLY (see the privacy rule in
  // the module header) — no recipient data, no per-package COD.
  let packages: LiveOperationPackageView[] = [];
  if (row.trip) {
    packages = row.trip.transfer.items.map((transferItem) => ({
      packageId: transferItem.packageId,
      trackingId: transferItem.package.trackingId,
      packageStatus: transferItem.package.operationalStatus,
      itemStatus: transferItem.itemStatus,
    }));
  } else if (row.deliveryBatch) {
    packages = row.deliveryBatch.assignments.map((assignment) => ({
      packageId: assignment.packageId,
      trackingId: assignment.package.trackingId,
      packageStatus: assignment.package.operationalStatus,
      assignmentStatus: assignment.status,
    }));
  }

  return { ...item, packages };
}
