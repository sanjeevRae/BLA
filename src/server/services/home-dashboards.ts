import "server-only";

import { prisma } from "@/lib/db/prisma";
import type { ActorContext } from "@/lib/auth/actor";
import { kathmanduToday, percent } from "@/lib/reports/domain";
import { requirePermAudited } from "@/server/services/scoping";
import { getDailyReport } from "@/server/services/reports";
import { listIncidents, type IncidentView } from "@/server/services/incidents";
import { listTasks, type TaskView } from "@/server/services/tasks";
import { listRemittances } from "@/server/services/cod-remittances";
import { listTransfers, type TransferView } from "@/server/services/transfers";
import {
  listLiveOperations,
  type LiveOperationItem,
} from "@/server/services/live-operations";
import {
  getWarehouseOpsSummary,
  type WarehouseOpsSummary,
} from "@/server/services/inventory";
import { listWarehouses } from "@/server/services/warehouses";

/**
 * Role-home read models (V2 Phase 6, slices B+D): the Admin operations
 * home and the Warehouse Staff "My Work" home.
 *
 * Composition rule: every figure comes from an existing service that
 * enforces its own permission + scope (reports, incidents, tasks, COD
 * remittances, transfers, live operations, warehouse-ops summaries).
 * The only direct aggregations here are the figures NO existing
 * service exposes — awaiting-pickup packages, the transfer pipeline
 * split, and drivers currently on assignment — and each of those is
 * gated below on the matching read permission (audited denial via
 * requirePermAudited) before any count runs. Pages never query Prisma.
 *
 * "Today" is always the Asia/Kathmandu calendar day, resolved through
 * the ReportingService's own range handling (getDailyReport), so the
 * home can never disagree with the reports page about what today is.
 */

// ---------------------------------------------------------------------------
// Shared definitions
// ---------------------------------------------------------------------------

/** Booked, pickup not yet completed — the parcel still owes a pickup. */
export const AWAITING_PICKUP_STATUSES: readonly string[] = [
  "BOOKED",
  "PICKUP_ASSIGNED",
  "PICKUP_IN_PROGRESS",
];

/** Transfers approved onward and not yet reconciled/closed/cancelled. */
export const ACTIVE_TRANSFER_STATUSES: readonly string[] = [
  "APPROVED",
  "PREPARING",
  "READY_FOR_DISPATCH",
  "DISPATCHED",
  "IN_TRANSIT",
  "ARRIVED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "RECONCILIATION_PENDING",
  "EXCEPTION",
];

/** Left the origin, not yet arrived at the destination. */
export const OUTGOING_TRANSFER_STATUSES: readonly string[] = [
  "DISPATCHED",
  "IN_TRANSIT",
];

/** Arrived at the destination, being received / reconciled. */
export const INCOMING_TRANSFER_STATUSES: readonly string[] = [
  "ARRIVED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "RECONCILIATION_PENDING",
];

/** Still being built / approved at the origin. */
export const PREPARING_TRANSFER_STATUSES: readonly string[] = [
  "DRAFT",
  "REQUESTED",
  "PREPARING",
  "READY_FOR_DISPATCH",
];

/** Availability values the assignment services set while a driver is
 *  out on real work (drivers.ts / transfers / deliveries maintain
 *  availabilityStatus; AVAILABLE / OFF_DUTY etc. are not "active"). */
export const ACTIVE_DRIVER_AVAILABILITY: readonly string[] = [
  "ASSIGNED",
  "ON_PICKUP",
  "ON_DELIVERY",
  "ON_TRIP",
];

/** Remittance states finance still has to act on. */
export const COD_AWAITING_VERIFICATION_STATUSES: readonly string[] = [
  "SUBMITTED",
  "UNDER_VERIFICATION",
];

// ---------------------------------------------------------------------------
// Live-operations summary (Phase 6 decision: summary CARD on the Admin
// home, not an embedded LiveOperationsBoard — the board is a
// full-viewport polling surface; embedding it would double polling and
// duplicate /admin/live-operations. This summary is computed from one
// listLiveOperations call, the same scoped read the board uses.)
// ---------------------------------------------------------------------------

