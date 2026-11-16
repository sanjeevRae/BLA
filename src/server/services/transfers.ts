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
import { PACKAGE_CONDITIONS, TRACKING_SOURCES } from "@/lib/bookings/domain";
import type { OperationalStatus } from "@/lib/bookings/lifecycle";
import {
  ACCOUNTED_ITEM_STATUSES,
  ACTIVE_TRIP_STATUSES,
  DRIVER_UNAVAILABLE_STATUSES,
  OPEN_TRANSFER_STATUSES,
  TRANSFER_CANCELLABLE_STATUSES,
  TRANSFER_EDITABLE_STATUSES,
} from "@/lib/transfers/domain";
import { isExpiredDate } from "@/server/services/drivers";
import { vehicleAssignmentBlockers } from "@/server/services/vehicles";
import {
  computeWarehouseCapacity,
  type OpsPackageSummary,
} from "@/server/services/inventory";
import { transitionPackageInTx } from "@/server/services/package-lifecycle";
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
  firstActiveLocationInZoneKind,
  isUnscoped,
  loadWarehouseOr404,
} from "@/server/services/warehouse-ops-shared";
import { raiseIncidentInTx } from "@/server/services/incidents";
import {
  advanceReturnOnDispatchInTx,
  advanceReturnOnReceiveInTx,
  checkReturnTravelForManifestInTx,
  linkReturnToTransferInTx,
  prepareReturnPackageForManifestInTx,
  unlinkReturnFromTransferInTx,
} from "@/server/services/returns";
import { endTrackingSessionsInTx } from "@/server/services/tracking";

/**
 * Inter-warehouse transfers (docs/transfer-workflow.md,
 * docs/database-schema.md §7). A transfer moves packages between two
 * warehouses under a frozen manifest, with a named line-haul driver
 * and vehicle, and it completes only when the destination's physical
 * receiving reconciles against what was dispatched.
 *
 * Invariants enforced here:
 * - A package is on at most one OPEN transfer (candidate package
 *   rows are locked FOR UPDATE inside the item-add transaction
 *   before the check — Phase 5 review P5-1; the DB trigger is the
 *   backstop). Mutations serialize on the Transfer row lock and
 *   re-check their status gates from the locked row (P5-5).
 * - Counts are ALWAYS recounted from TransferItem rows inside the
 *   transaction that acts on them (Phase 4 review P4-1); no stored
 *   counter is ever trusted for dispatch or reconciliation.
 * - Package statuses change only through PackageLifecycleService.
 * - Scope (P3-7b): every mutation asserts the actor's warehouse scope
 *   (origin for create/prepare/load/dispatch, destination for
 *   receive/reconcile) BEFORE any lifecycle transition.
 * - Custody at dispatch opens to the trip's ASSIGNED driver only —
 *   never to a user id taken from the request (P4-2).
 */

/**
 * The one package status this service filters on, bound to the
 * canonical lifecycle vocabulary (src/lib/bookings/lifecycle.ts) so a
 * typo is a type error. Used in READ filters only — writes always go
 * through PackageLifecycleService (the bookings source-scan guard
 * keys on raw `operationalStatus: "..."` literals for that reason).
 */
const READY_FOR_DISPATCH: OperationalStatus = "READY_FOR_DISPATCH";

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface TransferItemView {
  id: string;
  packageId: string;
  trackingId: string;
  itemStatus: string;
  expectedCondition: string;
  receivedCondition: string | null;
  receivedByName: string | null;
  receivedAt: string | null;
  discrepancyNote: string | null;
  packageStatus: string;
  packageCondition: string;
  exceptionStatus: string;
  recipientName: string;
  deliveryDistrict: string;
  weightKg: string;
  codAmountPaisa: string;
}

export interface TransferManifestView {
  id: string;
  manifestCode: string;
  generatedByName: string;
  generatedAt: string;
  packageCount: number;
  totalWeightKg: string;
  totalCodPaisa: string;
  sealedAt: string | null;
}

export interface ReconciliationSummary {
  totalItems: number;
  loadedCount: number;
  receivedCount: number;
  damagedCount: number;
  missingCount: number;
  accountedCount: number;
  unaccountedTrackingIds: string[];
}

export interface TransferView {
  id: string;
  transferNumber: string;
  status: string;
  originWarehouseId: string;
  originWarehouseCode: string;
  originWarehouseName: string;
  destinationWarehouseId: string;
  destinationWarehouseCode: string;
  destinationWarehouseName: string;
  driverId: string | null;
  driverName: string | null;
  driverUserId: string | null;
  vehicleId: string | null;
  vehicleRegistration: string | null;
  tripId: string | null;
  tripNumber: string | null;
  tripStatus: string | null;
  dispatchSupervisorName: string | null;
  createdByName: string;
  approvedByName: string | null;
  approvedAt: string | null;
  expectedArrivalAt: string | null;
  dispatchedAt: string | null;
  arrivedAt: string | null;
  reconciledAt: string | null;
  closedAt: string | null;
  instructions: string | null;
  createdAt: string;
  items: TransferItemView[];
  manifest: TransferManifestView | null;
  reconciliation: ReconciliationSummary;
}

