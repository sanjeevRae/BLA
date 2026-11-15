import "server-only";

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  hasPermission,
  type ActorContext,
} from "@/lib/auth/actor";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import { STOCK_MOVEMENT_TYPES, STOCK_UNITS } from "@/lib/warehouse-ops/domain";
import {
  auditAccessDenied,
  isUniqueViolation,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import {
  assertWarehouseScope,
  auditOps,
  loadWarehouseOr404,
} from "@/server/services/warehouse-ops-shared";

/**
 * Supplies inventory (docs/database-schema.md §6) — company
 * consumables (boxes, tape, labels, fuel cards), kept STRICTLY
 * separate from parcel inventory: no tracking IDs, no custody, no
 * customer linkage.
 *
 * quantityOnHand is maintained transactionally from the append-only
 * StockMovement ledger: every movement row snapshots quantityBefore /
 * quantityAfter, the StockItem row is locked FOR UPDATE while a
 * movement applies, and the balance can never go negative (service
 * check + database CHECK).
 */

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface StockItemView {
  id: string;
  warehouseId: string;
  warehouseCode: string;
  sku: string;
  name: string;
  unit: string;
  quantityOnHand: number;
  reorderLevel: number;
  lowStock: boolean;
  isActive: boolean;
  updatedAt: string;
}

export interface StockMovementView {
  id: string;
  stockItemId: string;
  type: string;
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
  reason: string | null;
  reference: string | null;
  performedByName: string;
  createdAt: string;
}

function toItemView(row: {
  id: string;
  warehouseId: string;
  warehouse: { code: string };
  sku: string;
  name: string;
  unit: string;
  quantityOnHand: number;
  reorderLevel: number;
  isActive: boolean;
  updatedAt: Date;
}): StockItemView {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouse.code,
    sku: row.sku,
    name: row.name,
    unit: row.unit,
    quantityOnHand: row.quantityOnHand,
    reorderLevel: row.reorderLevel,
    lowStock: row.quantityOnHand <= row.reorderLevel,
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadStockItem(stockItemId: string) {
  const item = await prisma.stockItem.findUnique({
    where: { id: stockItemId },
    include: { warehouse: { select: { code: true, status: true } } },
  });
  if (!item) throw new NotFoundError("Stock item not found");
  return item;
}

// ---------------------------------------------------------------------------
// CRUD + movements
// ---------------------------------------------------------------------------

export const createStockItemSchema = z.object({
  warehouseId: z.string().uuid(),
  sku: z.string().min(1).max(60),
  name: z.string().min(1).max(160),
  unit: z.enum(STOCK_UNITS).default("PCS"),
  reorderLevel: z.number().int().min(0).max(1000000).default(0),
  initialQuantity: z.number().int().min(0).max(1000000).default(0),
});
export type CreateStockItemInput = z.input<typeof createStockItemSchema>;

export async function createStockItem(
  actor: ActorContext,
  input: CreateStockItemInput,
): Promise<StockItemView> {
  const data = parse(createStockItemSchema, input);
  await requirePermAudited(actor, "supplies.manage", "StockItem");
  const warehouse = await loadWarehouseOr404(data.warehouseId);
  if (warehouse.status !== "ACTIVE") {
    throw new DomainValidationError("Warehouse is not active — supplies are read-only");
  }
  await assertWarehouseScope(actor, data.warehouseId, "StockItem");

  const sku = data.sku.trim().toUpperCase();
  try {
    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.stockItem.create({
        data: {
          warehouseId: data.warehouseId,
          sku,
          name: data.name.trim(),
          unit: data.unit,
          reorderLevel: data.reorderLevel,
          quantityOnHand: 0,
        },
        include: { warehouse: { select: { code: true } } },
      });
      if (data.initialQuantity > 0) {
        await tx.stockMovement.create({
          data: {
            stockItemId: created.id,
            warehouseId: data.warehouseId,
            type: "PURCHASE",
            quantityDelta: data.initialQuantity,
            quantityBefore: 0,
            quantityAfter: data.initialQuantity,
            reason: "Opening stock",
            performedById: actor.userId,
          },
        });
        await tx.stockItem.update({
          where: { id: created.id },
          data: { quantityOnHand: data.initialQuantity },
        });
        created.quantityOnHand = data.initialQuantity;
      }
      return created;
    });
    await auditOps(actor, "supplies.stock_create", "StockItem", item.id, {
      warehouseId: data.warehouseId,
      after: { sku, initialQuantity: data.initialQuantity },
    });
    return toItemView(item);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(`SKU ${sku} already exists in this warehouse`);
    }
    throw error;
  }
}

