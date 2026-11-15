import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  hasPermission,
  type ActorContext,
} from "@/lib/auth/actor";
import { NotFoundError } from "@/lib/errors";
import { auditAccessDenied } from "@/server/services/scoping";

/**
 * Shared plumbing for the Phase 4 warehouse-operations services
 * (inventory, custody, supplies), following the WarehouseService
 * patterns: permission checks first, scope applied inside queries,
 * every denial audit-logged as `access.denied` before throwing
 * (docs/security-architecture.md §3.4).
 *
 * Scope rule for operations (Phase 3 review P3-7b): the lifecycle
 * service checks only the transition edge + permission — it does NOT
 * scope the actor to the package. Every operation here therefore
 * asserts the actor's scope over the package's warehouse (its open
 * inventory record, or the operation's target warehouse) BEFORE any
 * lifecycle transition is attempted.
 */

/** True when the actor may operate in every warehouse (SA/AD). */
export function isUnscoped(actor: ActorContext): boolean {
  return hasPermission(actor, "warehouse.read_all");
}

/**
 * Assert the warehouse is inside the actor's scope. Unscoped actors
 * pass; scoped actors must hold an active membership there. Denials
 * are audited (`access.denied`) and thrown as 403.
 */
export async function assertWarehouseScope(
  actor: ActorContext,
  warehouseId: string,
  entityType: string,
  entityId?: string | null,
): Promise<void> {
  if (isUnscoped(actor)) return;
  if (actor.warehouseIds.includes(warehouseId)) return;
  await auditAccessDenied(actor, entityType, {
    entityId: entityId ?? null,
    warehouseId,
    reason: "warehouse_out_of_scope",
  });
  throw new AuthorizationError("Warehouse is outside your assigned scope");
}

/** Generic audit writer for warehouse-operations actions. */
export async function auditOps(
  actor: ActorContext,
  action: string,
  entityType: string,
  entityId: string | null,
  opts: {
    warehouseId?: string | null;
    before?: Prisma.InputJsonValue;
    after?: Prisma.InputJsonValue;
  } = {},
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action,
      entityType,
      entityId,
      warehouseId: opts.warehouseId ?? null,
      ...(opts.before !== undefined ? { before: opts.before } : {}),
      ...(opts.after !== undefined ? { after: opts.after } : {}),
    },
  });
}

export async function loadWarehouseOr404(warehouseId: string) {
  const warehouse = await prisma.warehouse.findUnique({
    where: { id: warehouseId },
  });
  if (!warehouse) throw new NotFoundError(`Warehouse not found: ${warehouseId}`);
  return warehouse;
}

/**
 * The first active storage location in the warehouse's first active
 * zone of the given kind (RECEIVING / INSPECTION / DAMAGED / DISPATCH),
 * or null when the warehouse has no such zone/location — operations
 * then record the zone-level position with a null location.
 */
export async function firstActiveLocationInZoneKind(
  tx: Prisma.TransactionClient,
  warehouseId: string,
  kind: string,
): Promise<string | null> {
  const zone = await tx.warehouseZone.findFirst({
    where: { warehouseId, kind, isActive: true },
    orderBy: { code: "asc" },
  });
  if (!zone) return null;
  const location = await tx.storageLocation.findFirst({
    where: { zoneId: zone.id, isActive: true },
    orderBy: { fullCode: "asc" },
  });
  return location?.id ?? null;
}
