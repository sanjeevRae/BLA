import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  hasPermission,
  type ActorContext,
} from "@/lib/auth/actor";
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
} from "@/lib/errors";
import {
  auditAccessDenied,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import {
  assertWarehouseScope,
  auditOps,
  isUnscoped,
} from "@/server/services/warehouse-ops-shared";

/**
 * Custody chain + handovers (docs/inventory-and-custody.md §3–§4).
 *
 * The open PackageCustody row IS the accountability record: exactly
 * one per package, enforced by a partial unique index. Custody moves
 * only through a HandoverBatch: the giver initiates with an expected
 * package set, the receiver confirms package by package (each confirm
 * closes the old custody and opens the new one atomically), and the
 * batch completes only when confirmedCount == expectedCount. A short
 * count can never be silently closed — closing a short batch marks
 * the unconfirmed lines MISSING and the batch DISPUTED, with audit +
 * TrackingEvent records. The Incident record itself lands in Phase 8;
 * the dispute audit/event rows are its link point.
 *
 * Phase 4 handovers are warehouse-internal (warehouse ↔ its own
 * staff). Cross-warehouse custody moves ride Phase 5 transfers, and
 * rider handovers land in Phase 6.
 */

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface CustodyView {
  id: string;
  packageId: string;
  trackingId: string;
  packageStatus: string;
  custodianType: string;
  custodianUserId: string | null;
  custodianName: string | null;
  warehouseId: string | null;
  warehouseCode: string | null;
  storageLocationId: string | null;
  locationCode: string | null;
  startedAt: string;
}

export interface HandoverLineView {
  id: string;
  packageId: string;
  trackingId: string;
  status: string;
  confirmedAt: string | null;
}

export interface HandoverBatchView {
  id: string;
  warehouseId: string;
  warehouseCode: string;
  fromCustodianType: string;
  fromLabel: string;
  toCustodianType: string;
  toLabel: string;
  expectedCount: number;
  confirmedCount: number;
  status: string;
  initiatedByName: string;
  createdAt: string;
  confirmedAt: string | null;
  lines: HandoverLineView[];
}

const batchInclude = {
  warehouse: { select: { code: true } },
  fromUser: { select: { fullName: true } },
  toUser: { select: { fullName: true } },
  initiatedBy: { select: { fullName: true } },
  lines: {
    include: { package: { select: { trackingId: true } } },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.HandoverBatchInclude;

type BatchRow = Prisma.HandoverBatchGetPayload<{ include: typeof batchInclude }>;

function custodianLabel(
  type: string,
  userName: string | null,
  warehouseCode: string | null,
): string {
  if (type === "USER") return userName ?? "Staff member";
  if (type === "WAREHOUSE") return warehouseCode ? `Warehouse ${warehouseCode}` : "Warehouse";
  return type;
}

function toBatchView(row: BatchRow): HandoverBatchView {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    warehouseCode: row.warehouse.code,
    fromCustodianType: row.fromCustodianType,
    fromLabel: custodianLabel(row.fromCustodianType, row.fromUser?.fullName ?? null, row.warehouse.code),
    toCustodianType: row.toCustodianType,
    toLabel: custodianLabel(row.toCustodianType, row.toUser?.fullName ?? null, row.warehouse.code),
    expectedCount: row.expectedCount,
    confirmedCount: row.confirmedCount,
    status: row.status,
    initiatedByName: row.initiatedBy.fullName,
    createdAt: row.createdAt.toISOString(),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    lines: row.lines.map((line) => ({
      id: line.id,
      packageId: line.packageId,
      trackingId: line.package.trackingId,
      status: line.status,
      confirmedAt: line.confirmedAt?.toISOString() ?? null,
    })),
  };
}

async function loadBatch(batchId: string): Promise<BatchRow> {
  const batch = await prisma.handoverBatch.findUnique({
    where: { id: batchId },
    include: batchInclude,
  });
  if (!batch) throw new NotFoundError("Handover batch not found");
  return batch;
}

// ---------------------------------------------------------------------------
// Initiate
// ---------------------------------------------------------------------------

export const initiateHandoverSchema = z.object({
  packageIds: z.array(z.string().uuid()).min(1).max(100),
  toCustodianType: z.enum(["WAREHOUSE", "USER"]),
  toUserId: z.string().uuid().optional().nullable(),
  toWarehouseId: z.string().uuid().optional().nullable(),
});
export type InitiateHandoverInput = z.input<typeof initiateHandoverSchema>;

export async function initiateHandover(
  actor: ActorContext,
  input: InitiateHandoverInput,
): Promise<HandoverBatchView> {
  const data = parse(initiateHandoverSchema, input);
  await requirePermAudited(actor, "custody.handover", "CustodyHandover");
  const packageIds = [...new Set(data.packageIds)];

  const custodies = await prisma.packageCustody.findMany({
    where: { packageId: { in: packageIds }, endedAt: null },
    include: { package: { select: { trackingId: true } } },
  });
  if (custodies.length !== packageIds.length) {
    const held = new Set(custodies.map((c) => c.packageId));
    const missing = packageIds.filter((id) => !held.has(id));
    throw new DomainValidationError(
      `${missing.length} package(s) have no open custody and cannot be handed over`,
    );
  }

  // Resolve each package's operational warehouse: a WAREHOUSE custody
  // names it directly; a USER custody resolves through the package's
  // open inventory record. All packages must share ONE warehouse —
  // a batch is a single physical act in a single place.
  const records = await prisma.inventoryRecord.findMany({
    where: { packageId: { in: packageIds }, releasedAt: null },
    select: { packageId: true, warehouseId: true },
  });
  const recordWarehouse = new Map(records.map((r) => [r.packageId, r.warehouseId]));
  const contextWarehouses = new Set<string>();
  for (const custody of custodies) {
    if (custody.custodianType === "RECIPIENT" || custody.custodianType === "RETURN_TEAM") {
      throw new DomainValidationError(
        "Handovers from recipients or the return team are not part of warehouse operations",
      );
    }
    const warehouseId =
      custody.custodianType === "WAREHOUSE"
        ? custody.warehouseId
        : recordWarehouse.get(custody.packageId);
    if (!warehouseId) {
      throw new DomainValidationError(
        "Every package in a handover must be stocked at a warehouse",
      );
    }
    contextWarehouses.add(warehouseId);
  }
  if (contextWarehouses.size !== 1) {
    throw new DomainValidationError(
      "All packages in one handover batch must be in the same warehouse",
    );
  }
  const warehouseId = [...contextWarehouses][0];

  // P3-7b scope: the actor must belong to the context warehouse.
  await assertWarehouseScope(actor, warehouseId, "CustodyHandover");

  // One batch = one giver. Mixed current custodians are rejected so
  // accountability for the batch is unambiguous.
  const first = custodies[0];
  const sameGiver = custodies.every(
    (c) =>
      c.custodianType === first.custodianType &&
      c.custodianUserId === first.custodianUserId &&
      c.warehouseId === first.warehouseId,
  );
  if (!sameGiver) {
    throw new DomainValidationError(
      "All packages in one batch must currently be held by the same custodian",
    );
  }

  // Receiver validation.
  let toUserId: string | null = null;
  let toWarehouseId: string | null = null;
  if (data.toCustodianType === "USER") {
    if (!data.toUserId) {
      throw new DomainValidationError("Choose the staff member receiving the packages");
    }
    const user = await prisma.user.findUnique({ where: { id: data.toUserId } });
    if (!user || user.status !== "ACTIVE") {
      throw new DomainValidationError("The receiving user is not an active account");
    }
    const membership = await prisma.warehouseMembership.findFirst({
      where: { userId: data.toUserId, warehouseId, revokedAt: null },
    });
    if (!membership) {
      throw new DomainValidationError(
        "The receiving user is not a member of this warehouse",
      );
    }
    toUserId = data.toUserId;
  } else {
    if (!data.toWarehouseId) {
      throw new DomainValidationError("Choose the receiving warehouse");
    }
    if (data.toWarehouseId !== warehouseId) {
      throw new DomainValidationError(
        "Warehouse handovers in this phase stay inside one warehouse — cross-warehouse custody moves ride transfers",
      );
    }
    toWarehouseId = data.toWarehouseId;
  }
  if (
    first.custodianType === data.toCustodianType &&
    first.custodianUserId === toUserId &&
    first.warehouseId === toWarehouseId
  ) {
    throw new DomainValidationError("The packages are already held by that custodian");
  }

  const batch = await prisma.$transaction(async (tx) => {
    const created = await tx.handoverBatch.create({
      data: {
        warehouseId,
        fromCustodianType: first.custodianType,
        fromUserId: first.custodianUserId,
        fromWarehouseId: first.warehouseId,
        toCustodianType: data.toCustodianType,
        toUserId,
        toWarehouseId,
        expectedCount: packageIds.length,
        initiatedById: actor.userId,
      },
    });
    await tx.custodyHandover.createMany({
      data: custodies.map((c) => ({
        batchId: created.id,
        packageId: c.packageId,
        fromCustodyId: c.id,
      })),
    });
    return created;
  });

  await auditOps(actor, "custody.handover_initiated", "HandoverBatch", batch.id, {
    warehouseId,
    after: {
      expectedCount: packageIds.length,
      fromCustodianType: first.custodianType,
      toCustodianType: data.toCustodianType,
      toUserId,
    },
  });
  return toBatchView(await loadBatch(batch.id));
}

// ---------------------------------------------------------------------------
// Confirm (receiver side, per package)
// ---------------------------------------------------------------------------

export const confirmHandoverSchema = z.object({
  batchId: z.string().uuid(),
  packageId: z.string().uuid(),
  condition: z.enum(["GOOD", "DAMAGED"]).default("GOOD"),
});
export type ConfirmHandoverInput = z.input<typeof confirmHandoverSchema>;

export async function confirmHandoverPackage(
  actor: ActorContext,
  input: ConfirmHandoverInput,
): Promise<HandoverBatchView> {
  const data = parse(confirmHandoverSchema, input);
  await requirePermAudited(actor, "custody.handover", "CustodyHandover");
  const batch = await loadBatch(data.batchId);
  if (batch.status !== "PENDING" && batch.status !== "PARTIALLY_CONFIRMED") {
    throw new ConflictError(`Handover batch is already ${batch.status}`);
  }
  await assertWarehouseScope(actor, batch.warehouseId, "CustodyHandover", batch.id);

  // Only the receiving side confirms: the named user, or a member of
  // the receiving warehouse for warehouse-bound batches (unscoped
  // actors pass both checks).
  if (batch.toCustodianType === "USER" && !isUnscoped(actor) && actor.userId !== batch.toUserId) {
    await auditAccessDenied(actor, "CustodyHandover", {
      entityId: batch.id,
      warehouseId: batch.warehouseId,
      reason: "handover_confirm_not_receiver",
    });
    throw new AuthorizationError("Only the receiving staff member can confirm this handover");
  }

  const line = batch.lines.find((l) => l.packageId === data.packageId);
  if (!line) throw new NotFoundError("Package is not part of this handover batch");
  if (line.status !== "PENDING") {
    throw new ConflictError(`This package's handover line is already ${line.status}`);
  }

  await prisma.$transaction(async (tx) => {
    const now = new Date();
    const openCustody = await tx.packageCustody.findFirst({
      where: { packageId: data.packageId, endedAt: null },
    });
    if (!openCustody || openCustody.id !== line.fromCustodyId) {
      throw new ConflictError(
        "The package's custody changed since this handover was initiated — close the batch and re-initiate",
      );
    }
    const pkg = await tx.package.findUniqueOrThrow({
      where: { id: data.packageId },
      select: { shipmentId: true, orderId: true, operationalStatus: true },
    });
    await tx.packageCustody.update({
      where: { id: openCustody.id },
      data: { endedAt: now },
    });
    const event = await tx.trackingEvent.create({
      data: {
        packageId: data.packageId,
        shipmentId: pkg.shipmentId,
        orderId: pkg.orderId,
        subjectType: "PACKAGE",
        eventType: "CUSTODY_TRANSFERRED",
        previousStatus: pkg.operationalStatus,
        newStatus: pkg.operationalStatus,
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        warehouseId: batch.warehouseId,
        source: "WEB",
        notes: `Custody confirmed in handover batch ${batch.id} (${batch.fromCustodianType} → ${batch.toCustodianType}).`,
      },
    });
    const newCustody = await tx.packageCustody.create({
      data: {
        packageId: data.packageId,
        custodianType: batch.toCustodianType,
        custodianUserId: batch.toUserId ?? null,
        warehouseId: batch.toWarehouseId ?? null,
        storageLocationId:
          batch.toCustodianType === "WAREHOUSE" ? openCustody.storageLocationId : null,
        handoverId: line.id,
        trackingEventId: event.id,
      },
    });
    const damaged = data.condition === "DAMAGED";
    if (damaged) {
      await tx.package.update({
        where: { id: data.packageId },
        data: { condition: "DAMAGED", exceptionStatus: "DAMAGED" },
      });
    }
    await tx.custodyHandover.update({
      where: { id: line.id },
      data: {
        status: damaged ? "DAMAGED" : "CONFIRMED",
        toCustodyId: newCustody.id,
        confirmedAt: now,
      },
    });
    const confirmedCount = batch.confirmedCount + 1;
    const complete = confirmedCount === batch.expectedCount;
    await tx.handoverBatch.update({
      where: { id: batch.id },
      data: {
        confirmedCount,
        status: complete ? "CONFIRMED" : "PARTIALLY_CONFIRMED",
        ...(complete ? { confirmedAt: now, confirmedById: actor.userId } : {}),
      },
    });
  });

  await auditOps(actor, "custody.handover_confirmed", "HandoverBatch", batch.id, {
    warehouseId: batch.warehouseId,
    after: { packageId: data.packageId, condition: data.condition },
  });
  return toBatchView(await loadBatch(batch.id));
}

// ---------------------------------------------------------------------------
// Close a short batch → DISPUTED (never silently complete)
// ---------------------------------------------------------------------------

export async function closeHandoverBatch(
  actor: ActorContext,
  batchId: string,
): Promise<HandoverBatchView> {
  await requirePermAudited(actor, "custody.handover", "CustodyHandover");
  const batch = await loadBatch(batchId);
  if (batch.status !== "PENDING" && batch.status !== "PARTIALLY_CONFIRMED") {
    throw new ConflictError(`Handover batch is already ${batch.status}`);
  }
  await assertWarehouseScope(actor, batch.warehouseId, "CustodyHandover", batch.id);
  const isWarehouseAdminHere = actor.membershipRoles.some(
    (m) => m.warehouseId === batch.warehouseId && m.roleCode === "WAREHOUSE_ADMIN",
  );
  if (
    actor.userId !== batch.initiatedById &&
    !isUnscoped(actor) &&
    !isWarehouseAdminHere
  ) {
    await auditAccessDenied(actor, "CustodyHandover", {
      entityId: batch.id,
      warehouseId: batch.warehouseId,
      reason: "handover_close_not_initiator",
    });
    throw new AuthorizationError(
      "Only the staff member who initiated this handover (or a Warehouse Admin) can close it",
    );
  }

  const pendingLines = batch.lines.filter((l) => l.status === "PENDING");
  if (pendingLines.length === 0) {
    throw new ConflictError("Every package is confirmed — the batch completes itself");
  }

  await prisma.$transaction(async (tx) => {
    const now = new Date();
    for (const line of pendingLines) {
      await tx.custodyHandover.update({
        where: { id: line.id },
        data: { status: "MISSING" },
      });
      const pkg = await tx.package.findUniqueOrThrow({
        where: { id: line.packageId },
        select: { shipmentId: true, orderId: true, operationalStatus: true },
      });
      // The shortfall is permanently on the package's history. The
      // Incident record itself is raised in Phase 8 — this event and
      // the custody.handover_disputed audit row are its link point.
      // Custody of a missing package stays with the giver.
      await tx.trackingEvent.create({
        data: {
          packageId: line.packageId,
          shipmentId: pkg.shipmentId,
          orderId: pkg.orderId,
          subjectType: "PACKAGE",
          eventType: "EXCEPTION_RAISED",
          previousStatus: pkg.operationalStatus,
          newStatus: pkg.operationalStatus,
          actorId: actor.userId,
          actorRole: actor.primaryRole,
          warehouseId: batch.warehouseId,
          source: "WEB",
          notes: `Package was not accounted for when handover batch ${batch.id} was closed short (${batch.confirmedCount}/${batch.expectedCount} confirmed). Custody remains with the giver pending investigation.`,
        },
      });
    }
    await tx.handoverBatch.update({
      where: { id: batch.id },
      data: { status: "DISPUTED", updatedAt: now },
    });
  });

  await auditOps(actor, "custody.handover_disputed", "HandoverBatch", batch.id, {
    warehouseId: batch.warehouseId,
    after: {
      confirmedCount: batch.confirmedCount,
      expectedCount: batch.expectedCount,
      missingPackageIds: pendingLines.map((l) => l.packageId),
    },
  });
  return toBatchView(await loadBatch(batch.id));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListCustodyQuery {
  warehouseId: string;
  holderType?: "WAREHOUSE" | "USER";
  userId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listCustody(
  actor: ActorContext,
  query: ListCustodyQuery,
): Promise<{ items: CustodyView[]; total: number; page: number; pageSize: number; totalPages: number }> {
  if (!hasPermission(actor, "custody.read")) {
    await auditAccessDenied(actor, "PackageCustody", {
      warehouseId: query.warehouseId,
      reason: "missing_permission:custody.read",
    });
    throw new AuthorizationError("Missing required permission: custody.read");
  }
  await assertWarehouseScope(actor, query.warehouseId, "PackageCustody");

  // What the warehouse holds (WAREHOUSE custodies at the warehouse)
  // plus what its people hold (USER custodies of packages stocked
  // there). Scope and search compose with explicit AND (P3-1).
  const conditions: Prisma.PackageCustodyWhereInput[] = [
    { endedAt: null },
    {
      OR: [
        { custodianType: "WAREHOUSE", warehouseId: query.warehouseId },
        {
          custodianType: "USER",
          package: {
            inventoryRecords: {
              some: { warehouseId: query.warehouseId, releasedAt: null },
            },
          },
        },
      ],
    },
  ];
  if (query.holderType) conditions.push({ custodianType: query.holderType });
  if (query.userId) conditions.push({ custodianUserId: query.userId });
  const term = query.search?.trim();
  if (term) {
    conditions.push({
      package: { trackingId: { contains: term, mode: "insensitive" } },
    });
  }
  const where: Prisma.PackageCustodyWhereInput = { AND: conditions };

  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  const [total, rows] = await Promise.all([
    prisma.packageCustody.count({ where }),
    prisma.packageCustody.findMany({
      where,
      include: {
        package: { select: { trackingId: true, operationalStatus: true } },
        custodianUser: { select: { fullName: true } },
        warehouse: { select: { code: true } },
        storageLocation: { select: { fullCode: true } },
      },
      orderBy: { startedAt: "desc" },
      skip,
      take,
    }),
  ]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      packageId: row.packageId,
      trackingId: row.package.trackingId,
      packageStatus: row.package.operationalStatus,
      custodianType: row.custodianType,
      custodianUserId: row.custodianUserId,
      custodianName: row.custodianUser?.fullName ?? null,
      warehouseId: row.warehouseId,
      warehouseCode: row.warehouse?.code ?? null,
      storageLocationId: row.storageLocationId,
      locationCode: row.storageLocation?.fullCode ?? null,
      startedAt: row.startedAt.toISOString(),
    })),
    ...pageMeta(total, page, pageSize),
  };
}

export interface ListHandoversQuery {
  warehouseId: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export async function listHandovers(
  actor: ActorContext,
  query: ListHandoversQuery,
): Promise<{ items: HandoverBatchView[]; total: number; page: number; pageSize: number; totalPages: number }> {
  if (!hasPermission(actor, "custody.read")) {
    await auditAccessDenied(actor, "HandoverBatch", {
      warehouseId: query.warehouseId,
      reason: "missing_permission:custody.read",
    });
    throw new AuthorizationError("Missing required permission: custody.read");
  }
  await assertWarehouseScope(actor, query.warehouseId, "HandoverBatch");
  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  const where: Prisma.HandoverBatchWhereInput = {
    warehouseId: query.warehouseId,
    ...(query.status ? { status: query.status } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.handoverBatch.count({ where }),
    prisma.handoverBatch.findMany({
      where,
      include: batchInclude,
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
  ]);
  return { items: rows.map(toBatchView), ...pageMeta(total, page, pageSize) };
}

export async function getHandoverBatch(
  actor: ActorContext,
  batchId: string,
): Promise<HandoverBatchView> {
  if (!hasPermission(actor, "custody.read")) {
    await auditAccessDenied(actor, "HandoverBatch", {
      entityId: batchId,
      reason: "missing_permission:custody.read",
    });
    throw new AuthorizationError("Missing required permission: custody.read");
  }
  const batch = await loadBatch(batchId);
  await assertWarehouseScope(actor, batch.warehouseId, "HandoverBatch", batchId);
  return toBatchView(batch);
}
