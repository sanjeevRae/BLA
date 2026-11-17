import "server-only";

import { prisma } from "@/lib/db/prisma";
import type { ActorContext } from "@/lib/auth/actor";
import { addDays, kathmanduToday, percent } from "@/lib/reports/domain";
import type { IncidentCategory } from "@/lib/operations/domain";
import { requirePermAudited } from "@/server/services/scoping";
import {
  getDailyReport,
  getOverviewReport,
  type OverviewReport,
} from "@/server/services/reports";
import { listAuditLogs, type AuditLogView } from "@/server/services/audit-log";
import { listIncidents, type IncidentView } from "@/server/services/incidents";
import { listTasks, type TaskView } from "@/server/services/tasks";
import { listRemittances } from "@/server/services/cod-remittances";
import {
  getTransfer,
  listTransfers,
  type TransferView,
} from "@/server/services/transfers";
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
  /** Distinct drivers with an ACTIVE or PAUSED session right now. */
  activeDrivers: number;
  /** Active movements whose latest report is DELAYED (mirrors
   *  byFreshness.delayed, surfaced flat for the executive home). */
  delayedMovements: number;
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
  return {
    activeMovements: active.length,
    activeDrivers: new Set(active.map((item) => item.driverId)).size,
    delayedMovements: byFreshness.delayed,
    byType,
    byFreshness,
    stalest,
    generatedAt,
  };
}

export async function getLiveOperationsSummary(
  actor: ActorContext,
): Promise<LiveOperationsSummary> {
  const { items, generatedAt } = await listLiveOperations(actor);
  return summarizeLiveOperations(items, generatedAt);
}

// ---------------------------------------------------------------------------
// Executive home helpers (V3 Step 4 — pure, exported for unit tests)
// ---------------------------------------------------------------------------

/** Packages physically sitting in a warehouse right now: received at
 *  origin or destination and not yet dispatched / out for delivery. */
export const AT_WAREHOUSE_STATUSES = [
  "RECEIVED_AT_ORIGIN",
  "INSPECTION_PENDING",
  "PROCESSING",
  "SORTED",
  "READY_FOR_DISPATCH",
  "TRANSFER_ASSIGNED",
  "ARRIVED_AT_DESTINATION",
  "RECEIVING_INSPECTION",
  "RECEIVED_AT_DESTINATION",
  "READY_FOR_DELIVERY",
];

/** Packages on a line-haul leg between warehouses. */
export const IN_TRANSIT_STATUSES = ["DISPATCHED", "IN_TRANSIT"];

export interface PackageStateBuckets {
  atWarehouses: number;
  inTransit: number;
  outForDelivery: number;
  delivered: number;
  awaitingPickup: number;
  assignedToRiders: number;
  cancelled: number;
  total: number;
}

/** Bucket an overview report's packagesByStatus snapshot into the
 *  executive home's package-state groups. Statuses in no named bucket
 *  (DRAFT, PICKED_UP, DELIVERY_ATTEMPTED, …) count toward `total`
 *  only. The bucket status sets are disjoint, so every named status
 *  lands in exactly one bucket. */
export function bucketPackageStates(
  packagesByStatus: { status: string; count: number }[],
): PackageStateBuckets {
  const atWarehouses = new Set(AT_WAREHOUSE_STATUSES);
  const inTransit = new Set(IN_TRANSIT_STATUSES);
  const awaitingPickup = new Set(AWAITING_PICKUP_STATUSES);
  const buckets: PackageStateBuckets = {
    atWarehouses: 0,
    inTransit: 0,
    outForDelivery: 0,
    delivered: 0,
    awaitingPickup: 0,
    assignedToRiders: 0,
    cancelled: 0,
    total: 0,
  };
  for (const row of packagesByStatus) {
    buckets.total += row.count;
    if (atWarehouses.has(row.status)) buckets.atWarehouses += row.count;
    else if (inTransit.has(row.status)) buckets.inTransit += row.count;
    else if (row.status === "OUT_FOR_DELIVERY") buckets.outForDelivery += row.count;
    else if (row.status === "DELIVERED") buckets.delivered += row.count;
    else if (awaitingPickup.has(row.status)) buckets.awaitingPickup += row.count;
    else if (row.status === "DELIVERY_ASSIGNED") buckets.assignedToRiders += row.count;
    else if (row.status === "CANCELLED") buckets.cancelled += row.count;
  }
  return buckets;
}

const MONTH_ABBREVIATIONS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** The Monday (YYYY-MM-DD) of the calendar week containing `date`.
 *  All math runs on the string parts through UTC — the input is a
 *  Kathmandu calendar date, and local-Date math would shift the week
 *  boundary with the host timezone. */
function mondayOfWeek(date: string): string {
  const [y, m, d] = date.split("-").map((part) => Number(part));
  const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  return addDays(date, -daysSinceMonday);
}

function weekLabel(monday: string): string {
  const [, month, day] = monday.split("-").map((part) => Number(part));
  return `${day} ${MONTH_ABBREVIATIONS[month - 1]}`;
}

/** Roll a daily bookings/delivered series up to calendar weeks
 *  (Monday-start), ascending by week. Only weeks present in the
 *  input appear — the overview series is zero-filled, so in
 *  practice every week of the window is present. */
export function weeklyDeliveredSeries(
  dailySeries: { date: string; bookings: number; delivered: number }[],
): { label: string; bookings: number; delivered: number }[] {
  const byMonday = new Map<string, { label: string; bookings: number; delivered: number }>();
  for (const row of dailySeries) {
    const monday = mondayOfWeek(row.date);
    const week = byMonday.get(monday) ?? {
      label: weekLabel(monday),
      bookings: 0,
      delivered: 0,
    };
    week.bookings += row.bookings;
    week.delivered += row.delivered;
    byMonday.set(monday, week);
  }
  return [...byMonday.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, week]) => week);
}

/** Today-vs-yesterday counts from a daily series. A metric is null
 *  when either day's row is absent from the series (the series does
 *  not cover that day, so no honest delta exists). */