export interface LiveOpsStaleMovement {
  trackingSessionId: string;
  driverName: string;
  trackingType: string;
  freshnessState: string;
  /** ISO instant of the last accepted report, or null when the driver
   *  has never reported on this session. */
  lastReceivedAt: string | null;
  originCode: string;
  destinationCode: string | null;
}

export interface LiveOperationsSummary {
  /** Sessions ACTIVE or PAUSED right now (recently-ended excluded). */
  activeMovements: number;
  byType: { transfers: number; pickups: number; deliveries: number };
  byFreshness: { fresh: number; delayed: number; stale: number; offline: number };
  /** The stalest few active movements, least-recent report first
   *  (never-reported sessions sort first). */
  stalest: LiveOpsStaleMovement[];
  generatedAt: string;
}

/** Pure aggregation over listLiveOperations items — exported so the
 *  bucketing is testable without a database. */
export function summarizeLiveOperations(
  items: readonly LiveOperationItem[],
  generatedAt: string,
): LiveOperationsSummary {
  const active = items.filter(
    (item) => item.sessionStatus === "ACTIVE" || item.sessionStatus === "PAUSED",
  );
  const byType = { transfers: 0, pickups: 0, deliveries: 0 };
  const byFreshness = { fresh: 0, delayed: 0, stale: 0, offline: 0 };
  for (const item of active) {
    if (item.trackingType === "LINEHAUL") byType.transfers += 1;
    else if (item.trackingType === "PICKUP") byType.pickups += 1;
    else if (item.trackingType === "DELIVERY") byType.deliveries += 1;
    if (item.freshnessState === "FRESH") byFreshness.fresh += 1;
    else if (item.freshnessState === "DELAYED") byFreshness.delayed += 1;
    else if (item.freshnessState === "STALE") byFreshness.stale += 1;
    else byFreshness.offline += 1;
  }
  const stalest = [...active]
    .sort((a, b) => {
      const at = a.location?.lastReceivedAt ?? null;
      const bt = b.location?.lastReceivedAt ?? null;
      if (at === null && bt === null) return 0;
      if (at === null) return -1;
      if (bt === null) return 1;
      return at < bt ? -1 : at > bt ? 1 : 0;
    })
    .slice(0, 3)
    .map((item) => ({
      trackingSessionId: item.trackingSessionId,
      driverName: item.driverName,
      trackingType: item.trackingType,
      freshnessState: item.freshnessState,
      lastReceivedAt: item.location?.lastReceivedAt ?? null,
      originCode: item.origin.code,
      destinationCode: item.destination?.code ?? null,
    }));
  return { activeMovements: active.length, byType, byFreshness, stalest, generatedAt };
}

export async function getLiveOperationsSummary(
  actor: ActorContext,
): Promise<LiveOperationsSummary> {
  const { items, generatedAt } = await listLiveOperations(actor);
  return summarizeLiveOperations(items, generatedAt);
}

// ---------------------------------------------------------------------------
// Admin operations home
// ---------------------------------------------------------------------------

export interface AdminHomeData {
  today: string;
  metrics: {
    bookingsToday: number;
    /** Delivered ÷ (delivered + failed attempts) today; null when no
     *  delivery was attempted or completed today. */
    deliverySuccessPercent: number | null;
    activeTransfers: number;
    activeDrivers: number;
    openIncidents: number;
    /** Remittances awaiting finance verification (SUBMITTED /
     *  UNDER_VERIFICATION). */
    pendingCod: number;
  };
  needsAttention: {
    openIncidents: number;
    incidentsBySeverity: { CRITICAL: number; HIGH: number; MEDIUM: number; LOW: number };
    topOpenIncidents: IncidentView[];
    codAwaitingVerification: number;
    codDiscrepancies: number;
    overdueTasks: number;
    topOverdueTasks: TaskView[];
    failedDeliveriesToday: number;
  };
  currentOps: {
    bookingsToday: number;
    deliveredToday: number;
    awaitingPickup: number;
    incomingTransfers: number;
    outgoingTransfers: number;
    preparingTransfers: number;
    activeDrivers: number;
  };
  live: LiveOperationsSummary | null;
  recentActivity: {
    incidents: IncidentView[];
    transfers: TransferView[];
  };
}

