import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  type ActorContext,
} from "@/lib/auth/actor";
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
} from "@/lib/errors";
import { PACKAGE_CONDITIONS } from "@/lib/bookings/domain";
import {
  OPEN_RETURN_STATUSES,
  RETURN_CHARGE_BEARERS,
  RETURN_REASONS,
  RETURN_STATUSES,
} from "@/lib/deliveries/domain";
import {
  rollupShipmentStatus,
  transitionPackageInTx,
} from "@/server/services/package-lifecycle";
import { raiseIncidentInTx } from "@/server/services/incidents";
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
import {
  notifyUsersInTx,
  vendorUserIds,
} from "@/server/services/notifications";

/**
 * Returns and reverse logistics (docs/return-workflow.md). A return
 * is a first-class record linked to the original package/shipment/
 * order — the original delivery history is never edited; the return
 * appends its own chain of TrackingEvents.
 *
 * Phase 6 scope: the last-mile return — requested (manually by
 * WA/AD/vendor, or automatically when a delivery attempt refuses /
 * hits the attempt limit / is marked RETURN_TO_SENDER), authorised
 * by a Warehouse Admin of the return warehouse, received back into
 * the Returns zone by the warehouse scan (deliveries.scanBackPackage
 * advances the record to RECEIVED), inspected, and completed by
 * handover to the vendor. The COLLECTION_ASSIGNED / COLLECTED
 * states exist in the vocabulary for collection legs the
 * same-warehouse flow does not use.
 *
 * Phase 7 scope (cross-warehouse returns, return-workflow §3
 * steps 4–6): when the warehouse that first receives the return
 * (`warehouseId`) is not the RETURN warehouse
 * (`destinationWarehouseId` — the origin warehouse of the
 * package's shipment, where inspection and vendor handover
 * happen), the received return travels on a NORMAL transfer: it is
 * manifested toward its destination only (see the transfer hook
 * helpers below), the return moves RECEIVED → IN_TRANSIT at
 * dispatch and back to RECEIVED when transfer receiving completes
 * at the destination, and inspection/completion then run at the
 * destination warehouse. Custody stays continuous through the
 * transfer's own chain.
 *
 * Invariants (return-workflow §7): one open return per package
 * (checked under the Package row lock — READ COMMITTED does not
 * serialise an EXISTS check on its own, Phase 5 review P5-1/P5-2 —
 * with the partial unique index as backstop); a package under an
 * open return cannot be assigned for delivery (enforced in the
 * delivery service); custody stays continuous through the return.
 */

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface ReturnRequestView {
  id: string;
  returnNumber: string;
  packageId: string;
  trackingId: string;
  shipmentId: string;
  orderId: string;
  orderNumber: string;
  warehouseId: string;
  warehouseCode: string;
  destinationWarehouseId: string | null;
  destinationWarehouseCode: string | null;
  transferId: string | null;
  transferNumber: string | null;
  reason: string;
  status: string;
  requestedById: string;
  requestedByName: string;
  authorisedById: string | null;
  authorisedAt: string | null;
  rejectionReason: string | null;
  chargeBearer: string | null;
  chargeAmountPaisa: string;
  conditionAtInitiation: string;
  conditionAtInspection: string | null;
  receivedById: string | null;
  receivedAt: string | null;
  inspectedById: string | null;
  inspectedAt: string | null;
  completedById: string | null;
  completedAt: string | null;
  handedToUserId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

type ReturnRow = Prisma.ReturnRequestGetPayload<{
  include: {
    package: { select: { trackingId: true } };
    order: { select: { orderNumber: true } };
    warehouse: { select: { code: true } };
    destinationWarehouse: { select: { code: true } };
    transfer: { select: { transferNumber: true } };
    requestedBy: { select: { fullName: true } };
  };
}>;

const returnInclude = {
  package: { select: { trackingId: true } },
  order: { select: { orderNumber: true } },
  warehouse: { select: { code: true } },
  destinationWarehouse: { select: { code: true } },
  transfer: { select: { transferNumber: true } },
  requestedBy: { select: { fullName: true } },
} satisfies Prisma.ReturnRequestInclude;

/** The warehouse where inspection + vendor handover happen for
 *  this return: the destination (return) warehouse once travel is
 *  involved, falling back to the first-receiving warehouse for
 *  same-warehouse returns and pre-Phase-7 rows. */
export function effectiveReturnWarehouseId(row: {
  warehouseId: string;
  destinationWarehouseId: string | null;
}): string {
  return row.destinationWarehouseId ?? row.warehouseId;
}

/**
 * The warehouse an inspection / completion act is authorised
 * against: the warehouse the package is PHYSICALLY at for the
 * return. Before travel that is the first-receiving warehouse
 * (`warehouseId` — the Phase 6 flow inspects and completes there);
 * after the cross-warehouse transfer it is the destination
 * (return) warehouse, because transfer receiving moves the
 * package's current warehouse. Keying off the package's actual
 * position keeps both flows correct with one rule: you work a
 * return where the parcel sits.
 */
export function returnWorkingWarehouseId(
  row: { warehouseId: string; destinationWarehouseId: string | null },
  packageCurrentWarehouseId: string | null,
): string {
  return packageCurrentWarehouseId ?? effectiveReturnWarehouseId(row);
}

function toReturnView(r: ReturnRow): ReturnRequestView {
  return {
    id: r.id,
    returnNumber: r.returnNumber,
    packageId: r.packageId,
    trackingId: r.package.trackingId,
    shipmentId: r.shipmentId,
    orderId: r.orderId,
    orderNumber: r.order.orderNumber,
    warehouseId: r.warehouseId,
    warehouseCode: r.warehouse.code,
    destinationWarehouseId: r.destinationWarehouseId,
    destinationWarehouseCode: r.destinationWarehouse?.code ?? null,
    transferId: r.transferId,
    transferNumber: r.transfer?.transferNumber ?? null,
    reason: r.reason,
    status: r.status,
    requestedById: r.requestedById,
    requestedByName: r.requestedBy.fullName,
    authorisedById: r.authorisedById,
    authorisedAt: r.authorisedAt?.toISOString() ?? null,
    rejectionReason: r.rejectionReason,
    chargeBearer: r.chargeBearer,
    chargeAmountPaisa: r.chargeAmountPaisa.toString(),
    conditionAtInitiation: r.conditionAtInitiation,
    conditionAtInspection: r.conditionAtInspection,
    receivedById: r.receivedById,
    receivedAt: r.receivedAt?.toISOString() ?? null,
    inspectedById: r.inspectedById,
    inspectedAt: r.inspectedAt?.toISOString() ?? null,
    completedById: r.completedById,
    completedAt: r.completedAt?.toISOString() ?? null,
    handedToUserId: r.handedToUserId,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function loadReturnOr404(returnId: string): Promise<ReturnRow> {
  const row = await prisma.returnRequest.findUnique({
    where: { id: returnId },
    include: returnInclude,
  });
  if (!row) throw new NotFoundError("Return request not found");
  return row;
}

/** Lock the Package row inside the caller's transaction (Phase 5
 *  review P5-1/P5-2: check-then-insert under READ COMMITTED does not
 *  serialise; the row lock does). */
export async function lockPackageRow(tx: Tx, packageId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "app"."Package" WHERE "id" = ${packageId} FOR UPDATE`,
  );
}

// ---------------------------------------------------------------------------
// Creation — shared by the manual initiation and the delivery-attempt
// auto-initiation (deliveries.recordDeliveryAttempt).
// ---------------------------------------------------------------------------

export interface CreateReturnInTxArgs {
  packageId: string;
  reason: string;
  notes?: string | null;
  chargeBearer?: string | null;
  chargeAmountPaisa?: bigint;
}

/**
 * Create the ReturnRequest inside the caller's transaction. The
 * caller MUST hold the Package row lock (see lockPackageRow) so the
 * one-open-return check serialises. Flags the package
 * (exceptionStatus RETURN_REQUESTED, deliveryStatus RETURN_INITIATED)
 * and appends the RETURN_REQUESTED tracking event; the original
 * delivery history is untouched.
 */
export async function createReturnRequestInTx(
  tx: Tx,
  actor: ActorContext,
  args: CreateReturnInTxArgs,
): Promise<{ id: string; returnNumber: string }> {
  const pkg = await tx.package.findUniqueOrThrow({
    where: { id: args.packageId },
    select: {
      id: true,
      shipmentId: true,
      orderId: true,
      currentWarehouseId: true,
      operationalStatus: true,
      condition: true,
      exceptionStatus: true,
      deliveryStatus: true,
    },
  });
  if (!pkg.currentWarehouseId) {
    throw new ConflictError("Package is not at a warehouse — a return cannot be opened");
  }
  const open = await tx.returnRequest.findFirst({
    where: { packageId: pkg.id, status: { in: [...OPEN_RETURN_STATUSES] } },
    select: { id: true, returnNumber: true },
  });
  if (open) {
    throw new ConflictError(
      `Package already has an open return (${open.returnNumber}) — a second return is refused (return-workflow rule 6)`,
    );
  }
  // The RETURN warehouse (destinationWarehouseId) is the origin
  // warehouse of the package's shipment — the warehouse the vendor
  // tendered the parcel at, and therefore where inspection and
  // vendor handover belong (return-workflow §3 step 5: "origin
  // warehouse by default"). When it cannot be determined, the
  // return stays a same-warehouse return at the receiving
  // warehouse.
  const shipment = await tx.shipment.findUnique({
    where: { id: pkg.shipmentId },
    select: { originWarehouseId: true },
  });
  const destinationWarehouseId = shipment?.originWarehouseId ?? pkg.currentWarehouseId;
  const seq = await tx.$queryRaw<{ n: bigint }[]>(
    Prisma.sql`SELECT nextval('"app"."return_number_seq"') AS n`,
  );
  const returnNumber = `RTN-${seq[0].n.toString()}`;
  const created = await tx.returnRequest.create({
    data: {
      returnNumber,
      packageId: pkg.id,
      shipmentId: pkg.shipmentId,
      orderId: pkg.orderId,
      warehouseId: pkg.currentWarehouseId,
      destinationWarehouseId,
      reason: args.reason,
      status: "REQUESTED",
      requestedById: actor.userId,
      chargeBearer: args.chargeBearer ?? null,
      chargeAmountPaisa: args.chargeAmountPaisa ?? BigInt(0),
      conditionAtInitiation: pkg.condition,
      notes: args.notes ?? null,
    },
  });
  await tx.package.update({
    where: { id: pkg.id },
    data: {
      exceptionStatus:
        pkg.exceptionStatus === "RETURN_APPROVED"
          ? pkg.exceptionStatus
          : "RETURN_REQUESTED",
      deliveryStatus:
        pkg.deliveryStatus === "RETURNED_TO_WAREHOUSE" ||
        pkg.deliveryStatus === "RETURNED_TO_SENDER"
          ? pkg.deliveryStatus
          : "RETURN_INITIATED",
    },
  });
  await tx.trackingEvent.create({
    data: {
      packageId: pkg.id,
      shipmentId: pkg.shipmentId,
      orderId: pkg.orderId,
      subjectType: "PACKAGE",
      eventType: "RETURN_REQUESTED",
      previousStatus: pkg.operationalStatus,
      newStatus: pkg.operationalStatus,
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      warehouseId: pkg.currentWarehouseId,
      notes: `Return ${returnNumber} requested: ${args.reason}`,
    },
  });
  return { id: created.id, returnNumber };
}

// ---------------------------------------------------------------------------
// Cross-warehouse travel — hooks called from the transfer service
// (transfers.ts) inside ITS transactions. A return that must travel
// joins a NORMAL transfer as a manifested package flagged as a
// return (return-workflow §3 steps 4–6); these helpers are the only
// return-side writes in that flow, and each is a no-op for packages
// that are not travelling returns.
// ---------------------------------------------------------------------------

export interface LinkReturnToTransferArgs {
  packageId: string;
  transferId: string;
  transferNumber: string;
  originWarehouseId: string;
  destinationWarehouseId: string;
}

/**
 * MANIFEST (item-add) validation hook: if the package has an OPEN
 * return, it may be manifested ONLY as a travelling return —
 * status RECEIVED, cross-warehouse (destination ≠ first-receiving
 * warehouse), on a transfer departing the warehouse that physically
 * holds the package and heading exactly to the return's
 * destination warehouse. Every other open return refuses the
 * manifest with a ConflictError: the package is in the return
 * flow, not ready to travel (REQUESTED / APPROVED / COLLECTED /
 * …), already home (INSPECTED at destination), or a
 * same-warehouse return that never travels. This runs BEFORE the
 * transfer service's stock/status gates so a return-flow refusal
 * is never masked by a forward-flow rejection reason, and it
 * writes nothing — the link itself is written by
 * linkReturnToTransferInTx only once the item row exists, so a
 * later forward-flow rejection cannot leave a stale link behind.
 * Returns null when the package has no open return (normal cargo).
 */
export async function checkReturnTravelForManifestInTx(
  tx: Tx,
  args: LinkReturnToTransferArgs,
): Promise<{ returnId: string; returnNumber: string; destinationWarehouseId: string } | null> {
  const open = await tx.returnRequest.findFirst({
    where: { packageId: args.packageId, status: { in: [...OPEN_RETURN_STATUSES] } },
    orderBy: { createdAt: "asc" },
  });
  if (!open) return null;
  if (open.status !== "RECEIVED") {
    throw new ConflictError(
      `Package is under return ${open.returnNumber} in status ${open.status} — only a RECEIVED return can be manifested for travel to its return warehouse`,
    );
  }
  const destinationWarehouseId = open.destinationWarehouseId ?? open.warehouseId;
  if (!open.destinationWarehouseId || destinationWarehouseId === open.warehouseId) {
    throw new ConflictError(
      `Return ${open.returnNumber} is a same-warehouse return — it is already at its return warehouse and never travels on a transfer`,
    );
  }
  const pkg = await tx.package.findUniqueOrThrow({
    where: { id: args.packageId },
    select: { currentWarehouseId: true },
  });
  if (args.originWarehouseId !== pkg.currentWarehouseId) {
    throw new ConflictError(
      `Return ${open.returnNumber} can only travel on a transfer departing the warehouse that holds the package`,
    );
  }
  if (args.destinationWarehouseId !== destinationWarehouseId) {
    throw new ConflictError(
      `Return ${open.returnNumber} may only travel to its return warehouse — transfer ${args.transferNumber} is headed to a different warehouse`,
    );
  }
  return { returnId: open.id, returnNumber: open.returnNumber, destinationWarehouseId };
}

/**
 * MANIFEST (item-add) link hook: attach the validated travelling
 * return to the transfer once its item row exists. The return's
 * status stays RECEIVED until dispatch.
 */
export async function linkReturnToTransferInTx(
  tx: Tx,
  args: { returnId: string; transferId: string },
): Promise<void> {
  await tx.returnRequest.update({
    where: { id: args.returnId },
    data: { transferId: args.transferId },
  });
}

/**
 * MANIFEST (generate) hook: a travelling return's package sits in
 * READY_FOR_DELIVERY (the scan-back state) when it is selected, so
 * before the manifest's READY_FOR_DISPATCH gate runs, move it to
 * READY_FOR_DISPATCH through the lifecycle service — from there
 * the normal manifest transition to TRANSFER_ASSIGNED applies.
 * No-op for packages without a return linked to this transfer.
 */
export async function prepareReturnPackageForManifestInTx(
  tx: Tx,
  actor: ActorContext,
  packageId: string,
  transferId: string,
): Promise<boolean> {
  const linked = await tx.returnRequest.findFirst({
    where: { packageId, transferId, status: "RECEIVED" },
    select: { id: true, returnNumber: true },
  });
  if (!linked) return false;
  const pkg = await tx.package.findUniqueOrThrow({
    where: { id: packageId },
    select: { operationalStatus: true, currentWarehouseId: true },
  });
  if (pkg.operationalStatus === "READY_FOR_DELIVERY") {
    await transitionPackageInTx(tx, actor, packageId, "READY_FOR_DISPATCH", {
      warehouseId: pkg.currentWarehouseId,
      transferId,
      notes: `Return ${linked.returnNumber} readied for dispatch to its return warehouse`,
    });
  }
  return true;
}

/**
 * UNLINK hook (item removed / transfer cancelled BEFORE dispatch):
 * the return has not left yet, so the link is cleared and the
 * return simply stays RECEIVED at the receiving warehouse, ready
 * to be manifested onto another transfer. No-op for packages
 * without a return linked to this transfer, and never unlinks a
 * return that has already dispatched (items are locked by then).
 */
export async function unlinkReturnFromTransferInTx(
  tx: Tx,
  args: { packageId: string; transferId: string },
): Promise<boolean> {
  const res = await tx.returnRequest.updateMany({
    where: { packageId: args.packageId, transferId: args.transferId, status: "RECEIVED" },
    data: { transferId: null },
  });
  return res.count > 0;
}

/**
 * DISPATCH hook: the travelling return leaves with the transfer —
 * RECEIVED → IN_TRANSIT, with its own tracking event appended (the
 * package's transfer events already record the physical leg).
 */
export async function advanceReturnOnDispatchInTx(
  tx: Tx,
  actor: ActorContext,
  args: { packageId: string; transferId: string; originWarehouseId: string },
): Promise<boolean> {
  const linked = await tx.returnRequest.findFirst({
    where: { packageId: args.packageId, transferId: args.transferId, status: "RECEIVED" },
  });
  if (!linked) return false;
  await tx.returnRequest.update({
    where: { id: linked.id },
    data: { status: "IN_TRANSIT" },
  });
  const pkg = await tx.package.findUniqueOrThrow({
    where: { id: args.packageId },
    select: { operationalStatus: true, shipmentId: true, orderId: true },
  });
  await tx.trackingEvent.create({
    data: {
      packageId: args.packageId,
      shipmentId: pkg.shipmentId,
      orderId: pkg.orderId,
      subjectType: "PACKAGE",
      eventType: "RETURN_IN_TRANSIT",
      previousStatus: pkg.operationalStatus,
      newStatus: pkg.operationalStatus,
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      warehouseId: args.originWarehouseId,
      transferId: args.transferId,
      notes: `Return ${linked.returnNumber} in transit to its return warehouse`,
    },
  });
  return true;
}

/**
 * RECEIVE hook (per-package receiving completion at the transfer's
 * destination): the travelling return has arrived — IN_TRANSIT →
 * RECEIVED. `receivedById`/`receivedAt` are NOT touched: they
 * record the FIRST receipt (the scan-back at the receiving
 * warehouse); the arrival is recorded as a
 * RETURN_RECEIVED_AT_DESTINATION tracking event instead.
 */
export async function advanceReturnOnReceiveInTx(
  tx: Tx,
  actor: ActorContext,
  args: { packageId: string; transferId: string; destinationWarehouseId: string },
): Promise<boolean> {
  const linked = await tx.returnRequest.findFirst({
    where: { packageId: args.packageId, transferId: args.transferId, status: "IN_TRANSIT" },
  });
  if (!linked) return false;
  await tx.returnRequest.update({
    where: { id: linked.id },
    data: { status: "RECEIVED" },
  });
  const pkg = await tx.package.findUniqueOrThrow({
    where: { id: args.packageId },
    select: { operationalStatus: true, shipmentId: true, orderId: true },
  });
  await tx.trackingEvent.create({
    data: {
      packageId: args.packageId,
      shipmentId: pkg.shipmentId,
      orderId: pkg.orderId,
      subjectType: "PACKAGE",
      eventType: "RETURN_RECEIVED_AT_DESTINATION",
      previousStatus: pkg.operationalStatus,
      newStatus: pkg.operationalStatus,
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      warehouseId: args.destinationWarehouseId,
      transferId: args.transferId,
      notes: `Return ${linked.returnNumber} received at its return warehouse`,
    },
  });
  return true;
}

export const initiateReturnSchema = z.object({
  packageId: z.string().uuid().optional(),
  trackingId: z.string().min(1).max(40).optional(),
  reason: z.enum(RETURN_REASONS),
  notes: z.string().max(500).optional().nullable(),
  chargeBearer: z.enum(RETURN_CHARGE_BEARERS).optional().nullable(),
  chargeAmountPaisa: z
    .string()
    .regex(/^\d+$/, "chargeAmountPaisa must be a non-negative integer string")
    .optional()
    .nullable(),
});
export type InitiateReturnInput = z.input<typeof initiateReturnSchema>;

const RETURNABLE_STATUSES = [
  "READY_FOR_DELIVERY",
  "DELIVERY_ASSIGNED",
  "OUT_FOR_DELIVERY",
  "DELIVERY_ATTEMPTED",
] as const;

export async function initiateReturn(
  actor: ActorContext,
  input: InitiateReturnInput,
): Promise<ReturnRequestView> {
  const data = parse(initiateReturnSchema, input);
  await requirePermAudited(actor, "package.return_initiate", "ReturnRequest");
  if (!data.packageId && !data.trackingId) {
    throw new DomainValidationError("A packageId or trackingId is required");
  }
  const pkg = await prisma.package.findUnique({
    where: data.packageId ? { id: data.packageId } : { trackingId: data.trackingId!.trim() },
    include: { order: { select: { vendorId: true } } },
  });
  if (!pkg) throw new NotFoundError("Package not found");

  // Scoped initiation (return-workflow §6): a vendor only for their
  // own shipments; a rider only for a package on their own active
  // assignment; warehouse staff only inside their warehouse scope.
  if (actor.vendorId) {
    if (pkg.order.vendorId !== actor.vendorId) {
      await auditAccessDenied(actor, "ReturnRequest", {
        entityId: pkg.id,
        reason: "vendor_return_other_vendor_package",
      });
      throw new AuthorizationError("Vendors can only request returns for their own packages");
    }
  } else if (!isUnscoped(actor) && actor.warehouseIds.length > 0) {
    await assertWarehouseScope(actor, pkg.currentWarehouseId ?? "", "ReturnRequest", pkg.id);
  } else if (!isUnscoped(actor) && actor.driverId) {
    const mine = await prisma.deliveryAssignment.findFirst({
      where: {
        packageId: pkg.id,
        driverId: actor.driverId,
        status: { in: ["PENDING", "ACCEPTED", "IN_PROGRESS"] },
      },
      select: { id: true },
    });
    if (!mine) {
      await auditAccessDenied(actor, "ReturnRequest", {
        entityId: pkg.id,
        reason: "rider_return_not_own_assignment",
      });
      throw new AuthorizationError("Riders can only request returns for their own assigned packages");
    }
  } else if (!isUnscoped(actor)) {
    await auditAccessDenied(actor, "ReturnRequest", {
      entityId: pkg.id,
      reason: "return_initiate_no_scope",
    });
    throw new AuthorizationError("You have no scope to request a return for this package");
  }

  if (!RETURNABLE_STATUSES.includes(pkg.operationalStatus as (typeof RETURNABLE_STATUSES)[number])) {
    throw new ConflictError(
      `A package in status ${pkg.operationalStatus} cannot enter the return flow`,
    );
  }

  const created = await prisma.$transaction(async (tx) => {
    await lockPackageRow(tx, pkg.id);
    return createReturnRequestInTx(tx, actor, {
      packageId: pkg.id,
      reason: data.reason,
      notes: data.notes ?? null,
      chargeBearer: data.chargeBearer ?? null,
      chargeAmountPaisa: data.chargeAmountPaisa ? BigInt(data.chargeAmountPaisa) : BigInt(0),
    });
  });
  await auditOps(actor, "return.initiated", "ReturnRequest", created.id, {
    warehouseId: pkg.currentWarehouseId,
    after: { returnNumber: created.returnNumber, reason: data.reason },
  });
  return toReturnView(await loadReturnOr404(created.id));
}

// ---------------------------------------------------------------------------
// Authorisation (WA of the return warehouse, or unscoped AD/SA)
// ---------------------------------------------------------------------------

/** Approval is a Warehouse Admin act (return-workflow §6): holding
 *  the permission is not enough — the actor must be unscoped or hold
 *  the WAREHOUSE_ADMIN membership IN the return warehouse (P2-4). */
async function assertReturnApprover(
  actor: ActorContext,
  row: ReturnRow,
): Promise<void> {
  await requirePermAudited(actor, "package.return_initiate", "ReturnRequest");
  if (isUnscoped(actor)) return;
  const isWa = actor.membershipRoles.some(
    (m) => m.warehouseId === row.warehouseId && m.roleCode === "WAREHOUSE_ADMIN",
  );
  if (isWa) return;
  await auditAccessDenied(actor, "ReturnRequest", {
    entityId: row.id,
    warehouseId: row.warehouseId,
    reason: "return_approve_requires_warehouse_admin",
  });
  throw new AuthorizationError(
    "Only a Warehouse Admin of the return warehouse can authorise a return",
  );
}

export const approveReturnSchema = z.object({
  chargeBearer: z.enum(RETURN_CHARGE_BEARERS),
  chargeAmountPaisa: z
    .string()
    .regex(/^\d+$/, "chargeAmountPaisa must be a non-negative integer string")
    .optional()
    .nullable(),
  notes: z.string().max(500).optional().nullable(),
});
export type ApproveReturnInput = z.input<typeof approveReturnSchema>;

export async function approveReturn(
  actor: ActorContext,
  returnId: string,
  input: ApproveReturnInput,
): Promise<ReturnRequestView> {
  const data = parse(approveReturnSchema, input);
  const row = await loadReturnOr404(returnId);
  await assertReturnApprover(actor, row);
  if (row.status !== "REQUESTED") {
    throw new ConflictError(`Return ${row.returnNumber} is ${row.status} — only REQUESTED returns can be approved`);
  }
  await prisma.$transaction(async (tx) => {
    await lockPackageRow(tx, row.packageId);
    // Re-read the status inside the transaction (Phase 6 review
    // P6-R5): the pre-transaction REQUESTED check races a
    // concurrent reject/approve — both writers gated on the same
    // stale snapshot and both applied, the second silently
    // overwriting the first's authorisation outcome. Under the
    // package lock the loser now sees the moved status and
    // refuses, so exactly one outcome is ever recorded.
    const fresh = await tx.returnRequest.findUniqueOrThrow({
      where: { id: row.id },
      select: { status: true },
    });
    if (fresh.status !== "REQUESTED") {
      throw new ConflictError(
        `Return ${row.returnNumber} is ${fresh.status} — only REQUESTED returns can be approved`,
      );
    }
    await tx.returnRequest.update({
      where: { id: row.id },
      data: {
        status: "APPROVED",
        authorisedById: actor.userId,
        authorisedAt: new Date(),
        chargeBearer: data.chargeBearer,
        chargeAmountPaisa: data.chargeAmountPaisa ? BigInt(data.chargeAmountPaisa) : row.chargeAmountPaisa,
        notes: data.notes ?? row.notes,
      },
    });
    const pkg = await tx.package.findUniqueOrThrow({
      where: { id: row.packageId },
      select: { operationalStatus: true, shipmentId: true, orderId: true },
    });
    await tx.package.update({
      where: { id: row.packageId },
      data: { exceptionStatus: "RETURN_APPROVED" },
    });
    await tx.trackingEvent.create({
      data: {
        packageId: row.packageId,
        shipmentId: pkg.shipmentId,
        orderId: pkg.orderId,
        subjectType: "PACKAGE",
        eventType: "RETURN_APPROVED",
        previousStatus: pkg.operationalStatus,
        newStatus: pkg.operationalStatus,
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        warehouseId: row.warehouseId,
        notes: `Return ${row.returnNumber} approved; charges borne by ${data.chargeBearer}`,
      },
    });
    // Phase 8 trigger: return authorised — the requester and the
    // vendor's users are notified inside the approval transaction.
    const order = await tx.order.findUnique({
      where: { id: row.orderId },
      select: { vendorId: true },
    });
    const recipients = new Set<string>();
    if (row.requestedById !== actor.userId) recipients.add(row.requestedById);
    if (order?.vendorId) {
      for (const id of await vendorUserIds(tx, order.vendorId)) recipients.add(id);
    }
    recipients.delete(actor.userId);
    await notifyUsersInTx(tx, recipients, {
      category: "RETURN_AUTHORISED",
      title: `Return ${row.returnNumber} authorised`,
      body: `Return ${row.returnNumber} has been authorised; charges borne by ${data.chargeBearer}.`,
      entityType: "ReturnRequest",
      entityId: row.id,
      dedupeKey: `return-authorised:${row.id}`,
    });
  });
  await auditOps(actor, "return.approved", "ReturnRequest", row.id, {
    warehouseId: row.warehouseId,
    after: { chargeBearer: data.chargeBearer },
  });
  return toReturnView(await loadReturnOr404(returnId));
}

export const rejectReturnSchema = z.object({
  reason: z.string().min(3).max(500),
});
export type RejectReturnInput = z.input<typeof rejectReturnSchema>;

/** deliveryStatus to restore when a return request is rejected and
 *  the package returns to the normal flow (return-workflow §3.2). */
function deliveryStatusForOperational(status: string): string {
  switch (status) {
    case "DELIVERY_ASSIGNED":
      return "ASSIGNED";
    case "OUT_FOR_DELIVERY":
      return "OUT_FOR_DELIVERY";
    case "DELIVERY_ATTEMPTED":
      return "ATTEMPTED";
    default:
      return "NOT_STARTED";
  }
}

export async function rejectReturn(
  actor: ActorContext,
  returnId: string,
  input: RejectReturnInput,
): Promise<ReturnRequestView> {
  const data = parse(rejectReturnSchema, input);
  const row = await loadReturnOr404(returnId);
  await assertReturnApprover(actor, row);
  if (row.status !== "REQUESTED") {
    throw new ConflictError(`Return ${row.returnNumber} is ${row.status} — only REQUESTED returns can be rejected`);
  }
  await prisma.$transaction(async (tx) => {
    await lockPackageRow(tx, row.packageId);
    // In-transaction status re-check (Phase 6 review P6-R5) — see
    // approveReturn: a concurrent approve must not be overwritten
    // by this rejection, nor the reverse.
    const fresh = await tx.returnRequest.findUniqueOrThrow({
      where: { id: row.id },
      select: { status: true },
    });
    if (fresh.status !== "REQUESTED") {
      throw new ConflictError(
        `Return ${row.returnNumber} is ${fresh.status} — only REQUESTED returns can be rejected`,
      );
    }
    await tx.returnRequest.update({
      where: { id: row.id },
      data: {
        status: "REJECTED",
        authorisedById: actor.userId,
        authorisedAt: new Date(),
        rejectionReason: data.reason,
      },
    });
    const pkg = await tx.package.findUniqueOrThrow({
      where: { id: row.packageId },
      select: {
        operationalStatus: true,
        shipmentId: true,
        orderId: true,
        exceptionStatus: true,
        deliveryStatus: true,
      },
    });
    await tx.package.update({
      where: { id: row.packageId },
      data: {
        ...(pkg.exceptionStatus === "RETURN_REQUESTED"
          ? { exceptionStatus: "NONE" }
          : {}),
        ...(pkg.deliveryStatus === "RETURN_INITIATED"
          ? { deliveryStatus: deliveryStatusForOperational(pkg.operationalStatus) }
          : {}),
      },
    });
    await tx.trackingEvent.create({
      data: {
        packageId: row.packageId,
        shipmentId: pkg.shipmentId,
        orderId: pkg.orderId,
        subjectType: "PACKAGE",
        eventType: "RETURN_REJECTED",
        previousStatus: pkg.operationalStatus,
        newStatus: pkg.operationalStatus,
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        warehouseId: row.warehouseId,
        notes: `Return ${row.returnNumber} rejected: ${data.reason}`,
      },
    });
  });
  await auditOps(actor, "return.rejected", "ReturnRequest", row.id, {
    warehouseId: row.warehouseId,
    after: { reason: data.reason },
  });
  return toReturnView(await loadReturnOr404(returnId));
}

// ---------------------------------------------------------------------------
// Inspection at the return warehouse (return-workflow §3.7)
// ---------------------------------------------------------------------------

export const inspectReturnSchema = z.object({
  condition: z.enum(PACKAGE_CONDITIONS),
  notes: z.string().max(500).optional().nullable(),
});
export type InspectReturnInput = z.input<typeof inspectReturnSchema>;

/** Conservative deterioration ordering over PACKAGE_CONDITIONS
 *  (the full vocabulary — there are no DESTROYED/OPENED values):
 *  GOOD → anything else is worse; PACKAGING_COMPROMISED →
 *  SUSPECTED_DAMAGE / DAMAGED is worse; SUSPECTED_DAMAGE → DAMAGED
 *  is worse. Unknown values rank 0, so an unrecognised inspection
 *  condition never fabricates a deterioration on its own. */
const CONDITION_RANK: Readonly<Record<string, number>> = {
  GOOD: 0,
  PACKAGING_COMPROMISED: 1,
  SUSPECTED_DAMAGE: 2,
  DAMAGED: 3,
};

export async function inspectReturn(
  actor: ActorContext,
  returnId: string,
  input: InspectReturnInput,
): Promise<ReturnRequestView> {
  const data = parse(inspectReturnSchema, input);
  await requirePermAudited(actor, "package.inspect", "ReturnRequest");
  const row = await loadReturnOr404(returnId);
  // Inspection happens where the package sits for the return
  // (return-workflow §3.7): the first-receiving warehouse before
  // travel, the destination (return) warehouse after the
  // cross-warehouse transfer has brought it there.
  const pkgForScope = await prisma.package.findUnique({
    where: { id: row.packageId },
    select: { currentWarehouseId: true },
  });
  const inspectionWarehouseId = returnWorkingWarehouseId(
    row,
    pkgForScope?.currentWarehouseId ?? null,
  );
  await assertWarehouseScope(actor, inspectionWarehouseId, "ReturnRequest", row.id);
  if (row.status !== "RECEIVED") {
    throw new ConflictError(`Return ${row.returnNumber} is ${row.status} — only RECEIVED returns can be inspected`);
  }
  const deteriorated =
    (CONDITION_RANK[data.condition] ?? 0) > (CONDITION_RANK[row.conditionAtInitiation] ?? 0);
  await prisma.$transaction(async (tx) => {
    await lockPackageRow(tx, row.packageId);
    await tx.returnRequest.update({
      where: { id: row.id },
      data: {
        status: "INSPECTED",
        conditionAtInspection: data.condition,
        inspectedById: actor.userId,
        inspectedAt: new Date(),
        notes: data.notes ?? row.notes,
      },
    });
    const pkg = await tx.package.findUniqueOrThrow({
      where: { id: row.packageId },
      select: { operationalStatus: true, shipmentId: true, orderId: true },
    });
    await tx.trackingEvent.create({
      data: {
        packageId: row.packageId,
        shipmentId: pkg.shipmentId,
        orderId: pkg.orderId,
        subjectType: "PACKAGE",
        eventType: "RETURN_INSPECTED",
        previousStatus: pkg.operationalStatus,
        newStatus: pkg.operationalStatus,
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        warehouseId: inspectionWarehouseId,
        notes: `Return ${row.returnNumber} inspected: condition ${data.condition}${deteriorated ? " (deteriorated since initiation)" : ""}`,
      },
    });
    if (deteriorated) {
      // Condition worsened between initiation and inspection
      // (return-workflow rule 4): the package is flagged DAMAGED
      // and a DAMAGED_PACKAGE incident is raised automatically,
      // linked to the package and the inspection warehouse, with
      // the inspector as reporter. Idempotent per return via the
      // sourceKey — inspection runs once, and a retry can never
      // stack a second incident for the same deterioration.
      await tx.package.update({
        where: { id: row.packageId },
        data: { exceptionStatus: "DAMAGED", condition: data.condition },
      });
      await tx.trackingEvent.create({
        data: {
          packageId: row.packageId,
          shipmentId: pkg.shipmentId,
          orderId: pkg.orderId,
          subjectType: "PACKAGE",
          eventType: "EXCEPTION_RAISED",
          previousStatus: pkg.operationalStatus,
          newStatus: pkg.operationalStatus,
          actorId: actor.userId,
          actorRole: actor.primaryRole,
          warehouseId: inspectionWarehouseId,
          notes: `Return ${row.returnNumber}: condition deteriorated from ${row.conditionAtInitiation} to ${data.condition} during the return`,
        },
      });
      await raiseIncidentInTx(tx, {
        sourceKey: `return-deterioration:${row.id}`,
        category: "DAMAGED_PACKAGE",
        description:
          `Return ${row.returnNumber}: package condition deteriorated from ` +
          `${row.conditionAtInitiation} at initiation to ${data.condition} at inspection`,
        reporterId: actor.userId,
        warehouseId: inspectionWarehouseId,
        packageId: row.packageId,
        orderId: row.orderId,
        shipmentId: row.shipmentId,
      });
    }
  });
  await auditOps(actor, "return.inspected", "ReturnRequest", row.id, {
    warehouseId: inspectionWarehouseId,
    after: { condition: data.condition, deteriorated },
  });
  return toReturnView(await loadReturnOr404(returnId));
}

// ---------------------------------------------------------------------------
// Completion — handover to the vendor (return-workflow §3.8)
// ---------------------------------------------------------------------------

export const completeReturnSchema = z.object({
  handedToUserId: z.string().uuid().optional().nullable(),
  notes: z.string().max(500).optional().nullable(),
});
export type CompleteReturnInput = z.input<typeof completeReturnSchema>;

export async function completeReturn(
  actor: ActorContext,
  returnId: string,
  input: CompleteReturnInput,
): Promise<ReturnRequestView> {
  const data = parse(completeReturnSchema, input);
  await requirePermAudited(actor, "custody.handover", "ReturnRequest");
  const row = await loadReturnOr404(returnId);
  if (row.status !== "INSPECTED") {
    throw new ConflictError(`Return ${row.returnNumber} is ${row.status} — only INSPECTED returns can be completed`);
  }
  const pkg = await prisma.package.findUniqueOrThrow({
    where: { id: row.packageId },
    include: { order: { select: { vendorId: true } } },
  });
  // Handover happens where the package sits for the return
  // (return-workflow §3.8): the first-receiving warehouse before
  // travel, the destination (return) warehouse after travel.
  const completionWarehouseId = returnWorkingWarehouseId(row, pkg.currentWarehouseId);
  await assertWarehouseScope(actor, completionWarehouseId, "ReturnRequest", row.id);
  // Default receiver: the vendor's OWNER user (the return is handed
  // back to the sender side); an explicit receiver must belong to
  // the same vendor.
  let handedToUserId = data.handedToUserId ?? null;
  if (handedToUserId) {
    const link = await prisma.vendorUser.findFirst({
      where: { userId: handedToUserId, vendorId: pkg.order.vendorId ?? "", isActive: true },
      select: { id: true },
    });
    if (!link) {
      throw new DomainValidationError("The receiving user does not belong to the vendor");
    }
  } else if (pkg.order.vendorId) {
    const owner = await prisma.vendorUser.findFirst({
      where: { vendorId: pkg.order.vendorId, vendorRole: "OWNER", isActive: true },
      orderBy: { createdAt: "asc" },
      select: { userId: true },
    });
    if (!owner) {
      throw new DomainValidationError("The vendor has no active owner user to receive the return");
    }
    handedToUserId = owner.userId;
  }
  if (!handedToUserId) {
    throw new DomainValidationError("A receiving user is required to complete the return");
  }

  await prisma.$transaction(async (tx) => {
    await lockPackageRow(tx, row.packageId);
    const record = await tx.inventoryRecord.findFirst({
      where: { packageId: row.packageId, releasedAt: null },
    });
    if (!record || record.warehouseId !== completionWarehouseId) {
      throw new ConflictError("The returned package is not in stock at the return warehouse");
    }
    const now = new Date();
    await tx.inventoryRecord.update({
      where: { id: record.id },
      data: { releasedAt: now, releasedById: actor.userId, releaseReason: "RETURN" },
    });
    await tx.inventoryMovement.create({
      data: {
        packageId: row.packageId,
        inventoryRecordId: record.id,
        type: "DISPATCH",
        fromWarehouseId: completionWarehouseId,
        fromLocationId: record.storageLocationId,
        actorId: actor.userId,
        reason: `Return ${row.returnNumber} handed to vendor`,
      },
    });
    // Custody: warehouse → receiving vendor user (continuous chain,
    // return-workflow rule 3).
    await tx.packageCustody.updateMany({
      where: { packageId: row.packageId, endedAt: null },
      data: { endedAt: now },
    });
    const event = await tx.trackingEvent.create({
      data: {
        packageId: row.packageId,
        shipmentId: pkg.shipmentId,
        orderId: pkg.orderId,
        subjectType: "PACKAGE",
        eventType: "RETURN_COMPLETED",
        previousStatus: pkg.operationalStatus,
        newStatus: pkg.operationalStatus,
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        warehouseId: completionWarehouseId,
        notes: `Return ${row.returnNumber} completed — handed to the vendor`,
      },
    });
    await tx.packageCustody.create({
      data: {
        packageId: row.packageId,
        custodianType: "USER",
        custodianUserId: handedToUserId,
        trackingEventId: event.id,
      },
    });
    await tx.package.update({
      where: { id: row.packageId },
      data: { deliveryStatus: "RETURNED_TO_SENDER", exceptionStatus: "NONE" },
    });
    await rollupShipmentStatus(tx, pkg.shipmentId);
    await tx.returnRequest.update({
      where: { id: row.id },
      data: {
        status: "COMPLETED",
        completedById: actor.userId,
        completedAt: now,
        handedToUserId,
        notes: data.notes ?? row.notes,
      },
    });
  });
  await auditOps(actor, "return.completed", "ReturnRequest", row.id, {
    warehouseId: completionWarehouseId,
    after: { handedToUserId },
  });
  return toReturnView(await loadReturnOr404(returnId));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface ListReturnsQuery {
  warehouseId?: string;
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listReturns(
  actor: ActorContext,
  query: ListReturnsQuery = {},
): Promise<{ items: ReturnRequestView[]; meta: ReturnType<typeof pageMeta> }> {
  const conditions: Prisma.ReturnRequestWhereInput[] = [];
  if (actor.vendorId) {
    conditions.push({ order: { vendorId: actor.vendorId } });
  } else if (!isUnscoped(actor)) {
    if (actor.warehouseIds.length === 0) {
      return { items: [], meta: pageMeta(0, query.page ?? 1, query.pageSize ?? 25) };
    }
    // A return touches TWO warehouses once it travels: the
    // receiving warehouse and the return (destination) warehouse —
    // staff of either side see it.
    conditions.push({
      OR: [
        { warehouseId: { in: actor.warehouseIds } },
        { destinationWarehouseId: { in: actor.warehouseIds } },
      ],
    });
  }
  if (query.warehouseId) {
    if (!isUnscoped(actor) && !actor.vendorId && !actor.warehouseIds.includes(query.warehouseId)) {
      await auditAccessDenied(actor, "ReturnRequest", {
        warehouseId: query.warehouseId,
        reason: "warehouse_out_of_scope",
      });
      throw new AuthorizationError("Warehouse is outside your assigned scope");
    }
    conditions.push({
      OR: [{ warehouseId: query.warehouseId }, { destinationWarehouseId: query.warehouseId }],
    });
  }
  if (query.status) {
    if (!(RETURN_STATUSES as readonly string[]).includes(query.status)) {
      throw new DomainValidationError(`Unknown return status: ${query.status}`);
    }
    conditions.push({ status: query.status });
  }
  if (query.search) {
    const term = query.search.trim();
    if (term) {
      conditions.push({
        OR: [
          { returnNumber: { contains: term, mode: "insensitive" } },
          { package: { trackingId: { contains: term, mode: "insensitive" } } },
        ],
      });
    }
  }
  const where: Prisma.ReturnRequestWhereInput =
    conditions.length > 0 ? { AND: conditions } : {};
  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  const [total, rows] = await Promise.all([
    prisma.returnRequest.count({ where }),
    prisma.returnRequest.findMany({
      where,
      include: returnInclude,
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
  ]);
  return { items: rows.map(toReturnView), meta: pageMeta(total, page, pageSize) };
}

export async function getReturn(
  actor: ActorContext,
  returnId: string,
): Promise<ReturnRequestView> {
  const row = await loadReturnOr404(returnId);
  if (actor.vendorId) {
    const pkg = await prisma.package.findUnique({
      where: { id: row.packageId },
      include: { order: { select: { vendorId: true } } },
    });
    if (pkg?.order.vendorId !== actor.vendorId) {
      await auditAccessDenied(actor, "ReturnRequest", {
        entityId: row.id,
        reason: "vendor_return_other_vendor",
      });
      throw new AuthorizationError("This return belongs to another vendor");
    }
  } else if (!isUnscoped(actor)) {
    // Readable from either side of the return: the receiving
    // warehouse and the return (destination) warehouse.
    if (
      !actor.warehouseIds.includes(row.warehouseId) &&
      !actor.warehouseIds.includes(effectiveReturnWarehouseId(row))
    ) {
      await assertWarehouseScope(actor, row.warehouseId, "ReturnRequest", row.id);
    }
  }
  return toReturnView(row);
}