export function dayDelta(
  dailySeries: { date: string; bookings: number; delivered: number }[],
  today: string,
): {
  bookings: { today: number; yesterday: number } | null;
  delivered: { today: number; yesterday: number } | null;
} {
  const todayRow = dailySeries.find((row) => row.date === today);
  const yesterdayRow = dailySeries.find((row) => row.date === addDays(today, -1));
  if (!todayRow || !yesterdayRow) return { bookings: null, delivered: null };
  return {
    bookings: { today: todayRow.bookings, yesterday: yesterdayRow.bookings },
    delivered: { today: todayRow.delivered, yesterday: yesterdayRow.delivered },
  };
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
// Executive home (V3 Step 4 — the Admin / Super Admin landing read)
// ---------------------------------------------------------------------------

export interface ExecutiveActivityItem {
  id: string;
  label: string;
  actorName: string | null;
  createdAt: string;
  href: string | null;
}

/** Entity types that belong on an operations activity feed — user /
 *  session / settings / finance-admin audit rows stay off it. */
const ACTIVITY_ENTITY_TYPES: ReadonlySet<string> = new Set([
  "Order",
  "Package",
  "Transfer",
  "Trip",
  "DeliveryBatch",
  "DeliveryAssignment",
  "Task",
  "Incident",
  "Driver",
  "ReturnRequest",
  "VendorSettlement",
  "Warehouse",
  "Vendor",
  "Customer",
]);

/** Friendly labels for the audit actions the feed names explicitly.
 *  Anything else falls back to a humanised action (see below). */
const ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  "booking.create": "New booking created",
  "booking.approve": "Booking approved",
  "booking.cancel": "Booking cancelled",
  "booking.reject": "Booking rejected",
  "booking.update": "Booking updated",
  "transfer.create": "Transfer created",
  "transfer.dispatch": "Transfer dispatched",
  "transfer.dispatched": "Transfer dispatched",
  "transfer.receive": "Transfer received",
  "transfer.reconciled": "Transfer reconciled",
  "trip.departed": "Trip departed",
  "trip.arrived": "Trip arrived",
  "delivery.confirmed": "Delivery completed",
  "delivery.attempt_recorded": "Delivery attempt recorded",
  "delivery.assign": "Driver assigned to a delivery",
  "driver.assign": "Driver assigned",
  "package.inspect": "Package inspected",
  "transfer.package_received_scan": "Package received",
  "task.created": "Task created",
  "task.create": "Task created",
  "task.verify": "Task verified",
  "task.status_changed": "Task updated",
  "incident.reported": "Incident reported",
  "incident.report": "Incident reported",
  "incident.resolve": "Incident resolved",
};

/** Deep links for the entity types that have a detail page under
 *  every dashboard tree; the rest render as plain feed rows. */
const ACTIVITY_HREF_SEGMENTS: Readonly<Record<string, string>> = {
  Order: "bookings",
  Incident: "incidents",
  Task: "tasks",
  Vendor: "vendors",
  Customer: "customers",
  Driver: "drivers",
  Warehouse: "warehouses",
  VendorSettlement: "settlements",
};

