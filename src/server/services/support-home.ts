import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import {
  TASK_TERMINAL_STATUSES,
  TICKET_OPEN_STATUSES,
} from "@/lib/operations/domain";
import {
  addDays,
  kathmanduDayStartUtc,
  kathmanduToday,
} from "@/lib/reports/domain";
import { requirePermAudited } from "@/server/services/scoping";
import { listIncidents } from "@/server/services/incidents";
import { listTickets } from "@/server/services/support-tickets";
import { listTasks } from "@/server/services/tasks";

/**
 * Support home read (V2 Phase 6, audit defect H-2). One scoped read
 * behind the universal home pattern: needs-attention → current
 * operations → metrics → recent activity.
 *
 * Scope: the ticket figures are the staff inbox figures — a
 * `support.ticket.manage` holder sees every ticket (the same scope
 * `listTickets` applies). Incident figures reuse `listIncidents`,
 * so the SUPPORT category scope (customer-facing categories) is
 * inherited exactly, never re-implemented. Overdue deliveries are a
 * package read: a shipment whose expected delivery date has passed
 * while its package is not DELIVERED (and not in a terminal
 * operational state) — computed from Shipment.expectedDeliveryAt,
 * the only expected-date field in the schema. No existing report
 * produced this count, so the read lives here, read-only.
 *
 * This module is reads only. Support holds no custody or payment
 * mutation permission and this read creates no path to one.
 */

/** Hours an open ticket may age before the home flags it as
 *  breaching. There is no SLA contract table in the schema; 48h is
 *  the home's explicit attention threshold, labelled as such in the
 *  UI — not a promised customer SLA. */
export const SUPPORT_TICKET_ATTENTION_HOURS = 48;

export interface SupportHome {
  today: string;
  attention: {
    unassignedTickets: number;
    /** Open tickets older than SUPPORT_TICKET_ATTENTION_HOURS. */
    breachingTickets: number;
    unresolvedHighSeverityIncidents: number;
    overdueDeliveries: number;
  };
  queues: {
    open: number;
    inProgress: number;
    awaitingCustomer: number;
    escalated: number;
    resolvedToday: number;
    totalOpen: number;
  };
  metrics: {
    openTickets: number;
    openIncidents: number;
    resolvedToday: number;
    overdueDeliveries: number;
  };
  oldestOpenTickets: {
    id: string;
    ticketNumber: string;
    subject: string;
    status: string;
    priority: string;
    assignedToId: string | null;
    createdAt: string;
  }[];
  overdueDeliveryItems: {
    packageId: string;
    trackingId: string;
    deliveryStatus: string;
    operationalStatus: string;
    expectedDeliveryAt: string;
  }[];
  recentTickets: {
    id: string;
    ticketNumber: string;
    subject: string;
    status: string;
    updatedAt: string;
  }[];
  recentIncidents: {
    id: string;
    incidentNumber: string;
    category: string;
    severity: string;
    status: string;
    updatedAt: string;
  }[];
}