async function countAwaitingPickup(actor: ActorContext): Promise<number> {
  await requirePermAudited(actor, "package.read_all", "Package");
  return prisma.package.count({
    where: { operationalStatus: { in: [...AWAITING_PICKUP_STATUSES] } },
  });
}

async function transferPipelineCounts(actor: ActorContext): Promise<{
  active: number;
  incoming: number;
  outgoing: number;
  preparing: number;
}> {
  await requirePermAudited(actor, "transfer.read_all", "Transfer");
  const [active, incoming, outgoing, preparing] = await Promise.all([
    prisma.transfer.count({ where: { status: { in: [...ACTIVE_TRANSFER_STATUSES] } } }),
    prisma.transfer.count({ where: { status: { in: [...INCOMING_TRANSFER_STATUSES] } } }),
    prisma.transfer.count({ where: { status: { in: [...OUTGOING_TRANSFER_STATUSES] } } }),
    prisma.transfer.count({ where: { status: { in: [...PREPARING_TRANSFER_STATUSES] } } }),
  ]);
  return { active, incoming, outgoing, preparing };
}

async function countActiveDrivers(actor: ActorContext): Promise<number> {
  await requirePermAudited(actor, "driver.assign", "Driver");
  return prisma.driver.count({
    where: {
      employmentStatus: "ACTIVE",
      availabilityStatus: { in: [...ACTIVE_DRIVER_AVAILABILITY] },
    },
  });
}

/** Run a section read, returning null when the actor simply does not
 *  hold that section's permission — the home renders what the actor
 *  may see instead of failing whole-page on one denied section. Any
 *  non-authorization error still propagates. */
async function optional<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if ((error as { name?: string })?.name === "AuthorizationError") return null;
    throw error;
  }
}

