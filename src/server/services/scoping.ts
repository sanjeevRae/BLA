import "server-only";

import { Prisma } from "@prisma/client";
import type { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  requirePermission,
  type ActorContext,
} from "@/lib/auth/actor";
import { DomainValidationError } from "@/lib/errors";

/**
 * Shared service-layer plumbing for the Phase 3 modules, following the
 * WarehouseService patterns (docs/security-architecture.md §3.4):
 * permission checks run before any query, denials are audit-logged as
 * `access.denied`, and Zod validation failures surface as
 * DomainValidationError (400).
 */

export async function auditAccessDenied(
  actor: ActorContext,
  entityType: string,
  attempted: {
    entityId?: string | null;
    warehouseId?: string | null;
    reason: string;
  },
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "access.denied",
      entityType,
      entityId: attempted.entityId ?? null,
      warehouseId: attempted.warehouseId ?? null,
      after: { reason: attempted.reason },
    },
  });
}

/** requirePermission + an access.denied audit row when it is missing. */
export async function requirePermAudited(
  actor: ActorContext,
  permission: string,
  entityType: string,
): Promise<void> {
  try {
    requirePermission(actor, permission);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      await auditAccessDenied(actor, entityType, {
        reason: `missing_permission:${permission}`,
      });
    }
    throw error;
  }
}

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DomainValidationError(
      result.error.issues[0]?.message ?? "Invalid input",
    );
  }
  return result.data;
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

/** True when the unique violation hit the named constraint/index. */
export function isUniqueViolationOn(error: unknown, target: string): boolean {
  if (!isUniqueViolation(error)) return false;
  const meta = (error as Prisma.PrismaClientKnownRequestError).meta as
    | { target?: string[] | string }
    | undefined;
  const targets = Array.isArray(meta?.target)
    ? meta.target
    : meta?.target
      ? [meta.target]
      : [];
  return targets.some((t) => t.includes(target));
}

export const paginationSchema = {
  page: 1,
  pageSize: 25,
};

export function pageArgs(page: number, pageSize: number) {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeSize = Math.min(100, Math.max(1, Math.floor(pageSize) || 25));
  return { skip: (safePage - 1) * safeSize, take: safeSize, page: safePage, pageSize: safeSize };
}

export function pageMeta(total: number, page: number, pageSize: number) {
  return { total, page, pageSize, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