export async function getSupportHome(actor: ActorContext): Promise<SupportHome> {
  await requirePermAudited(actor, "support.ticket.manage", "SupportTicket");

  const today = kathmanduToday();
  const todaySpan = { gte: kathmanduDayStartUtc(today), lt: kathmanduDayStartUtc(addDays(today, 1)) };
  const now = new Date();
  const breachCutoff = new Date(now.getTime() - SUPPORT_TICKET_ATTENTION_HOURS * 60 * 60 * 1000);
  const openStatuses = [...TICKET_OPEN_STATUSES];

  const canReadPackages =
    hasPermission(actor, "package.read_all") || hasPermission(actor, "booking.read_all");
  const overdueWhere: Prisma.PackageWhereInput = {
    deliveryStatus: { not: "DELIVERED" },
    operationalStatus: { notIn: ["DELIVERED", "CANCELLED"] },
    shipment: { expectedDeliveryAt: { lt: now } },
  };

  const [
    statusGroups,
    unassigned,
    breaching,
    resolvedToday,
    oldestOpen,
    recentTicketRows,
    openIncidents,
    highIncidents,
    criticalIncidents,
    recentIncidentList,
    overdueCount,
  ] = await Promise.all([
    prisma.supportTicket.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.supportTicket.count({
      where: { assignedToId: null, status: { in: openStatuses } },
    }),
    prisma.supportTicket.count({
      where: { status: { in: openStatuses }, createdAt: { lt: breachCutoff } },
    }),
    prisma.supportTicket.count({
      where: { status: "RESOLVED", resolvedAt: todaySpan },
    }),
    prisma.supportTicket.findMany({
      where: { status: { in: openStatuses } },
      orderBy: { createdAt: "asc" },
      take: 5,
      select: {
        id: true,
        ticketNumber: true,
        subject: true,
        status: true,
        priority: true,
        assignedToId: true,
        createdAt: true,
      },
    }),
    prisma.supportTicket.findMany({
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { id: true, ticketNumber: true, subject: true, status: true, updatedAt: true },
    }),
    listIncidents(actor, { openOnly: true, page: 1, pageSize: 1 }),
    listIncidents(actor, { openOnly: true, severity: "HIGH", page: 1, pageSize: 1 }),
    listIncidents(actor, { openOnly: true, severity: "CRITICAL", page: 1, pageSize: 1 }),
    listIncidents(actor, { page: 1, pageSize: 5 }),
    canReadPackages ? prisma.package.count({ where: overdueWhere }) : Promise.resolve(0),
  ]);

  const overdueRows = canReadPackages
    ? await prisma.package.findMany({
        where: overdueWhere,
        orderBy: { shipment: { expectedDeliveryAt: "asc" } },
        take: 5,
        select: {
          id: true,
          trackingId: true,
          deliveryStatus: true,
          operationalStatus: true,
          shipment: { select: { expectedDeliveryAt: true } },
        },
      })
    : [];

  const byStatus = new Map(statusGroups.map((g) => [g.status, g._count._all]));
  const open = byStatus.get("OPEN") ?? 0;
  const inProgress = byStatus.get("IN_PROGRESS") ?? 0;
  const awaitingCustomer = byStatus.get("AWAITING_CUSTOMER") ?? 0;
  const escalated = byStatus.get("ESCALATED") ?? 0;
  const totalOpen = open + inProgress + awaitingCustomer + escalated;
  const highSeverity = highIncidents.meta.total + criticalIncidents.meta.total;

  return {
    today,
    attention: {
      unassignedTickets: unassigned,
      breachingTickets: breaching,
      unresolvedHighSeverityIncidents: highSeverity,
      overdueDeliveries: overdueCount,
    },
    queues: { open, inProgress, awaitingCustomer, escalated, resolvedToday, totalOpen },
    metrics: {
      openTickets: totalOpen,
      openIncidents: openIncidents.meta.total,
      resolvedToday,
      overdueDeliveries: overdueCount,
    },
    oldestOpenTickets: oldestOpen.map((row) => ({
      id: row.id,
      ticketNumber: row.ticketNumber,
      subject: row.subject,
      status: row.status,
      priority: row.priority,
      assignedToId: row.assignedToId,
      createdAt: row.createdAt.toISOString(),
    })),
    overdueDeliveryItems: overdueRows.map((row) => ({
      packageId: row.id,
      trackingId: row.trackingId,
      deliveryStatus: row.deliveryStatus,
      operationalStatus: row.operationalStatus,
      expectedDeliveryAt: row.shipment.expectedDeliveryAt!.toISOString(),
    })),
    recentTickets: recentTicketRows.map((row) => ({
      id: row.id,
      ticketNumber: row.ticketNumber,
      subject: row.subject,
      status: row.status,
      updatedAt: row.updatedAt.toISOString(),
    })),
    recentIncidents: recentIncidentList.items.map((item) => ({
      id: item.id,
      incidentNumber: item.incidentNumber,
      category: item.category,
      severity: item.severity,
      status: item.status,
      updatedAt: item.updatedAt,
    })),
  };
}

// ---------------------------------------------------------------------------
// V3 Step 8 — Support console read model
// ---------------------------------------------------------------------------

