import "server-only";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  hasPermission,
  type ActorContext,
} from "@/lib/auth/actor";
import { INCIDENT_OPEN_STATUSES, TASK_OVERDUE_STATUSES } from "@/lib/operations/domain";
import { resolveReportRange, kathmanduToday } from "@/lib/reports/domain";
import { getWarehouseOpsSummary } from "@/server/services/inventory";
import { getDailyReport } from "@/server/services/reports";
import { listTransfers, type TransferView } from "@/server/services/transfers";
import { auditAccessDenied } from "@/server/services/scoping";
import {
  assertWarehouseScope,
  loadWarehouseOr404,
} from "@/server/services/warehouse-ops-shared";

/**
 * Warehouse Admin home aggregate (V2 Phase 6, spec §7 + §10.6).
 *
 * One scoped read for the WA home screen: every figure is computed
 * from queries that carry the warehouse id as an explicit predicate
 * — never a global count filtered in memory. The warehouse scope is
 * asserted BEFORE any query runs (scoped actors must hold a
 * membership; denials are `access.denied`-audited by the shared
 * guard). Inventory figures reuse getWarehouseOpsSummary so the
 * home can never disagree with the operations screens.
 *
 * "Today" is the Asia/Kathmandu calendar day (reports domain).
 */

export interface WarehouseHomeSummary {
  warehouseId: string;
  warehouseCode: string;
  needsAttention: {
    openIncidents: number;
    incidents: {
      id: string;
      incidentNumber: string;
      category: string;
      severity: string;
      status: string;
      createdAt: string;
    }[];
    /** Transfers at this destination whose receiving cannot close
     *  cleanly: status RECONCILIATION_PENDING / EXCEPTION, or any
     *  MISSING / DAMAGED item still on the transfer. */
    discrepancyTransfers: number;
    discrepancyItems: number;
    discrepancies: {
      id: string;
      transferNumber: string;
      status: string;
      missingCount: number;
      damagedCount: number;
      totalItems: number;
    }[];
    overdueTasks: number;
    overdueTaskList: {
      id: string;
      title: string;
      priority: string;
      dueAt: string | null;
      assigneeName: string | null;
    }[];
  };
  metrics: {
    /** InventoryRecords created today (Kathmandu) at this warehouse. */
    receivedToday: number;
    /** Open inventory records (packages physically here). */
    packagesAtWarehouse: number;
    /** RECEIVED_AT_ORIGIN + INSPECTION_PENDING — the inspection queue. */
    awaitingInspection: number;
    readyForDispatch: number;
    /** Transfers headed here in DISPATCHED / IN_TRANSIT / ARRIVED. */
    incomingTransfers: number;
    /** Open transfers originating here (OPEN_TRANSFER_STATUSES set). */
    outgoingTransfers: number;
  };
  deliveriesToday: {
    batches: number;
    assigned: number;
    delivered: number;
    remaining: number;
  };
  /** Drivers homed here, actively employed, AVAILABLE, licence valid. */
  availableRiders: number;
  recentMovements: {
    id: string;
    type: string;
    trackingId: string;
    actorName: string;
    createdAt: string;
  }[];
}

const INCOMING_STATUSES = ["DISPATCHED", "IN_TRANSIT", "ARRIVED"] as const;
const OPEN_OUTGOING_STATUSES = [
  "DRAFT",
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "PREPARING",
  "READY_FOR_DISPATCH",
  "DISPATCHED",
  "IN_TRANSIT",
  "ARRIVED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "RECONCILIATION_PENDING",
  "EXCEPTION",
] as const;