export const updateStockItemSchema = z.object({
  stockItemId: z.string().uuid(),
  name: z.string().min(1).max(160).optional(),
  unit: z.enum(STOCK_UNITS).optional(),
  reorderLevel: z.number().int().min(0).max(1000000).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateStockItemInput = z.input<typeof updateStockItemSchema>;

export async function updateStockItem(
  actor: ActorContext,
  input: UpdateStockItemInput,
): Promise<StockItemView> {
  const data = parse(updateStockItemSchema, input);
  await requirePermAudited(actor, "supplies.manage", "StockItem");
  const item = await loadStockItem(data.stockItemId);
  await assertWarehouseScope(actor, item.warehouseId, "StockItem", item.id);
  const updated = await prisma.stockItem.update({
    where: { id: item.id },
    data: {
      ...(data.name !== undefined ? { name: data.name.trim() } : {}),
      ...(data.unit !== undefined ? { unit: data.unit } : {}),
      ...(data.reorderLevel !== undefined ? { reorderLevel: data.reorderLevel } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
    include: { warehouse: { select: { code: true } } },
  });
  await auditOps(actor, "supplies.stock_update", "StockItem", item.id, {
    warehouseId: item.warehouseId,
    after: { name: updated.name, reorderLevel: updated.reorderLevel, isActive: updated.isActive },
  });
  return toItemView(updated);
}

export const recordStockMovementSchema = z.object({
  stockItemId: z.string().uuid(),
  type: z.enum(STOCK_MOVEMENT_TYPES),
  /** Positive magnitude for PURCHASE/ISSUE/RETURN/DAMAGE_WRITE_OFF;
   *  a signed non-zero delta for ADJUSTMENT. */
  quantity: z.number().int(),
  reason: z.string().max(500).optional().nullable(),
  reference: z.string().max(120).optional().nullable(),
});
export type RecordStockMovementInput = z.input<typeof recordStockMovementSchema>;

export async function recordStockMovement(
  actor: ActorContext,
  input: RecordStockMovementInput,
): Promise<{ item: StockItemView; movement: StockMovementView }> {
  const data = parse(recordStockMovementSchema, input);
  await requirePermAudited(actor, "supplies.manage", "StockItem");
  const item = await loadStockItem(data.stockItemId);
  if (item.warehouse.status !== "ACTIVE") {
    throw new DomainValidationError("Warehouse is not active — supplies are read-only");
  }
  await assertWarehouseScope(actor, item.warehouseId, "StockItem", item.id);
  if (!item.isActive) {
    throw new DomainValidationError("Stock item is inactive");
  }

  let delta: number;
  if (data.type === "ADJUSTMENT") {
    if (data.quantity === 0) {
      throw new DomainValidationError("An adjustment must change the quantity");
    }
    delta = data.quantity;
  } else {
    if (data.quantity <= 0) {
      throw new DomainValidationError("Quantity must be a positive number");
    }
    delta =
      data.type === "ISSUE" || data.type === "DAMAGE_WRITE_OFF"
        ? -data.quantity
        : data.quantity;
  }

  const result = await prisma.$transaction(async (tx) => {
    // Lock the row so two concurrent issues cannot both pass the
    // balance check (the ledger's before/after chain stays exact).
    const locked = await tx.$queryRaw<{ quantityOnHand: number }[]>`
      SELECT "quantityOnHand" FROM "app"."StockItem" WHERE "id" = ${item.id} FOR UPDATE
    `;
    const before = locked[0]?.quantityOnHand;
    if (before === undefined) throw new NotFoundError("Stock item not found");
    const after = before + delta;
    if (after < 0) {
      throw new DomainValidationError(
        `Insufficient stock: ${before} on hand, cannot apply a change of ${delta}`,
      );
    }
    const movement = await tx.stockMovement.create({
      data: {
        stockItemId: item.id,
        warehouseId: item.warehouseId,
        type: data.type,
        quantityDelta: delta,
        quantityBefore: before,
        quantityAfter: after,
        reason: data.reason ?? null,
        reference: data.reference ?? null,
        performedById: actor.userId,
      },
      include: { performedBy: { select: { fullName: true } } },
    });
    const updated = await tx.stockItem.update({
      where: { id: item.id },
      data: { quantityOnHand: after },
      include: { warehouse: { select: { code: true } } },
    });
    return { item: updated, movement };
  });

  await auditOps(actor, "supplies.stock_movement", "StockItem", item.id, {
    warehouseId: item.warehouseId,
    after: {
      type: data.type,
      quantityDelta: result.movement.quantityDelta,
      quantityAfter: result.movement.quantityAfter,
    },
  });
  return {
    item: toItemView(result.item),
    movement: {
      id: result.movement.id,
      stockItemId: result.movement.stockItemId,
      type: result.movement.type,
      quantityDelta: result.movement.quantityDelta,
      quantityBefore: result.movement.quantityBefore,
      quantityAfter: result.movement.quantityAfter,
      reason: result.movement.reason,
      reference: result.movement.reference,
      performedByName: result.movement.performedBy.fullName,
      createdAt: result.movement.createdAt.toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

async function assertSuppliesRead(
  actor: ActorContext,
  warehouseId: string,
): Promise<void> {
  const canRead =
    hasPermission(actor, "supplies.manage") ||
    hasPermission(actor, "inventory.read_all") ||
    hasPermission(actor, "inventory.read_warehouse");
  if (!canRead) {
    await auditAccessDenied(actor, "StockItem", {
      warehouseId,
      reason: "missing_permission:supplies.read",
    });
    throw new AuthorizationError("Missing required permission to read supplies");
  }
  await assertWarehouseScope(actor, warehouseId, "StockItem");
}

export interface ListStockItemsQuery {
  warehouseId: string;
  search?: string;
  lowStockOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listStockItems(
  actor: ActorContext,
  query: ListStockItemsQuery,
): Promise<{ items: StockItemView[]; total: number; page: number; pageSize: number; totalPages: number }> {
  await assertSuppliesRead(actor, query.warehouseId);
  // Scope and search compose with explicit AND (P3-1).
  const conditions: Prisma.StockItemWhereInput[] = [
    { warehouseId: query.warehouseId },
  ];
  const term = query.search?.trim();
  if (term) {
    conditions.push({
      OR: [
        { sku: { contains: term, mode: "insensitive" } },
        { name: { contains: term, mode: "insensitive" } },
      ],
    });
  }
  const rows = await prisma.stockItem.findMany({
    where: { AND: conditions },
    include: { warehouse: { select: { code: true } } },
    orderBy: { sku: "asc" },
  });
  let views = rows.map(toItemView);
  if (query.lowStockOnly) views = views.filter((v) => v.lowStock);
  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  return {
    items: views.slice(skip, skip + take),
    ...pageMeta(views.length, page, pageSize),
  };
}

export async function listStockMovements(
  actor: ActorContext,
  stockItemId: string,
  query: { page?: number; pageSize?: number } = {},
): Promise<{ items: StockMovementView[]; total: number; page: number; pageSize: number; totalPages: number }> {
  const item = await loadStockItem(stockItemId);
  await assertSuppliesRead(actor, item.warehouseId);
  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  const [total, rows] = await Promise.all([
    prisma.stockMovement.count({ where: { stockItemId } }),
    prisma.stockMovement.findMany({
      where: { stockItemId },
      include: { performedBy: { select: { fullName: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      stockItemId: row.stockItemId,
      type: row.type,
      quantityDelta: row.quantityDelta,
      quantityBefore: row.quantityBefore,
      quantityAfter: row.quantityAfter,
      reason: row.reason,
      reference: row.reference,
      performedByName: row.performedBy.fullName,
      createdAt: row.createdAt.toISOString(),
    })),
    ...pageMeta(total, page, pageSize),
  };
}