/**
 * Support console (V3 Step 8) — the dashboard read model behind
 * SupportHomeView. A field-mapped composition over existing reads;
 * it modifies no existing service function.
 *
 * Gate: inherited from `getSupportHome`, which runs
 * `requirePermAudited(actor, "support.ticket.manage",
 * "SupportTicket")` before any figure is read — the same gate this
 * console is specified to use.
 *
 * Composition:
 * - `getSupportHome(actor)` supplies today, the attention counts,
 *   the queue breakdown, the open-incident count, the oldest open
 *   tickets, the overdue delivery items and the recent ticket /
 *   incident rows. Every field is carried through field-mapped —
 *   the home object is never spread into this model.
 * - The ticket queue table and the My tickets count come from
 *   `listTickets`: support actors hold support.ticket.manage, so
 *   its scope is the staff inbox — exactly the queues' own
 *   definition.
 * - `highPriorityOpen` is the ONE new read in this model:
 *   `listTickets` has no priority filter, so the HIGH + URGENT open
 *   count cannot be composed from it and is counted directly.
 * - My tasks come from `listTasks` queue "mine"; terminal tasks
 *   (TASK_TERMINAL_STATUSES) are filtered out in-model, and the
 *   due / overdue figures are real arithmetic on `dueAt` against
 *   now and the Kathmandu tomorrow boundary.
 *
 * MONEY BOUNDARY (hard): support is a case-management surface. This
 * model carries NO finance figure of any kind — no paisa, amount,
 * COD, invoice, payment or revenue field at any depth — and the
 * view renders none.
 *
 * NO invented SLA: the home's 48h figure is an attention threshold
 * (see SUPPORT_TICKET_ATTENTION_HOURS), never an SLA promise, and
 * the view labels it exactly that way.
 */
export interface SupportConsoleData {
  today: string;
  attention: {
    unassignedTickets: number;
    /** Open tickets older than SUPPORT_TICKET_ATTENTION_HOURS. */
    breachingTickets: number;
    unresolvedHighSeverityIncidents: number;
    overdueDeliveries: number;
  };
  queues: {
    open: number;
    inProgress: number;
    awaitingCustomer: number;
    escalated: number;
    resolvedToday: number;
    totalOpen: number;
  };
  openIncidents: number;
  /** Open tickets at HIGH or URGENT priority (the one new read). */
  highPriorityOpen: number;
  /** Open tickets assigned to the actor (listTickets meta.total). */
  myTicketsOpen: number;
  oldestOpenTickets: {
    id: string;
    ticketNumber: string;
    subject: string;
    status: string;
    priority: string;
    assignedToId: string | null;
    createdAt: string;
  }[];
  overdueDeliveryItems: {
    packageId: string;
    trackingId: string;
    deliveryStatus: string;
    operationalStatus: string;
    expectedDeliveryAt: string;
  }[];
  /** The queue table rows: newest open tickets, staff-inbox scope. */
  queueTickets: {
    id: string;
    ticketNumber: string;
    subject: string;
    raiserName: string | null;
    priority: string;
    status: string;
    assignedToId: string | null;
    assigneeName: string | null;
    createdAt: string;
  }[];
  recentTickets: {
    id: string;
    ticketNumber: string;
    subject: string;
    status: string;
    updatedAt: string;
  }[];
  recentIncidents: {
    id: string;
    incidentNumber: string;
    category: string;
    severity: string;
    status: string;
    updatedAt: string;
  }[];
  /** The actor's open tasks, due soonest first (no due date last). */
  myTasks: {
    id: string;
    title: string;
    status: string;
    priority: string;
    dueAt: string | null;
    warehouseId: string | null;
    overdue: boolean;
  }[];
  /** Open tasks due before Kathmandu tomorrow starts (incl. overdue). */
  tasksDue: number;
  /** Open tasks whose dueAt is already past. */
  tasksOverdue: number;
  can: {
    viewTickets: boolean;
    incidents: boolean;
    tasks: boolean;
  };
}

