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