export async function getAdminHome(actor: ActorContext): Promise<AdminHomeData> {
  // Top-level gate (Phase 6 security review F6): the Admin home is a
  // global-role read — it aggregates company-wide figures (including
  // the global active-driver count, whose own gate is only
  // driver.assign, held by Warehouse Admins). Require BOTH global
  // read grants up front, each with an audited denial; Admin / Super
  // Admin hold both, warehouse-scoped actors hold neither read_all.
  // The per-section optional() degradation below still applies to
  // partial-permission cases among actors who pass this gate.
  await requirePermAudited(actor, "report.read_all", "Report");
  await requirePermAudited(actor, "booking.read_all", "Order");
  const today = kathmanduToday();

  // The daily report is the home's spine (bookings / delivered /
  // failed today) and itself enforces report.read_all /
  // report.read_warehouse scoping.
  const daily = await getDailyReport(actor, { from: today, to: today });

  const [
    awaitingPickup,
    pipeline,
    activeDrivers,
    incidentsCritical,
    incidentsHigh,
    incidentsMedium,
    incidentsLow,
    openIncidentsPage,
    recentIncidentsPage,
    overduePage,
    codSubmitted,
    codUnderVerification,
    codDiscrepancy,
    recentTransfersPage,
    live,
  ] = await Promise.all([
    optional(() => countAwaitingPickup(actor)),
    optional(() => transferPipelineCounts(actor)),
    optional(() => countActiveDrivers(actor)),
    optional(() =>
      listIncidents(actor, { openOnly: true, severity: "CRITICAL", pageSize: 1 }),
    ),
    optional(() =>
      listIncidents(actor, { openOnly: true, severity: "HIGH", pageSize: 1 }),
    ),
    optional(() =>
      listIncidents(actor, { openOnly: true, severity: "MEDIUM", pageSize: 1 }),
    ),
    optional(() =>
      listIncidents(actor, { openOnly: true, severity: "LOW", pageSize: 1 }),
    ),
    optional(() => listIncidents(actor, { openOnly: true, pageSize: 5 })),
    optional(() => listIncidents(actor, { pageSize: 5 })),
    optional(() => listTasks(actor, { queue: "all", overdueOnly: true, pageSize: 5 })),
    optional(() => listRemittances(actor, { status: "SUBMITTED", pageSize: 1 })),
    optional(() =>
      listRemittances(actor, { status: "UNDER_VERIFICATION", pageSize: 1 }),
    ),
    optional(() => listRemittances(actor, { status: "DISCREPANCY", pageSize: 1 })),
    optional(() => listTransfers(actor, { pageSize: 5 })),
    optional(() => getLiveOperationsSummary(actor)),
  ]);

  const openIncidents = openIncidentsPage?.meta.total ?? 0;
  const codAwaitingVerification =
    (codSubmitted?.meta.total ?? 0) + (codUnderVerification?.meta.total ?? 0);
  const deliverySuccessPercent = percent(
    daily.delivered,
    daily.delivered + daily.failedAttempts,
  );

  return {
    today,
    metrics: {
      bookingsToday: daily.bookings,
      deliverySuccessPercent,
      activeTransfers: pipeline?.active ?? 0,
      activeDrivers: activeDrivers ?? 0,
      openIncidents,
      pendingCod: codAwaitingVerification,
    },
    needsAttention: {
      openIncidents,
      incidentsBySeverity: {
        CRITICAL: incidentsCritical?.meta.total ?? 0,
        HIGH: incidentsHigh?.meta.total ?? 0,
        MEDIUM: incidentsMedium?.meta.total ?? 0,
        LOW: incidentsLow?.meta.total ?? 0,
      },
      topOpenIncidents: openIncidentsPage?.items ?? [],
      codAwaitingVerification,
      codDiscrepancies: codDiscrepancy?.meta.total ?? 0,
      overdueTasks: overduePage?.meta.total ?? 0,
      topOverdueTasks: overduePage?.items ?? [],
      failedDeliveriesToday: daily.failedAttempts,
    },
    currentOps: {
      bookingsToday: daily.bookings,
      deliveredToday: daily.delivered,
      awaitingPickup: awaitingPickup ?? 0,
      incomingTransfers: pipeline?.incoming ?? 0,
      outgoingTransfers: pipeline?.outgoing ?? 0,
      preparingTransfers: pipeline?.preparing ?? 0,
      activeDrivers: activeDrivers ?? 0,
    },
    live,
    recentActivity: {
      incidents: recentIncidentsPage?.items ?? [],
      transfers: recentTransfersPage?.items ?? [],
    },
  };
}

// ---------------------------------------------------------------------------
// Warehouse Staff "My Work" home
// ---------------------------------------------------------------------------

export interface StaffWarehouseQueues {
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  /** Received at origin, not yet through inspection (RECEIVED_AT_ORIGIN
   *  + INSPECTION_PENDING open inventory). */
  awaitingInspection: number;
  /** Inspection started — record result / put away (PROCESSING). */
  inInspection: number;
  /** Sorted, awaiting the ready-for-dispatch step + already ready
   *  (SORTED + READY_FOR_DISPATCH). */
  dispatchPrep: number;
  /** Transfers in the receiving window whose DESTINATION is this
   *  warehouse — work arriving to be received. */
  arrivalsInbound: number;
  openPackages: number;
  damagedPackages: number;
  pendingHandovers: number;
}

export interface StaffMyWorkData {
  hasWarehouse: boolean;
  warehouses: { id: string; code: string; name: string }[];
  myTasks: TaskView[];
  myTasksTotal: number;
  myOverdueTasks: number;
  perWarehouse: StaffWarehouseQueues[];
  totals: {
    awaitingInspection: number;
    inInspection: number;
    dispatchPrep: number;
    arrivalsInbound: number;
    openPackages: number;
    damagedPackages: number;
    pendingHandovers: number;
  };
}

const ZERO_TOTALS: StaffMyWorkData["totals"] = {
  awaitingInspection: 0,
  inInspection: 0,
  dispatchPrep: 0,
  arrivalsInbound: 0,
  openPackages: 0,
  damagedPackages: 0,
  pendingHandovers: 0,
};