function humaniseAction(action: string): string {
  const last = action.split(".").pop() ?? action;
  const words = last.replaceAll("_", " ").trim();
  if (!words) return action;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Project audit-log rows onto the executive activity feed: recorded
 *  operational events only (reads and denials are noise here),
 *  newest first as delivered by listAuditLogs, capped at 8. */
export function mapAuditActivity(
  rows: AuditLogView[],
  basePath: string,
): ExecutiveActivityItem[] {
  const items: ExecutiveActivityItem[] = [];
  for (const row of rows) {
    if (items.length >= 8) break;
    if (row.outcome !== "recorded") continue;
    if (!ACTIVITY_ENTITY_TYPES.has(row.entityType)) continue;
    if (row.action.includes("read_") || row.action === "access.denied") continue;
    const segment = ACTIVITY_HREF_SEGMENTS[row.entityType];
    items.push({
      id: row.id,
      label: ACTIVITY_LABELS[row.action] ?? humaniseAction(row.action),
      actorName: row.actorName,
      createdAt: row.createdAt,
      href:
        row.entityId !== null && segment
          ? `${basePath}/${segment}/${encodeURIComponent(row.entityId)}`
          : null,
    });
  }
  return items;
}

export interface ExecutiveAttentionGroup {
  key: string;
  label: string;
  count: number;
}

/** Open-incident category groups for the attention panel. The COD
 *  group additionally folds in finance's DISCREPANCY remittances
 *  (added by the caller, not an incident category). */
const ATTENTION_GROUP_DEFS: {
  key: string;
  label: string;
  categories: IncidentCategory[];
}[] = [
  {
    key: "missing",
    label: "Missing packages",
    categories: ["MISSING_PACKAGE", "TRANSFER_SHORTAGE"],
  },
  {
    key: "transferDiscrepancies",
    label: "Transfer discrepancies",
    categories: [
      "TRANSFER_EXCESS",
      "HANDOVER_DISCREPANCY",
      "WRONG_PACKAGE_RECEIVED",
      "WRONG_WAREHOUSE",
    ],
  },
  { key: "delayed", label: "Delayed deliveries", categories: ["DELAYED_SHIPMENT"] },
  { key: "damaged", label: "Damaged packages", categories: ["DAMAGED_PACKAGE"] },
  { key: "codMismatches", label: "COD mismatches", categories: ["COD_DISCREPANCY"] },
];

export interface ExecutiveHomeData {
  today: string;
  kpis: {
    /** Every order ever booked (snapshot count, not windowed). */
    totalBookings: number;
    /** Every package on record; null when package.read_all is denied. */
    totalPackages: number | null;
    bookingsLast30Days: number;
    buckets: PackageStateBuckets;
    openExceptions: number;
    bookingsDelta: { today: number; yesterday: number } | null;
    deliveredDelta: { today: number; yesterday: number } | null;
  };
  analytics: {
    dailySeries: OverviewReport["dailySeries"];
    distribution: OverviewReport["packagesByStatus"];
    weekly: { label: string; bookings: number; delivered: number }[];
  };
  attention: {
    openIncidents: number;
    bySeverity: AdminHomeData["needsAttention"]["incidentsBySeverity"];
    /** Alias of bySeverity under the Admin home's own field name. */
    incidentsBySeverity: AdminHomeData["needsAttention"]["incidentsBySeverity"];
    topOpenIncidents: IncidentView[];
    codAwaitingVerification: number;
    codDiscrepancies: number;
    overdueTasks: number;
    topOverdueTasks: TaskView[];
    failedDeliveriesToday: number;
    /** Open-incident category groups; null when incidents are unreadable. */
    groups: ExecutiveAttentionGroup[] | null;
    allClear: boolean;
  };
  activity: ExecutiveActivityItem[];
  ops: {
    deliverySuccessPercent: number | null;
    activeTransfers: number;
    activeDrivers: number;
    pendingCod: number;
  };
  money: {
    invoicedPaisa: string;
    invoicedCount: number;
    outstandingPaisa: string;
    openInvoices: number;
    codCollectedPaisa: string;
    codWithRidersPaisa: string;
    onTimePercent: number | null;
    returnRatePercent: number | null;
  } | null;
}

/**
 * The V3 executive home for Admin / Super Admin: one composed read
 * over the overview report (30-day window), the Admin operations
 * home (attention + ops metrics — reused, never re-queried here),
 * two gated snapshot counts, incident category groups and the audit
 * activity feed. Like getAdminHome this is a global-role read: the
 * report.read_all + booking.read_all gates run up front with
 * audited denials, so warehouse-scoped actors are refused outright.
 * Sections whose own permission can still be missing for an actor
 * who passes the top gates degrade through optional() instead.
 */
export async function getExecutiveHome(
  actor: ActorContext,
  basePath: string,
): Promise<ExecutiveHomeData> {
  await requirePermAudited(actor, "report.read_all", "Report");
  await requirePermAudited(actor, "booking.read_all", "Order");
  const today = kathmanduToday();

  const overview = await getOverviewReport(actor, {});
  const admin = await getAdminHome(actor);

  // Snapshot totals no report exposes: gated counts, following the
  // same pattern as the Admin home's direct aggregations.
  await requirePermAudited(actor, "booking.read_all", "Order");
  const totalBookings = await prisma.order.count({});
  const totalPackages = await optional(async () => {
    await requirePermAudited(actor, "package.read_all", "Package");
    return prisma.package.count({});
  });

  const delta = dayDelta(overview.dailySeries, today);
  const needsAttention = admin.needsAttention;

  const groups = await optional(async () => {
    const counted: ExecutiveAttentionGroup[] = [];
    for (const def of ATTENTION_GROUP_DEFS) {
      let count = 0;
      for (const category of def.categories) {
        const page = await listIncidents(actor, {
          openOnly: true,
          category,
          pageSize: 1,
        });
        count += page.meta.total;
      }
      if (def.key === "codMismatches") count += needsAttention.codDiscrepancies;
      counted.push({ key: def.key, label: def.label, count });
    }
    return counted;
  });

  const auditPage = await optional(() => listAuditLogs(actor, { pageSize: 40 }));
  const activity = auditPage ? mapAuditActivity(auditPage.items, basePath) : [];

  return {
    today,
    kpis: {
      totalBookings,
      totalPackages,
      bookingsLast30Days: overview.bookings,
      buckets: bucketPackageStates(overview.packagesByStatus),
      openExceptions: overview.incidents.open,
      bookingsDelta: delta.bookings,
      deliveredDelta: delta.delivered,
    },
    analytics: {
      dailySeries: overview.dailySeries,
      distribution: overview.packagesByStatus,
      weekly: weeklyDeliveredSeries(overview.dailySeries),
    },
    attention: {
      openIncidents: needsAttention.openIncidents,
      bySeverity: needsAttention.incidentsBySeverity,
      incidentsBySeverity: needsAttention.incidentsBySeverity,
      topOpenIncidents: needsAttention.topOpenIncidents,
      codAwaitingVerification: needsAttention.codAwaitingVerification,
      codDiscrepancies: needsAttention.codDiscrepancies,
      overdueTasks: needsAttention.overdueTasks,
      topOverdueTasks: needsAttention.topOverdueTasks,
      failedDeliveriesToday: needsAttention.failedDeliveriesToday,
      groups,
      allClear:
        needsAttention.openIncidents === 0 &&
        needsAttention.overdueTasks === 0 &&
        needsAttention.codDiscrepancies === 0 &&
        needsAttention.codAwaitingVerification === 0 &&
        needsAttention.failedDeliveriesToday === 0,
    },
    activity,
    ops: {
      deliverySuccessPercent: admin.metrics.deliverySuccessPercent,
      activeTransfers: admin.metrics.activeTransfers,
      activeDrivers: admin.metrics.activeDrivers,
      pendingCod: admin.metrics.pendingCod,
    },
    money: {
      invoicedPaisa: overview.invoiced.totalPaisa,
      invoicedCount: overview.invoiced.count,
      outstandingPaisa: overview.outstanding.outstandingPaisa,
      openInvoices: overview.outstanding.openInvoices,
      codCollectedPaisa: overview.cod.collectedPaisa,
      codWithRidersPaisa: overview.cod.outstandingWithRidersPaisa,
      onTimePercent: overview.onTimePercent,
      returnRatePercent: overview.returnRatePercent,
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

// ---------------------------------------------------------------------------
// Warehouse Staff work console (V3 Step 5, brief §8)
// ---------------------------------------------------------------------------

import { getWarehouseHomeSummary } from "@/server/services/warehouse-home";

/**
 * The V3 Staff home read model: a finance-free reshaping of
 * `getStaffMyWork` plus the two figures the Warehouse Admin home
 * aggregate (`getWarehouseHomeSummary`) already computes per
 * warehouse — packages received today (Asia/Kathmandu) and the
 * warehouse-scoped inventory-movement feed.
 *
 * HARD RULE — NO FINANCE: this model carries no money figure of any
 * kind. Tasks and movements are mapped field-by-field (never spread)
 * so nothing from a shared view type can leak an amount into the
 * Staff surface; the Step 5 integration test serialises the model and
 * asserts no finance key exists anywhere in it.
 *
 * "Today" honesty: the warehouse-home aggregate exposes ONLY
 * `receivedToday` as a today-scoped count. No existing read provides
 * inspected / packed / transferred today counts, so the console does
 * not present them — the remaining summary cards are the LIVE queue
 * totals from `getStaffMyWork`, labelled as current queues.
 *
 * Task order is the task service's own order (listTasks queue="mine":
 * dueAt asc, then newest first) and is preserved verbatim — the next
 * task is simply the first row; nothing here re-sorts.
 */
export interface StaffConsoleTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  overdue: boolean;
}

export interface StaffConsoleActivityItem {
  id: string;
  /** Inventory movement type (RECEIVING, PUT_AWAY, INTERNAL_MOVE, …). */
  type: string;
  trackingId: string;
  actorName: string;
  warehouseCode: string;
  createdAt: string;
}

export interface StaffWorkConsoleData {
  hasWarehouse: boolean;
  warehouses: { id: string; code: string; name: string }[];
  /** The staff member's tasks, in the task service's own order. */
  myTasks: StaffConsoleTask[];
  myTasksTotal: number;
  myOverdueTasks: number;
  perWarehouse: StaffWarehouseQueues[];
  totals: StaffMyWorkData["totals"];
  /**
   * Packages received today (Kathmandu) across the member warehouses
   * — summed from the existing warehouse-home aggregate. `null` when
   * there is no warehouse or the aggregate could not be read for a
   * member warehouse (the console then omits the card rather than
   * showing a partial sum as a total).
   */
  receivedToday: number | null;
  /**
   * Latest inventory movements at the member warehouses only, newest
   * first — the warehouse-home aggregate's movement feed, which is
   * scoped by its warehouse predicate and carries no finance fields.
   */
  recentActivity: StaffConsoleActivityItem[];
}

export async function getStaffWorkConsole(
  actor: ActorContext,
): Promise<StaffWorkConsoleData> {
  const work = await getStaffMyWork(actor);

  const base: StaffWorkConsoleData = {
    hasWarehouse: work.hasWarehouse,
    warehouses: work.warehouses,
    myTasks: work.myTasks.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueAt: task.dueAt,
      overdue: task.overdue,
    })),
    myTasksTotal: work.myTasksTotal,
    myOverdueTasks: work.myOverdueTasks,
    perWarehouse: work.perWarehouse,
    totals: work.totals,
    receivedToday: null,
    recentActivity: [],
  };

  if (!work.hasWarehouse) return base;

  let receivedToday = 0;
  const activity: StaffConsoleActivityItem[] = [];
  for (const warehouse of work.warehouses) {
    let summary: Awaited<ReturnType<typeof getWarehouseHomeSummary>>;
    try {
      summary = await getWarehouseHomeSummary(actor, warehouse.id);
    } catch {
      // The aggregate is an auxiliary read (today count + movement
      // feed). If it cannot be read for one member warehouse, omit
      // BOTH extras entirely — a partial today sum presented as the
      // total would be a false figure.
      return base;
    }
    receivedToday += summary.metrics.receivedToday;
    for (const movement of summary.recentMovements) {
      activity.push({
        id: `${warehouse.id}:${movement.id}`,
        type: movement.type,
        trackingId: movement.trackingId,
        actorName: movement.actorName,
        warehouseCode: warehouse.code,
        createdAt: movement.createdAt,
      });
    }
  }

  // Each warehouse feed is already newest-first; merging several
  // warehouses' feeds requires one chronological merge to keep the
  // combined feed newest-first. This sorts ACTIVITY only — the task
  // queue above keeps the task service's order untouched.
  activity.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    ...base,
    receivedToday,
    recentActivity: activity.slice(0, 8),
  };
}

