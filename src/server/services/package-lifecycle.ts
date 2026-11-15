import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { AuthorizationError, type ActorContext } from "@/lib/auth/actor";
import { ConflictError, NotFoundError } from "@/lib/errors";
import {
  allowedTransitionsFrom,
  findTransition,
  type OperationalStatus,
} from "@/lib/bookings/lifecycle";
import { auditAccessDenied } from "@/server/services/scoping";

/**
 * THE package lifecycle service (docs/package-lifecycle.md §7): the
 * only code in the system allowed to write `Package.operationalStatus`.
 * Every change goes through the explicit transition table with the
 * operation's permission, is recorded as an append-only TrackingEvent
 * with the previous/new pair, and recomputes the shipment roll-up in
 * the same transaction. Rejected attempts are audit-logged and change
 * nothing. Optimistic locking (`version`) makes concurrent transitions
 * fail loudly instead of interleaving (rule T8).
 */

type Tx = Prisma.TransactionClient;

export interface PackageView {
  id: string;
  trackingId: string;
  shipmentId: string;
  orderId: string;
  orderNumber: string;
  recipientName: string;
  recipientPhone: string;
  recipientAltPhone: string | null;
  recipientEmail: string | null;
  recipientCustomerId: string | null;
  deliveryAddress: string;
  deliveryCity: string;
  deliveryDistrict: string;
  municipality: string | null;
  wardNumber: string | null;
  landmark: string | null;
  declaredWeightKg: string;
  actualWeightKg: string | null;
  volumetricWeightKg: string | null;
  billableWeightKg: string | null;
  declaredValuePaisa: string | null;
  description: string;
  category: string;
  isFragile: boolean;
  codAmountPaisa: string;
  currentWarehouseId: string | null;
  operationalStatus: string;
  condition: string;
  paymentStatus: string;
  deliveryStatus: string;
  exceptionStatus: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

type PackageRow = Prisma.PackageGetPayload<{
  include: { order: { select: { orderNumber: true; vendorId: true } } };
}>;

export function toPackageView(p: PackageRow): PackageView {
  return {
    id: p.id,
    trackingId: p.trackingId,
    shipmentId: p.shipmentId,
    orderId: p.orderId,
    orderNumber: p.order.orderNumber,
    recipientName: p.recipientName,
    recipientPhone: p.recipientPhone,
    recipientAltPhone: p.recipientAltPhone,
    recipientEmail: p.recipientEmail,
    recipientCustomerId: p.recipientCustomerId,
    deliveryAddress: p.deliveryAddress,
    deliveryCity: p.deliveryCity,
    deliveryDistrict: p.deliveryDistrict,
    municipality: p.municipality,
    wardNumber: p.wardNumber,
    landmark: p.landmark,
    declaredWeightKg: p.declaredWeightKg.toString(),
    actualWeightKg: p.actualWeightKg?.toString() ?? null,
    volumetricWeightKg: p.volumetricWeightKg?.toString() ?? null,
    billableWeightKg: p.billableWeightKg?.toString() ?? null,
    declaredValuePaisa: p.declaredValuePaisa?.toString() ?? null,
    description: p.description,
    category: p.category,
    isFragile: p.isFragile,
    codAmountPaisa: p.codAmountPaisa.toString(),
    currentWarehouseId: p.currentWarehouseId,
    operationalStatus: p.operationalStatus,
    condition: p.condition,
    paymentStatus: p.paymentStatus,
    deliveryStatus: p.deliveryStatus,
    exceptionStatus: p.exceptionStatus,
    version: p.version,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export const packageInclude = {
  order: { select: { orderNumber: true, vendorId: true } },
} satisfies Prisma.PackageInclude;

// ---------------------------------------------------------------------------
// Creation — the only other writer of the initial status (BOOKED), and
// only ever inside the booking transaction that creates the parcel.
// ---------------------------------------------------------------------------

export interface InitialisePackageArgs {
  trackingId: string;
  shipmentId: string;
  orderId: string;
  recipientName: string;
  recipientPhone: string;
  recipientAltPhone?: string | null;
  recipientEmail?: string | null;
  recipientCustomerId?: string | null;
  deliveryAddress: string;
  deliveryCity: string;
  deliveryDistrict: string;
  municipality?: string | null;
  wardNumber?: string | null;
  landmark?: string | null;
  declaredWeightKg: Prisma.Decimal;
  volumetricWeightKg?: Prisma.Decimal | null;
  billableWeightKg?: Prisma.Decimal | null;
  lengthCm?: Prisma.Decimal | null;
  widthCm?: Prisma.Decimal | null;
  heightCm?: Prisma.Decimal | null;
  declaredValuePaisa?: bigint | null;
  description: string;
  category: string;
  isFragile: boolean;
  handlingInstructions?: string | null;
  restrictedGoodsDeclared: boolean;
  codAmountPaisa: bigint;
  currentWarehouseId: string;
  actorId: string;
  actorRole: string | null;
  orderItemId?: string | null;
  packageItemDescription: string;
  packageItemDeclaredValuePaisa?: bigint | null;
}

export async function initialisePackage(
  tx: Tx,
  args: InitialisePackageArgs,
): Promise<{ id: string; trackingId: string }> {
  const pkg = await tx.package.create({
    data: {
      trackingId: args.trackingId,
      shipmentId: args.shipmentId,
      orderId: args.orderId,
      recipientName: args.recipientName,
      recipientPhone: args.recipientPhone,
      recipientAltPhone: args.recipientAltPhone ?? null,
      recipientEmail: args.recipientEmail ?? null,
      recipientCustomerId: args.recipientCustomerId ?? null,
      deliveryAddress: args.deliveryAddress,
      deliveryCity: args.deliveryCity,
      deliveryDistrict: args.deliveryDistrict,
      municipality: args.municipality ?? null,
      wardNumber: args.wardNumber ?? null,
      landmark: args.landmark ?? null,
      declaredWeightKg: args.declaredWeightKg,
      volumetricWeightKg: args.volumetricWeightKg ?? null,
      billableWeightKg: args.billableWeightKg ?? null,
      lengthCm: args.lengthCm ?? null,
      widthCm: args.widthCm ?? null,
      heightCm: args.heightCm ?? null,
      declaredValuePaisa: args.declaredValuePaisa ?? null,
      description: args.description,
      category: args.category,
      isFragile: args.isFragile,
      handlingInstructions: args.handlingInstructions ?? null,
      restrictedGoodsDeclared: args.restrictedGoodsDeclared,
      codAmountPaisa: args.codAmountPaisa,
      currentWarehouseId: args.currentWarehouseId,
      operationalStatus: "BOOKED",
      paymentStatus: args.codAmountPaisa > BigInt(0) ? "COD_DUE" : "NOT_APPLICABLE",
      items: {
        create: [
          {
            orderItemId: args.orderItemId ?? null,
            description: args.packageItemDescription,
            quantity: 1,
            declaredValuePaisa: args.packageItemDeclaredValuePaisa ?? null,
          },
        ],
      },
      labels: {
        create: [
          {
            labelCode: args.trackingId,
            qrPayload: `/track/${args.trackingId}`,
          },
        ],
      },
    },
  });
  await tx.trackingEvent.create({
    data: {
      packageId: pkg.id,
      shipmentId: args.shipmentId,
      orderId: args.orderId,
      subjectType: "PACKAGE",
      eventType: "BOOKED",
      previousStatus: null,
      newStatus: "BOOKED",
      actorId: args.actorId,
      actorRole: args.actorRole,
      warehouseId: args.currentWarehouseId,
      source: "WEB",
    },
  });
  return { id: pkg.id, trackingId: pkg.trackingId };
}

// ---------------------------------------------------------------------------
// Shipment roll-up (schema doc §4): derived, never set directly.
// ---------------------------------------------------------------------------

export async function rollupShipmentStatus(tx: Tx, shipmentId: string): Promise<void> {
  const packages = await tx.package.findMany({
    where: { shipmentId },
    select: { operationalStatus: true, deliveryStatus: true },
  });
  if (packages.length === 0) return;
  const live = packages.filter((p) => p.operationalStatus !== "CANCELLED");
  let status: string;
  if (live.length === 0) {
    status = "CANCELLED";
  } else if (live.every((p) => p.operationalStatus === "DELIVERED")) {
    status = "DELIVERED";
  } else if (
    live.every((p) => p.deliveryStatus === "RETURNED_TO_SENDER") &&
    live.some((p) => p.deliveryStatus === "RETURNED_TO_SENDER")
  ) {
    status = "RETURNED";
  } else if (live.some((p) => p.operationalStatus === "DELIVERED")) {
    status = "PARTIALLY_DELIVERED";
  } else {
    status = "ACTIVE";
  }
  await tx.shipment.updateMany({
    where: { id: shipmentId, NOT: { status } },
    data: { status },
  });
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export interface TransitionOptions {
  /** Warehouse the parcel is at after this move (receiving scans etc). */
  warehouseId?: string | null;
  notes?: string | null;
  /** Retry-safe key (rule T11): a repeated call with the same key
   *  returns the current state without writing a second event. */
  idempotencyKey?: string | null;
  source?: string;
  /** Operational context recorded on the TrackingEvent (Phase 5:
   *  transfer/trip legs attribute their events to the movement). */
  transferId?: string | null;
  tripId?: string | null;
  /** Phase 6: delivery legs attribute their events to the assignment. */
  deliveryAssignmentId?: string | null;
}

/** Delivery-progress side effects of operational moves (schema doc §5:
 *  the delivery status field tracks the last-mile dimension). Keyed by
 *  (from, to): the return/release edges into READY_FOR_DELIVERY mean
 *  different things depending on where the parcel came from — a
 *  pre-pickup release resets the final-mile state, a return scan
 *  after attempts keeps ATTEMPTED truthful, and a return scan with no
 *  attempt recorded marks the run FAILED for that parcel. */
function deliveryStatusFor(from: string, to: string): string | undefined {
  switch (to) {
    case "DELIVERY_ASSIGNED":
      return "ASSIGNED";
    case "OUT_FOR_DELIVERY":
      return "OUT_FOR_DELIVERY";
    case "DELIVERY_ATTEMPTED":
      return "ATTEMPTED";
    case "DELIVERED":
      return "DELIVERED";
    case "READY_FOR_DELIVERY":
      if (from === "DELIVERY_ASSIGNED") return "NOT_STARTED";
      if (from === "DELIVERY_ATTEMPTED") return "ATTEMPTED";
      if (from === "OUT_FOR_DELIVERY") return "FAILED";
      return undefined;
    default:
      return undefined;
  }
}

export async function transitionPackage(
  actor: ActorContext,
  packageId: string,
  toStatus: OperationalStatus,
  options: TransitionOptions = {},
): Promise<PackageView> {
  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    include: packageInclude,
  });
  if (!pkg) throw new NotFoundError("Package not found");

  if (options.idempotencyKey) {
    const prior = await prisma.trackingEvent.findUnique({
      where: { idempotencyKey: options.idempotencyKey },
    });
    if (prior && prior.packageId === packageId) {
      return toPackageView(pkg);
    }
    // Phase 10 slice 2 (P3-7a): the key already belongs to a
    // DIFFERENT package — refuse cleanly instead of falling through
    // to the event insert, which surfaced as a raw P2002.
    if (prior) {
      throw new ConflictError("This idempotency key was already used for a different package");
    }
  }

  const transition = findTransition(pkg.operationalStatus, toStatus);
  if (!transition) {
    const allowed = allowedTransitionsFrom(pkg.operationalStatus)
      .map((t) => t.to)
      .join(", ");
    await prisma.auditLog.create({
      data: {
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        action: "package.transition_rejected",
        entityType: "Package",
        entityId: packageId,
        before: { operationalStatus: pkg.operationalStatus },
        after: { attemptedStatus: toStatus },
      },
    });
    throw new ConflictError(
      `A package in ${pkg.operationalStatus} cannot move to ${toStatus}. Allowed next states: ${allowed || "none (terminal)"}`,
    );
  }

  if (!actor.permissions.has(transition.permission)) {
    await auditAccessDenied(actor, "Package", {
      entityId: packageId,
      reason: `missing_permission:${transition.permission}`,
    });
    throw new AuthorizationError(`Missing required permission: ${transition.permission}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    const applied = await applyTransitionInTx(tx, actor, pkg, toStatus, options);
    return applied.updated;
  });

  if (toStatus === "CANCELLED") {
    await prisma.auditLog.create({
      data: {
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        action: "package.cancel",
        entityType: "Package",
        entityId: packageId,
        before: { operationalStatus: pkg.operationalStatus },
        after: { operationalStatus: toStatus },
      },
    });
  }
  return toPackageView(updated);
}

// ---------------------------------------------------------------------------
// Transaction-composable transitions (Phase 4+)
// ---------------------------------------------------------------------------

/**
 * The shared write core of a transition: optimistic-lock claim,
 * TrackingEvent, shipment roll-up — inside the caller's transaction.
 * Throws ConflictError when the version/status claim is lost.
 */
async function applyTransitionInTx(
  tx: Tx,
  actor: ActorContext,
  pkg: PackageRow,
  toStatus: OperationalStatus,
  options: TransitionOptions,
): Promise<{ updated: PackageRow; eventId: string }> {
  const deliveryStatus = deliveryStatusFor(pkg.operationalStatus, toStatus);
  const claimed = await tx.package.updateMany({
    where: { id: pkg.id, version: pkg.version, operationalStatus: pkg.operationalStatus },
    data: {
      operationalStatus: toStatus,
      version: { increment: 1 },
      ...(options.warehouseId !== undefined
        ? { currentWarehouseId: options.warehouseId }
        : {}),
      ...(deliveryStatus ? { deliveryStatus } : {}),
    },
  });
  if (claimed.count !== 1) {
    throw new ConflictError(
      "The package changed while this operation was running — reload and try again",
    );
  }
  const event = await tx.trackingEvent.create({
    data: {
      packageId: pkg.id,
      shipmentId: pkg.shipmentId,
      orderId: pkg.orderId,
      subjectType: "PACKAGE",
      eventType: toStatus,
      previousStatus: pkg.operationalStatus,
      newStatus: toStatus,
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      warehouseId: options.warehouseId ?? pkg.currentWarehouseId,
      notes: options.notes ?? null,
      source: options.source ?? "WEB",
      idempotencyKey: options.idempotencyKey ?? null,
      transferId: options.transferId ?? null,
      tripId: options.tripId ?? null,
      deliveryAssignmentId: options.deliveryAssignmentId ?? null,
    },
  });
  await rollupShipmentStatus(tx, pkg.shipmentId);
  const updated = await tx.package.findUniqueOrThrow({
    where: { id: pkg.id },
    include: packageInclude,
  });
  return { updated, eventId: event.id };
}

export interface TransitionInTxResult {
  pkg: PackageView;
  eventId: string | null;
  transitioned: boolean;
}

/**
 * Transaction-composable variant of {@link transitionPackage} for
 * composite warehouse operations (Phase 4 receiving; Phase 5 transfer
 * receiving) that must write the status change AND dependent rows
 * (InventoryRecord, PackageCustody, InventoryMovement) in ONE
 * transaction — inventory invariant I3: a package is in stock at a
 * warehouse only because a receiving event exists.
 *
 * Differences from `transitionPackage`: invalid edges and missing
 * permissions THROW (the caller translates/audits in its own context),
 * and authorization SCOPE over the package (warehouse membership) is
 * the caller's responsibility — this service checks only the
 * transition-table edge and its permission, exactly like
 * `transitionPackage` (Phase 3 review P3-7b).
 */
export async function transitionPackageInTx(
  tx: Tx,
  actor: ActorContext,
  packageId: string,
  toStatus: OperationalStatus,
  options: TransitionOptions = {},
): Promise<TransitionInTxResult> {
  const pkg = await tx.package.findUnique({
    where: { id: packageId },
    include: packageInclude,
  });
  if (!pkg) throw new NotFoundError("Package not found");

  if (options.idempotencyKey) {
    const prior = await tx.trackingEvent.findUnique({
      where: { idempotencyKey: options.idempotencyKey },
    });
    if (prior && prior.packageId === packageId) {
      return { pkg: toPackageView(pkg), eventId: prior.id, transitioned: false };
    }
    // Phase 10 slice 2 (P3-7a): same cross-package guard as
    // transitionPackage — a key owned by another package is a
    // conflict, never a raw unique-violation from the event insert.
    if (prior) {
      throw new ConflictError("This idempotency key was already used for a different package");
    }
  }

  const transition = findTransition(pkg.operationalStatus, toStatus);
  if (!transition) {
    const allowed = allowedTransitionsFrom(pkg.operationalStatus)
      .map((t) => t.to)
      .join(", ");
    // Phase 10 slice 2 (P4-5): mirror transitionPackage's rejection
    // audit. The row is written through the ROOT client, not `tx` —
    // the caller's transaction is about to roll back, and a rejected
    // transition must still leave its audit trace. An audit failure
    // never masks the rejection itself.
    try {
      await prisma.auditLog.create({
        data: {
          actorId: actor.userId,
          actorRole: actor.primaryRole,
          action: "package.transition_rejected",
          entityType: "Package",
          entityId: packageId,
          before: { operationalStatus: pkg.operationalStatus },
          after: { attemptedStatus: toStatus },
        },
      });
    } catch {
      // Audit is best-effort here; the ConflictError below stands.
    }
    throw new ConflictError(
      `A package in ${pkg.operationalStatus} cannot move to ${toStatus}. Allowed next states: ${allowed || "none (terminal)"}`,
    );
  }
  if (!actor.permissions.has(transition.permission)) {
    // P4-5: same treatment for the permission rejection
    // (auditAccessDenied already writes through the root client).
    try {
      await auditAccessDenied(actor, "Package", {
        entityId: packageId,
        reason: `missing_permission:${transition.permission}`,
      });
    } catch {
      // Audit is best-effort here; the AuthorizationError stands.
    }
    throw new AuthorizationError(`Missing required permission: ${transition.permission}`);
  }

  const applied = await applyTransitionInTx(tx, actor, pkg, toStatus, options);
  return { pkg: toPackageView(applied.updated), eventId: applied.eventId, transitioned: true };
}