function queuesFromSummary(
  summary: WarehouseOpsSummary,
  warehouseName: string,
  arrivalsInbound: number,
): StaffWarehouseQueues {
  const byStatus = summary.byStatus;
  return {
    warehouseId: summary.warehouseId,
    warehouseCode: summary.warehouseCode,
    warehouseName,
    awaitingInspection:
      (byStatus["RECEIVED_AT_ORIGIN"] ?? 0) + (byStatus["INSPECTION_PENDING"] ?? 0),
    inInspection: byStatus["PROCESSING"] ?? 0,
    dispatchPrep:
      (byStatus["SORTED"] ?? 0) + (byStatus["READY_FOR_DISPATCH"] ?? 0),
    arrivalsInbound,
    openPackages: summary.openPackages,
    damagedPackages: summary.damagedPackages,
    pendingHandovers: summary.pendingHandovers,
  };
}

export async function getStaffMyWork(actor: ActorContext): Promise<StaffMyWorkData> {
  // My tasks are readable regardless of warehouse membership.
  const [mine, mineOverdue] = await Promise.all([
    listTasks(actor, { queue: "mine", pageSize: 5 }),
    listTasks(actor, { queue: "mine", overdueOnly: true, pageSize: 1 }),
  ]);

  if (actor.warehouseIds.length === 0) {
    return {
      hasWarehouse: false,
      warehouses: [],
      myTasks: mine.items,
      myTasksTotal: mine.meta.total,
      myOverdueTasks: mineOverdue.meta.total,
      perWarehouse: [],
      totals: { ...ZERO_TOTALS },
    };
  }

  const { items: warehouseItems } = await listWarehouses(actor, { pageSize: 100 });
  const warehouses = warehouseItems
    .filter((w) => actor.warehouseIds.includes(w.id))
    .map((w) => ({ id: w.id, code: w.code, name: w.name }));

  // Inbound arrivals: transfers are scoped inside listTransfers to the
  // actor's memberships (origin OR destination); the destination
  // filter below is what makes a transfer "arriving at my warehouse"
  // rather than "leaving my warehouse".
  const { items: transfers } = await listTransfers(actor, { pageSize: 100 });
  const receivingWindow: ReadonlySet<string> = new Set([
    "IN_TRANSIT",
    "ARRIVED",
    "PARTIALLY_RECEIVED",
    "RECEIVED",
    "RECONCILIATION_PENDING",
    "EXCEPTION",
  ]);
  const arrivalsByWarehouse = new Map<string, number>();
  for (const transfer of transfers) {
    if (!receivingWindow.has(transfer.status)) continue;
    if (!actor.warehouseIds.includes(transfer.destinationWarehouseId)) continue;
    arrivalsByWarehouse.set(
      transfer.destinationWarehouseId,
      (arrivalsByWarehouse.get(transfer.destinationWarehouseId) ?? 0) + 1,
    );
  }

  const perWarehouse: StaffWarehouseQueues[] = [];
  for (const warehouse of warehouses) {
    const summary = await getWarehouseOpsSummary(actor, warehouse.id);
    perWarehouse.push(
      queuesFromSummary(summary, warehouse.name, arrivalsByWarehouse.get(warehouse.id) ?? 0),
    );
  }

  const totals = perWarehouse.reduce<StaffMyWorkData["totals"]>(
    (acc, row) => ({
      awaitingInspection: acc.awaitingInspection + row.awaitingInspection,
      inInspection: acc.inInspection + row.inInspection,
      dispatchPrep: acc.dispatchPrep + row.dispatchPrep,
      arrivalsInbound: acc.arrivalsInbound + row.arrivalsInbound,
      openPackages: acc.openPackages + row.openPackages,
      damagedPackages: acc.damagedPackages + row.damagedPackages,
      pendingHandovers: acc.pendingHandovers + row.pendingHandovers,
    }),
    { ...ZERO_TOTALS },
  );

  return {
    hasWarehouse: true,
    warehouses,
    myTasks: mine.items,
    myTasksTotal: mine.meta.total,
    myOverdueTasks: mineOverdue.meta.total,
    perWarehouse,
    totals,
  };
}