// ---------------------------------------------------------------------------
// Field homes (V3 Step 6 — Rider + Line-haul driver landing reads)
// ---------------------------------------------------------------------------

import {
  getRiderBatch,
  getRiderHomeToday,
  listRiderBatches,
  type RiderFailedAttemptView,
} from "@/server/services/deliveries";
import { getRiderCodPosition } from "@/server/services/cod-remittances";
import { listMyCustody } from "@/server/services/custody";
import { getDriver } from "@/server/services/drivers";
import { getMyActiveTrip, listTrips, type TripView } from "@/server/services/trips";

/**
 * Shared field-home task slice: the actor's OWN tasks (listTasks
 * queue="mine" — assignee-scoped inside the service), filtered to
 * open work, service order preserved verbatim (dueAt asc, then
 * newest first — the field homes never re-sort a work queue).
 *
 * "Open" excludes the terminal states. The brief named COMPLETED /
 * CANCELLED, but the task vocabulary has no COMPLETED status — its
 * terminal pair is CLOSED / CANCELLED (TASK_TERMINAL_STATUSES), so
 * CLOSED is excluded alongside them; otherwise finished tasks would
 * render as open work on a field home.
 */
const FIELD_TASK_CLOSED_STATUSES: ReadonlySet<string> = new Set([
  "COMPLETED",
  "CANCELLED",
  "CLOSED",
]);

interface FieldTaskSlice {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  overdue: boolean;
}

async function fieldTasks(
  actor: ActorContext,
): Promise<{ tasks: FieldTaskSlice[]; openTaskCount: number }> {
  const page = await listTasks(actor, { queue: "mine", pageSize: 50 });
  const open = page.items.filter((task) => !FIELD_TASK_CLOSED_STATUSES.has(task.status));
  return {
    tasks: open.slice(0, 5).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueAt: task.dueAt,
      overdue: task.overdue,
    })),
    openTaskCount: open.length,
  };
}

// ---------------------------------------------------------------------------
// Rider field home (V3 Step 6)
// ---------------------------------------------------------------------------

export interface RiderJobCardData {
  assignmentId: string;
  batchId: string;
  packageId: string;
  trackingId: string;
  status: string;
  packageStatus: string;
  recipientName: string;
  recipientPhone: string;
  recipientAltPhone: string | null;
  address: string;
  landmark: string | null;
  city: string | null;
  district: string | null;
  codDuePaisa: string;
  codCollectedPaisa: string | null;
  codStatus: string | null;
  deliveryInstructions: string | null;
  failedAttempts: number;
  isNext: boolean;
}

export interface RiderFieldHomeData {
  date: string;
  riderName: string;
  summary: { assigned: number; delivered: number; remaining: number; failed: number };
  failedAttempts: RiderFailedAttemptView[];
  batches: {
    id: string;
    warehouseCode: string;
    status: string;
    kind: string;
    batchDate: string;
    counts: {
      total: number;
      pending: number;
      inProgress: number;
      completed: number;
      failed: number;
      cancelled: number;
      reassigned: number;
    };
    jobs: RiderJobCardData[];
  }[];
  currentBatchId: string | null;
  cod: {
    expectedPaisa: string;
    collectedPaisa: string;
    remainingPaisa: string;
    awaitingRemittancePaisa: string;
    verifiedRemittedPaisa: string;
  };
  custody: {
    trackingId: string;
    packageStatus: string;
    warehouseCode: string | null;
    startedAt: string;
  }[];
  tasks: {
    id: string;
    title: string;
    status: string;
    priority: string;
    dueAt: string | null;
    overdue: boolean;
  }[];
  openTaskCount: number;
}

/**
 * The V3 Rider field home read model: a composition over the exact
 * reads the current rider surfaces already use — getRiderHomeToday
 * (summary / failed attempts / next stop / today's COD), the rider's
 * own batch list + per-batch rider views (job cards), the rider COD
 * position (the same read the COD pages use, so the figures cannot
 * drift), own custody, and own open tasks. Every underlying read is
 * actor-scoped to the rider's own driver profile, so this model is
 * own-scope by construction; every view is field-mapped explicitly
 * (never spread) so no extra field from a shared view type can leak
 * onto the field surface.
 *
 * `date` carries the same semantics as the current page: a
 * YYYY-MM-DD day string, defaulting to today (UTC slice, exactly as
 * RiderHomePage computes it).
 */
export async function getRiderFieldHome(
  actor: ActorContext,
  date?: string,
): Promise<RiderFieldHomeData> {
  const day = date ?? new Date().toISOString().slice(0, 10);
  const home = await getRiderHomeToday(actor, day);
  const batchViews = await listRiderBatches(actor, { date: day });
  const nextAssignmentId = home.currentBatch?.nextStop?.assignmentId ?? null;

  const batches: RiderFieldHomeData["batches"] = [];
  let failed = 0;
  for (const batch of batchViews) {
    failed += batch.counts.failed;
    const { assignments } = await getRiderBatch(actor, batch.id);
    batches.push({
      id: batch.id,
      warehouseCode: batch.warehouseCode,
      status: batch.status,
      kind: batch.kind,
      batchDate: batch.batchDate,
      counts: {
        total: batch.counts.total,
        pending: batch.counts.pending,
        inProgress: batch.counts.inProgress,
        completed: batch.counts.completed,
        failed: batch.counts.failed,
        cancelled: batch.counts.cancelled,
        reassigned: batch.counts.reassigned,
      },
      jobs: assignments.map((a) => ({
        assignmentId: a.id,
        batchId: batch.id,
        packageId: a.packageId,
        trackingId: a.trackingId,
        status: a.status,
        packageStatus: a.packageStatus,
        recipientName: a.recipientName,
        recipientPhone: a.recipientPhone,
        recipientAltPhone: a.recipientAltPhone,
        address: a.destinationAddress,
        landmark: a.destinationLandmark,
        city: a.destinationCity,
        district: a.destinationDistrict,
        codDuePaisa: a.codExpectedPaisa,
        codCollectedPaisa: a.codCollectedPaisa,
        codStatus: a.codStatus,
        deliveryInstructions: a.deliveryInstructions,
        failedAttempts: a.failedAttempts,
        isNext: a.id === nextAssignmentId,
      })),
    });
  }

  // Unguarded, exactly as the current page calls it — a rider who
  // cannot read their COD position has no field home at all.
  const codPosition = await getRiderCodPosition(actor);
  const custody = await listMyCustody(actor);
  const taskSlice = await fieldTasks(actor);

  return {
    date: day,
    riderName: actor.fullName,
    summary: {
      assigned: home.assigned,
      delivered: home.delivered,
      remaining: home.remaining,
      failed,
    },
    failedAttempts: home.failedAttempts,
    batches,
    currentBatchId: home.currentBatch?.batch.id ?? null,
    cod: {
      expectedPaisa: home.codExpectedPaisa,
      collectedPaisa: home.codCollectedPaisa,
      remainingPaisa: (
        BigInt(home.codExpectedPaisa) - BigInt(home.codCollectedPaisa)
      ).toString(),
      awaitingRemittancePaisa: codPosition.awaitingRemittanceTotalPaisa,
      verifiedRemittedPaisa: codPosition.verifiedRemittedPaisa,
    },
    custody: custody.map((row) => ({
      trackingId: row.trackingId,
      packageStatus: row.packageStatus,
      warehouseCode: row.warehouseCode,
      startedAt: row.startedAt,
    })),
    tasks: taskSlice.tasks,
    openTaskCount: taskSlice.openTaskCount,
  };
}

