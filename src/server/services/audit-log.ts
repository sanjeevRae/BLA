import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import type { ActorContext } from "@/lib/auth/actor";
import { pageArgs, pageMeta, requirePermAudited } from "@/server/services/scoping";

/**
 * Audit-log read surface (Phase 6, audit H-4). AuditLog rows are
 * append-only and trigger-protected; this service only reads them.
 * The before/after JSON is returned exactly as stored — writers
 * already redact secrets at write time, and this projection adds no
 * new fields.
 */

export interface AuditLogView {
  id: string;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  warehouseId: string | null;
  before: unknown;
  after: unknown;
  /** "denied" ⇔ action = access.denied; "recorded" otherwise. */
  outcome: "denied" | "recorded";
  createdAt: string;
}

export interface ListAuditLogsFilters {
  actorSearch?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  warehouseId?: string;
  outcome?: "denied" | "recorded";
  from?: Date;
  to?: Date;
  page?: number;
  pageSize?: number;
}

export interface ListAuditLogsResult {
  items: AuditLogView[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Roles whose audit view is company-wide. Everyone else holding
 *  audit.read (e.g. Warehouse Admin, Finance) is restricted to rows
 *  for their membership warehouses — defence in depth on top of the
 *  permission gate. */
function isGlobalAuditReader(actor: ActorContext): boolean {
  return actor.roles.includes("SUPER_ADMIN") || actor.roles.includes("ADMIN");
}

export async function listAuditLogs(
  actor: ActorContext,
  filters: ListAuditLogsFilters = {},
): Promise<ListAuditLogsResult> {
  await requirePermAudited(actor, "audit.read", "AuditLog");
  const { skip, take, page, pageSize } = pageArgs(filters.page ?? 1, filters.pageSize ?? 25);

  const where: Prisma.AuditLogWhereInput = {};
  if (!isGlobalAuditReader(actor)) {
    where.warehouseId = { in: actor.warehouseIds };
  }
  if (filters.warehouseId) {
    // A non-global actor asking for a warehouse outside their scope
    // simply intersects to nothing.
    where.warehouseId = isGlobalAuditReader(actor)
      ? filters.warehouseId
      : { in: actor.warehouseIds.filter((id) => id === filters.warehouseId) };
  }
  // Action and outcome both constrain the action column — compose
  // them with AND instead of letting one overwrite the other.
  const actionFilters: Prisma.AuditLogWhereInput[] = [];
  if (filters.action) actionFilters.push({ action: filters.action });
  if (filters.outcome === "denied") actionFilters.push({ action: "access.denied" });
  if (filters.outcome === "recorded") actionFilters.push({ action: { not: "access.denied" } });
  if (actionFilters.length === 1) Object.assign(where, actionFilters[0]);
  else if (actionFilters.length > 1) where.AND = actionFilters;
  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.entityId) where.entityId = filters.entityId;
  if (filters.from || filters.to) {
    where.createdAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }
  if (filters.actorSearch?.trim()) {
    const term = filters.actorSearch.trim();
    where.actor = {
      OR: [
        { fullName: { contains: term, mode: "insensitive" } },
        { email: { contains: term, mode: "insensitive" } },
      ],
    };
  }

  const [total, rows] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      include: { actor: { select: { fullName: true, email: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorName: row.actor?.fullName ?? null,
      actorEmail: row.actor?.email ?? null,
      actorRole: row.actorRole,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      warehouseId: row.warehouseId,
      before: row.before ?? null,
      after: row.after ?? null,
      outcome: row.action === "access.denied" ? ("denied" as const) : ("recorded" as const),
      createdAt: row.createdAt.toISOString(),
    })),
    ...pageMeta(total, page, pageSize),
  };
}