export async function getSupportConsole(
  actor: ActorContext,
): Promise<SupportConsoleData> {
  // The gate lives in getSupportHome (support.ticket.manage).
  const home = await getSupportHome(actor);

  const now = new Date();
  const tomorrowStart = kathmanduDayStartUtc(addDays(home.today, 1));
  const canWorkTasks = hasPermission(actor, "task.update_own");

  const [highPriorityOpen, queueList, mineList, myTaskList] = await Promise.all([
    // The one new read: listTickets has no priority filter.
    prisma.supportTicket.count({
      where: {
        priority: { in: ["HIGH", "URGENT"] },
        status: { in: [...TICKET_OPEN_STATUSES] },
      },
    }),
    listTickets(actor, { openOnly: true, pageSize: 10 }),
    listTickets(actor, { openOnly: true, assignedToMe: true, pageSize: 1 }),
    // listTasks itself requires task.update_own; an actor without
    // it simply has no task queue on this console.
    canWorkTasks
      ? listTasks(actor, { queue: "mine", pageSize: 100 })
      : Promise.resolve(null),
  ]);

  const openTasks = (myTaskList?.items ?? []).filter(
    (task) => !(TASK_TERMINAL_STATUSES as readonly string[]).includes(task.status),
  );
  const tasksDue = openTasks.filter(
    (task) => task.dueAt !== null && new Date(task.dueAt) < tomorrowStart,
  ).length;
  const tasksOverdue = openTasks.filter(
    (task) => task.dueAt !== null && new Date(task.dueAt) < now,
  ).length;
  const myTasks = [...openTasks]
    .sort((a, b) => {
      if (a.dueAt === null && b.dueAt === null) return 0;
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      return new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
    })
    .slice(0, 8)
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      priority: task.priority,
      dueAt: task.dueAt,
      warehouseId: task.warehouseId,
      overdue: task.overdue,
    }));

  return {
    today: home.today,
    attention: {
      unassignedTickets: home.attention.unassignedTickets,
      breachingTickets: home.attention.breachingTickets,
      unresolvedHighSeverityIncidents:
        home.attention.unresolvedHighSeverityIncidents,
      overdueDeliveries: home.attention.overdueDeliveries,
    },
    queues: {
      open: home.queues.open,
      inProgress: home.queues.inProgress,
      awaitingCustomer: home.queues.awaitingCustomer,
      escalated: home.queues.escalated,
      resolvedToday: home.queues.resolvedToday,
      totalOpen: home.queues.totalOpen,
    },
    openIncidents: home.metrics.openIncidents,
    highPriorityOpen,
    myTicketsOpen: mineList.meta.total,
    oldestOpenTickets: home.oldestOpenTickets.map((row) => ({
      id: row.id,
      ticketNumber: row.ticketNumber,
      subject: row.subject,
      status: row.status,
      priority: row.priority,
      assignedToId: row.assignedToId,
      createdAt: row.createdAt,
    })),
    overdueDeliveryItems: home.overdueDeliveryItems.map((row) => ({
      packageId: row.packageId,
      trackingId: row.trackingId,
      deliveryStatus: row.deliveryStatus,
      operationalStatus: row.operationalStatus,
      expectedDeliveryAt: row.expectedDeliveryAt,
    })),
    queueTickets: queueList.items.map((item) => ({
      id: item.id,
      ticketNumber: item.ticketNumber,
      subject: item.subject,
      raiserName: item.raiserName,
      priority: item.priority,
      status: item.status,
      assignedToId: item.assignedToId,
      assigneeName: item.assigneeName,
      createdAt: item.createdAt,
    })),
    recentTickets: home.recentTickets.map((row) => ({
      id: row.id,
      ticketNumber: row.ticketNumber,
      subject: row.subject,
      status: row.status,
      updatedAt: row.updatedAt,
    })),
    recentIncidents: home.recentIncidents.map((row) => ({
      id: row.id,
      incidentNumber: row.incidentNumber,
      category: row.category,
      severity: row.severity,
      status: row.status,
      updatedAt: row.updatedAt,
    })),
    myTasks,
    tasksDue,
    tasksOverdue,
    can: {
      viewTickets: hasPermission(actor, "support.ticket.manage"),
      incidents: hasPermission(actor, "incident.manage"),
      tasks: hasPermission(actor, "task.update_own"),
    },
  };
}