// ---------------------------------------------------------------------------
// Line-haul field home (V3 Step 6)
// ---------------------------------------------------------------------------

export interface LinehaulFieldHomeData {
  driverName: string;
  profile: {
    homeWarehouseCode: string;
    licenseNumber: string;
    licenseExpiry: string;
    licenseExpired: boolean;
    employmentStatus: string;
    availabilityStatus: string;
  } | null;
  activeTrip: {
    id: string;
    transferId: string;
    tripNumber: string;
    transferNumber: string;
    status: string;
    originWarehouseCode: string;
    destinationWarehouseCode: string;
    vehicleRegistration: string;
    manifestCode: string | null;
    loadedCount: number;
    expectedCount: number;
    departedAt: string | null;
    arrivedAt: string | null;
    loadByStatus: { status: string; count: number }[];
    packages: {
      packageId: string;
      trackingId: string;
      itemStatus: string;
      packageStatus: string;
    }[];
    stops: {
      id: string;
      sequence: number;
      label: string;
      passedAt: string | null;
      recordedByName: string;
      notes: string | null;
    }[];
  } | null;
  destination: {
    name: string;
    code: string;
    city: string;
    district: string;
    addressLine1: string | null;
    addressLine2: string | null;
    contactPhone: string | null;
  } | null;
  tasks: {
    id: string;
    title: string;
    status: string;
    priority: string;
    dueAt: string | null;
    overdue: boolean;
  }[];
  openTaskCount: number;
  recentTrips: {
    id: string;
    tripNumber: string;
    originWarehouseCode: string;
    destinationWarehouseCode: string;
    status: string;
    packageCount: number;
    departedAt: string | null;
    arrivedAt: string | null;
  }[];
  recentActivity: { at: string; label: string }[];
}

/** Group a trip's packages by item status, first-appearance order. */
function loadByStatus(
  packages: TripView["packages"],
): { status: string; count: number }[] {
  const grouped: { status: string; count: number }[] = [];
  for (const pkg of packages) {
    const row = grouped.find((g) => g.status === pkg.itemStatus);
    if (row) row.count += 1;
    else grouped.push({ status: pkg.itemStatus, count: 1 });
  }
  return grouped;
}

/**
 * The V3 Line-haul field home read model: mirrors the CURRENT
 * linehaul-home.tsx composition exactly — own driver profile
 * (getDriver, failures degrade to null), own active trip
 * (getMyActiveTrip), its transfer (getTransfer, failures degrade to
 * null) for the manifest code + reconciliation loaded count, and own
 * trip history (listTrips mine) for recent completed/cancelled trips.
 *
 * NO ETA (hard rule): the trip view is field-mapped explicitly and
 * the model carries NO plannedDepartureAt / expectedArrivalAt key
 * anywhere — a field home shows what has happened and what is
 * loaded, never a promised arrival.
 *
 * The one new query is the destination warehouse read: it is keyed
 * by the destination of the driver's OWN active trip (never by a
 * parameter), and mirrors warehouses.ts toView's address pick
 * (PRIMARY address, else the first).
 */
export async function getLinehaulFieldHome(
  actor: ActorContext,
): Promise<LinehaulFieldHomeData> {
  const profileView = actor.driverId
    ? await getDriver(actor, actor.driverId).catch(() => null)
    : null;
  const trip = await getMyActiveTrip(actor);
  const transfer = trip
    ? await getTransfer(actor, trip.transferId).catch(() => null)
    : null;
  const { items: history } = await listTrips(actor, { mine: true, pageSize: 10 });
  const taskSlice = await fieldTasks(actor);

  const loadedCount =
    transfer?.reconciliation.loadedCount ??
    (trip
      ? trip.packages.filter((p) =>
          ["LOADED", "IN_TRANSIT", "RECEIVED"].includes(p.itemStatus),
        ).length
      : 0);
  const expectedCount = transfer?.manifest?.packageCount ?? trip?.packageCount ?? 0;

  let destination: LinehaulFieldHomeData["destination"] = null;
  if (trip) {
    const warehouse = await prisma.warehouse.findUnique({
      where: { id: trip.destinationWarehouseId },
      select: {
        name: true,
        code: true,
        city: true,
        district: true,
        contactPhone: true,
        addresses: {
          select: { kind: true, addressLine1: true, addressLine2: true },
        },
      },
    });
    if (warehouse) {
      const primary =
        warehouse.addresses.find((a) => a.kind === "PRIMARY") ?? warehouse.addresses[0];
      destination = {
        name: warehouse.name,
        code: warehouse.code,
        city: warehouse.city,
        district: warehouse.district,
        addressLine1: primary?.addressLine1 ?? null,
        addressLine2: primary?.addressLine2 ?? null,
        contactPhone: warehouse.contactPhone,
      };
    }
  }

  const recentTrips = history
    .filter(
      (t) => (t.status === "COMPLETED" || t.status === "CANCELLED") && t.id !== trip?.id,
    )
    .slice(0, 5)
    .map((t) => ({
      id: t.id,
      tripNumber: t.tripNumber,
      originWarehouseCode: t.originWarehouseCode,
      destinationWarehouseCode: t.destinationWarehouseCode,
      status: t.status,
      packageCount: t.packageCount,
      departedAt: t.actualDepartureAt,
      arrivedAt: t.actualArrivalAt,
    }));

  // Activity derived from the trip views themselves (active trip
  // first, then history — de-duplicated by trip id): departures,
  // arrivals and passed checkpoints, newest first.
  const activity: { at: string; label: string }[] = [];
  const seenTripIds = new Set<string>();
  const activitySources: TripView[] = [];
  if (trip) {
    seenTripIds.add(trip.id);
    activitySources.push(trip);
  }
  for (const item of history) {
    if (seenTripIds.has(item.id)) continue;
    seenTripIds.add(item.id);
    activitySources.push(item);
  }
  for (const source of activitySources) {
    if (source.actualDepartureAt) {
      activity.push({
        at: source.actualDepartureAt,
        label: `Departed ${source.originWarehouseCode} → ${source.destinationWarehouseCode} · ${source.tripNumber}`,
      });
    }
    if (source.actualArrivalAt) {
      activity.push({
        at: source.actualArrivalAt,
        label: `Arrived ${source.destinationWarehouseCode} · ${source.tripNumber}`,
      });
    }
    for (const stop of source.stops) {
      if (stop.passedAt) {
        activity.push({ at: stop.passedAt, label: `${stop.label} · ${source.tripNumber}` });
      }
    }
  }
  activity.sort((a, b) => b.at.localeCompare(a.at));

  return {
    driverName: actor.fullName,
    profile: profileView
      ? {
          homeWarehouseCode: profileView.homeWarehouseCode,
          licenseNumber: profileView.licenseNumber,
          licenseExpiry: profileView.licenseExpiry,
          licenseExpired: profileView.licenseExpired,
          employmentStatus: profileView.employmentStatus,
          availabilityStatus: profileView.availabilityStatus,
        }
      : null,
    activeTrip: trip
      ? {
          id: trip.id,
          transferId: trip.transferId,
          tripNumber: trip.tripNumber,
          transferNumber: trip.transferNumber,
          status: trip.status,
          originWarehouseCode: trip.originWarehouseCode,
          destinationWarehouseCode: trip.destinationWarehouseCode,
          vehicleRegistration: trip.vehicleRegistration,
          manifestCode: transfer?.manifest?.manifestCode ?? null,
          loadedCount,
          expectedCount,
          departedAt: trip.actualDepartureAt,
          arrivedAt: trip.actualArrivalAt,
          loadByStatus: loadByStatus(trip.packages),
          packages: trip.packages.map((p) => ({
            packageId: p.packageId,
            trackingId: p.trackingId,
            itemStatus: p.itemStatus,
            packageStatus: p.packageStatus,
          })),
          stops: trip.stops.map((s) => ({
            id: s.id,
            sequence: s.sequence,
            label: s.label,
            passedAt: s.passedAt,
            recordedByName: s.recordedByName,
            notes: s.notes,
          })),
        }
      : null,
    destination,
    tasks: taskSlice.tasks,
    openTaskCount: taskSlice.openTaskCount,
    recentTrips,
    recentActivity: activity.slice(0, 6),
  };
}

