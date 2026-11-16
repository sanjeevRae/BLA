import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { TICKET_OPEN_STATUSES } from "@/lib/operations/domain";
import {
  addDays,
  kathmanduDayStartUtc,
  kathmanduToday,
} from "@/lib/reports/domain";
import { requirePermAudited } from "@/server/services/scoping";
import { listIncidents } from "@/server/services/incidents";

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