const transferInclude = {
  originWarehouse: { select: { code: true, name: true } },
  destinationWarehouse: { select: { code: true, name: true } },
  driver: { include: { user: { select: { fullName: true } } } },
  vehicle: { select: { registration: true } },
  trip: { select: { tripNumber: true, status: true } },
  dispatchSupervisor: { select: { fullName: true } },
  createdBy: { select: { fullName: true } },
  approvedBy: { select: { fullName: true } },
  manifest: { include: { generatedBy: { select: { fullName: true } } } },
  items: {
    include: {
      package: {
        select: {
          trackingId: true,
          operationalStatus: true,
          condition: true,
          exceptionStatus: true,
          recipientName: true,
          deliveryDistrict: true,
          declaredWeightKg: true,
          actualWeightKg: true,
          billableWeightKg: true,
          codAmountPaisa: true,
        },
      },
      receivedBy: { select: { fullName: true } },
    },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.TransferInclude;

type TransferRow = Prisma.TransferGetPayload<{ include: typeof transferInclude }>;

function packageWeightKg(pkg: {
  billableWeightKg: Prisma.Decimal | null;
  actualWeightKg: Prisma.Decimal | null;
  declaredWeightKg: Prisma.Decimal;
}): Prisma.Decimal {
  return pkg.billableWeightKg ?? pkg.actualWeightKg ?? pkg.declaredWeightKg;
}

function summarizeItems(
  items: { itemStatus: string; package: { trackingId: string } }[],
  loadedStatuses: readonly string[],
): ReconciliationSummary {
  const received = items.filter((i) => i.itemStatus === "RECEIVED").length;
  const damaged = items.filter((i) => i.itemStatus === "DAMAGED").length;
  const missing = items.filter((i) => i.itemStatus === "MISSING").length;
  const unaccounted = items.filter(
    (i) => !ACCOUNTED_ITEM_STATUSES.includes(i.itemStatus),
  );
  return {
    totalItems: items.length,
    loadedCount: items.filter((i) => loadedStatuses.includes(i.itemStatus)).length,
    receivedCount: received,
    damagedCount: damaged,
    missingCount: missing,
    accountedCount: received + damaged,
    unaccountedTrackingIds: unaccounted.map((i) => i.package.trackingId),
  };
}

function toTransferView(row: TransferRow): TransferView {
  return {
    id: row.id,
    transferNumber: row.transferNumber,
    status: row.status,
    originWarehouseId: row.originWarehouseId,
    originWarehouseCode: row.originWarehouse.code,
    originWarehouseName: row.originWarehouse.name,
    destinationWarehouseId: row.destinationWarehouseId,
    destinationWarehouseCode: row.destinationWarehouse.code,
    destinationWarehouseName: row.destinationWarehouse.name,
    driverId: row.driverId,
    driverName: row.driver?.user.fullName ?? null,
    driverUserId: row.driver?.userId ?? null,
    vehicleId: row.vehicleId,
    vehicleRegistration: row.vehicle?.registration ?? null,
    tripId: row.tripId,
    tripNumber: row.trip?.tripNumber ?? null,
    tripStatus: row.trip?.status ?? null,
    dispatchSupervisorName: row.dispatchSupervisor?.fullName ?? null,
    createdByName: row.createdBy.fullName,
    approvedByName: row.approvedBy?.fullName ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    expectedArrivalAt: row.expectedArrivalAt?.toISOString() ?? null,
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    arrivedAt: row.arrivedAt?.toISOString() ?? null,
    reconciledAt: row.reconciledAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    instructions: row.instructions,
    createdAt: row.createdAt.toISOString(),
    items: row.items.map((item) => ({
      id: item.id,
      packageId: item.packageId,
      trackingId: item.package.trackingId,
      itemStatus: item.itemStatus,
      expectedCondition: item.expectedCondition,
      receivedCondition: item.receivedCondition,
      receivedByName: item.receivedBy?.fullName ?? null,
      receivedAt: item.receivedAt?.toISOString() ?? null,
      discrepancyNote: item.discrepancyNote,
      packageStatus: item.package.operationalStatus,
      packageCondition: item.package.condition,
      exceptionStatus: item.package.exceptionStatus,
      recipientName: item.package.recipientName,
      deliveryDistrict: item.package.deliveryDistrict,
      weightKg: packageWeightKg(item.package).toString(),
      codAmountPaisa: item.package.codAmountPaisa.toString(),
    })),
    manifest: row.manifest
      ? {
          id: row.manifest.id,
          manifestCode: row.manifest.manifestCode,
          generatedByName: row.manifest.generatedBy.fullName,
          generatedAt: row.manifest.generatedAt.toISOString(),
          packageCount: row.manifest.packageCount,
          totalWeightKg: row.manifest.totalWeightKg.toString(),
          totalCodPaisa: row.manifest.totalCodPaisa.toString(),
          sealedAt: row.manifest.sealedAt?.toISOString() ?? null,
        }
      : null,
    reconciliation: summarizeItems(row.items, ["LOADED", "IN_TRANSIT", "RECEIVED", "DAMAGED"]),
  };
}

export async function loadTransferOr404(transferId: string): Promise<TransferRow> {
  const transfer = await prisma.transfer.findUnique({
    where: { id: transferId },
    include: transferInclude,
  });
  if (!transfer) throw new NotFoundError("Transfer not found");
  return transfer;
}

// ---------------------------------------------------------------------------
// Scope helpers
// ---------------------------------------------------------------------------

/** Read scope: read_all sees everything; the assigned line-haul
 *  driver sees their own transfer; warehouse members see transfers
 *  touching their warehouses. Denials are audited (security §3.4). */
export async function assertTransferReadable(
  actor: ActorContext,
  transfer: { id: string; originWarehouseId: string; destinationWarehouseId: string; driverId: string | null },
): Promise<void> {
  if (hasPermission(actor, "transfer.read_all")) return;
  if (actor.driverId && transfer.driverId === actor.driverId) return;
  if (
    actor.warehouseIds.includes(transfer.originWarehouseId) ||
    actor.warehouseIds.includes(transfer.destinationWarehouseId)
  ) {
    return;
  }
  await auditAccessDenied(actor, "Transfer", {
    entityId: transfer.id,
    reason: "transfer_out_of_scope",
  });
  throw new AuthorizationError("Transfer is outside your assigned scope");
}

async function nextSequenceValue(
  tx: Prisma.TransactionClient,
  sequence: "transfer_number_seq" | "trip_number_seq",
): Promise<bigint> {
  const rows =
    sequence === "transfer_number_seq"
      ? await tx.$queryRaw<{ nextval: bigint }[]>`SELECT nextval('app.transfer_number_seq') AS nextval`
      : await tx.$queryRaw<{ nextval: bigint }[]>`SELECT nextval('app.trip_number_seq') AS nextval`;
  return rows[0].nextval;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export const createTransferSchema = z.object({
  originWarehouseId: z.string().uuid(),
  destinationWarehouseId: z.string().uuid(),
  expectedArrivalAt: z.string().datetime().optional().nullable(),
  instructions: z.string().max(1000).optional().nullable(),
});
export type CreateTransferInput = z.input<typeof createTransferSchema>;

export async function createTransfer(
  actor: ActorContext,
  input: CreateTransferInput,
): Promise<TransferView> {
  const data = parse(createTransferSchema, input);
  await requirePermAudited(actor, "transfer.create", "Transfer");
  if (data.originWarehouseId === data.destinationWarehouseId) {
    throw new DomainValidationError(
      "Origin and destination must differ — moving parcels inside one warehouse is an internal inventory movement, not a transfer",
    );
  }
  const [origin, destination] = await Promise.all([
    loadWarehouseOr404(data.originWarehouseId),
    loadWarehouseOr404(data.destinationWarehouseId),
  ]);
  if (origin.status !== "ACTIVE" || destination.status !== "ACTIVE") {
    throw new DomainValidationError("Both warehouses must be active to open a transfer");
  }
  // Footnote 18: a scoped creator's origin must be their own warehouse.
  await assertWarehouseScope(actor, data.originWarehouseId, "Transfer");

  const created = await prisma.$transaction(async (tx) => {
    const seq = await nextSequenceValue(tx, "transfer_number_seq");
    return tx.transfer.create({
      data: {
        transferNumber: `TRF-${seq.toString()}`,
        originWarehouseId: data.originWarehouseId,
        destinationWarehouseId: data.destinationWarehouseId,
        expectedArrivalAt: data.expectedArrivalAt
          ? new Date(data.expectedArrivalAt)
          : null,
        instructions: data.instructions ?? null,
        createdById: actor.userId,
      },
    });
  });

  await auditOps(actor, "transfer.create", "Transfer", created.id, {
    warehouseId: data.originWarehouseId,
    after: {
      transferNumber: created.transferNumber,
      destinationWarehouseId: data.destinationWarehouseId,
    },
  });
  return toTransferView(await loadTransferOr404(created.id));
}

// ---------------------------------------------------------------------------
// Item selection
// ---------------------------------------------------------------------------

export interface AddItemsResult {
  added: { packageId: string; trackingId: string }[];
  rejected: { packageId: string; trackingId: string | null; reason: string }[];
}

const BLOCKING_EXCEPTIONS: readonly string[] = [
  "ON_HOLD",
  "DAMAGED",
  "MISSING",
  "LOST_UNDER_INVESTIGATION",
];

/** Lock the Transfer row for the duration of a mutating transaction
 *  and return its FRESH status (Phase 5 review P5-5). Status gates
 *  decided from a snapshot loaded before the transaction are
 *  TOCTOU-unsafe: a concurrent dispatch/manifest/cancel can commit
 *  in between and the stale gate lets the mutation through. Every
 *  mutating transfer operation takes this lock first and re-checks
 *  its gate from the locked row. */
async function lockTransferRow(
  tx: Prisma.TransactionClient,
  transferId: string,
): Promise<string> {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status" FROM "app"."Transfer" WHERE "id" = ${transferId} FOR UPDATE
  `;
  if (rows.length === 0) throw new NotFoundError("Transfer not found");
  return rows[0].status;
}

/** Recount the manifest snapshot from the transfer's CURRENT items.
 *  Runs inside the caller's transaction (P4-1: totals are derived
 *  from item rows, never maintained as a running counter). */
async function refreshManifestTotals(
  tx: Prisma.TransactionClient,
  transferId: string,
): Promise<void> {
  const manifest = await tx.transferManifest.findUnique({
    where: { transferId },
  });
  if (!manifest) return;
  const items = await tx.transferItem.findMany({
    where: { transferId },
    include: {
      package: {
        select: {
          declaredWeightKg: true,
          actualWeightKg: true,
          billableWeightKg: true,
          codAmountPaisa: true,
        },
      },
    },
  });
  let totalWeight = new Prisma.Decimal(0);
  let totalCod = BigInt(0);
  for (const item of items) {
    totalWeight = totalWeight.add(packageWeightKg(item.package));
    totalCod += item.package.codAmountPaisa;
  }
  await tx.transferManifest.update({
    where: { id: manifest.id },
    data: { packageCount: items.length, totalWeightKg: totalWeight, totalCodPaisa: totalCod },
  });
}

export async function addTransferItems(
  actor: ActorContext,
  transferId: string,
  packageIds: string[],
): Promise<AddItemsResult> {
  await requirePermAudited(actor, "transfer.prepare", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  await assertWarehouseScope(actor, transfer.originWarehouseId, "Transfer", transferId);
  if (!TRANSFER_EDITABLE_STATUSES.includes(transfer.status)) {
    throw new ConflictError(
      `A transfer in ${transfer.status} cannot take new packages — items are locked once the transfer is dispatched`,
    );
  }
  const uniqueIds = [...new Set(packageIds)];
  if (uniqueIds.length === 0) {
    throw new DomainValidationError("Select at least one package");
  }

  const result: AddItemsResult = { added: [], rejected: [] };
  let manifestPresent = transfer.manifest != null;

  await prisma.$transaction(async (tx) => {
    // P5-5: serialize on the transfer row and re-check the status
    // gate from the locked row — the snapshot check above can be
    // overtaken by a concurrent dispatch/manifest/cancel.
    const lockedStatus = await lockTransferRow(tx, transferId);
    if (!TRANSFER_EDITABLE_STATUSES.includes(lockedStatus)) {
      throw new ConflictError(
        `A transfer in ${lockedStatus} cannot take new packages — items are locked once the transfer is dispatched`,
      );
    }
    // P5-1: lock every candidate package row BEFORE the
    // one-open-transfer check below. The check (and the DB trigger)
    // is a plain EXISTS under READ COMMITTED: two concurrent adds
    // cannot see each other's uncommitted item rows, so without this
    // lock both pass and the package lands on two open transfers.
    // Sorted order keeps concurrent multi-package adds deadlock-free.
    await tx.$queryRaw`
      SELECT "id" FROM "app"."Package"
      WHERE "id" IN (${Prisma.join(uniqueIds)})
      ORDER BY "id"
      FOR UPDATE
    `;
    for (const packageId of uniqueIds) {
      const pkg = await tx.package.findUnique({
        where: { id: packageId },
        include: {
          shipment: { select: { destinationWarehouseId: true } },
        },
      });
      if (!pkg) {
        result.rejected.push({ packageId, trackingId: null, reason: "Package not found" });
        continue;
      }
      const reject = (reason: string) =>
        result.rejected.push({ packageId, trackingId: pkg.trackingId, reason });

      const existingHere = await tx.transferItem.findUnique({
        where: { transferId_packageId: { transferId, packageId } },
      });
      if (existingHere) {
        reject("Already on this transfer");
        continue;
      }
      // P4-3: the one-open-transfer check runs INSIDE this
      // transaction (the DB trigger backstops it).
      const openElsewhere = await tx.transferItem.findFirst({
        where: {
          packageId,
          transfer: { status: { in: [...OPEN_TRANSFER_STATUSES] } },
        },
        include: { transfer: { select: { transferNumber: true } } },
      });
      if (openElsewhere) {
        reject(`Already on open transfer ${openElsewhere.transfer.transferNumber}`);
        continue;
      }
      // Cross-warehouse returns (Phase 7): a package under an open
      // return may be manifested ONLY as a travelling return toward
      // its return warehouse — the hook validates that, or throws a
      // ConflictError refusing the manifest. It runs BEFORE the
      // stock/status gates so a return-flow refusal is never masked
      // by a forward-flow rejection (a not-yet-received return has
      // no stock record at all). A travelling return bypasses the
      // two forward-flow gates below (its operational status is the
      // scan-back READY_FOR_DELIVERY, and its shipment destination
      // is the warehouse it is travelling FROM, not to).
      const travelReturn = await checkReturnTravelForManifestInTx(tx, {
        packageId,
        transferId,
        transferNumber: transfer.transferNumber,
        originWarehouseId: transfer.originWarehouseId,
        destinationWarehouseId: transfer.destinationWarehouseId,
      });
      const record = await tx.inventoryRecord.findFirst({
        where: { packageId, releasedAt: null },
        select: { warehouseId: true },
      });
      if (!record) {
        reject("Not in stock at any warehouse — receive it at the origin first");
        continue;
      }
      if (record.warehouseId !== transfer.originWarehouseId) {
        reject("In stock at a different warehouse, not this transfer's origin");
        continue;
      }
      if (!travelReturn && pkg.operationalStatus !== "READY_FOR_DISPATCH") {
        reject(
          `Package is ${pkg.operationalStatus} — only READY_FOR_DISPATCH packages can be manifested`,
        );
        continue;
      }
      if (!travelReturn && pkg.shipment.destinationWarehouseId !== transfer.destinationWarehouseId) {
        reject("This package is destined for a different warehouse than the transfer's destination");
        continue;
      }
      if (BLOCKING_EXCEPTIONS.includes(pkg.exceptionStatus)) {
        reject(`Package has an active ${pkg.exceptionStatus} exception and cannot be dispatched`);
        continue;
      }
      await tx.transferItem.create({
        data: {
          transferId,
          packageId,
          expectedCondition: pkg.condition,
        },
      });
      if (travelReturn) {
        await linkReturnToTransferInTx(tx, {
          returnId: travelReturn.returnId,
          transferId,
        });
      }
      result.added.push({ packageId, trackingId: pkg.trackingId });
    }
    if (result.added.length > 0) {
      // Manifest already sealed: adding is an authorised amendment —
      // the snapshot is recounted and the amendment audited below.
      // (refreshManifestTotals no-ops when no manifest exists yet.)
      manifestPresent =
        (await tx.transferManifest.findUnique({
          where: { transferId },
          select: { id: true },
        })) != null;
      if (manifestPresent) {
        await refreshManifestTotals(tx, transferId);
      }
    }
  });

  if (result.added.length > 0) {
    await auditOps(
      actor,
      manifestPresent ? "transfer.manifest_amended" : "transfer.items_added",
      "Transfer",
      transferId,
      {
        warehouseId: transfer.originWarehouseId,
        after: {
          addedPackageIds: result.added.map((a) => a.packageId),
          rejected: result.rejected,
        },
      },
    );
  }
  return result;
}

export async function removeTransferItem(
  actor: ActorContext,
  transferId: string,
  packageId: string,
  reason?: string | null,
): Promise<TransferView> {
  await requirePermAudited(actor, "transfer.prepare", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  await assertWarehouseScope(actor, transfer.originWarehouseId, "Transfer", transferId);
  if (!TRANSFER_EDITABLE_STATUSES.includes(transfer.status)) {
    throw new ConflictError(
      `Items cannot be removed from a transfer in ${transfer.status}`,
    );
  }
  const item = transfer.items.find((i) => i.packageId === packageId);
  if (!item) throw new NotFoundError("Package is not on this transfer");
  if (item.itemStatus === "LOADED") {
    throw new ConflictError(
      "This package is already loaded — unload it (reverse the load scan) before removing it from the transfer",
    );
  }

  let manifestPresent = transfer.manifest != null;
  await prisma.$transaction(async (tx) => {
    // P5-5: re-validate from the locked transfer row and a FRESH
    // item row — the snapshot checks above can be overtaken by a
    // concurrent load scan (item now LOADED) or manifest generation
    // (package now TRANSFER_ASSIGNED), and acting on the stale item
    // either corrupts the manifest or dies on a raw FK error.
    const lockedStatus = await lockTransferRow(tx, transferId);
    if (!TRANSFER_EDITABLE_STATUSES.includes(lockedStatus)) {
      throw new ConflictError(
        `Items cannot be removed from a transfer in ${lockedStatus}`,
      );
    }
    const freshItem = await tx.transferItem.findUnique({
      where: { transferId_packageId: { transferId, packageId } },
      include: { package: { select: { operationalStatus: true } } },
    });
    if (!freshItem) throw new NotFoundError("Package is not on this transfer");
    if (freshItem.itemStatus === "LOADED") {
      throw new ConflictError(
        "This package is already loaded — unload it (reverse the load scan) before removing it from the transfer",
      );
    }
    if (freshItem.package.operationalStatus === "TRANSFER_ASSIGNED") {
      // Release the parcel back to origin stock (the pre-dispatch
      // release edge in the lifecycle table).
      await transitionPackageInTx(tx, actor, packageId, "READY_FOR_DISPATCH", {
        warehouseId: transfer.originWarehouseId,
        transferId,
        notes: `Removed from transfer ${transfer.transferNumber} before dispatch${reason ? `: ${reason}` : ""}`,
      });
    }
    // Phase 7: a removed travelling return unlinks (still RECEIVED
    // at the origin, ready to be re-manifested); no-op otherwise.
    await unlinkReturnFromTransferInTx(tx, { packageId, transferId });
    await tx.transferItem.delete({ where: { id: freshItem.id } });
    manifestPresent =
      (await tx.transferManifest.findUnique({
        where: { transferId },
        select: { id: true },
      })) != null;
    if (manifestPresent) {
      await refreshManifestTotals(tx, transferId);
    }
  });

  await auditOps(
    actor,
    manifestPresent ? "transfer.manifest_amended" : "transfer.item_removed",
    "Transfer",
    transferId,
    {
      warehouseId: transfer.originWarehouseId,
      after: { packageId, trackingId: item.package.trackingId, reason: reason ?? null },
    },
  );
  return toTransferView(await loadTransferOr404(transferId));
}

// ---------------------------------------------------------------------------
// Approval (only where the lane is submitted for it — workflow step 5)
// ---------------------------------------------------------------------------

export async function submitTransferForApproval(
  actor: ActorContext,
  transferId: string,
): Promise<TransferView> {
  await requirePermAudited(actor, "transfer.create", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  await assertWarehouseScope(actor, transfer.originWarehouseId, "Transfer", transferId);
  if (transfer.status !== "DRAFT" && transfer.status !== "PREPARING") {
    throw new ConflictError(`A transfer in ${transfer.status} cannot be submitted for approval`);
  }
  if (transfer.items.length === 0) {
    throw new DomainValidationError("Add at least one package before submitting for approval");
  }
  await prisma.transfer.update({
    where: { id: transferId },
    data: { status: "REQUESTED" },
  });
  await auditOps(actor, "transfer.submitted_for_approval", "Transfer", transferId, {
    warehouseId: transfer.originWarehouseId,
  });
  return toTransferView(await loadTransferOr404(transferId));
}

export async function approveTransfer(
  actor: ActorContext,
  transferId: string,
): Promise<TransferView> {
  await requirePermAudited(actor, "transfer.approve", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  // Footnote 20: a WA approves transfers into OR out of their own
  // warehouse; AD/SA approve any.
  if (!isUnscoped(actor)) {
    const inScope =
      actor.warehouseIds.includes(transfer.originWarehouseId) ||
      actor.warehouseIds.includes(transfer.destinationWarehouseId);
    if (!inScope) {
      await auditAccessDenied(actor, "Transfer", {
        entityId: transferId,
        reason: "transfer_approve_out_of_scope",
      });
      throw new AuthorizationError("You can only approve transfers into or out of your own warehouse");
    }
  }
  if (transfer.status !== "REQUESTED") {
    throw new ConflictError(`Only a REQUESTED transfer can be approved (current: ${transfer.status})`);
  }
  await prisma.transfer.update({
    where: { id: transferId },
    data: { status: "APPROVED", approvedById: actor.userId, approvedAt: new Date() },
  });
  await auditOps(actor, "transfer.approved", "Transfer", transferId, {
    warehouseId: transfer.originWarehouseId,
  });
  return toTransferView(await loadTransferOr404(transferId));
}

export async function rejectTransfer(
  actor: ActorContext,
  transferId: string,
  reason: string,
): Promise<TransferView> {
  await requirePermAudited(actor, "transfer.approve", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  if (!isUnscoped(actor)) {
    const inScope =
      actor.warehouseIds.includes(transfer.originWarehouseId) ||
      actor.warehouseIds.includes(transfer.destinationWarehouseId);
    if (!inScope) {
      await auditAccessDenied(actor, "Transfer", {
        entityId: transferId,
        reason: "transfer_approve_out_of_scope",
      });
      throw new AuthorizationError("You can only reject transfers into or out of your own warehouse");
    }
  }
  if (transfer.status !== "REQUESTED") {
    throw new ConflictError(`Only a REQUESTED transfer can be rejected (current: ${transfer.status})`);
  }
  await prisma.transfer.update({
    where: { id: transferId },
    data: { status: "REJECTED" },
  });
  await auditOps(actor, "transfer.rejected", "Transfer", transferId, {
    warehouseId: transfer.originWarehouseId,
    after: { reason },
  });
  return toTransferView(await loadTransferOr404(transferId));
}

export async function reviseTransfer(
  actor: ActorContext,
  transferId: string,
): Promise<TransferView> {
  await requirePermAudited(actor, "transfer.create", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  await assertWarehouseScope(actor, transfer.originWarehouseId, "Transfer", transferId);
  if (transfer.status !== "REJECTED") {
    throw new ConflictError(`Only a REJECTED transfer returns to draft (current: ${transfer.status})`);
  }
  await prisma.transfer.update({
    where: { id: transferId },
    data: { status: "DRAFT", approvedById: null, approvedAt: null },
  });
  await auditOps(actor, "transfer.revised", "Transfer", transferId, {
    warehouseId: transfer.originWarehouseId,
  });
  return toTransferView(await loadTransferOr404(transferId));
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export async function generateManifest(
  actor: ActorContext,
  transferId: string,
): Promise<TransferView> {
  await requirePermAudited(actor, "transfer.prepare", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  await assertWarehouseScope(actor, transfer.originWarehouseId, "Transfer", transferId);
  if (transfer.manifest) {
    throw new ConflictError("This transfer already has a manifest — it is frozen and cannot be regenerated");
  }
  if (transfer.status === "REQUESTED") {
    throw new ConflictError("This transfer is awaiting approval — the manifest can be prepared once it is approved");
  }
  if (!["DRAFT", "PREPARING", "APPROVED"].includes(transfer.status)) {
    throw new ConflictError(`A manifest cannot be generated for a transfer in ${transfer.status}`);
  }
  if (transfer.items.length === 0) {
    throw new DomainValidationError("Add at least one package before generating the manifest");
  }

  let manifestedCount = transfer.items.length;
  await prisma.$transaction(async (tx) => {
    // P5-5: re-check the gates from the locked transfer row and
    // iterate FRESH item rows — the snapshot above can be overtaken
    // by a concurrent remove (which releases the package and deletes
    // its item; manifesting the stale list would strand the package
    // in TRANSFER_ASSIGNED with no open item) or a second generate.
    const lockedStatus = await lockTransferRow(tx, transferId);
    const existingManifest = await tx.transferManifest.findUnique({
      where: { transferId },
      select: { id: true },
    });
    if (existingManifest) {
      throw new ConflictError("This transfer already has a manifest — it is frozen and cannot be regenerated");
    }
    if (lockedStatus === "REQUESTED") {
      throw new ConflictError("This transfer is awaiting approval — the manifest can be prepared once it is approved");
    }
    if (!["DRAFT", "PREPARING", "APPROVED"].includes(lockedStatus)) {
      throw new ConflictError(`A manifest cannot be generated for a transfer in ${lockedStatus}`);
    }
    const freshItems = await tx.transferItem.findMany({
      where: { transferId },
      include: { package: { select: { trackingId: true } } },
      orderBy: { createdAt: "asc" },
    });
    if (freshItems.length === 0) {
      throw new DomainValidationError("Add at least one package before generating the manifest");
    }
    manifestedCount = freshItems.length;
    // Re-validate every item inside the transaction: stock position
    // and status may have moved since selection.
    for (const item of freshItems) {
      // Phase 7: a travelling return's package is readied for
      // dispatch first (READY_FOR_DELIVERY → READY_FOR_DISPATCH);
      // no-op for normal cargo.
      await prepareReturnPackageForManifestInTx(tx, actor, item.packageId, transferId);
      const pkg = await tx.package.findUniqueOrThrow({
        where: { id: item.packageId },
        select: { operationalStatus: true },
      });
      if (pkg.operationalStatus !== "READY_FOR_DISPATCH") {
        throw new ConflictError(
          `Package ${item.package.trackingId} is ${pkg.operationalStatus}, not READY_FOR_DISPATCH — remove it or ready it before manifesting`,
        );
      }
      const record = await tx.inventoryRecord.findFirst({
        where: { packageId: item.packageId, releasedAt: null },
        select: { warehouseId: true },
      });
      if (!record || record.warehouseId !== transfer.originWarehouseId) {
        throw new ConflictError(
          `Package ${item.package.trackingId} is no longer in stock at the origin warehouse`,
        );
      }
      await transitionPackageInTx(tx, actor, item.packageId, "TRANSFER_ASSIGNED", {
        warehouseId: transfer.originWarehouseId,
        transferId,
        notes: `Manifested on transfer ${transfer.transferNumber}`,
      });
    }
    const numberPart = transfer.transferNumber.replace(/^TRF-/, "");
    await tx.transferManifest.create({
      data: {
        transferId,
        manifestCode: `MNF-${numberPart}`,
        generatedById: actor.userId,
        packageCount: 0, // recounted immediately below from item rows
        totalWeightKg: new Prisma.Decimal(0),
        totalCodPaisa: BigInt(0),
        sealedAt: new Date(),
      },
    });
    await refreshManifestTotals(tx, transferId);
    await tx.transfer.update({
      where: { id: transferId },
      data: { status: "READY_FOR_DISPATCH" },
    });
  });

  await auditOps(actor, "transfer.manifest_generated", "Transfer", transferId, {
    warehouseId: transfer.originWarehouseId,
    after: { packageCount: manifestedCount },
  });
  return toTransferView(await loadTransferOr404(transferId));
}

// ---------------------------------------------------------------------------
// Crew assignment (driver + vehicle + trip creation)
// ---------------------------------------------------------------------------

export const assignCrewSchema = z.object({
  transferId: z.string().uuid(),
  driverId: z.string().uuid(),
  vehicleId: z.string().uuid(),
  plannedDepartureAt: z.string().datetime().optional().nullable(),
});
export type AssignCrewInput = z.input<typeof assignCrewSchema>;

/** Why this driver cannot take a trip right now (empty = assignable).
 *  Shared by assignment and the dispatch re-check. */
export async function driverAssignmentBlockers(
  tx: Prisma.TransactionClient | typeof prisma,
  driver: {
    id: string;
    employmentStatus: string;
    availabilityStatus: string;
    licenseExpiry: Date;
    user: { status: string; roles: { role: { code: string } }[] };
    capabilities: { capability: string }[];
  },
  excludeTransferId?: string,
): Promise<string[]> {
  const blockers: string[] = [];
  if (driver.employmentStatus !== "ACTIVE") {
    blockers.push(`Driver employment status is ${driver.employmentStatus}`);
  }
  if (driver.user.status !== "ACTIVE") blockers.push("Driver's user account is not active");
  if (!driver.user.roles.some((r) => r.role.code === "LINEHAUL_DRIVER")) {
    blockers.push("User does not hold the LINEHAUL_DRIVER role");
  }
  if (!driver.capabilities.some((c) => c.capability === "LINEHAUL")) {
    blockers.push("Driver does not hold the LINEHAUL capability");
  }
  if (isExpiredDate(driver.licenseExpiry)) blockers.push("Driving licence has expired");
  if (DRIVER_UNAVAILABLE_STATUSES.includes(driver.availabilityStatus)) {
    blockers.push(`Driver availability is ${driver.availabilityStatus}`);
  }
  const activeTrip = await tx.trip.findFirst({
    where: {
      driverId: driver.id,
      status: { in: [...ACTIVE_TRIP_STATUSES] },
      ...(excludeTransferId ? { NOT: { transferId: excludeTransferId } } : {}),
    },
    select: { tripNumber: true },
  });
  if (activeTrip) {
    blockers.push(`Driver is already assigned to active trip ${activeTrip.tripNumber}`);
  }
  return blockers;
}

export async function assignTransferCrew(
  actor: ActorContext,
  input: AssignCrewInput,
): Promise<TransferView> {
  const data = parse(assignCrewSchema, input);
  await requirePermAudited(actor, "driver.assign", "Transfer");
  await requirePermAudited(actor, "vehicle.assign", "Transfer");
  const transfer = await loadTransferOr404(data.transferId);
  await assertWarehouseScope(actor, transfer.originWarehouseId, "Transfer", transfer.id);
  if (!TRANSFER_EDITABLE_STATUSES.includes(transfer.status)) {
    throw new ConflictError(`Crew cannot be assigned to a transfer in ${transfer.status}`);
  }
  if (transfer.status === "REQUESTED" || transfer.status === "REJECTED") {
    throw new ConflictError("Resolve the approval before assigning a crew");
  }

  // P5-2: EVERY assignment check runs INSIDE the write transaction,
  // under row locks on the transfer, the driver and the vehicle.
  // Previously the blockers were evaluated on unlocked reads before
  // the transaction opened, so two concurrent assignments of the
  // same driver (or vehicle) both passed the already-on-a-trip check
  // and the driver landed on two active trips. Lock order is fixed
  // (transfer → driver → vehicle) so concurrent calls serialize
  // instead of deadlocking.
  const assigned = await prisma.$transaction(async (tx) => {
    await lockTransferRow(tx, transfer.id);
    await tx.$queryRaw`
      SELECT "id" FROM "app"."Driver" WHERE "id" = ${data.driverId} FOR UPDATE
    `;
    await tx.$queryRaw`
      SELECT "id" FROM "app"."Vehicle" WHERE "id" = ${data.vehicleId} FOR UPDATE
    `;
    const freshTransfer = await tx.transfer.findUniqueOrThrow({
      where: { id: transfer.id },
    });
    if (!TRANSFER_EDITABLE_STATUSES.includes(freshTransfer.status)) {
      throw new ConflictError(`Crew cannot be assigned to a transfer in ${freshTransfer.status}`);
    }
    if (freshTransfer.status === "REQUESTED" || freshTransfer.status === "REJECTED") {
      throw new ConflictError("Resolve the approval before assigning a crew");
    }
    const driver = await tx.driver.findUnique({
      where: { id: data.driverId },
      include: {
        user: {
          include: { roles: { include: { role: { select: { code: true } } } } },
        },
        capabilities: true,
      },
    });
    if (!driver) throw new NotFoundError("Driver profile not found");
    const vehicle = await tx.vehicle.findUnique({ where: { id: data.vehicleId } });
    if (!vehicle) throw new NotFoundError("Vehicle not found");

    const driverBlockers = await driverAssignmentBlockers(tx, driver, freshTransfer.id);
    if (driverBlockers.length > 0) {
      throw new DomainValidationError(driverBlockers.join("; "));
    }
    const vehicleBlockers = vehicleAssignmentBlockers(vehicle);
    if (vehicleBlockers.length > 0) {
      throw new DomainValidationError(vehicleBlockers.join("; "));
    }
    const activeVehicleTrip = await tx.trip.findFirst({
      where: {
        vehicleId: vehicle.id,
        status: { in: [...ACTIVE_TRIP_STATUSES] },
        NOT: { transferId: freshTransfer.id },
      },
      select: { tripNumber: true },
    });
    if (activeVehicleTrip) {
      throw new DomainValidationError(
        `Vehicle is already assigned to active trip ${activeVehicleTrip.tripNumber}`,
      );
    }
    const manifest = await tx.transferManifest.findUnique({
      where: { transferId: freshTransfer.id },
    });
    if (manifest && vehicle.capacityKg) {
      if (vehicle.capacityKg.lessThan(manifest.totalWeightKg)) {
        throw new DomainValidationError(
          `Vehicle capacity ${vehicle.capacityKg.toString()} kg is below the manifest weight ${manifest.totalWeightKg} kg`,
        );
      }
    }

    // Replacing a previously assigned driver frees their ASSIGNED
    // availability (they never took custody — that happens at
    // dispatch).
    if (freshTransfer.driverId && freshTransfer.driverId !== driver.id) {
      const previous = await tx.driver.findUnique({
        where: { id: freshTransfer.driverId },
        select: { availabilityStatus: true },
      });
      if (previous?.availabilityStatus === "ASSIGNED") {
        await tx.driver.update({
          where: { id: freshTransfer.driverId },
          data: { availabilityStatus: "AVAILABLE" },
        });
      }
    }
    let tripId = freshTransfer.tripId;
    if (tripId) {
      await tx.trip.update({
        where: { id: tripId },
        data: {
          driverId: driver.id,
          vehicleId: vehicle.id,
          status: "ASSIGNED",
          plannedDepartureAt: data.plannedDepartureAt
            ? new Date(data.plannedDepartureAt)
            : undefined,
          expectedArrivalAt: freshTransfer.expectedArrivalAt,
        },
      });
    } else {
      const seq = await nextSequenceValue(tx, "trip_number_seq");
      const trip = await tx.trip.create({
        data: {
          tripNumber: `TRP-${seq.toString()}`,
          transferId: freshTransfer.id,
          driverId: driver.id,
          vehicleId: vehicle.id,
          status: "ASSIGNED",
          plannedDepartureAt: data.plannedDepartureAt
            ? new Date(data.plannedDepartureAt)
            : null,
          expectedArrivalAt: freshTransfer.expectedArrivalAt,
        },
      });
      tripId = trip.id;
    }
    await tx.transfer.update({
      where: { id: freshTransfer.id },
      data: { driverId: driver.id, vehicleId: vehicle.id, tripId },
    });
    await tx.driver.update({
      where: { id: driver.id },
      data: { availabilityStatus: "ASSIGNED" },
    });
    return { driverId: driver.id, vehicleId: vehicle.id };
  });

  await auditOps(actor, "transfer.crew_assigned", "Transfer", transfer.id, {
    warehouseId: transfer.originWarehouseId,
    after: { driverId: assigned.driverId, vehicleId: assigned.vehicleId },
  });
  return toTransferView(await loadTransferOr404(transfer.id));
}

// ---------------------------------------------------------------------------
// Loading scans + dispatch
// ---------------------------------------------------------------------------

export const loadScanSchema = z.object({
  trackingId: z.string().min(1).max(40),
  idempotencyKey: z.string().min(1).max(120).optional().nullable(),
  source: z.enum(TRACKING_SOURCES).default("WEB"),
});
export type LoadScanInput = z.input<typeof loadScanSchema>;

export interface LoadScanResult {
  trackingId: string;
  alreadyScanned: boolean;
  loadedCount: number;
  totalCount: number;
  allLoaded: boolean;
}

/** Origin-side actors by membership, plus the assigned line-haul
 *  driver for their own transfer (matrix A19). */
async function assertLoadScope(
  actor: ActorContext,
  transfer: TransferRow,
): Promise<void> {
  if (actor.driverId && transfer.driverId === actor.driverId) return;
  await assertWarehouseScope(actor, transfer.originWarehouseId, "Transfer", transfer.id);
}

export async function loadTransferPackage(
  actor: ActorContext,
  transferId: string,
  input: LoadScanInput,
): Promise<LoadScanResult> {
  const data = parse(loadScanSchema, input);
  await requirePermAudited(actor, "transfer.load", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  await assertLoadScope(actor, transfer);
  if (!transfer.manifest) {
    throw new DomainValidationError("Generate the manifest before loading — loading scans verify against it");
  }
  if (transfer.status !== "READY_FOR_DISPATCH") {
    throw new ConflictError(`Packages can only be loaded while the transfer is READY_FOR_DISPATCH (current: ${transfer.status})`);
  }
  const item = transfer.items.find((i) => i.package.trackingId === data.trackingId.trim());
  if (!item) {
    throw new NotFoundError(
      `Package ${data.trackingId} is not on transfer ${transfer.transferNumber}'s manifest`,
    );
  }
  const scanKey =
    data.idempotencyKey ?? `load-${transferId}-${item.packageId}`;

  const outcome = await prisma.$transaction(async (tx) => {
    const prior = await tx.transferScan.findUnique({
      where: { idempotencyKey: scanKey },
    });
    if (prior) {
      if (prior.transferItemId !== item.id) {
        throw new ConflictError("This scan key was already used for a different package");
      }
      const items = await tx.transferItem.findMany({
        where: { transferId },
        select: { itemStatus: true },
      });
      const loaded = items.filter((i) => i.itemStatus === "LOADED").length;
      return { already: true, loaded, total: items.length };
    }
    const fresh = await tx.transferItem.findUniqueOrThrow({ where: { id: item.id } });
    if (fresh.itemStatus === "LOADED") {
      const items = await tx.transferItem.findMany({
        where: { transferId },
        select: { itemStatus: true },
      });
      return {
        already: true,
        loaded: items.filter((i) => i.itemStatus === "LOADED").length,
        total: items.length,
      };
    }
    if (fresh.itemStatus !== "EXPECTED") {
      throw new ConflictError(`This package's manifest line is ${fresh.itemStatus} and cannot be loaded`);
    }
    // Physical presence: still TRANSFER_ASSIGNED and stocked at origin.
    const pkg = await tx.package.findUniqueOrThrow({
      where: { id: item.packageId },
      select: { operationalStatus: true },
    });
    if (pkg.operationalStatus !== "TRANSFER_ASSIGNED") {
      throw new ConflictError(
        `Package is ${pkg.operationalStatus} — it is not staged for this transfer`,
      );
    }
    const record = await tx.inventoryRecord.findFirst({
      where: { packageId: item.packageId, releasedAt: null },
      select: { warehouseId: true },
    });
    if (!record || record.warehouseId !== transfer.originWarehouseId) {
      throw new ConflictError("Package is not in stock at the origin warehouse");
    }
    await tx.transferScan.create({
      data: {
        transferItemId: item.id,
        scanType: "LOAD",
        warehouseId: transfer.originWarehouseId,
        scannedById: actor.userId,
        idempotencyKey: scanKey,
      },
    });
    await tx.transferItem.update({
      where: { id: item.id },
      data: { itemStatus: "LOADED" },
    });
    if (transfer.tripId) {
      const trip = await tx.trip.findUnique({ where: { id: transfer.tripId } });
      if (trip?.status === "ASSIGNED") {
        await tx.trip.update({ where: { id: trip.id }, data: { status: "LOADING" } });
      }
    }
    // P4-1: the loaded count is recounted from item rows in this
    // transaction, never incremented from a stale snapshot.
    const items = await tx.transferItem.findMany({
      where: { transferId },
      select: { itemStatus: true },
    });
    return {
      already: false,
      loaded: items.filter((i) => i.itemStatus === "LOADED").length,
      total: items.length,
    };
  }).catch((error: unknown) => {
    // Unique-key race on the scan: the duplicate wins gracefully.
    if (isUniqueViolation(error)) {
      return { already: true, loaded: -1, total: transfer.items.length };
    }
    throw error;
  });

  if (outcome.loaded < 0) {
    const items = await prisma.transferItem.findMany({
      where: { transferId },
      select: { itemStatus: true },
    });
    outcome.loaded = items.filter((i) => i.itemStatus === "LOADED").length;
    outcome.total = items.length;
  }
  return {
    trackingId: item.package.trackingId,
    alreadyScanned: outcome.already,
    loadedCount: outcome.loaded,
    totalCount: outcome.total,
    allLoaded: outcome.loaded === outcome.total,
  };
}

/** Reverse a load scan before dispatch (workflow §7 rule 5): the
 *  parcel is physically unloaded back into origin stock; the reversal
 *  is itself a scan record, never a deletion. */
export async function unloadTransferPackage(
  actor: ActorContext,
  transferId: string,
  trackingId: string,
): Promise<LoadScanResult> {
  await requirePermAudited(actor, "transfer.load", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  await assertLoadScope(actor, transfer);
  if (transfer.status !== "READY_FOR_DISPATCH") {
    throw new ConflictError("Loads can only be reversed before dispatch");
  }
  const item = transfer.items.find((i) => i.package.trackingId === trackingId.trim());
  if (!item) throw new NotFoundError("Package is not on this transfer's manifest");
  if (item.itemStatus !== "LOADED") {
    throw new ConflictError(`Package line is ${item.itemStatus} — only LOADED packages can be unloaded`);
  }
  await prisma.$transaction(async (tx) => {
    await tx.transferScan.create({
      data: {
        transferItemId: item.id,
        scanType: "UNLOAD",
        warehouseId: transfer.originWarehouseId,
        scannedById: actor.userId,
        idempotencyKey: `unload-${transferId}-${item.packageId}-${Date.now()}`,
        notes: "Load reversed before dispatch — parcel returned to origin stock",
      },
    });
    await tx.transferItem.update({
      where: { id: item.id },
      data: { itemStatus: "EXPECTED" },
    });
  });
  await auditOps(actor, "transfer.load_reversed", "Transfer", transferId, {
    warehouseId: transfer.originWarehouseId,
    after: { packageId: item.packageId, trackingId: item.package.trackingId },
  });
  const items = await prisma.transferItem.findMany({
    where: { transferId },
    select: { itemStatus: true },
  });
  const loaded = items.filter((i) => i.itemStatus === "LOADED").length;
  return {
    trackingId: item.package.trackingId,
    alreadyScanned: false,
    loadedCount: loaded,
    totalCount: items.length,
    allLoaded: loaded === items.length,
  };
}

export async function dispatchTransfer(
  actor: ActorContext,
  transferId: string,
): Promise<TransferView> {
  await requirePermAudited(actor, "transfer.dispatch", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  await assertWarehouseScope(actor, transfer.originWarehouseId, "Transfer", transferId);
  if (transfer.status !== "READY_FOR_DISPATCH") {
    throw new ConflictError(`Only a READY_FOR_DISPATCH transfer can be dispatched (current: ${transfer.status})`);
  }
  if (!transfer.manifest) {
    throw new DomainValidationError("No manifest — generate the manifest before dispatch");
  }
  if (!transfer.driverId || !transfer.vehicleId || !transfer.tripId) {
    throw new DomainValidationError("Assign a driver and vehicle before dispatch");
  }

  await prisma.$transaction(async (tx) => {
    // Recount from item rows inside the transaction (P4-1): a
    // partial load can NEVER dispatch silently.
    const items = await tx.transferItem.findMany({
      where: { transferId },
      include: { package: { select: { trackingId: true } } },
    });
    const unscanned = items.filter((i) => i.itemStatus !== "LOADED");
    if (unscanned.length > 0) {
      throw new ConflictError(
        `Cannot dispatch: ${unscanned.length} manifested package(s) have not been load-scanned: ${unscanned.map((i) => i.package.trackingId).join(", ")}. Load them, or remove them from the transfer first.`,
      );
    }

    // Crew re-check at the gate: assignment state may have changed
    // since the crew was picked.
    const driver = await tx.driver.findUniqueOrThrow({
      where: { id: transfer.driverId! },
      include: {
        user: {
          include: { roles: { include: { role: { select: { code: true } } } } },
        },
        capabilities: true,
      },
    });
    const driverBlockers = await driverAssignmentBlockers(tx, driver, transferId);
    if (driverBlockers.length > 0) {
      throw new DomainValidationError(`Driver can no longer take this trip: ${driverBlockers.join("; ")}`);
    }
    const vehicle = await tx.vehicle.findUniqueOrThrow({
      where: { id: transfer.vehicleId! },
    });
    const vehicleBlockers = vehicleAssignmentBlockers(vehicle);
    if (vehicleBlockers.length > 0) {
      throw new DomainValidationError(`Vehicle can no longer take this trip: ${vehicleBlockers.join("; ")}`);
    }
    const otherVehicleTrip = await tx.trip.findFirst({
      where: {
        vehicleId: vehicle.id,
        status: { in: [...ACTIVE_TRIP_STATUSES] },
        NOT: { transferId },
      },
      select: { tripNumber: true },
    });
    if (otherVehicleTrip) {
      throw new DomainValidationError(
        `Vehicle is already assigned to active trip ${otherVehicleTrip.tripNumber}`,
      );
    }
    const manifest = await tx.transferManifest.findUniqueOrThrow({
      where: { transferId },
    });
    if (vehicle.capacityKg && vehicle.capacityKg.lessThan(manifest.totalWeightKg)) {
      throw new DomainValidationError(
        `Vehicle capacity ${vehicle.capacityKg.toString()} kg is below the manifest weight ${manifest.totalWeightKg.toString()} kg`,
      );
    }

    const now = new Date();
    for (const item of items) {
      const record = await tx.inventoryRecord.findFirst({
        where: { packageId: item.packageId, releasedAt: null },
      });
      if (!record || record.warehouseId !== transfer.originWarehouseId) {
        throw new ConflictError(
          `Package ${item.package.trackingId} is not in stock at the origin warehouse — dispatch halted`,
        );
      }
      const transitioned = await transitionPackageInTx(
        tx,
        actor,
        item.packageId,
        "DISPATCHED",
        {
          warehouseId: transfer.originWarehouseId,
          transferId,
          tripId: transfer.tripId,
          notes: `Dispatched on transfer ${transfer.transferNumber} (${transfer.originWarehouse.code} → ${transfer.destinationWarehouse.code})`,
        },
      );
      if (!transitioned.transitioned || !transitioned.eventId) {
        throw new ConflictError(
          `Package ${item.package.trackingId} changed state while dispatch was running — reload and retry`,
        );
      }
      await tx.inventoryRecord.update({
        where: { id: record.id },
        data: {
          releasedAt: now,
          releasedById: actor.userId,
          releaseReason: "DISPATCH",
        },
      });
      await tx.inventoryMovement.create({
        data: {
          packageId: item.packageId,
          inventoryRecordId: record.id,
          type: "DISPATCH",
          fromWarehouseId: transfer.originWarehouseId,
          fromLocationId: record.storageLocationId,
          actorId: actor.userId,
          reason: `Dispatched on ${transfer.transferNumber}`,
          trackingEventId: transitioned.eventId,
        },
      });
      // Custody: origin warehouse → the trip's assigned driver
      // (P4-2: the driver comes from the transfer's assignment,
      // never from request input).
      await tx.packageCustody.updateMany({
        where: { packageId: item.packageId, endedAt: null },
        data: { endedAt: now },
      });
      await tx.packageCustody.create({
        data: {
          packageId: item.packageId,
          custodianType: "USER",
          custodianUserId: driver.userId,
          trackingEventId: transitioned.eventId,
        },
      });
      // Phase 7: a travelling return on this package departs with
      // the transfer (RECEIVED → IN_TRANSIT); no-op otherwise.
      await advanceReturnOnDispatchInTx(tx, actor, {
        packageId: item.packageId,
        transferId,
        originWarehouseId: transfer.originWarehouseId,
      });
    }

    const claimed = await tx.transfer.updateMany({
      where: { id: transferId, status: "READY_FOR_DISPATCH", version: transfer.version },
      data: {
        status: "DISPATCHED",
        dispatchedAt: now,
        dispatchSupervisorId: actor.userId,
        version: { increment: 1 },
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictError("The transfer changed while dispatch was running — reload and retry");
    }
    await tx.trip.update({
      where: { id: transfer.tripId! },
      data: { status: "DISPATCHED" },
    });
    await tx.vehicle.update({
      where: { id: vehicle.id },
      data: { status: "ON_TRIP" },
    });
    await tx.driver.update({
      where: { id: driver.id },
      data: { availabilityStatus: "ON_TRIP", currentTripId: transfer.tripId },
    });
  });

  await auditOps(actor, "transfer.dispatched", "Transfer", transferId, {
    warehouseId: transfer.originWarehouseId,
    after: {
      packageCount: transfer.items.length,
      driverId: transfer.driverId,
      vehicleId: transfer.vehicleId,
    },
  });
  return toTransferView(await loadTransferOr404(transferId));
}

// ---------------------------------------------------------------------------
// Cancellation (pre-dispatch, pre-load only)
// ---------------------------------------------------------------------------

export async function cancelTransfer(
  actor: ActorContext,
  transferId: string,
  reason?: string | null,
): Promise<TransferView> {
  await requirePermAudited(actor, "transfer.create", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  await assertWarehouseScope(actor, transfer.originWarehouseId, "Transfer", transferId);
  if (!TRANSFER_CANCELLABLE_STATUSES.includes(transfer.status)) {
    throw new ConflictError(`A transfer in ${transfer.status} cannot be cancelled`);
  }
  const loadScans = await prisma.transferScan.count({
    where: {
      scanType: "LOAD",
      transferItem: { transferId, itemStatus: "LOADED" },
    },
  });
  if (loadScans > 0) {
    throw new ConflictError(
      "Packages are loaded on this transfer — reverse the loads (unload scans) before cancelling; a loaded transfer is never silently cancelled",
    );
  }

  let releasedCount = transfer.items.length;
  await prisma.$transaction(async (tx) => {
    // P5-5: re-validate from the locked transfer row — the status
    // gate, the loaded-scan count and the item list above are
    // pre-transaction snapshots a concurrent load/dispatch can
    // overtake (cancelling then would release packages that are in
    // fact loaded, or free a driver who has since departed).
    const lockedStatus = await lockTransferRow(tx, transferId);
    if (!TRANSFER_CANCELLABLE_STATUSES.includes(lockedStatus)) {
      throw new ConflictError(`A transfer in ${lockedStatus} cannot be cancelled`);
    }
    const freshTransfer = await tx.transfer.findUniqueOrThrow({
      where: { id: transferId },
      select: { driverId: true, tripId: true, transferNumber: true },
    });
    const freshLoadScans = await tx.transferScan.count({
      where: {
        scanType: "LOAD",
        transferItem: { transferId, itemStatus: "LOADED" },
      },
    });
    if (freshLoadScans > 0) {
      throw new ConflictError(
        "Packages are loaded on this transfer — reverse the loads (unload scans) before cancelling; a loaded transfer is never silently cancelled",
      );
    }
    const freshItems = await tx.transferItem.findMany({
      where: { transferId },
      include: { package: { select: { operationalStatus: true } } },
    });
    releasedCount = freshItems.length;
    for (const item of freshItems) {
      if (item.package.operationalStatus === "TRANSFER_ASSIGNED") {
        await transitionPackageInTx(tx, actor, item.packageId, "READY_FOR_DISPATCH", {
          warehouseId: transfer.originWarehouseId,
          transferId,
          notes: `Transfer ${freshTransfer.transferNumber} cancelled — package released back to origin stock`,
        });
      }
      // Phase 7: a cancelled travelling return unlinks (still
      // RECEIVED at the origin); no-op for normal cargo.
      await unlinkReturnFromTransferInTx(tx, { packageId: item.packageId, transferId });
    }
    if (freshTransfer.tripId) {
      await tx.trip.update({
        where: { id: freshTransfer.tripId },
        data: { status: "CANCELLED" },
      });
      await endTrackingSessionsInTx(
        tx,
        { tripId: freshTransfer.tripId },
        "ASSIGNMENT_CANCELLED",
      );
    }
    if (freshTransfer.driverId) {
      const driver = await tx.driver.findUnique({
        where: { id: freshTransfer.driverId },
        select: { availabilityStatus: true, currentTripId: true },
      });
      if (driver?.availabilityStatus === "ASSIGNED" && !driver.currentTripId) {
        await tx.driver.update({
          where: { id: freshTransfer.driverId },
          data: { availabilityStatus: "AVAILABLE" },
        });
      }
    }
    await tx.transfer.update({
      where: { id: transferId },
      data: { status: "CANCELLED" },
    });
  });

  await auditOps(actor, "transfer.cancelled", "Transfer", transferId, {
    warehouseId: transfer.originWarehouseId,
    after: { reason: reason ?? null, releasedPackages: releasedCount },
  });
  return toTransferView(await loadTransferOr404(transferId));
}

// ---------------------------------------------------------------------------
// Destination receiving + reconciliation
// ---------------------------------------------------------------------------

const RECEIVING_WINDOW_STATUSES: readonly string[] = [
  "ARRIVED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "RECONCILIATION_PENDING",
  "EXCEPTION",
];

/** Recount receiving progress from item rows and roll the transfer
 *  status forward (P4-1: derived, never a maintained counter). Only
 *  runs inside the receiving window; terminal states are untouched. */
async function applyReceivingRollup(
  tx: Prisma.TransactionClient,
  transferId: string,
): Promise<void> {
  const transfer = await tx.transfer.findUniqueOrThrow({
    where: { id: transferId },
    select: { status: true },
  });
  if (!RECEIVING_WINDOW_STATUSES.includes(transfer.status)) return;
  const items = await tx.transferItem.findMany({
    where: { transferId },
    select: { itemStatus: true },
  });
  if (items.length === 0) return;
  const accounted = items.filter((i) =>
    ACCOUNTED_ITEM_STATUSES.includes(i.itemStatus),
  ).length;
  let next: string;
  if (accounted === items.length) next = "RECEIVED";
  else if (accounted > 0) next = "PARTIALLY_RECEIVED";
  else {
    const anyScanned = await tx.transferItem.findFirst({
      where: {
        transferId,
        package: { operationalStatus: { in: ["RECEIVING_INSPECTION", "RECEIVED_AT_DESTINATION"] } },
      },
      select: { id: true },
    });
    next = anyScanned ? "PARTIALLY_RECEIVED" : "ARRIVED";
  }
  if (next !== transfer.status) {
    await tx.transfer.update({ where: { id: transferId }, data: { status: next } });
  }
}

export const destinationScanSchema = z.object({
  trackingId: z.string().min(1).max(40),
  idempotencyKey: z.string().min(1).max(120).optional().nullable(),
  source: z.enum(TRACKING_SOURCES).default("WEB"),
  capacityOverrideReason: z.string().min(3).max(500).optional().nullable(),
});
export type DestinationScanInput = z.input<typeof destinationScanSchema>;

export interface DestinationScanResult {
  kind: "RECEIVED_SCAN" | "EXCESS" | "WRONG_PACKAGE";
  trackingId: string;
  alreadyReceived: boolean;
  package: OpsPackageSummary | null;
}

export async function scanDestinationPackage(
  actor: ActorContext,
  transferId: string,
  input: DestinationScanInput,
): Promise<DestinationScanResult> {
  const data = parse(destinationScanSchema, input);
  await requirePermAudited(actor, "transfer.receive", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  await assertWarehouseScope(actor, transfer.destinationWarehouseId, "Transfer", transferId);

  if (["DISPATCHED", "IN_TRANSIT"].includes(transfer.status)) {
    throw new DomainValidationError(
      "The trip has not arrived yet — destination receiving opens when the driver records arrival",
    );
  }
  if (!RECEIVING_WINDOW_STATUSES.includes(transfer.status)) {
    throw new ConflictError(`Transfer is ${transfer.status} — destination receiving is closed`);
  }

  const pkg = await prisma.package.findUnique({
    where: { trackingId: data.trackingId.trim() },
    include: {
      shipment: { select: { originWarehouseId: true, destinationWarehouseId: true } },
    },
  });
  if (!pkg) {
    await auditOps(actor, "package.scan_unknown", "Package", null, {
      warehouseId: transfer.destinationWarehouseId,
      after: { trackingId: data.trackingId, transferId },
    });
    throw new NotFoundError(`No package found with tracking ID ${data.trackingId}`);
  }
  const summary: OpsPackageSummary = {
    id: pkg.id,
    trackingId: pkg.trackingId,
    operationalStatus: pkg.operationalStatus,
    condition: pkg.condition,
    exceptionStatus: pkg.exceptionStatus,
    recipientName: pkg.recipientName,
    deliveryDistrict: pkg.deliveryDistrict,
    declaredWeightKg: pkg.declaredWeightKg.toString(),
    actualWeightKg: pkg.actualWeightKg?.toString() ?? null,
    billableWeightKg: pkg.billableWeightKg?.toString() ?? null,
  };

  const item = transfer.items.find((i) => i.packageId === pkg.id);

  // -- Not on this manifest: excess / wrong-package observation -------
  if (!item) {
    if (pkg.shipment.destinationWarehouseId !== transfer.destinationWarehouseId) {
      // Wrong warehouse (Scenario 2): the arrival is observed and the
      // parcel flagged MISROUTED — it is NEVER stocked here.
      //
      // P5-4: the flag is raised ONLY when the package's state is
      // consistent with a physical arrival: dispatched / in transit /
      // arrived, holding an open item on an arrived transfer, or
      // received into warehouse stock (an open InventoryRecord — e.g.
      // a READY_FOR_DISPATCH parcel sitting in origin stock is a
      // physical parcel in the network, and a scan at the wrong
      // warehouse is a genuine misroute). A parcel still BOOKED at
      // origin has never been received anywhere — no stock record
      // exists — so a scan of its tracking ID is observed and
      // returned WITHOUT mutating it: previously any insider who
      // knew a tracking ID could brand any package MISROUTED, and
      // every repeat scan stacked another permanent EXCEPTION_RAISED
      // event + audit row. Repeat scans from a warehouse that
      // already recorded the flag likewise write nothing further
      // (P4-4 dedupe).
      const arrivalPlausible =
        ["DISPATCHED", "IN_TRANSIT", "ARRIVED_AT_DESTINATION"].includes(
          pkg.operationalStatus,
        ) ||
        (await prisma.transferItem.findFirst({
          where: {
            packageId: pkg.id,
            transfer: {
              status: {
                in: ["DISPATCHED", "IN_TRANSIT", ...RECEIVING_WINDOW_STATUSES],
              },
            },
          },
          select: { id: true },
        })) != null ||
        (await prisma.inventoryRecord.findFirst({
          where: { packageId: pkg.id, releasedAt: null },
          select: { id: true },
        })) != null;
      if (!arrivalPlausible) {
        return { kind: "WRONG_PACKAGE", trackingId: pkg.trackingId, alreadyReceived: false, package: summary };
      }
      const alreadyFlaggedHere =
        pkg.exceptionStatus === "MISROUTED" &&
        (await prisma.trackingEvent.findFirst({
          where: {
            packageId: pkg.id,
            eventType: "EXCEPTION_RAISED",
            warehouseId: transfer.destinationWarehouseId,
          },
          select: { id: true },
        })) != null;
      if (alreadyFlaggedHere) {
        return { kind: "WRONG_PACKAGE", trackingId: pkg.trackingId, alreadyReceived: false, package: summary };
      }
      await prisma.$transaction(async (tx) => {
        await tx.package.update({
          where: { id: pkg.id },
          data: { exceptionStatus: "MISROUTED" },
        });
        await tx.trackingEvent.create({
          data: {
            packageId: pkg.id,
            shipmentId: pkg.shipmentId,
            orderId: pkg.orderId,
            subjectType: "PACKAGE",
            eventType: "EXCEPTION_RAISED",
            previousStatus: pkg.operationalStatus,
            newStatus: pkg.operationalStatus,
            actorId: actor.userId,
            actorRole: actor.primaryRole,
            warehouseId: transfer.destinationWarehouseId,
            source: data.source,
            transferId,
            notes: `Wrong-warehouse arrival observed during receiving of ${transfer.transferNumber}: this parcel is destined for another warehouse. It has NOT been stocked here.`,
          },
        });
        // Phase 8 link point: the misroute raises a WRONG_WAREHOUSE
        // incident (idempotent per package + warehouse via
        // sourceKey — repeat scans here already returned early
        // above). Resolving the incident can clear the MISROUTED
        // flag through the package lifecycle service.
        await raiseIncidentInTx(tx, {
          sourceKey: `misrouted:${pkg.id}:${transfer.destinationWarehouseId}`,
          category: "WRONG_WAREHOUSE",
          description:
            `Package ${pkg.trackingId} arrived at the wrong warehouse during receiving of ` +
            `${transfer.transferNumber}; it is destined for another warehouse and was not stocked here.`,
          reporterId: actor.userId,
          warehouseId: transfer.destinationWarehouseId,
          packageId: pkg.id,
          transferId,
        });
      });
      await auditOps(actor, "transfer.wrong_package_scan", "Transfer", transferId, {
        warehouseId: transfer.destinationWarehouseId,
        after: { packageId: pkg.id, trackingId: pkg.trackingId },
      });
      return { kind: "WRONG_PACKAGE", trackingId: pkg.trackingId, alreadyReceived: false, package: summary };
    }
    // Destined here but not manifested on this transfer: an excess
    // arrival. Recorded as an observation + audit — the parcel joins
    // stock only through its own flow, never by this scan.
    await prisma.$transaction(async (tx) => {
      await tx.trackingEvent.create({
        data: {
          packageId: pkg.id,
          shipmentId: pkg.shipmentId,
          orderId: pkg.orderId,
          subjectType: "PACKAGE",
          eventType: "EXCEPTION_RAISED",
          previousStatus: pkg.operationalStatus,
          newStatus: pkg.operationalStatus,
          actorId: actor.userId,
          actorRole: actor.primaryRole,
          warehouseId: transfer.destinationWarehouseId,
          source: data.source,
          transferId,
          notes: `Excess arrival during receiving of ${transfer.transferNumber}: parcel is destined for this warehouse but is not on the transfer manifest. It was NOT stocked by this scan.`,
        },
      });
      // Phase 8 link point: an excess arrival raises one
      // TRANSFER_EXCESS incident per (transfer, package) — the
      // sourceKey keeps repeat scans from stacking duplicates.
      await raiseIncidentInTx(tx, {
        sourceKey: `transfer-excess:${transferId}:${pkg.id}`,
        category: "TRANSFER_EXCESS",
        description:
          `Package ${pkg.trackingId} arrived with transfer ${transfer.transferNumber} but is not on its manifest. ` +
          "It was not stocked by this scan.",
        reporterId: actor.userId,
        warehouseId: transfer.destinationWarehouseId,
        packageId: pkg.id,
        transferId,
      });
    });
    await auditOps(actor, "transfer.excess_scan", "Transfer", transferId, {
      warehouseId: transfer.destinationWarehouseId,
      after: { packageId: pkg.id, trackingId: pkg.trackingId },
    });
    return { kind: "EXCESS", trackingId: pkg.trackingId, alreadyReceived: false, package: summary };
  }

  // -- On the manifest -------------------------------------------------
  if (ACCOUNTED_ITEM_STATUSES.includes(item.itemStatus)) {
    return { kind: "RECEIVED_SCAN", trackingId: pkg.trackingId, alreadyReceived: true, package: summary };
  }
  const scanKey = data.idempotencyKey ?? `unload-${transferId}-${item.packageId}`;
  const priorScan = await prisma.transferScan.findUnique({
    where: { idempotencyKey: scanKey },
  });
  if (priorScan) {
    if (priorScan.transferItemId !== item.id) {
      throw new ConflictError("This scan key was already used for a different package");
    }
    return { kind: "RECEIVED_SCAN", trackingId: pkg.trackingId, alreadyReceived: true, package: summary };
  }
  if (pkg.operationalStatus === "RECEIVING_INSPECTION" || pkg.operationalStatus === "RECEIVED_AT_DESTINATION") {
    // Duplicate scan with a fresh key (Scenario 7): already in the
    // destination's receiving flow — return, write nothing.
    return { kind: "RECEIVED_SCAN", trackingId: pkg.trackingId, alreadyReceived: true, package: summary };
  }
  if (pkg.operationalStatus !== "ARRIVED_AT_DESTINATION") {
    throw new ConflictError(
      `Package is ${pkg.operationalStatus} — it cannot be received on this transfer`,
    );
  }

  // Destination capacity gate (workflow §8): at full capacity the
  // scan is refused unless an unscoped actor records an override;
  // the parcel stays in the driver's custody.
  const capacity = await computeWarehouseCapacity(transfer.destinationWarehouseId);
  let capacityOverrideUsed = false;
  if (capacity.configured && capacity.occupancy >= capacity.capacity) {
    if (isUnscoped(actor) && data.capacityOverrideReason) {
      capacityOverrideUsed = true;
    } else {
      await auditOps(actor, "transfer.receive_capacity_blocked", "Transfer", transferId, {
        warehouseId: transfer.destinationWarehouseId,
        after: { packageId: pkg.id, occupancy: capacity.occupancy, capacity: capacity.capacity },
      });
      throw new DomainValidationError(
        `Destination warehouse is at full package capacity (${capacity.occupancy}/${capacity.capacity}) — receiving is blocked`,
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    const transitioned = await transitionPackageInTx(
      tx,
      actor,
      pkg.id,
      "RECEIVING_INSPECTION",
      {
        warehouseId: transfer.destinationWarehouseId,
        transferId,
        tripId: transfer.tripId,
        idempotencyKey: data.idempotencyKey ?? null,
        source: data.source,
        notes: `Destination receiving scan on transfer ${transfer.transferNumber}`,
      },
    );
    if (!transitioned.transitioned || !transitioned.eventId) {
      return; // idempotent replay — the winner's rows already exist
    }
    const now = new Date();
    await tx.packageCustody.updateMany({
      where: { packageId: pkg.id, endedAt: null },
      data: { endedAt: now },
    });
    // Phase 7: a travelling return is received into the destination's
    // RETURNS zone (return-workflow §3 step 6), falling back to the
    // RECEIVING zone when the destination has no Returns location.
    const travellingReturn = await tx.returnRequest.findFirst({
      where: { packageId: pkg.id, transferId, status: "IN_TRANSIT" },
      select: { id: true },
    });
    let locationId = await firstActiveLocationInZoneKind(
      tx,
      transfer.destinationWarehouseId,
      travellingReturn ? "RETURNS" : "RECEIVING",
    );
    if (travellingReturn && !locationId) {
      locationId = await firstActiveLocationInZoneKind(
        tx,
        transfer.destinationWarehouseId,
        "RECEIVING",
      );
    }
    const record = await tx.inventoryRecord.create({
      data: {
        packageId: pkg.id,
        warehouseId: transfer.destinationWarehouseId,
        storageLocationId: locationId,
        receivingEventId: transitioned.eventId,
        receivedById: actor.userId,
        conditionOnArrival: pkg.condition,
      },
    });
    await tx.packageCustody.create({
      data: {
        packageId: pkg.id,
        custodianType: "WAREHOUSE",
        warehouseId: transfer.destinationWarehouseId,
        storageLocationId: locationId,
        trackingEventId: transitioned.eventId,
      },
    });
    await tx.inventoryMovement.create({
      data: {
        packageId: pkg.id,
        inventoryRecordId: record.id,
        type: "TRANSFER_IN",
        fromWarehouseId: transfer.originWarehouseId,
        toWarehouseId: transfer.destinationWarehouseId,
        toLocationId: locationId,
        actorId: actor.userId,
        reason: `Received on transfer ${transfer.transferNumber}`,
        trackingEventId: transitioned.eventId,
      },
    });
    await tx.transferScan.create({
      data: {
        transferItemId: item.id,
        scanType: "UNLOAD",
        warehouseId: transfer.destinationWarehouseId,
        scannedById: actor.userId,
        idempotencyKey: scanKey,
      },
    });
    if (pkg.exceptionStatus === "MISSING") {
      // A package declared missing has been found: the flag clears
      // with the receiving scan as the evidence.
      await tx.package.update({
        where: { id: pkg.id },
        data: { exceptionStatus: "NONE" },
      });
    }
    await applyReceivingRollup(tx, transferId);
  });

  await auditOps(actor, "transfer.package_received_scan", "Transfer", transferId, {
    warehouseId: transfer.destinationWarehouseId,
    after: { packageId: pkg.id, trackingId: pkg.trackingId, capacityOverrideUsed },
  });
  const fresh = await prisma.package.findUniqueOrThrow({ where: { id: pkg.id } });
  return {
    kind: "RECEIVED_SCAN",
    trackingId: pkg.trackingId,
    alreadyReceived: false,
    package: { ...summary, operationalStatus: fresh.operationalStatus, exceptionStatus: fresh.exceptionStatus },
  };
}

export const completeReceivingSchema = z.object({
  packageId: z.string().uuid(),
  condition: z.enum(PACKAGE_CONDITIONS).default("GOOD"),
  notes: z.string().max(1000).optional().nullable(),
});
export type CompleteReceivingInput = z.input<typeof completeReceivingSchema>;

/** Complete one package's destination receiving: condition is
 *  recorded (damage follows the Phase 4 quarantine mechanics) and the
 *  package transitions to RECEIVED_AT_DESTINATION — the lifecycle
 *  rule T5 gate: a package the destination never scanned can never
 *  reach this state. */
export async function completePackageReceiving(
  actor: ActorContext,
  transferId: string,
  input: CompleteReceivingInput,
): Promise<TransferView> {
  const data = parse(completeReceivingSchema, input);
  await requirePermAudited(actor, "transfer.receive", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  await assertWarehouseScope(actor, transfer.destinationWarehouseId, "Transfer", transferId);
  const item = transfer.items.find((i) => i.packageId === data.packageId);
  if (!item) throw new NotFoundError("Package is not on this transfer");
  if (ACCOUNTED_ITEM_STATUSES.includes(item.itemStatus)) {
    throw new ConflictError(`This package's receiving is already complete (${item.itemStatus})`);
  }

  await prisma.$transaction(async (tx) => {
    const pkg = await tx.package.findUniqueOrThrow({
      where: { id: data.packageId },
      select: { operationalStatus: true, exceptionStatus: true },
    });
    if (pkg.operationalStatus !== "RECEIVING_INSPECTION") {
      throw new ConflictError(
        `Package is ${pkg.operationalStatus} — scan it at the destination before completing its receiving`,
      );
    }
    const record = await tx.inventoryRecord.findFirst({
      where: { packageId: data.packageId, releasedAt: null },
      select: { id: true, warehouseId: true, storageLocationId: true },
    });
    if (!record || record.warehouseId !== transfer.destinationWarehouseId) {
      throw new ConflictError("Package has no open inventory record at the destination warehouse");
    }
    const damaged = data.condition === "DAMAGED";
    const transitioned = await transitionPackageInTx(
      tx,
      actor,
      data.packageId,
      "RECEIVED_AT_DESTINATION",
      {
        warehouseId: transfer.destinationWarehouseId,
        transferId,
        tripId: transfer.tripId,
        notes: data.notes ?? `Destination receiving complete: condition ${data.condition}`,
      },
    );
    await tx.package.update({
      where: { id: data.packageId },
      data: {
        condition: data.condition,
        // P5-3: a package that was branded MISSING (e.g. by an early
        // finishReceiving) but has in fact been scanned and received
        // clears the flag on completion — mirroring the scan path.
        // Without this the flag outlived the receiving it denied,
        // because a rescan short-circuits as already-received.
        ...(damaged
          ? { exceptionStatus: "DAMAGED" }
          : pkg.exceptionStatus === "MISSING"
            ? { exceptionStatus: "NONE" }
            : {}),
      },
    });
    if (damaged) {
      // Phase 4 damage mechanics: quarantine to the DAMAGED zone.
      const damagedLocationId = await firstActiveLocationInZoneKind(
        tx,
        transfer.destinationWarehouseId,
        "DAMAGED",
      );
      if (damagedLocationId && damagedLocationId !== record.storageLocationId) {
        await tx.inventoryMovement.create({
          data: {
            packageId: data.packageId,
            inventoryRecordId: record.id,
            type: "DAMAGE_QUARANTINE",
            fromWarehouseId: transfer.destinationWarehouseId,
            toWarehouseId: transfer.destinationWarehouseId,
            fromLocationId: record.storageLocationId,
            toLocationId: damagedLocationId,
            actorId: actor.userId,
            reason: "Damaged on arrival — moved to quarantine",
            trackingEventId: transitioned.eventId,
          },
        });
        await tx.inventoryRecord.update({
          where: { id: record.id },
          data: { storageLocationId: damagedLocationId },
        });
      }
    }
    await tx.transferItem.update({
      where: { id: item.id },
      data: {
        itemStatus: damaged ? "DAMAGED" : "RECEIVED",
        receivedCondition: data.condition,
        receivedById: actor.userId,
        receivedAt: new Date(),
        ...(data.notes ? { discrepancyNote: data.notes } : {}),
      },
    });
    // Phase 7: a travelling return on this package has arrived at
    // its return warehouse (IN_TRANSIT → RECEIVED, first-receipt
    // stamps preserved); no-op for normal cargo.
    await advanceReturnOnReceiveInTx(tx, actor, {
      packageId: data.packageId,
      transferId,
      destinationWarehouseId: transfer.destinationWarehouseId,
    });
    await applyReceivingRollup(tx, transferId);
  });

  await auditOps(actor, "transfer.package_receiving_completed", "Transfer", transferId, {
    warehouseId: transfer.destinationWarehouseId,
    after: { packageId: data.packageId, condition: data.condition },
  });
  return toTransferView(await loadTransferOr404(transferId));
}

/** Declare unloading finished. Items whose packages were never
 *  unload-scanned are marked MISSING (those packages stay in the
 *  driver's custody with a MISSING exception — the Phase 8 incident
 *  link point, exactly like Phase 4's disputed handovers);
 *  scanned-but-incomplete items are left completable and unbranded
 *  (P5-3). The trip completes: the transfer, not the trip, carries
 *  the open shortage. */
export async function finishReceiving(
  actor: ActorContext,
  transferId: string,
): Promise<TransferView> {
  await requirePermAudited(actor, "transfer.receive", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  await assertWarehouseScope(actor, transfer.destinationWarehouseId, "Transfer", transferId);
  if (!RECEIVING_WINDOW_STATUSES.includes(transfer.status)) {
    throw new ConflictError(`Receiving cannot be finished while the transfer is ${transfer.status}`);
  }

  const missingTrackingIds: string[] = [];
  await prisma.$transaction(async (tx) => {
    const items = await tx.transferItem.findMany({
      where: { transferId },
      include: {
        package: {
          select: { trackingId: true, shipmentId: true, orderId: true, operationalStatus: true, exceptionStatus: true },
        },
      },
    });
    for (const item of items) {
      if (ACCOUNTED_ITEM_STATUSES.includes(item.itemStatus)) continue;
      // P5-3: only a package that was NEVER unload-scanned is
      // missing. A scanned package sits in RECEIVING_INSPECTION at
      // the destination, in the warehouse's custody, with an open
      // inventory record — branding it MISSING wrote a false
      // "remains in the driver's custody" exception onto its history
      // and the flag could never be cleared afterwards. Scanned-but-
      // incomplete items stay unaccounted (reconciliation still
      // blocks) but completable, without the false branding.
      const neverScanned = ["IN_TRANSIT", "ARRIVED_AT_DESTINATION"].includes(
        item.package.operationalStatus,
      );
      if (!neverScanned) continue;
      missingTrackingIds.push(item.package.trackingId);
      if (item.itemStatus !== "MISSING") {
        await tx.transferItem.update({
          where: { id: item.id },
          data: {
            itemStatus: "MISSING",
            discrepancyNote: "Not received when destination unloading was finished",
          },
        });
        if (item.package.exceptionStatus === "NONE") {
          await tx.package.update({
            where: { id: item.packageId },
            data: { exceptionStatus: "MISSING" },
          });
        }
        await tx.trackingEvent.create({
          data: {
            packageId: item.packageId,
            shipmentId: item.package.shipmentId,
            orderId: item.package.orderId,
            subjectType: "PACKAGE",
            eventType: "EXCEPTION_RAISED",
            previousStatus: item.package.operationalStatus,
            newStatus: item.package.operationalStatus,
            actorId: actor.userId,
            actorRole: actor.primaryRole,
            warehouseId: transfer.destinationWarehouseId,
            source: "WEB",
            transferId,
            tripId: transfer.tripId,
            notes: `Package was manifested on ${transfer.transferNumber} but not received at the destination when unloading finished. It remains in the line-haul driver's custody pending investigation (transfer_shortage).`,
          },
        });
        // Phase 8 link point: the shortage raises a
        // TRANSFER_SHORTAGE incident and the item links to it
        // (TransferItem.incidentId). Idempotent per item via
        // sourceKey — this block only runs on the transition into
        // MISSING, and a retry collides on the key instead of
        // duplicating.
        const raised = await raiseIncidentInTx(tx, {
          sourceKey: `transfer-item-missing:${item.id}`,
          category: "TRANSFER_SHORTAGE",
          description:
            `Package ${item.package.trackingId} was manifested on ${transfer.transferNumber} but not received ` +
            "at the destination when unloading finished. It remains in the line-haul driver's custody pending investigation.",
          reporterId: actor.userId,
          warehouseId: transfer.destinationWarehouseId,
          packageId: item.packageId,
          transferId,
          tripId: transfer.tripId,
        });
        await tx.transferItem.update({
          where: { id: item.id },
          data: { incidentId: raised.incidentId },
        });
      }
    }
    await tx.transfer.update({
      where: { id: transferId },
      data: { status: "RECONCILIATION_PENDING" },
    });
    // The trip ends here (driver-workflow.md §5): what arrived is
    // received; the shortage lives on the transfer.
    if (transfer.tripId) {
      const trip = await tx.trip.findUnique({ where: { id: transfer.tripId } });
      if (trip && trip.status !== "COMPLETED" && trip.status !== "CANCELLED") {
        await tx.trip.update({ where: { id: trip.id }, data: { status: "COMPLETED" } });
        await endTrackingSessionsInTx(tx, { tripId: trip.id }, "ASSIGNMENT_COMPLETED");
        const vehicle = await tx.vehicle.findUnique({ where: { id: trip.vehicleId } });
        if (vehicle?.status === "ON_TRIP") {
          await tx.vehicle.update({ where: { id: vehicle.id }, data: { status: "AVAILABLE" } });
        }
        const driver = await tx.driver.findUnique({ where: { id: trip.driverId } });
        if (driver?.currentTripId === trip.id) {
          await tx.driver.update({
            where: { id: driver.id },
            data: {
              currentTripId: null,
              ...(driver.availabilityStatus === "ON_TRIP"
                ? { availabilityStatus: "AVAILABLE" }
                : {}),
            },
          });
        }
      }
    }
  });

  await auditOps(actor, "transfer.receiving_finished", "Transfer", transferId, {
    warehouseId: transfer.destinationWarehouseId,
    after: { missingTrackingIds },
  });
  return toTransferView(await loadTransferOr404(transferId));
}

export async function reconcileTransfer(
  actor: ActorContext,
  transferId: string,
): Promise<TransferView> {
  await requirePermAudited(actor, "transfer.reconcile", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  // Footnote 21: the DESTINATION warehouse reconciles; the origin
  // side can view but never close a transfer into another warehouse.
  await assertWarehouseScope(actor, transfer.destinationWarehouseId, "Transfer", transferId);
  if (transfer.status !== "RECONCILIATION_PENDING") {
    throw new ConflictError(
      `Reconciliation runs after receiving is finished (current: ${transfer.status}) — finish receiving first`,
    );
  }
  // P5-6: the recount and the status claim run in ONE transaction
  // over FRESH item rows. Previously the recount filtered the
  // pre-call snapshot and the RECONCILED write was an unguarded
  // update, so two concurrent reconciles both "succeeded" and wrote
  // duplicate transfer.reconciled audits. The claim below
  // (updateMany on id + status) serializes them: exactly one wins.
  const outcome = await prisma.$transaction(async (tx) => {
    const freshItems = await tx.transferItem.findMany({
      where: { transferId },
      include: { package: { select: { trackingId: true } } },
    });
    const unaccounted = freshItems.filter(
      (i) => !ACCOUNTED_ITEM_STATUSES.includes(i.itemStatus),
    );
    if (unaccounted.length > 0) {
      await tx.transfer.updateMany({
        where: { id: transferId, status: "RECONCILIATION_PENDING" },
        data: { status: "EXCEPTION" },
      });
      return {
        blocked: unaccounted.map((i) => i.package.trackingId),
        packageCount: freshItems.length,
      } as const;
    }
    const claimed = await tx.transfer.updateMany({
      where: { id: transferId, status: "RECONCILIATION_PENDING" },
      data: { status: "RECONCILED", reconciledAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new ConflictError(
        "This transfer's state changed while reconciliation was running — reload and retry",
      );
    }
    return { blocked: null, packageCount: freshItems.length } as const;
  });
  if (outcome.blocked) {
    await auditOps(actor, "transfer.reconciliation_blocked", "Transfer", transferId, {
      warehouseId: transfer.destinationWarehouseId,
      after: { unaccountedTrackingIds: outcome.blocked },
    });
    throw new ConflictError(
      `Reconciliation refused: ${outcome.blocked.length} manifested package(s) are unaccounted for: ${outcome.blocked.join(", ")}. The transfer stays open until every package is received or resolved through the loss process.`,
    );
  }
  await auditOps(actor, "transfer.reconciled", "Transfer", transferId, {
    warehouseId: transfer.destinationWarehouseId,
    after: { packageCount: outcome.packageCount },
  });
  return toTransferView(await loadTransferOr404(transferId));
}

export async function closeTransfer(
  actor: ActorContext,
  transferId: string,
): Promise<TransferView> {
  await requirePermAudited(actor, "transfer.reconcile", "Transfer");
  const transfer = await loadTransferOr404(transferId);
  await assertWarehouseScope(actor, transfer.destinationWarehouseId, "Transfer", transferId);
  if (transfer.status !== "RECONCILED") {
    throw new ConflictError(`Only a RECONCILED transfer can be closed (current: ${transfer.status})`);
  }
  await prisma.transfer.update({
    where: { id: transferId },
    data: { status: "CLOSED", closedAt: new Date() },
  });
  await auditOps(actor, "transfer.closed", "Transfer", transferId, {
    warehouseId: transfer.destinationWarehouseId,
  });
  return toTransferView(await loadTransferOr404(transferId));
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getTransfer(
  actor: ActorContext,
  transferId: string,
): Promise<TransferView> {
  if (
    !hasPermission(actor, "transfer.read_all") &&
    !hasPermission(actor, "transfer.read_warehouse") &&
    !hasPermission(actor, "trip.read_assigned")
  ) {
    await auditAccessDenied(actor, "Transfer", {
      entityId: transferId,
      reason: "missing_permission:transfer.read",
    });
    throw new AuthorizationError("Missing required permission to read transfers");
  }
  const transfer = await loadTransferOr404(transferId);
  await assertTransferReadable(actor, transfer);
  return toTransferView(transfer);
}

export interface ListTransfersQuery {
  warehouseId?: string;
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listTransfers(
  actor: ActorContext,
  query: ListTransfersQuery = {},
): Promise<{ items: TransferView[]; total: number; page: number; pageSize: number; totalPages: number }> {
  if (
    !hasPermission(actor, "transfer.read_all") &&
    !hasPermission(actor, "transfer.read_warehouse") &&
    !hasPermission(actor, "trip.read_assigned")
  ) {
    await auditAccessDenied(actor, "Transfer", {
      reason: "missing_permission:transfer.read",
    });
    throw new AuthorizationError("Missing required permission to read transfers");
  }
  if (query.warehouseId) {
    await assertWarehouseScope(actor, query.warehouseId, "Transfer");
  }

  // Scope and search compose with explicit AND (P3-1): the scope is a
  // single OR element inside the AND array, never spread-merged.
  const conditions: Prisma.TransferWhereInput[] = [];
  if (!hasPermission(actor, "transfer.read_all")) {
    const scopeOr: Prisma.TransferWhereInput[] = [
      { originWarehouseId: { in: actor.warehouseIds } },
      { destinationWarehouseId: { in: actor.warehouseIds } },
    ];
    if (actor.driverId) scopeOr.push({ driverId: actor.driverId });
    conditions.push({ OR: scopeOr });
  }
  if (query.warehouseId) {
    conditions.push({
      OR: [
        { originWarehouseId: query.warehouseId },
        { destinationWarehouseId: query.warehouseId },
      ],
    });
  }
  if (query.status) conditions.push({ status: query.status });
  const term = query.search?.trim();
  if (term) {
    conditions.push({ transferNumber: { contains: term, mode: "insensitive" } });
  }
  const where: Prisma.TransferWhereInput =
    conditions.length > 0 ? { AND: conditions } : {};

  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  const [total, rows] = await Promise.all([
    prisma.transfer.count({ where }),
    prisma.transfer.findMany({
      where,
      include: transferInclude,
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
  ]);
  return { items: rows.map(toTransferView), ...pageMeta(total, page, pageSize) };
}

/** Packages that can be selected onto a new transfer from this
 *  origin to this destination right now (workflow step 2). */
export async function listEligiblePackages(
  actor: ActorContext,
  originWarehouseId: string,
  destinationWarehouseId: string,
  search?: string,
): Promise<OpsPackageSummary[]> {
  await requirePermAudited(actor, "transfer.prepare", "Transfer");
  await assertWarehouseScope(actor, originWarehouseId, "Transfer");
  const conditions: Prisma.PackageWhereInput[] = [
    { operationalStatus: READY_FOR_DISPATCH },
    { shipment: { destinationWarehouseId } },
    {
      inventoryRecords: {
        some: { warehouseId: originWarehouseId, releasedAt: null },
      },
    },
    {
      transferItems: {
        none: { transfer: { status: { in: [...OPEN_TRANSFER_STATUSES] } } },
      },
    },
  ];
  // Phase 7 run-through fix: cross-warehouse return packages must be
  // pickable too — a RECEIVED return travels to its return destination
  // (ReturnRequest.destinationWarehouseId), not to the shipment's
  // destination, and sits at READY_FOR_DELIVERY rather than
  // READY_FOR_DISPATCH. Without this branch the returns flow is
  // service-complete but unreachable from the transfer UI.
  // addTransferItems remains the authoritative gate (the return
  // travel hook re-validates status + destination there).
  const returnConditions: Prisma.PackageWhereInput[] = [
    {
      returnRequests: {
        some: { status: "RECEIVED", destinationWarehouseId },
      },
    },
    { currentWarehouseId: originWarehouseId },
    {
      inventoryRecords: {
        some: { warehouseId: originWarehouseId, releasedAt: null },
      },
    },
    {
      transferItems: {
        none: { transfer: { status: { in: [...OPEN_TRANSFER_STATUSES] } } },
      },
    },
  ];
  const term = search?.trim();
  if (term) {
    const termCondition: Prisma.PackageWhereInput = {
      OR: [
        { trackingId: { contains: term, mode: "insensitive" } },
        { recipientName: { contains: term, mode: "insensitive" } },
      ],
    };
    conditions.push(termCondition);
    returnConditions.push(termCondition);
  }
  const rows = await prisma.package.findMany({
    where: { OR: [{ AND: conditions }, { AND: returnConditions }] },
    select: {
      id: true,
      trackingId: true,
      operationalStatus: true,
      condition: true,
      exceptionStatus: true,
      recipientName: true,
      deliveryDistrict: true,
      declaredWeightKg: true,
      actualWeightKg: true,
      billableWeightKg: true,
    },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  return rows.map((pkg) => ({
    id: pkg.id,
    trackingId: pkg.trackingId,
    operationalStatus: pkg.operationalStatus,
    condition: pkg.condition,
    exceptionStatus: pkg.exceptionStatus,
    recipientName: pkg.recipientName,
    deliveryDistrict: pkg.deliveryDistrict,
    declaredWeightKg: pkg.declaredWeightKg.toString(),
    actualWeightKg: pkg.actualWeightKg?.toString() ?? null,
    billableWeightKg: pkg.billableWeightKg?.toString() ?? null,
  }));
}

/** Directory of possible destination warehouses for the create form
 *  (all ACTIVE warehouses except the origin). Gated on transfer
 *  creation — warehouse directory data, not operational detail. */
export async function listTransferDestinations(
  actor: ActorContext,
  originWarehouseId: string,
): Promise<{ id: string; code: string; name: string; district: string }[]> {
  await requirePermAudited(actor, "transfer.create", "Transfer");
  await assertWarehouseScope(actor, originWarehouseId, "Transfer");
  const rows = await prisma.warehouse.findMany({
    where: { status: "ACTIVE", NOT: { id: originWarehouseId } },
    select: { id: true, code: true, name: true, district: true },
    orderBy: { code: "asc" },
  });
  return rows;
}