// ---------------------------------------------------------------------------
// Vendor + Customer homes (V3 Step 7)
// ---------------------------------------------------------------------------

import { getVendor, listVendorAssignments } from "@/server/services/vendors";
import { getVendorReport } from "@/server/services/reports";
import { listBookings } from "@/server/services/bookings";
import { listPackages } from "@/server/services/packages";
import type { PackageView } from "@/server/services/package-lifecycle";
import { listReturns } from "@/server/services/returns";
import { listTickets } from "@/server/services/support-tickets";
import { listInvoices } from "@/server/services/invoices";
import { listMyNotifications } from "@/server/services/notifications";

/** Vendor-shipment row shared by the recent + attention lists. Mapped
 *  field-by-field from PackageView (never spread): the vendor surface
 *  gets the parcel's identity, destination district/city, statuses and
 *  COD amount — nothing else from the shared view. */
export interface VendorShipmentRow {
  id: string;
  trackingId: string;
  orderId: string;
  recipientName: string;
  deliveryCity: string;
  deliveryDistrict: string;
  operationalStatus: string;
  deliveryStatus: string;
  codAmountPaisa: string;
  createdAt: string;
}

function toVendorShipmentRow(pkg: PackageView): VendorShipmentRow {
  return {
    id: pkg.id,
    trackingId: pkg.trackingId,
    orderId: pkg.orderId,
    recipientName: pkg.recipientName,
    deliveryCity: pkg.deliveryCity,
    deliveryDistrict: pkg.deliveryDistrict,
    operationalStatus: pkg.operationalStatus,
    deliveryStatus: pkg.deliveryStatus,
    codAmountPaisa: pkg.codAmountPaisa,
    createdAt: pkg.createdAt,
  };
}

/** Current package count for a set of operational statuses, summed
 *  from the scoped list's totals (pageSize 1 — only the count is
 *  read). Mirrors the current vendor page's own helper. */
async function vendorPackageCount(
  actor: ActorContext,
  statuses: readonly string[],
): Promise<number> {
  const parts = await Promise.all(
    statuses.map(
      async (status) =>
        (await listPackages(actor, { status, page: 1, pageSize: 1 })).meta.total,
    ),
  );
  return parts.reduce((sum, n) => sum + n, 0);
}

export interface VendorHomeData {
  vendor: {
    id: string;
    businessName: string;
    verificationStatus: string;
    isActive: boolean;
    /** The vendor's warehouse assignments (listVendorAssignments —
     *  readable by the vendor's own users via requireVendorReadable).
     *  VendorView itself carries no primary-warehouse field, so the
     *  assignments are the honest warehouse picture: every assigned
     *  warehouse, no invented "primary". */
    warehouses: {
      warehouseId: string;
      warehouseCode: string;
      kind: string;
      isActive: boolean;
    }[];
  };
  metrics: {
    /** The vendor report's own range (its default 30-day window) —
     *  carried through so the page labels the windowed figures with
     *  the exact dates the report used. */
    range: { from: string; to: string };
    /** Orders booked in the report range (report row). */
    bookings: number;
    /** Live ProofOfDelivery rows in the report range (report row). */
    delivered: number;
    /** Returns created in the report range (report row). */
    returnsCreated: number;
    /** Current packages booked but not yet picked up
     *  (BOOKED + PICKUP_ASSIGNED + PICKUP_IN_PROGRESS). */
    pendingPickup: number;
    /** Current packages on a warehouse-to-warehouse leg
     *  (DISPATCHED + IN_TRANSIT — the file's IN_TRANSIT_STATUSES). */
    inTransit: number;
    outForDelivery: number;
    deliveryAttempted: number;
    /** The vendor-payable LEDGER balance from the report row
     *  (payableBalancePaisa). This is COD payable TO the vendor —
     *  it is never the report's codCollectedPaisa and is never
     *  labelled "COD collected". */
    codPayablePaisa: string;
    /** Open-invoice totals minus derived paid components (report
     *  row). The report row carries NO open-invoice count (its
     *  invoicesIssued counts invoices issued inside the range, a
     *  different figure), so this model carries no such count
     *  rather than mislabelling one. */
    outstandingPaisa: string;
  };
  attention: {
    deliveryAttempted: number;
    /** Returns in REQUESTED — asked for, not yet approved/collected. */
    returnsAwaiting: number;
    /** Open incidents on the vendor's own packages. Scoping proof:
     *  listIncidents branches on actor type — a vendor actor holds
     *  incident.report, not incident.manage (permissions catalog),
     *  so it lands in the `actor.vendorId` branch, which scopes the
     *  query to `{ package: { order: { vendorId } } }`. */
    openIncidents: number;
    /** Open tickets on the vendor organisation. Scoping proof:
     *  listTickets scopes `{ vendorId: actor.vendorId }` for every
     *  actor without support.ticket.manage (a staff-only grant the
     *  vendor role does not hold). */
    openTickets: number;
  };
  recentShipments: VendorShipmentRow[];
  /** The DELIVERY_ATTEMPTED packages behind attention.deliveryAttempted. */
  attentionShipments: VendorShipmentRow[];
  recentBookings: {
    id: string;
    orderNumber: string;
    destinationDistrict: string;
    packageCount: number;
    status: string;
    approvalStatus: string;
    createdAt: string;
  }[];
  recentReturns: {
    id: string;
    returnNumber: string;
    trackingId: string;
    reason: string;
    status: string;
    createdAt: string;
  }[];
}