export async function getWarehouseHomeSummary(
  actor: ActorContext,
  warehouseId: string,
): Promise<WarehouseHomeSummary> {
  // Operations gate (Phase 6 security review F1): the warehouse home
  // exposes operational figures (incidents, tasks, transfers,
  // deliveries), so directory access alone (warehouse.read_all, held
  // by FINANCE / SUPPORT) must not unlock it. The actor needs an
  // inventory read grant — read_all (Admin / Super Admin) or
  // read_warehouse (Warehouse Admin / Staff) — checked BEFORE any
  // data read; assertWarehouseScope alone treats warehouse.read_all
  // holders as unscoped and would let them through.
  if (
    !hasPermission(actor, "inventory.read_all") &&
    !hasPermission(actor, "inventory.read_warehouse")
  ) {
    await auditAccessDenied(actor, "Warehouse", {
      warehouseId,
      reason: "missing_permission:inventory.read",
    });
    throw new AuthorizationError(
      "Missing required permission: inventory.read_all or inventory.read_warehouse",
    );
  }
  const warehouse = await loadWarehouseOr404(warehouseId);
  await assertWarehouseScope(actor, warehouseId, "Warehouse");

  const today = kathmanduToday();
  const range = resolveReportRange(today, today);
  const span = { gte: range.fromUtc, lt: range.toUtc };
  const batchDate = new Date(`${today}T00:00:00.000Z`);
  const now = new Date();

  const canReadInventory =
    hasPermission(actor, "inventory.read_all") ||
    hasPermission(actor, "inventory.read_warehouse");

  const [
    ops,
    receivedToday,
    openIncidentCount,
    incidentRows,
    discrepancyRows,
    overdueTaskCount,
    overdueTaskRows,
    incomingTransfers,
    outgoingTransfers,
    batchesToday,
    availableRiders,
    movementRows,
  ] = await Promise.all([
    canReadInventory
      ? getWarehouseOpsSummary(actor, warehouseId)
      : Promise.resolve(null),
    prisma.inventoryRecord.count({
      where: { warehouseId, receivedAt: span },
    }),
    prisma.incident.count({
      where: { warehouseId, status: { in: [...INCIDENT_OPEN_STATUSES] } },
    }),
    prisma.incident.findMany({
      where: { warehouseId, status: { in: [...INCIDENT_OPEN_STATUSES] } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        incidentNumber: true,
        category: true,
        severity: true,
        status: true,
        createdAt: true,
      },
    }),
    prisma.transfer.findMany({
      where: {
        destinationWarehouseId: warehouseId,
        status: { notIn: ["CLOSED", "CANCELLED"] },
        OR: [
          { status: { in: ["RECONCILIATION_PENDING", "EXCEPTION"] } },
          { items: { some: { itemStatus: { in: ["MISSING", "DAMAGED"] } } } },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        transferNumber: true,
        status: true,
        items: { select: { itemStatus: true } },
      },
    }),
    prisma.task.count({
      where: {
        warehouseId,
        dueAt: { lt: now },
        status: { in: [...TASK_OVERDUE_STATUSES] },
      },
    }),
    prisma.task.findMany({
      where: {
        warehouseId,
        dueAt: { lt: now },
        status: { in: [...TASK_OVERDUE_STATUSES] },
      },
      orderBy: { dueAt: "asc" },
      take: 5,
      include: { assignee: { select: { fullName: true } } },
    }),
    prisma.transfer.count({
      where: {
        destinationWarehouseId: warehouseId,
        status: { in: [...INCOMING_STATUSES] },
      },
    }),
    prisma.transfer.count({
      where: {
        originWarehouseId: warehouseId,
        status: { in: [...OPEN_OUTGOING_STATUSES] },
      },
    }),
    prisma.deliveryBatch.findMany({
      where: { warehouseId, batchDate },
      include: { assignments: { select: { status: true } } },
    }),
    prisma.driver.count({
      where: {
        homeWarehouseId: warehouseId,
        employmentStatus: "ACTIVE",
        availabilityStatus: "AVAILABLE",
        licenseExpiry: { gte: new Date(now.toISOString().slice(0, 10)) },
      },
    }),
    prisma.inventoryMovement.findMany({
      where: {
        OR: [{ fromWarehouseId: warehouseId }, { toWarehouseId: warehouseId }],
      },
      orderBy: { createdAt: "desc" },
      take: 8,
      include: {
        package: { select: { trackingId: true } },
        actor: { select: { fullName: true } },
      },
    }),
  ]);

  const discrepancies = discrepancyRows.map((t) => ({
    id: t.id,
    transferNumber: t.transferNumber,
    status: t.status,
    missingCount: t.items.filter((i) => i.itemStatus === "MISSING").length,
    damagedCount: t.items.filter((i) => i.itemStatus === "DAMAGED").length,
    totalItems: t.items.length,
  }));

  let assigned = 0;
  let delivered = 0;
  let remaining = 0;
  for (const batch of batchesToday) {
    for (const a of batch.assignments) {
      assigned += 1;
      if (a.status === "COMPLETED") delivered += 1;
      else if (["PENDING", "ACCEPTED", "IN_PROGRESS"].includes(a.status)) remaining += 1;
    }
  }

  const byStatus = ops?.byStatus ?? {};
  return {
    warehouseId,
    warehouseCode: warehouse.code,
    needsAttention: {
      openIncidents: openIncidentCount,
      incidents: incidentRows.map((r) => ({
        id: r.id,
        incidentNumber: r.incidentNumber,
        category: r.category,
        severity: r.severity,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
      discrepancyTransfers: discrepancies.length,
      discrepancyItems: discrepancies.reduce(
        (n, d) => n + d.missingCount + d.damagedCount,
        0,
      ),
      discrepancies,
      overdueTasks: overdueTaskCount,
      overdueTaskList: overdueTaskRows.map((t) => ({
        id: t.id,
        title: t.title,
        priority: t.priority,
        dueAt: t.dueAt?.toISOString() ?? null,
        assigneeName: t.assignee?.fullName ?? null,
      })),
    },
    metrics: {
      receivedToday,
      packagesAtWarehouse: ops?.openPackages ?? 0,
      awaitingInspection:
        (byStatus["RECEIVED_AT_ORIGIN"] ?? 0) + (byStatus["INSPECTION_PENDING"] ?? 0),
      readyForDispatch: byStatus["READY_FOR_DISPATCH"] ?? 0,
      incomingTransfers,
      outgoingTransfers,
    },
    deliveriesToday: {
      batches: batchesToday.length,
      assigned,
      delivered,
      remaining,
    },
    availableRiders,
    recentMovements: movementRows.map((m) => ({
      id: m.id,
      type: m.type,
      trackingId: m.package.trackingId,
      actorName: m.actor.fullName,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Warehouse Admin console (V3 Step 5)
// ---------------------------------------------------------------------------

export interface WarehouseConsoleTransferRow {
  id: string;
  transferNumber: string;
  status: string;
  /** The warehouse at the OTHER end of the transfer. */
  otherWarehouseName: string;
  otherWarehouseCode: string;
  expectedPackages: number;
  receivedPackages: number;
  driverName: string | null;
  dispatchedAt: string | null;
  expectedArrivalAt: string | null;
  arrivedAt: string | null;
  createdAt: string;
}

export interface WarehouseConsoleTaskRow {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueAt: string | null;
  assigneeName: string | null;
  warehouseCode: string | null;
  /** Due instant is in the past and the task is still open — the
   *  same semantics as the home summary's overdue list. */
  overdue: boolean;
  /** Due instant falls inside today's Kathmandu span. */
  dueToday: boolean;
}

export interface WarehouseConsoleData {
  /** Asia/Kathmandu calendar date (YYYY-MM-DD) every "today" figure
   *  on the console refers to. */
  today: string;
  /** The scope actually read — the caller's list, validated. */
  warehouseIds: string[];
  kpis: {
    receivedToday: number;
    awaitingInspection: number;
    readyForDispatch: number;
    incomingTransfers: number;
    outgoingTransfers: number;
    /** Today's delivery batches: assignments not yet completed. */
    pendingDeliveries: number;
    deliveriesAssignedToday: number;
    deliveriesDeliveredToday: number;
    /** Failed delivery attempts recorded today; null when the daily
     *  report is not readable by this actor (the card is omitted). */
    failedDeliveriesToday: number | null;
    /** Open inventory records — packages physically in stock. */
    inventoryItems: number;
    openIncidents: number;
    tasksDueToday: number;
    overdueTasks: number;
    availableRiders: number;
  };
  /** Today's operations from the daily report (per-warehouse reads
   *  summed over the scope). Null when the report is not readable —
   *  the section is omitted rather than estimated. Inspected /
   *  packed / loaded stages have no honest daily read and are not
   *  part of this shape at all. */
  todaysOps: {
    received: number;
    dispatchedPackages: number;
    transfersDispatched: number;
    delivered: number;
    failedAttempts: number;
  } | null;
  transfers: {
    incoming: WarehouseConsoleTransferRow[];
    outgoing: WarehouseConsoleTransferRow[];
  };
  /** Packages awaiting a human action, grouped by the queue that
   *  clears them. */
  awaitingAction: {
    inspection: number;
    dispatch: number;
    /** Packages READY_FOR_DELIVERY in open inventory — stocked,
     *  cleared, and not yet on a rider's batch. */
    deliveryAssignment: number;
    failedToday: number | null;
  };
  /** Open tasks at the scoped warehouses that are overdue or due
   *  today, earliest due first (capped at 10). */
  tasks: WarehouseConsoleTaskRow[];
  recentMovements: (WarehouseHomeSummary["recentMovements"][number] & {
    warehouseCode: string;
  })[];
}

const CONSOLE_CLOSED_TRANSFER_STATUSES: ReadonlySet<string> = new Set([
  "CLOSED",
  "CANCELLED",
]);

function consoleTransferRow(
  transfer: TransferView,
  direction: "incoming" | "outgoing",
): WarehouseConsoleTransferRow {
  const other =
    direction === "incoming"
      ? {
          name: transfer.originWarehouseName,
          code: transfer.originWarehouseCode,
        }
      : {
          name: transfer.destinationWarehouseName,
          code: transfer.destinationWarehouseCode,
        };
  return {
    id: transfer.id,
    transferNumber: transfer.transferNumber,
    status: transfer.status,
    otherWarehouseName: other.name,
    otherWarehouseCode: other.code,
    expectedPackages: transfer.items.length,
    receivedPackages: transfer.reconciliation.receivedCount,
    driverName: transfer.driverName,
    dispatchedAt: transfer.dispatchedAt,
    expectedArrivalAt: transfer.expectedArrivalAt,
    arrivedAt: transfer.arrivedAt,
    createdAt: transfer.createdAt,
  };
}

/**
 * The V3 Warehouse Admin console read model: one scoped aggregate
 * over an explicit warehouse list (the actor's member warehouses,
 * narrowed by the requested scope — the page resolves that list;
 * this function re-validates EVERY id through the same scope guard
 * the per-warehouse summary uses, so a caller can never widen the
 * read by passing another warehouse's id).
 *
 * Composition: the per-warehouse figures come from
 * getWarehouseHomeSummary itself (the console can never disagree
 * with the operations screens), today's stage counts come from the
 * daily report read once per warehouse with that warehouse as the
 * report's own scope filter, transfers come from listTransfers
 * (membership-scoped inside the service) split by which end of the
 * transfer sits in scope, and the task list / delivery-assignment
 * queue are direct queries carrying the scope ids as an explicit
 * predicate — the warehouse-home file's existing style.
 */
export async function getWarehouseConsole(
  actor: ActorContext,
  warehouseIds: string[],
): Promise<WarehouseConsoleData> {
  const today = kathmanduToday();
  const ids = [...new Set(warehouseIds)];

  if (ids.length === 0) {
    return {
      today,
      warehouseIds: [],
      kpis: {
        receivedToday: 0,
        awaitingInspection: 0,
        readyForDispatch: 0,
        incomingTransfers: 0,
        outgoingTransfers: 0,
        pendingDeliveries: 0,
        deliveriesAssignedToday: 0,
        deliveriesDeliveredToday: 0,
        failedDeliveriesToday: null,
        inventoryItems: 0,
        openIncidents: 0,
        tasksDueToday: 0,
        overdueTasks: 0,
        availableRiders: 0,
      },
      todaysOps: null,
      transfers: { incoming: [], outgoing: [] },
      awaitingAction: {
        inspection: 0,
        dispatch: 0,
        deliveryAssignment: 0,
        failedToday: null,
      },
      tasks: [],
      recentMovements: [],
    };
  }

  // Per-warehouse summaries first: each call re-runs the inventory
  // permission gate and assertWarehouseScope for its warehouse, so
  // an out-of-scope id fails the whole read before any console-only
  // query runs.
  const summaries = await Promise.all(
    ids.map((id) => getWarehouseHomeSummary(actor, id)),
  );

  const range = resolveReportRange(today, today);
  const span = { gte: range.fromUtc, lt: range.toUtc };
  const now = new Date();

  // Daily report per warehouse (its warehouseId filter is itself
  // scope-checked inside the reports service). Any denial makes the
  // whole today-section unreadable — a partial sum would understate
  // silently, so the section degrades to null instead.
  let todaysOps: WarehouseConsoleData["todaysOps"] = {
    received: 0,
    dispatchedPackages: 0,
    transfersDispatched: 0,
    delivered: 0,
    failedAttempts: 0,
  };
  for (const id of ids) {
    try {
      const daily = await getDailyReport(actor, {
        from: today,
        to: today,
        warehouseId: id,
      });
      todaysOps.received += daily.packagesReceived;
      todaysOps.dispatchedPackages += daily.packagesDispatched;
      todaysOps.transfersDispatched += daily.transfersDispatched;
      todaysOps.delivered += daily.delivered;
      todaysOps.failedAttempts += daily.failedAttempts;
    } catch (error) {
      if ((error as { name?: string })?.name === "AuthorizationError") {
        todaysOps = null;
        break;
      }
      throw error;
    }
  }

  const [taskRows, tasksDueToday, deliveryAssignment] = await Promise.all([
    prisma.task.findMany({
      where: {
        warehouseId: { in: ids },
        status: { in: [...TASK_OVERDUE_STATUSES] },
        dueAt: { lt: range.toUtc },
      },
      orderBy: { dueAt: "asc" },
      take: 10,
      include: {
        assignee: { select: { fullName: true } },
        warehouse: { select: { code: true } },
      },
    }),
    prisma.task.count({
      where: {
        warehouseId: { in: ids },
        status: { in: [...TASK_OVERDUE_STATUSES] },
        dueAt: span,
      },
    }),
    prisma.inventoryRecord.count({
      where: {
        warehouseId: { in: ids },
        releasedAt: null,
        package: { operationalStatus: "READY_FOR_DELIVERY" },
      },
    }),
  ]);

  // Transfers: listTransfers scopes to the actor's memberships
  // itself; the split below narrows further to the console scope —
  // a transfer touching only a non-scope member warehouse drops out.
  let transferViews: TransferView[] = [];
  try {
    transferViews = (await listTransfers(actor, { pageSize: 100 })).items;
  } catch (error) {
    if ((error as { name?: string })?.name !== "AuthorizationError") throw error;
  }
  const scopeSet = new Set(ids);
  const openTransfers = transferViews.filter(
    (t) => !CONSOLE_CLOSED_TRANSFER_STATUSES.has(t.status),
  );
  const incoming = openTransfers
    .filter((t) => scopeSet.has(t.destinationWarehouseId))
    .slice(0, 6)
    .map((t) => consoleTransferRow(t, "incoming"));
  const outgoing = openTransfers
    .filter((t) => scopeSet.has(t.originWarehouseId))
    .slice(0, 6)
    .map((t) => consoleTransferRow(t, "outgoing"));

  const sum = (pick: (s: WarehouseHomeSummary) => number) =>
    summaries.reduce((total, s) => total + pick(s), 0);

  return {
    today,
    warehouseIds: ids,
    kpis: {
      receivedToday: sum((s) => s.metrics.receivedToday),
      awaitingInspection: sum((s) => s.metrics.awaitingInspection),
      readyForDispatch: sum((s) => s.metrics.readyForDispatch),
      incomingTransfers: sum((s) => s.metrics.incomingTransfers),
      outgoingTransfers: sum((s) => s.metrics.outgoingTransfers),
      pendingDeliveries: sum((s) => s.deliveriesToday.remaining),
      deliveriesAssignedToday: sum((s) => s.deliveriesToday.assigned),
      deliveriesDeliveredToday: sum((s) => s.deliveriesToday.delivered),
      failedDeliveriesToday: todaysOps ? todaysOps.failedAttempts : null,
      inventoryItems: sum((s) => s.metrics.packagesAtWarehouse),
      openIncidents: sum((s) => s.needsAttention.openIncidents),
      tasksDueToday,
      overdueTasks: sum((s) => s.needsAttention.overdueTasks),
      availableRiders: sum((s) => s.availableRiders),
    },
    todaysOps,
    transfers: { incoming, outgoing },
    awaitingAction: {
      inspection: sum((s) => s.metrics.awaitingInspection),
      dispatch: sum((s) => s.metrics.readyForDispatch),
      deliveryAssignment,
      failedToday: todaysOps ? todaysOps.failedAttempts : null,
    },
    tasks: taskRows.map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueAt: t.dueAt?.toISOString() ?? null,
      assigneeName: t.assignee?.fullName ?? null,
      warehouseCode: t.warehouse?.code ?? null,
      overdue: t.dueAt !== null && t.dueAt < now,
      dueToday:
        t.dueAt !== null && t.dueAt >= range.fromUtc && t.dueAt < range.toUtc,
    })),
    recentMovements: summaries
      .flatMap((s) =>
        s.recentMovements.map((m) => ({ ...m, warehouseCode: s.warehouseCode })),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, 8),
  };
}