/**
 * The V3 Vendor home read model: a 1:1 data replacement for the
 * composition the current vendor page performs inline. Every read is
 * force-scoped to the vendor organisation inside its own service —
 * getVendor / listVendorAssignments (requireVendorReadable: own org
 * or vendor.read_all), getVendorReport (vendor actors resolve to
 * their own row only), listPackages / listBookings (vendor branch:
 * order.vendorId = actor.vendorId), listReturns (vendor branch:
 * order.vendorId), listIncidents / listTickets (see the attention
 * field comments for their vendor branches). Every list row is
 * field-mapped explicitly, never spread.
 *
 * The page handles the unlinked case (!actor.vendorId) before
 * calling; this model assumes the link exists and throws otherwise,
 * matching the fail-closed posture of the sibling models.
 */
export async function getVendorHome(actor: ActorContext): Promise<VendorHomeData> {
  if (!actor.vendorId) {
    throw new Error("getVendorHome requires an actor linked to a vendor organisation");
  }
  const vendorId = actor.vendorId;

  const vendor = await getVendor(actor, vendorId);
  const assignments = await listVendorAssignments(actor, vendorId);
  const report = await getVendorReport(actor, {});
  const row = report.rows[0];

  const [
    pendingPickup,
    inTransit,
    outForDelivery,
    attemptedPage,
    recentPage,
    returnsAwaitingPage,
    recentReturnsPage,
    recentBookingsPage,
    openIncidentsPage,
    openTicketsPage,
  ] = await Promise.all([
    vendorPackageCount(actor, AWAITING_PICKUP_STATUSES),
    vendorPackageCount(actor, IN_TRANSIT_STATUSES),
    vendorPackageCount(actor, ["OUT_FOR_DELIVERY"]),
    listPackages(actor, { status: "DELIVERY_ATTEMPTED", page: 1, pageSize: 5 }),
    listPackages(actor, { page: 1, pageSize: 8 }),
    listReturns(actor, { status: "REQUESTED", page: 1, pageSize: 1 }),
    listReturns(actor, { page: 1, pageSize: 5 }),
    listBookings(actor, { page: 1, pageSize: 5 }),
    listIncidents(actor, { openOnly: true, page: 1, pageSize: 1 }),
    listTickets(actor, { openOnly: true, page: 1, pageSize: 1 }),
  ]);

  return {
    vendor: {
      id: vendor.id,
      businessName: vendor.businessName,
      verificationStatus: vendor.verificationStatus,
      isActive: vendor.isActive,
      warehouses: assignments.map((assignment) => ({
        warehouseId: assignment.warehouseId,
        warehouseCode: assignment.warehouseCode,
        kind: assignment.kind,
        isActive: assignment.isActive,
      })),
    },
    metrics: {
      range: { from: report.range.from, to: report.range.to },
      bookings: row?.bookings ?? 0,
      delivered: row?.delivered ?? 0,
      returnsCreated: row?.returnsCreated ?? 0,
      pendingPickup,
      inTransit,
      outForDelivery,
      deliveryAttempted: attemptedPage.meta.total,
      codPayablePaisa: row?.payableBalancePaisa ?? "0",
      outstandingPaisa: row?.outstandingPaisa ?? "0",
    },
    attention: {
      deliveryAttempted: attemptedPage.meta.total,
      returnsAwaiting: returnsAwaitingPage.meta.total,
      openIncidents: openIncidentsPage.meta.total,
      openTickets: openTicketsPage.meta.total,
    },
    recentShipments: recentPage.packages.map(toVendorShipmentRow),
    attentionShipments: attemptedPage.packages.map(toVendorShipmentRow),
    recentBookings: recentBookingsPage.bookings.map((booking) => ({
      id: booking.id,
      orderNumber: booking.orderNumber,
      destinationDistrict: booking.destinationDistrict,
      packageCount: booking.packageCount,
      status: booking.status,
      approvalStatus: booking.approvalStatus,
      createdAt: booking.createdAt,
    })),
    recentReturns: recentReturnsPage.items.map((ret) => ({
      id: ret.id,
      returnNumber: ret.returnNumber,
      trackingId: ret.trackingId,
      reason: ret.reason,
      status: ret.status,
      createdAt: ret.createdAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// Customer home (V3 Step 7)
// ---------------------------------------------------------------------------

export interface CustomerHomeData {
  metrics: {
    /** Every package addressed to this customer. */
    total: number;
    /** On a warehouse-to-warehouse leg: DISPATCHED + IN_TRANSIT —
     *  the same bucket this file's executive home uses
     *  (IN_TRANSIT_STATUSES / bucketPackageStates). DISPATCHED joins
     *  it deliberately: the parcel has left its origin warehouse and
     *  is travelling, which is what "in transit" means on this home. */
    inTransit: number;
    /** OUT_FOR_DELIVERY, carried SEPARATELY from inTransit — the
     *  current UI folds it into the "In transit" tile with an OFD
     *  sub-line; the model keeps the two counts distinct so the page
     *  can present each honestly. */
    outForDelivery: number;
    delivered: number;
    /** ReturnRequests whose package is addressed to this customer.
     *  Source: ONE direct count scoped exactly
     *  `package.recipientCustomerId = actor.customerId` — listReturns
     *  has NO customer branch (a customer actor falls through to the
     *  warehouse branch and reads nothing), so the returns service
     *  cannot supply a customer figure; the direct count follows the
     *  same own-scope predicate listPackages uses for customers. */
    returned: number;
  };
  attention: {
    deliveryAttempted: number;
    /** Open tickets — listTickets scopes a customer actor to
     *  `{ customerId: actor.customerId }` (raisedBy fallthrough does
     *  not apply: the customerId branch precedes it, and the actor
     *  holds no support.ticket.manage). */
    openTickets: number;
    /** Invoices addressed to the customer with money still owing —
     *  the current home's own derivation over the customer's FULL
     *  listInvoices result (every page; status !== CANCELLED &&
     *  outstandingPaisa !== "0"). */
    unpaidInvoices: number;
    unpaidTotalPaisa: string;
  };
  /** The DELIVERY_ATTEMPTED packages behind attention.deliveryAttempted. */
  attemptedShipments: {
    id: string;
    trackingId: string;
    description: string;
    operationalStatus: string;
    deliveryStatus: string;
    deliveryCity: string;
    deliveryDistrict: string;
    createdAt: string;
  }[];
  /**
   * Active shipments (not DELIVERED / CANCELLED), newest first,
   * capped at 5. Source: ONE direct query scoped exactly
   * `recipientCustomerId = actor.customerId` — listPackages'
   * PackageView carries neither the shipment's expectedDeliveryAt
   * nor the current warehouse, and both are real stored fields the
   * home shows. The select names ONLY the fields below plus
   * shipment.expectedDeliveryAt and currentWarehouse { name, city }:
   * no coordinates, no driver fields, no recipient phone/address.
   */
  currentShipments: {
    trackingId: string;
    description: string;
    operationalStatus: string;
    deliveryCity: string;
    deliveryDistrict: string;
    /** The shipment's stored estimate, set at booking from the
     *  shipping service. Null when the data carries none — never
     *  computed here; the page shows it only when present. */
    expectedDeliveryAt: string | null;
    /** "<warehouse name>, <city>" of the package's current
     *  warehouse; null when the package is not at a warehouse. */
    currentLocationLabel: string | null;
    lastUpdateAt: string;
  }[];
  recentDeliveries: {
    trackingId: string;
    description: string;
    deliveryCity: string;
    deliveryDistrict: string;
    /** PackageView carries no delivered-at timestamp (the
     *  ProofOfDelivery row is not exposed by any package read), so
     *  this is the package's own updatedAt — the page labels it as
     *  a last-update time, never as a proven delivery instant. */
    lastUpdateAt: string;
  }[];
  /** The customer's own in-app notifications, newest first; null
   *  when the read failed — the current home's catch-to-null
   *  tolerance, so a notification outage never fails the home. */
  recentNotifications:
    | { id: string; title: string; body: string; createdAt: string }[]
    | null;
}

/**
 * The V3 Customer home read model: a composition over the same
 * force-scoped reads the current customer home uses — listPackages
 * (customer branch: recipientCustomerId = actor.customerId),
 * listTickets (customer branch: customerId), listInvoices
 * (invoiceScope: customerId) and listMyNotifications (own userId) —
 * plus the two direct own-scope queries documented on the model
 * fields above (returned count, current shipments).
 *
 * HARD RULE — the customer surface carries NO coordinates, NO driver
 * identity or contact, NO other customer's data, and no recipient
 * phone or street address (city/district only). Every service view
 * is field-mapped explicitly so nothing extra can leak through a
 * shared type; the Step 7 integration test serialises the model and
 * scans for the forbidden keys.
 *
 * The page handles the unlinked case (!actor.customerId) before
 * calling; this model assumes the link exists and throws otherwise.
 */
export async function getCustomerHome(actor: ActorContext): Promise<CustomerHomeData> {
  if (!actor.customerId) {
    throw new Error("getCustomerHome requires an actor linked to a customer record");
  }
  const customerId = actor.customerId;

  const totalFor = async (status?: string) =>
    (await listPackages(actor, { status, page: 1, pageSize: 1 })).meta.total;

  const [
    total,
    dispatched,
    inTransitStatus,
    outForDelivery,
    delivered,
    attemptedPage,
    deliveredPage,
    openTicketsPage,
    notificationsPage,
    returned,
    currentRows,
  ] = await Promise.all([
    totalFor(),
    totalFor("DISPATCHED"),
    totalFor("IN_TRANSIT"),
    totalFor("OUT_FOR_DELIVERY"),
    totalFor("DELIVERED"),
    listPackages(actor, { status: "DELIVERY_ATTEMPTED", page: 1, pageSize: 5 }),
    listPackages(actor, { status: "DELIVERED", page: 1, pageSize: 5 }),
    listTickets(actor, { openOnly: true, page: 1, pageSize: 1 }),
    listMyNotifications(actor, { page: 1, pageSize: 5 }).catch(() => null),
    prisma.returnRequest.count({
      where: { package: { recipientCustomerId: customerId } },
    }),
    prisma.package.findMany({
      where: {
        recipientCustomerId: customerId,
        operationalStatus: { notIn: ["DELIVERED", "CANCELLED"] },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        trackingId: true,
        description: true,
        operationalStatus: true,
        deliveryCity: true,
        deliveryDistrict: true,
        updatedAt: true,
        shipment: { select: { expectedDeliveryAt: true } },
        currentWarehouse: { select: { name: true, city: true } },
      },
    }),
  ]);

  // Unpaid derivation reads EVERY invoice page: a single page would
  // silently understate the count/total for a customer with more
  // open invoices than one page holds (Step 7 review finding G-1).
  const invoiceItems: Awaited<ReturnType<typeof listInvoices>>["items"] = [];
  for (let page = 1; ; page += 1) {
    const result = await listInvoices(actor, { page, pageSize: 100 });
    invoiceItems.push(...result.items);
    if (result.items.length < 100) break;
  }

  const unpaid = invoiceItems.filter(
    (invoice) => invoice.status !== "CANCELLED" && invoice.outstandingPaisa !== "0",
  );
  const unpaidTotal = unpaid.reduce(
    (sum, invoice) => sum + BigInt(invoice.outstandingPaisa),
    BigInt(0),
  );

  return {
    metrics: {
      total,
      inTransit: dispatched + inTransitStatus,
      outForDelivery,
      delivered,
      returned,
    },
    attention: {
      deliveryAttempted: attemptedPage.meta.total,
      openTickets: openTicketsPage.meta.total,
      unpaidInvoices: unpaid.length,
      unpaidTotalPaisa: unpaidTotal.toString(),
    },
    attemptedShipments: attemptedPage.packages.map((pkg) => ({
      id: pkg.id,
      trackingId: pkg.trackingId,
      description: pkg.description,
      operationalStatus: pkg.operationalStatus,
      deliveryStatus: pkg.deliveryStatus,
      deliveryCity: pkg.deliveryCity,
      deliveryDistrict: pkg.deliveryDistrict,
      createdAt: pkg.createdAt,
    })),
    currentShipments: currentRows.map((row) => ({
      trackingId: row.trackingId,
      description: row.description,
      operationalStatus: row.operationalStatus,
      deliveryCity: row.deliveryCity,
      deliveryDistrict: row.deliveryDistrict,
      expectedDeliveryAt: row.shipment.expectedDeliveryAt?.toISOString() ?? null,
      currentLocationLabel: row.currentWarehouse
        ? `${row.currentWarehouse.name}, ${row.currentWarehouse.city}`
        : null,
      lastUpdateAt: row.updatedAt.toISOString(),
    })),
    recentDeliveries: deliveredPage.packages.map((pkg) => ({
      trackingId: pkg.trackingId,
      description: pkg.description,
      deliveryCity: pkg.deliveryCity,
      deliveryDistrict: pkg.deliveryDistrict,
      lastUpdateAt: pkg.updatedAt,
    })),
    recentNotifications: notificationsPage
      ? notificationsPage.items.map((note) => ({
          id: note.id,
          title: note.title,
          body: note.body,
          createdAt: note.createdAt,
        }))
      : null,
  };
}
