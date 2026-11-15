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
import type { OperationalStatus } from "@/lib/bookings/lifecycle";
import {
  ACTIVE_ASSIGNMENT_STATUSES,
  ASSIGNMENT_BLOCKING_EXCEPTIONS,
  ATTEMPT_EXCEPTION_BY_RESULT,
  COD_METHODS,
  DELIVERY_ASSIGNMENT_STATUSES,
  DELIVERY_ATTEMPT_RESULTS,
  DELIVERY_CONTACT_OUTCOMES,
  DELIVERY_NEXT_ACTIONS,
  MAX_DELIVERY_ATTEMPTS,
  OTP_MAX_FAILURES,
  OTP_TTL_MS,
} from "@/lib/deliveries/domain";
import { generateOtpCode, hashOtpCode, verifyOtpCode } from "@/lib/deliveries/otp";
import {
  transitionPackageInTx,
  type TransitionInTxResult,
} from "@/server/services/package-lifecycle";
import {
  createReturnRequestInTx,
  lockPackageRow,
} from "@/server/services/returns";
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
 * Last-mile delivery (docs/delivery-workflow.md, docs/
 * return-workflow.md): batches, assignments, rider pickup, attempts,
 * OTP-verified proof of delivery, COD collection events, end-of-day
 * reconciliation, and the warehouse scan-back that feeds returns.
 *
 * Status changes go ONLY through PackageLifecycleService. Every
 * mutation asserts permission + scope BEFORE any transition.
 *
 * Concurrency (Phase 5 review P5-1/P5-2 + Phase 4 P4-1): the
 * one-active-assignment rule is enforced by locking the Package row
 * (SELECT … FOR UPDATE) inside the assignment transaction BEFORE
 * the open-assignment check — an EXISTS check alone does not
 * serialise under READ COMMITTED; the partial unique index is the
 * backstop. Batch closure recounts assignment rows inside the
 * transaction under the DeliveryBatch row lock.
 *
 * OTP: a 6-digit code is generated per assignment at pickup, stored
 * ONLY as a bcrypt hash on the assignment, expires after
 * OTP_TTL_MS, and locks after OTP_MAX_FAILURES wrong entries
 * (delivery-workflow §10). The plaintext is returned exactly once,
 * in the pickup result — the transitional hand-off until Phase 8
 * notifications deliver it to the recipient. It is never persisted,
 * logged, audited, or shown in any rider view.
 *
 * COD: the rider records expected vs collected in exact paisa at
 * delivery. A mismatch is stored as a MISMATCH collection record
 * (with a mandatory explanation) — it neither blocks nor silently
 * passes the delivery. The finance ledger is Phase 7; this service
 * records the collection EVENT only and never writes paymentStatus.
 */

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Package statuses this service filters on, bound to the canonical
 * lifecycle vocabulary (src/lib/bookings/lifecycle.ts) so a typo is
 * a type error. Used in READ filters only — writes always go
 * through PackageLifecycleService (the bookings source-scan guard
 * keys on raw `operationalStatus: "..."` literals for that reason;
 * same pattern as transfers.ts).
 */
const STATUS_READY_FOR_DELIVERY: OperationalStatus = "READY_FOR_DELIVERY";
const STATUS_RECEIVED_AT_DESTINATION: OperationalStatus = "RECEIVED_AT_DESTINATION";
const STATUS_READY_FOR_DISPATCH: OperationalStatus = "READY_FOR_DISPATCH";
const STATUS_DELIVERY_ASSIGNED: OperationalStatus = "DELIVERY_ASSIGNED";

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface DeliveryBatchView {
  id: string;
  riderId: string;
  riderName: string;
  riderUserId: string;
  warehouseId: string;
  warehouseCode: string;
  serviceAreaId: string | null;
  batchDate: string;
  kind: string;
  status: string;
  createdById: string;
  closedAt: string | null;
  closedById: string | null;
  counts: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    cancelled: number;
    reassigned: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface DeliveryAssignmentView {
  id: string;
  packageId: string;
  trackingId: string;
  driverId: string;
  riderName: string;
  batchId: string | null;
  vehicleId: string | null;
  kind: string;
  status: string;
  assignedById: string;
  assignedAt: string;
  acceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  routeSequence: number | null;
  deliveryInstructions: string | null;
  failureNote: string | null;
  reassignedFromId: string | null;
  attemptsRecorded: number;
  failedAttempts: number;
  codExpectedPaisa: string;
  packageStatus: string;
  createdAt: string;
  updatedAt: string;
}

/** Rider-facing assignment view: recipient contact details are
 *  included ONLY here, and the service only ever builds it for the
 *  assignment's own rider (security-architecture: recipient address
 *  and phone are visible only to the assigned rider). */
export interface RiderAssignmentView extends DeliveryAssignmentView {
  recipientName: string;
  recipientPhone: string;
  recipientAltPhone: string | null;
  destinationAddress: string;
  destinationLandmark: string | null;
  destinationCity: string | null;
  destinationDistrict: string | null;
  codCollectedPaisa: string | null;
  codStatus: string | null;
  otpState: { generated: boolean; expiresAt: string | null; locked: boolean };
}

type BatchRow = Prisma.DeliveryBatchGetPayload<{
  include: {
    rider: { include: { user: { select: { fullName: true } } } };
    warehouse: { select: { code: true } };
    assignments: { select: { status: true } };
  };
}>;

const batchInclude = {
  rider: { include: { user: { select: { fullName: true } } } },
  warehouse: { select: { code: true } },
  assignments: { select: { status: true } },
} satisfies Prisma.DeliveryBatchInclude;

function toBatchView(b: BatchRow): DeliveryBatchView {
  const counts = {
    total: b.assignments.length,
    pending: 0,
    inProgress: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    reassigned: 0,
  };
  for (const a of b.assignments) {
    if (a.status === "PENDING" || a.status === "ACCEPTED") counts.pending += 1;
    else if (a.status === "IN_PROGRESS") counts.inProgress += 1;
    else if (a.status === "COMPLETED") counts.completed += 1;
    else if (a.status === "FAILED") counts.failed += 1;
    else if (a.status === "CANCELLED") counts.cancelled += 1;
    else if (a.status === "REASSIGNED") counts.reassigned += 1;
  }
  return {
    id: b.id,
    riderId: b.riderId,
    riderName: b.rider.user.fullName,
    riderUserId: b.rider.userId,
    warehouseId: b.warehouseId,
    warehouseCode: b.warehouse.code,
    serviceAreaId: b.serviceAreaId,
    batchDate: b.batchDate.toISOString().slice(0, 10),
    kind: b.kind,
    status: b.status,
    createdById: b.createdById,
    closedAt: b.closedAt?.toISOString() ?? null,
    closedById: b.closedById,
    counts,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

async function loadBatchOr404(batchId: string): Promise<BatchRow> {
  const row = await prisma.deliveryBatch.findUnique({
    where: { id: batchId },
    include: batchInclude,
  });
  if (!row) throw new NotFoundError("Delivery batch not found");
  return row;
}

type AssignmentRow = Prisma.DeliveryAssignmentGetPayload<{
  include: {
    package: true;
    driver: { include: { user: { select: { fullName: true } } } };
    attempts: { select: { result: true } };
    codCollection: { select: { collectedPaisa: true; status: true } };
  };
}>;

const assignmentInclude = {
  package: true,
  driver: { include: { user: { select: { fullName: true } } } },
  attempts: { select: { result: true } },
  codCollection: { select: { collectedPaisa: true, status: true } },
} satisfies Prisma.DeliveryAssignmentInclude;

function toAssignmentView(a: AssignmentRow): DeliveryAssignmentView {
  return {
    id: a.id,
    packageId: a.packageId,
    trackingId: a.package.trackingId,
    driverId: a.driverId,
    riderName: a.driver.user.fullName,
    batchId: a.batchId,
    vehicleId: a.vehicleId,
    kind: a.kind,
    status: a.status,
    assignedById: a.assignedById,
    assignedAt: a.assignedAt.toISOString(),
    acceptedAt: a.acceptedAt?.toISOString() ?? null,
    startedAt: a.startedAt?.toISOString() ?? null,
    completedAt: a.completedAt?.toISOString() ?? null,
    routeSequence: a.routeSequence,
    deliveryInstructions: a.deliveryInstructions,
    failureNote: a.failureNote,
    reassignedFromId: a.reassignedFromId,
    attemptsRecorded: a.attempts.length,
    failedAttempts: a.attempts.filter((t) => t.result !== "DELIVERED").length,
    codExpectedPaisa: a.package.codAmountPaisa.toString(),
    packageStatus: a.package.operationalStatus,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

function toRiderAssignmentView(a: AssignmentRow): RiderAssignmentView {
  return {
    ...toAssignmentView(a),
    recipientName: a.package.recipientName,
    recipientPhone: a.package.recipientPhone,
    recipientAltPhone: a.package.recipientAltPhone,
    destinationAddress: a.package.deliveryAddress,
    destinationLandmark: a.package.landmark,
    destinationCity: a.package.deliveryCity,
    destinationDistrict: a.package.deliveryDistrict,
    codCollectedPaisa: a.codCollection?.collectedPaisa.toString() ?? null,
    codStatus: a.codCollection?.status ?? null,
    otpState: {
      generated: a.otpCodeHash !== null,
      expiresAt: a.otpExpiresAt?.toISOString() ?? null,
      locked: a.otpLockedAt !== null,
    },
  };
}

async function loadAssignmentOr404(assignmentId: string): Promise<AssignmentRow> {
  const row = await prisma.deliveryAssignment.findUnique({
    where: { id: assignmentId },
    include: assignmentInclude,
  });
  if (!row) throw new NotFoundError("Delivery assignment not found");
  return row;
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/** The assigned rider only (delivery-workflow §10): anyone else
 *  attempting to act on the assignment is denied and audited. */
async function assertAssignedRider(
  actor: ActorContext,
  assignment: { id: string; driverId: string },
  reason: string,
): Promise<void> {
  if (actor.driverId && actor.driverId === assignment.driverId) return;
  await auditAccessDenied(actor, "DeliveryAssignment", {
    entityId: assignment.id,
    reason,
  });
  throw new AuthorizationError("Only the assigned rider can perform this action");
}

/** Warehouse-side access to a batch: unscoped actors, actors with
 *  the warehouse in scope, or the batch's own rider. */
async function assertBatchVisible(
  actor: ActorContext,
  batch: { id: string; warehouseId: string; riderId: string },
): Promise<void> {
  if (isUnscoped(actor)) return;
  if (actor.driverId && actor.driverId === batch.riderId) return;
  if (actor.warehouseIds.includes(batch.warehouseId)) return;
  await auditAccessDenied(actor, "DeliveryBatch", {
    entityId: batch.id,
    warehouseId: batch.warehouseId,
    reason: "batch_out_of_scope",
  });
  throw new AuthorizationError("This batch is outside your scope");
}

interface EligibleRider {
  driverId: string;
  userId: string;
  fullName: string;
}

/** Rider eligibility for a batch at a warehouse (delivery-workflow
 *  §3): an ACTIVE user holding the RIDER role with a Driver profile
 *  that is actively employed, licensed, capable of the batch kind,
 *  and linked to the warehouse (home warehouse or active
 *  membership). */
async function loadEligibleRider(
  db: Db,
  riderUserId: string,
  warehouseId: string,
  kind: string,
): Promise<EligibleRider> {
  const user = await db.user.findUnique({
    where: { id: riderUserId },
    include: {
      roles: { include: { role: { select: { code: true } } } },
      driverProfile: { include: { capabilities: true } },
      memberships: {
        where: { warehouseId, revokedAt: null },
        select: { id: true },
      },
    },
  });
  if (!user) throw new DomainValidationError("Rider user not found");
  if (user.status !== "ACTIVE") {
    throw new DomainValidationError("The rider's account is not active");
  }
  if (!user.roles.some((r) => r.role.code === "RIDER")) {
    throw new DomainValidationError("The selected user does not hold the RIDER role");
  }
  const driver = user.driverProfile;
  if (!driver) {
    throw new DomainValidationError("The selected user has no driver profile");
  }
  if (driver.employmentStatus !== "ACTIVE") {
    throw new DomainValidationError("The rider is not actively employed");
  }
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (driver.licenseExpiry < today) {
    throw new DomainValidationError("The rider's driving licence has expired");
  }
  const requiredCapability = kind === "PICKUP" ? "PICKUP" : "DELIVERY";
  if (!driver.capabilities.some((c) => c.capability === requiredCapability)) {
    throw new DomainValidationError(
      `The rider lacks the ${requiredCapability} capability`,
    );
  }
  if (driver.homeWarehouseId !== warehouseId && user.memberships.length === 0) {
    throw new DomainValidationError(
      "The rider is not linked to this warehouse (home warehouse or active membership required)",
    );
  }
  return { driverId: driver.id, userId: user.id, fullName: user.fullName };
}

async function loadWarehouseOr404(warehouseId: string) {
  const warehouse = await prisma.warehouse.findUnique({
    where: { id: warehouseId },
  });
  if (!warehouse) throw new NotFoundError("Warehouse not found");
  return warehouse;
}

// ---------------------------------------------------------------------------
// Batch creation + assignment
// ---------------------------------------------------------------------------

export const createDeliveryBatchSchema = z.object({
  warehouseId: z.string().uuid(),
  riderUserId: z.string().uuid(),
  serviceAreaId: z.string().uuid().optional().nullable(),
  batchDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "batchDate must be YYYY-MM-DD")
    .optional(),
  kind: z.enum(["DELIVERY", "PICKUP", "MIXED"]).optional(),
});
export type CreateDeliveryBatchInput = z.input<typeof createDeliveryBatchSchema>;

export async function createDeliveryBatch(
  actor: ActorContext,
  input: CreateDeliveryBatchInput,
): Promise<DeliveryBatchView> {
  const data = parse(createDeliveryBatchSchema, input);
  await requirePermAudited(actor, "delivery.assign", "DeliveryBatch");
  const warehouse = await loadWarehouseOr404(data.warehouseId);
  await assertWarehouseScope(actor, warehouse.id, "DeliveryBatch");
  if (warehouse.status !== "ACTIVE") {
    throw new DomainValidationError("Warehouse is not ACTIVE");
  }
  const kind = data.kind ?? "DELIVERY";
  const rider = await loadEligibleRider(prisma, data.riderUserId, warehouse.id, kind);
  if (data.serviceAreaId) {
    const area = await prisma.serviceArea.findUnique({
      where: { id: data.serviceAreaId },
      select: { servingWarehouseId: true },
    });
    if (!area || area.servingWarehouseId !== warehouse.id) {
      throw new DomainValidationError("Service area does not belong to this warehouse");
    }
  }
  const batchDate = data.batchDate ? new Date(`${data.batchDate}T00:00:00.000Z`) : new Date();
  if (!data.batchDate) batchDate.setUTCHours(0, 0, 0, 0);
  const batch = await prisma.deliveryBatch.create({
    data: {
      riderId: rider.driverId,
      warehouseId: warehouse.id,
      serviceAreaId: data.serviceAreaId ?? null,
      batchDate,
      kind,
      status: "OPEN",
      createdById: actor.userId,
    },
  });
  await auditOps(actor, "delivery.batch_created", "DeliveryBatch", batch.id, {
    warehouseId: warehouse.id,
    after: { riderId: rider.driverId, kind, batchDate: batchDate.toISOString().slice(0, 10) },
  });
  return toBatchView(await loadBatchOr404(batch.id));
}

export const addBatchPackagesSchema = z.object({
  packageIds: z.array(z.string().uuid()).min(1).max(200),
});
export type AddBatchPackagesInput = z.input<typeof addBatchPackagesSchema>;

export interface AddBatchPackagesResult {
  added: DeliveryAssignmentView[];
  rejected: { packageId: string; trackingId: string | null; reason: string }[];
}

/**
 * Assign packages to a batch. Each package is processed in ONE
 * transaction that locks the Package row first (P5-1/P5-2), wires
 * the READY_FOR_DELIVERY step for packages that just arrived
 * (RECEIVED_AT_DESTINATION → READY_FOR_DELIVERY, and local
 * READY_FOR_DISPATCH → READY_FOR_DELIVERY), asserts stock + scope,
 * then creates the assignment and moves the package to
 * DELIVERY_ASSIGNED — atomically, so a package can never sit in two
 * open batches.
 */
export async function addBatchPackages(
  actor: ActorContext,
  batchId: string,
  input: AddBatchPackagesInput,
): Promise<AddBatchPackagesResult> {
  const data = parse(addBatchPackagesSchema, input);
  await requirePermAudited(actor, "delivery.assign", "DeliveryBatch");
  const batch = await loadBatchOr404(batchId);
  await assertWarehouseScope(actor, batch.warehouseId, "DeliveryBatch", batch.id);
  if (batch.status !== "OPEN") {
    throw new ConflictError(`Batch is ${batch.status} — packages can only be added to an OPEN batch`);
  }

  const added: DeliveryAssignmentView[] = [];
  const rejected: AddBatchPackagesResult["rejected"] = [];

  for (const packageId of data.packageIds) {
    try {
      const assignmentId = await prisma.$transaction(async (tx) => {
        await lockPackageRow(tx, packageId);
        const pkg = await tx.package.findUnique({
          where: { id: packageId },
          include: {
            shipment: { select: { destinationWarehouseId: true } },
            inventoryRecords: {
              where: { releasedAt: null },
              select: { warehouseId: true },
            },
            deliveryAssignments: {
              where: { kind: "DELIVERY", status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
              select: { id: true },
            },
            returnRequests: {
              where: {
                status: {
                  in: [
                    "REQUESTED",
                    "APPROVED",
                    "COLLECTION_ASSIGNED",
                    "COLLECTED",
                    "IN_TRANSIT",
                    "RECEIVED",
                    "INSPECTED",
                  ],
                },
              },
              select: { id: true },
            },
          },
        });
        if (!pkg) throw new NotFoundError("Package not found");
        if (pkg.currentWarehouseId !== batch.warehouseId) {
          throw new DomainValidationError(
            `Package ${pkg.trackingId} is at another warehouse`,
          );
        }
        if (pkg.deliveryAssignments.length > 0) {
          throw new DomainValidationError(
            `Package ${pkg.trackingId} already has an open delivery assignment`,
          );
        }
        if (pkg.returnRequests.length > 0) {
          throw new DomainValidationError(
            `Package ${pkg.trackingId} is under an open return and cannot be assigned`,
          );
        }
        if (
          (ASSIGNMENT_BLOCKING_EXCEPTIONS as readonly string[]).includes(pkg.exceptionStatus)
        ) {
          throw new DomainValidationError(
            `Package ${pkg.trackingId} is blocked by exception ${pkg.exceptionStatus}`,
          );
        }
        const stockedHere = pkg.inventoryRecords.some(
          (r) => r.warehouseId === batch.warehouseId,
        );
        if (!stockedHere) {
          throw new DomainValidationError(
            `Package ${pkg.trackingId} is not in stock at this warehouse`,
          );
        }

        const readyArgs = { warehouseId: batch.warehouseId };
        if (pkg.operationalStatus === "RECEIVED_AT_DESTINATION") {
          // Wire the READY_FOR_DELIVERY step (it previously had no
          // caller): destination-warehouse scope + delivery.assign
          // were asserted above, before this transition.
          await transitionPackageInTx(tx, actor, pkg.id, "READY_FOR_DELIVERY", readyArgs);
        } else if (pkg.operationalStatus === "READY_FOR_DISPATCH") {
          if (pkg.shipment.destinationWarehouseId !== batch.warehouseId) {
            throw new DomainValidationError(
              `Package ${pkg.trackingId} is ready for dispatch to another warehouse — it is not a local delivery`,
            );
          }
          await transitionPackageInTx(tx, actor, pkg.id, "READY_FOR_DELIVERY", readyArgs);
        } else if (pkg.operationalStatus === "DELIVERY_ASSIGNED") {
          // All prior assignments are terminal (checked above): the
          // package was shorted at pickup or its batch was cancelled
          // without release. Release it back, then re-assign below.
          await transitionPackageInTx(tx, actor, pkg.id, "READY_FOR_DELIVERY", readyArgs);
        } else if (pkg.operationalStatus !== "READY_FOR_DELIVERY") {
          throw new DomainValidationError(
            `Package ${pkg.trackingId} is ${pkg.operationalStatus} — not ready for delivery assignment`,
          );
        }

        const assignment = await tx.deliveryAssignment.create({
          data: {
            packageId: pkg.id,
            driverId: batch.riderId,
            batchId: batch.id,
            kind: "DELIVERY",
            status: "PENDING",
            assignedById: actor.userId,
          },
        });
        await transitionPackageInTx(tx, actor, pkg.id, "DELIVERY_ASSIGNED", {
          deliveryAssignmentId: assignment.id,
          warehouseId: batch.warehouseId,
        });
        return assignment.id;
      });
      added.push(toAssignmentView(await loadAssignmentOr404(assignmentId)));
    } catch (err) {
      if (
        err instanceof DomainValidationError ||
        err instanceof NotFoundError ||
        err instanceof ConflictError
      ) {
        const pkg = await prisma.package.findUnique({
          where: { id: packageId },
          select: { trackingId: true },
        });
        rejected.push({
          packageId,
          trackingId: pkg?.trackingId ?? null,
          reason: err.message,
        });
        continue;
      }
      throw err;
    }
  }

  await auditOps(actor, "delivery.batch_packages_added", "DeliveryBatch", batch.id, {
    warehouseId: batch.warehouseId,
    after: {
      added: added.map((a) => a.trackingId),
      rejected: rejected.map((r) => ({ trackingId: r.trackingId, reason: r.reason })),
    },
  });
  return { added, rejected };
}

// ---------------------------------------------------------------------------
// Assignment release / cancel / reassign (dispatcher side)
// ---------------------------------------------------------------------------

export const cancelAssignmentSchema = z.object({
  reason: z.string().min(3).max(500),
});
export type CancelAssignmentInput = z.input<typeof cancelAssignmentSchema>;

export async function cancelAssignment(
  actor: ActorContext,
  assignmentId: string,
  input: CancelAssignmentInput,
): Promise<DeliveryAssignmentView> {
  const data = parse(cancelAssignmentSchema, input);
  await requirePermAudited(actor, "delivery.assign", "DeliveryAssignment");
  const assignment = await loadAssignmentOr404(assignmentId);
  const batch = assignment.batchId ? await loadBatchOr404(assignment.batchId) : null;
  await assertWarehouseScope(
    actor,
    batch?.warehouseId ?? assignment.package.currentWarehouseId ?? "",
    "DeliveryAssignment",
    assignment.id,
  );
  if (assignment.status !== "PENDING" && assignment.status !== "ACCEPTED") {
    throw new ConflictError(
      `Assignment is ${assignment.status} — only PENDING/ACCEPTED assignments can be cancelled`,
    );
  }
  await prisma.$transaction(async (tx) => {
    await lockPackageRow(tx, assignment.packageId);
    await tx.deliveryAssignment.update({
      where: { id: assignment.id },
      data: {
        status: "CANCELLED",
        completedAt: new Date(),
        failureNote: data.reason,
        version: { increment: 1 },
      },
    });
    const pkg = await tx.package.findUniqueOrThrow({
      where: { id: assignment.packageId },
      select: { operationalStatus: true },
    });
    if (pkg.operationalStatus === "DELIVERY_ASSIGNED") {
      await transitionPackageInTx(tx, actor, assignment.packageId, "READY_FOR_DELIVERY", {
        warehouseId: batch?.warehouseId ?? undefined,
      });
    }
  });
  await auditOps(actor, "delivery.assignment_cancelled", "DeliveryAssignment", assignment.id, {
    warehouseId: batch?.warehouseId,
    after: { reason: data.reason },
  });
  return toAssignmentView(await loadAssignmentOr404(assignmentId));
}

export const reassignAssignmentSchema = z.object({
  riderUserId: z.string().uuid(),
});
export type ReassignAssignmentInput = z.input<typeof reassignAssignmentSchema>;

export async function reassignAssignment(
  actor: ActorContext,
  assignmentId: string,
  input: ReassignAssignmentInput,
): Promise<{ previous: DeliveryAssignmentView; assignment: DeliveryAssignmentView; batch: DeliveryBatchView }> {
  const data = parse(reassignAssignmentSchema, input);
  await requirePermAudited(actor, "delivery.assign", "DeliveryAssignment");
  const assignment = await loadAssignmentOr404(assignmentId);
  const oldBatch = assignment.batchId ? await loadBatchOr404(assignment.batchId) : null;
  const warehouseId = oldBatch?.warehouseId ?? assignment.package.currentWarehouseId;
  if (!warehouseId) throw new ConflictError("Package is not at a warehouse");
  await assertWarehouseScope(actor, warehouseId, "DeliveryAssignment", assignment.id);
  if (assignment.status !== "PENDING" && assignment.status !== "ACCEPTED") {
    throw new ConflictError(
      `Assignment is ${assignment.status} — only a not-yet-collected assignment can be reassigned`,
    );
  }
  const rider = await loadEligibleRider(prisma, data.riderUserId, warehouseId, "DELIVERY");
  if (rider.driverId === assignment.driverId) {
    throw new DomainValidationError("The package is already assigned to this rider");
  }
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const newAssignmentId = await prisma.$transaction(async (tx) => {
    await lockPackageRow(tx, assignment.packageId);
    const fresh = await tx.deliveryAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
      select: { status: true },
    });
    if (fresh.status !== "PENDING" && fresh.status !== "ACCEPTED") {
      throw new ConflictError(`Assignment is ${fresh.status} — it can no longer be reassigned`);
    }
    await tx.deliveryAssignment.update({
      where: { id: assignment.id },
      data: {
        status: "REASSIGNED",
        completedAt: new Date(),
        failureNote: `Reassigned to ${rider.fullName}`,
        version: { increment: 1 },
      },
    });
    const newBatch = await tx.deliveryBatch.create({
      data: {
        riderId: rider.driverId,
        warehouseId,
        batchDate: today,
        kind: "DELIVERY",
        status: "OPEN",
        createdById: actor.userId,
      },
    });
    const created = await tx.deliveryAssignment.create({
      data: {
        packageId: assignment.packageId,
        driverId: rider.driverId,
        batchId: newBatch.id,
        kind: "DELIVERY",
        status: "PENDING",
        assignedById: actor.userId,
        reassignedFromId: assignment.id,
      },
    });
    return created.id;
  });
  await auditOps(actor, "delivery.assignment_reassigned", "DeliveryAssignment", assignment.id, {
    warehouseId,
    after: { newAssignmentId, newRiderId: rider.driverId },
  });
  const created = await loadAssignmentOr404(newAssignmentId);
  return {
    previous: toAssignmentView(await loadAssignmentOr404(assignmentId)),
    assignment: toAssignmentView(created),
    batch: toBatchView(await loadBatchOr404(created.batchId!)),
  };
}

export async function cancelBatch(
  actor: ActorContext,
  batchId: string,
): Promise<DeliveryBatchView> {
  await requirePermAudited(actor, "delivery.assign", "DeliveryBatch");
  const batch = await loadBatchOr404(batchId);
  await assertWarehouseScope(actor, batch.warehouseId, "DeliveryBatch", batch.id);
  if (batch.status !== "OPEN" && batch.status !== "IN_PROGRESS") {
    throw new ConflictError(`Batch is ${batch.status} — it can no longer be cancelled`);
  }
  await prisma.$transaction(async (tx) => {
    const active = await tx.deliveryAssignment.findMany({
      where: { batchId: batch.id, status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
      select: { id: true, packageId: true, status: true },
    });
    if (active.some((a) => a.status === "IN_PROGRESS")) {
      throw new ConflictError(
        "Batch has packages out with the rider — it cannot be cancelled; close it at end of day instead",
      );
    }
    for (const a of active) {
      await lockPackageRow(tx, a.packageId);
      await tx.deliveryAssignment.update({
        where: { id: a.id },
        data: {
          status: "CANCELLED",
          completedAt: new Date(),
          failureNote: "Batch cancelled by dispatcher",
          version: { increment: 1 },
        },
      });
      const pkg = await tx.package.findUniqueOrThrow({
        where: { id: a.packageId },
        select: { operationalStatus: true },
      });
      if (pkg.operationalStatus === "DELIVERY_ASSIGNED") {
        await transitionPackageInTx(tx, actor, a.packageId, "READY_FOR_DELIVERY", {
          warehouseId: batch.warehouseId,
        });
      }
    }
    await tx.deliveryBatch.update({
      where: { id: batch.id },
      data: { status: "CANCELLED", closedAt: new Date(), closedById: actor.userId },
    });
  });
  await auditOps(actor, "delivery.batch_cancelled", "DeliveryBatch", batch.id, {
    warehouseId: batch.warehouseId,
  });
  return toBatchView(await loadBatchOr404(batchId));
}

// ---------------------------------------------------------------------------
// Pickup — the rider confirms the physical set (delivery-workflow §4)
// ---------------------------------------------------------------------------

export const confirmPickupSchema = z.object({
  trackingIds: z.array(z.string().min(1).max(40)).max(500),
});
export type ConfirmPickupInput = z.input<typeof confirmPickupSchema>;

export interface PickupPackageResult {
  assignmentId: string;
  trackingId: string;
  /** The recipient delivery code, returned ONCE here (see the OTP
   *  note in the file header). Never stored, logged, or re-shown. */
  otp: string;
}

export interface ConfirmPickupResult {
  batch: DeliveryBatchView;
  taken: PickupPackageResult[];
  shortages: { assignmentId: string; trackingId: string }[];
  failed: { assignmentId: string; trackingId: string; reason: string }[];
}

export async function confirmPickup(
  actor: ActorContext,
  batchId: string,
  input: ConfirmPickupInput,
): Promise<ConfirmPickupResult> {
  const data = parse(confirmPickupSchema, input);
  await requirePermAudited(actor, "delivery.confirm", "DeliveryBatch");
  const batch = await loadBatchOr404(batchId);
  await assertAssignedRider(actor, { id: batch.id, driverId: batch.riderId }, "pickup_not_own_batch");
  if (batch.status !== "OPEN" && batch.status !== "IN_PROGRESS") {
    throw new ConflictError(`Batch is ${batch.status} — pickup is no longer possible`);
  }
  const pending = await prisma.deliveryAssignment.findMany({
    where: { batchId: batch.id, status: { in: ["PENDING", "ACCEPTED"] } },
    include: { package: { select: { trackingId: true } } },
    orderBy: { createdAt: "asc" },
  });
  const scanned = new Set(data.trackingIds.map((t) => t.trim()));
  const taken: PickupPackageResult[] = [];
  const failed: ConfirmPickupResult["failed"] = [];
  const shortages: ConfirmPickupResult["shortages"] = [];

  for (const assignment of pending) {
    if (!scanned.has(assignment.package.trackingId)) {
      shortages.push({ assignmentId: assignment.id, trackingId: assignment.package.trackingId });
      continue;
    }
    const otp = generateOtpCode();
    const otpHash = await hashOtpCode(otp);
    try {
      await prisma.$transaction(async (tx) => {
        await lockPackageRow(tx, assignment.packageId);
        const fresh = await tx.deliveryAssignment.findUniqueOrThrow({
          where: { id: assignment.id },
          select: { status: true },
        });
        if (fresh.status !== "PENDING" && fresh.status !== "ACCEPTED") {
          throw new ConflictError(`Assignment is ${fresh.status}`);
        }
        const pkg = await tx.package.findUniqueOrThrow({
          where: { id: assignment.packageId },
        });
        if (pkg.operationalStatus !== "DELIVERY_ASSIGNED") {
          throw new ConflictError(`Package is ${pkg.operationalStatus}, not DELIVERY_ASSIGNED`);
        }
        const record = await tx.inventoryRecord.findFirst({
          where: { packageId: pkg.id, releasedAt: null },
        });
        if (!record || record.warehouseId !== batch.warehouseId) {
          throw new ConflictError("Package is not in stock at this warehouse");
        }
        const custody = await tx.packageCustody.findFirst({
          where: { packageId: pkg.id, endedAt: null },
        });
        if (!custody || custody.custodianType !== "WAREHOUSE" || custody.warehouseId !== batch.warehouseId) {
          throw new ConflictError("Warehouse custody is not open for this package");
        }
        const now = new Date();
        const transition: TransitionInTxResult = await transitionPackageInTx(
          tx,
          actor,
          pkg.id,
          "OUT_FOR_DELIVERY",
          {
            deliveryAssignmentId: assignment.id,
            warehouseId: batch.warehouseId,
            source: "MOBILE",
          },
        );
        if (!transition.transitioned || !transition.eventId) {
          throw new ConflictError("Package could not be moved to OUT_FOR_DELIVERY");
        }
        // Inventory closes at handout: a package out with a rider
        // has no open InventoryRecord (schema doc §6).
        await tx.inventoryRecord.update({
          where: { id: record.id },
          data: {
            releasedAt: now,
            releasedById: actor.userId,
            releaseReason: "DELIVERY_HANDOUT",
          },
        });
        await tx.inventoryMovement.create({
          data: {
            packageId: pkg.id,
            inventoryRecordId: record.id,
            type: "DISPATCH",
            fromWarehouseId: batch.warehouseId,
            fromLocationId: record.storageLocationId,
            actorId: actor.userId,
            trackingEventId: transition.eventId,
            reason: "Handed to rider for last-mile delivery",
          },
        });
        await tx.packageCustody.update({
          where: { id: custody.id },
          data: { endedAt: now },
        });
        await tx.packageCustody.create({
          data: {
            packageId: pkg.id,
            custodianType: "USER",
            custodianUserId: actor.userId,
            trackingEventId: transition.eventId,
          },
        });
        await tx.deliveryAssignment.update({
          where: { id: assignment.id },
          data: {
            status: "IN_PROGRESS",
            startedAt: now,
            otpCodeHash: otpHash,
            otpGeneratedAt: now,
            otpExpiresAt: new Date(now.getTime() + OTP_TTL_MS),
            otpFailedAttempts: 0,
            otpLockedAt: null,
            otpVerifiedAt: null,
            version: { increment: 1 },
          },
        });
      });
      taken.push({ assignmentId: assignment.id, trackingId: assignment.package.trackingId, otp });
    } catch (err) {
      if (err instanceof ConflictError || err instanceof DomainValidationError) {
        failed.push({
          assignmentId: assignment.id,
          trackingId: assignment.package.trackingId,
          reason: err.message,
        });
        continue;
      }
      throw err;
    }
  }

  // Shortages are explicit, never silent (delivery-workflow §10):
  // the assignment is marked FAILED and the package stays
  // DELIVERY_ASSIGNED at the warehouse for the dispatcher to
  // release or re-batch.
  if (shortages.length > 0) {
    await prisma.deliveryAssignment.updateMany({
      where: { id: { in: shortages.map((s) => s.assignmentId) } },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        failureNote: "PICKUP_SHORTAGE — not scanned at pickup; left at the warehouse",
      },
    });
  }
  if (taken.length > 0 && batch.status === "OPEN") {
    await prisma.deliveryBatch.update({
      where: { id: batch.id },
      data: { status: "IN_PROGRESS" },
    });
    await prisma.driver.update({
      where: { id: batch.riderId },
      data: { availabilityStatus: "ON_DELIVERY" },
    });
  }
  await auditOps(actor, "delivery.pickup_confirmed", "DeliveryBatch", batch.id, {
    warehouseId: batch.warehouseId,
    after: {
      taken: taken.map((t) => t.trackingId),
      shortages: shortages.map((s) => s.trackingId),
      failed: failed.map((f) => ({ trackingId: f.trackingId, reason: f.reason })),
    },
  });
  return { batch: toBatchView(await loadBatchOr404(batchId)), taken, shortages, failed };
}

// ---------------------------------------------------------------------------
// OTP regeneration (recipient lost the code / code expired)
// ---------------------------------------------------------------------------

export async function regenerateOtp(
  actor: ActorContext,
  assignmentId: string,
): Promise<{ assignmentId: string; otp: string; expiresAt: string }> {
  await requirePermAudited(actor, "delivery.confirm", "DeliveryAssignment");
  const assignment = await loadAssignmentOr404(assignmentId);
  const isRider = actor.driverId === assignment.driverId;
  if (!isRider) {
    // Warehouse staff may regenerate for a package at their
    // warehouse (e.g. recipient calls the warehouse).
    const batch = assignment.batchId ? await loadBatchOr404(assignment.batchId) : null;
    await assertWarehouseScope(
      actor,
      batch?.warehouseId ?? assignment.package.currentWarehouseId ?? "",
      "DeliveryAssignment",
      assignment.id,
    );
  }
  if (assignment.status !== "IN_PROGRESS") {
    throw new ConflictError(`Assignment is ${assignment.status} — the package is not out for delivery`);
  }
  const otp = generateOtpCode();
  const otpHash = await hashOtpCode(otp);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  await prisma.deliveryAssignment.update({
    where: { id: assignment.id },
    data: {
      otpCodeHash: otpHash,
      otpGeneratedAt: now,
      otpExpiresAt: expiresAt,
      otpFailedAttempts: 0,
      otpLockedAt: null,
      version: { increment: 1 },
    },
  });
  await auditOps(actor, "delivery.otp_regenerated", "DeliveryAssignment", assignment.id, {
    after: { expiresAt: expiresAt.toISOString() },
  });
  return { assignmentId: assignment.id, otp, expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Attempts (delivery-workflow §5–§7)
// ---------------------------------------------------------------------------

export const recordAttemptSchema = z.object({
  result: z.enum(DELIVERY_ATTEMPT_RESULTS),
  failureReason: z.string().max(200).optional().nullable(),
  contactOutcome: z.enum(DELIVERY_CONTACT_OUTCOMES).optional().nullable(),
  nextAction: z.enum(DELIVERY_NEXT_ACTIONS).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
});
export type RecordAttemptInput = z.input<typeof recordAttemptSchema>;

export interface RecordAttemptResult {
  assignment: DeliveryAssignmentView;
  attemptNumber: number;
  failedAttempts: number;
  maxAttemptsReached: boolean;
  returnRequest: { id: string; returnNumber: string } | null;
}

const SOFT_DELIVERY_EXCEPTIONS = ["NONE", "DELIVERY_FAILED", "CUSTOMER_UNAVAILABLE"];

function defaultNextAction(result: string): string {
  if (result === "REFUSED") return "RETURN_TO_SENDER";
  if (result === "WRONG_ADDRESS") return "ADDRESS_CORRECTION";
  if (result === "PACKAGE_DAMAGED") return "RETURN_TO_WAREHOUSE";
  return "REDELIVER";
}

function returnReasonFor(result: string, failedAttempts: number): string {
  if (result === "REFUSED") return "RECIPIENT_REFUSED";
  if (result === "WRONG_ADDRESS") return "WRONG_ADDRESS";
  if (result === "PACKAGE_DAMAGED") return "PACKAGE_DAMAGED";
  if (failedAttempts >= MAX_DELIVERY_ATTEMPTS) return "ATTEMPT_LIMIT_REACHED";
  return "UNDELIVERABLE";
}

export async function recordDeliveryAttempt(
  actor: ActorContext,
  assignmentId: string,
  input: RecordAttemptInput,
): Promise<RecordAttemptResult> {
  const data = parse(recordAttemptSchema, input);
  if (data.result === "DELIVERED") {
    throw new DomainValidationError(
      "A successful delivery is recorded through the delivery confirmation (proof of delivery + OTP), not as a plain attempt",
    );
  }
  await requirePermAudited(actor, "delivery.attempt.record", "DeliveryAssignment");
  const assignment = await loadAssignmentOr404(assignmentId);
  await assertAssignedRider(actor, assignment, "attempt_not_own_assignment");
  if (assignment.status !== "IN_PROGRESS") {
    throw new ConflictError(`Assignment is ${assignment.status} — the package is not out with you`);
  }
  const pkgStatus = assignment.package.operationalStatus;
  if (pkgStatus !== "OUT_FOR_DELIVERY" && pkgStatus !== "DELIVERY_ATTEMPTED") {
    throw new ConflictError(`Package is ${pkgStatus} — no attempt can be recorded`);
  }
  const nextAction = data.nextAction ?? defaultNextAction(data.result);

  const outcome = await prisma.$transaction(async (tx) => {
    await lockPackageRow(tx, assignment.packageId);
    const pkg = await tx.package.findUniqueOrThrow({ where: { id: assignment.packageId } });
    if (pkg.operationalStatus === "DELIVERY_ATTEMPTED") {
      // A further attempt first returns the package to
      // OUT_FOR_DELIVERY (reattempt_delivery), then records.
      await transitionPackageInTx(tx, actor, pkg.id, "OUT_FOR_DELIVERY", {
        deliveryAssignmentId: assignment.id,
        warehouseId: pkg.currentWarehouseId ?? undefined,
        source: "MOBILE",
      });
    } else if (pkg.operationalStatus !== "OUT_FOR_DELIVERY") {
      throw new ConflictError(`Package is ${pkg.operationalStatus} — no attempt can be recorded`);
    }
    const priorAttempts = await tx.deliveryAttempt.count({
      where: { packageId: pkg.id },
    });
    const attemptNumber = priorAttempts + 1;
    await tx.deliveryAttempt.create({
      data: {
        assignmentId: assignment.id,
        packageId: pkg.id,
        attemptNumber,
        result: data.result,
        failureReason: data.failureReason ?? null,
        contactOutcome: data.contactOutcome ?? null,
        nextAction,
        notes: data.notes ?? null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        recordedById: actor.userId,
      },
    });
    await transitionPackageInTx(tx, actor, pkg.id, "DELIVERY_ATTEMPTED", {
      deliveryAssignmentId: assignment.id,
      warehouseId: pkg.currentWarehouseId ?? undefined,
      source: "MOBILE",
      notes: data.notes ?? undefined,
    });
    const failedAttempts = await tx.deliveryAttempt.count({
      where: { packageId: pkg.id, result: { not: "DELIVERED" } },
    });
    // Soft delivery exceptions track the latest attempt outcome;
    // hard/return exceptions are owned by the return flow.
    const exceptionFor = ATTEMPT_EXCEPTION_BY_RESULT[data.result];
    if (
      exceptionFor &&
      SOFT_DELIVERY_EXCEPTIONS.includes(pkg.exceptionStatus)
    ) {
      await tx.package.update({
        where: { id: pkg.id },
        data: { exceptionStatus: exceptionFor },
      });
    }
    // Return initiation (delivery-workflow §6–§7): refusal, the
    // attempt limit, or an explicit RETURN_TO_SENDER next action.
    let returnRequest: { id: string; returnNumber: string } | null = null;
    const mustReturn =
      nextAction === "RETURN_TO_SENDER" ||
      data.result === "REFUSED" ||
      failedAttempts >= MAX_DELIVERY_ATTEMPTS;
    if (mustReturn) {
      const openReturn = await tx.returnRequest.findFirst({
        where: {
          packageId: pkg.id,
          status: {
            in: [
              "REQUESTED",
              "APPROVED",
              "COLLECTION_ASSIGNED",
              "COLLECTED",
              "IN_TRANSIT",
              "RECEIVED",
              "INSPECTED",
            ],
          },
        },
        select: { id: true, returnNumber: true },
      });
      returnRequest =
        openReturn ??
        (await createReturnRequestInTx(tx, actor, {
          packageId: pkg.id,
          reason: returnReasonFor(data.result, failedAttempts),
          notes: `Auto-initiated from delivery attempt ${attemptNumber} (${data.result})`,
        }));
    }
    return { attemptNumber, failedAttempts, returnRequest };
  });

  await auditOps(actor, "delivery.attempt_recorded", "DeliveryAssignment", assignment.id, {
    after: {
      result: data.result,
      attemptNumber: outcome.attemptNumber,
      failedAttempts: outcome.failedAttempts,
      returnNumber: outcome.returnRequest?.returnNumber ?? null,
    },
  });
  return {
    assignment: toAssignmentView(await loadAssignmentOr404(assignmentId)),
    attemptNumber: outcome.attemptNumber,
    failedAttempts: outcome.failedAttempts,
    maxAttemptsReached: outcome.failedAttempts >= MAX_DELIVERY_ATTEMPTS,
    returnRequest: outcome.returnRequest,
  };
}

// ---------------------------------------------------------------------------
// Delivery confirmation — POD + OTP + COD (delivery-workflow §5)
// ---------------------------------------------------------------------------

export const confirmDeliverySchema = z.object({
  receivedByName: z.string().min(1).max(200),
  relationshipToRecipient: z.string().max(100).optional().nullable(),
  otpCode: z.string().regex(/^\d{6}$/, "otpCode must be the 6-digit delivery code"),
  codCollectedPaisa: z
    .string()
    .regex(/^\d+$/, "codCollectedPaisa must be a non-negative integer string")
    .optional()
    .nullable(),
  codMethod: z.enum(COD_METHODS).optional(),
  notes: z.string().max(1000).optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
});
export type ConfirmDeliveryInput = z.input<typeof confirmDeliverySchema>;

export interface ConfirmDeliveryResult {
  assignment: DeliveryAssignmentView;
  proofOfDeliveryId: string;
  cod: { expectedPaisa: string; collectedPaisa: string; status: string } | null;
}

export async function confirmDelivery(
  actor: ActorContext,
  assignmentId: string,
  input: ConfirmDeliveryInput,
): Promise<ConfirmDeliveryResult> {
  const data = parse(confirmDeliverySchema, input);
  await requirePermAudited(actor, "delivery.confirm", "DeliveryAssignment");
  const assignment = await loadAssignmentOr404(assignmentId);
  await assertAssignedRider(actor, assignment, "deliver_not_own_assignment");
  if (assignment.status !== "IN_PROGRESS") {
    throw new ConflictError(`Assignment is ${assignment.status} — the package is not out with you`);
  }
  const pkgStatus = assignment.package.operationalStatus;
  if (pkgStatus !== "OUT_FOR_DELIVERY" && pkgStatus !== "DELIVERY_ATTEMPTED") {
    throw new ConflictError(`Package is ${pkgStatus} — it cannot be delivered now`);
  }

  // --- OTP gate (security-architecture §7, delivery-workflow §10).
  // Runs BEFORE the delivery transaction so failure counts persist.
  if (!assignment.otpCodeHash || !assignment.otpExpiresAt) {
    throw new DomainValidationError("No delivery code was generated for this package");
  }
  if (assignment.otpLockedAt) {
    throw new DomainValidationError(
      "The delivery code is locked after too many wrong entries — request a new code",
    );
  }
  if (assignment.otpExpiresAt.getTime() < Date.now()) {
    throw new DomainValidationError("The delivery code has expired — request a new code");
  }
  const otpOk = await verifyOtpCode(data.otpCode, assignment.otpCodeHash);
  if (!otpOk) {
    const failures = assignment.otpFailedAttempts + 1;
    const locksNow = failures >= OTP_MAX_FAILURES;
    await prisma.deliveryAssignment.update({
      where: { id: assignment.id },
      data: {
        otpFailedAttempts: failures,
        ...(locksNow ? { otpLockedAt: new Date() } : {}),
      },
    });
    await auditOps(actor, "delivery.otp_failed", "DeliveryAssignment", assignment.id, {
      after: { failedAttempts: failures, locked: locksNow },
    });
    throw new DomainValidationError(
      locksNow
        ? "Incorrect delivery code — the code is now locked after too many wrong entries; request a new code"
        : "Incorrect delivery code",
    );
  }

  // --- COD gate: exact paisa; a mismatch needs an explanation and
  // is recorded as MISMATCH — never silently accepted (Phase 7 owns
  // the ledger; this records the collection event only).
  const expectedPaisa = assignment.package.codAmountPaisa;
  let collectedPaisa: bigint | null = null;
  if (expectedPaisa > BigInt(0)) {
    if (data.codCollectedPaisa === undefined || data.codCollectedPaisa === null) {
      throw new DomainValidationError(
        "This package has cash on delivery due — record the collected amount",
      );
    }
    collectedPaisa = BigInt(data.codCollectedPaisa);
    if (collectedPaisa !== expectedPaisa && !(data.notes && data.notes.trim().length >= 3)) {
      throw new DomainValidationError(
        "The collected amount differs from the COD amount due — record the mismatch explanation in notes",
      );
    }
  }

  const outcome = await prisma.$transaction(async (tx) => {
    await lockPackageRow(tx, assignment.packageId);
    const pkg = await tx.package.findUniqueOrThrow({ where: { id: assignment.packageId } });
    const freshAssignment = await tx.deliveryAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
      select: { status: true },
    });
    if (freshAssignment.status !== "IN_PROGRESS") {
      throw new ConflictError(`Assignment is ${freshAssignment.status} — it can no longer be delivered`);
    }
    if (pkg.operationalStatus === "DELIVERY_ATTEMPTED") {
      await transitionPackageInTx(tx, actor, pkg.id, "OUT_FOR_DELIVERY", {
        deliveryAssignmentId: assignment.id,
        warehouseId: pkg.currentWarehouseId ?? undefined,
        source: "MOBILE",
      });
    } else if (pkg.operationalStatus !== "OUT_FOR_DELIVERY") {
      throw new ConflictError(`Package is ${pkg.operationalStatus} — it cannot be delivered now`);
    }
    const now = new Date();
    const priorAttempts = await tx.deliveryAttempt.count({ where: { packageId: pkg.id } });
    const attempt = await tx.deliveryAttempt.create({
      data: {
        assignmentId: assignment.id,
        packageId: pkg.id,
        attemptNumber: priorAttempts + 1,
        result: "DELIVERED",
        nextAction: "NONE",
        notes: data.notes ?? null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        recordedById: actor.userId,
      },
    });
    const pod = await tx.proofOfDelivery.create({
      data: {
        packageId: pkg.id,
        assignmentId: assignment.id,
        attemptId: attempt.id,
        method: "OTP",
        receivedByName: data.receivedByName.trim(),
        relationshipToRecipient: data.relationshipToRecipient ?? null,
        otpCodeHash: assignment.otpCodeHash,
        otpExpiresAt: assignment.otpExpiresAt,
        otpVerifiedAt: now,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        deliveredAt: now,
        recordedById: actor.userId,
      },
    });
    let cod: ConfirmDeliveryResult["cod"] = null;
    if (expectedPaisa > BigInt(0) && collectedPaisa !== null) {
      const status = collectedPaisa === expectedPaisa ? "MATCHED" : "MISMATCH";
      await tx.deliveryCodCollection.create({
        data: {
          packageId: pkg.id,
          shipmentId: pkg.shipmentId,
          assignmentId: assignment.id,
          batchId: assignment.batchId,
          expectedPaisa,
          collectedPaisa,
          status,
          method: data.codMethod ?? "CASH",
          collectedById: actor.userId,
          notes: data.notes ?? null,
        },
      });
      cod = {
        expectedPaisa: expectedPaisa.toString(),
        collectedPaisa: collectedPaisa.toString(),
        status,
      };
    }
    const transition = await transitionPackageInTx(tx, actor, pkg.id, "DELIVERED", {
      deliveryAssignmentId: assignment.id,
      warehouseId: pkg.currentWarehouseId ?? undefined,
      source: "MOBILE",
      notes: data.notes ?? undefined,
    });
    if (!transition.transitioned || !transition.eventId) {
      throw new ConflictError("Package could not be moved to DELIVERED");
    }
    // Custody closes rider → RECIPIENT in the same transaction.
    // (Destination inventory already closed at pickup handout —
    // schema doc §6: no open InventoryRecord exists while out.)
    await tx.packageCustody.updateMany({
      where: { packageId: pkg.id, endedAt: null },
      data: { endedAt: now },
    });
    await tx.packageCustody.create({
      data: {
        packageId: pkg.id,
        custodianType: "RECIPIENT",
        trackingEventId: transition.eventId,
      },
    });
    if (cod) {
      await tx.trackingEvent.create({
        data: {
          packageId: pkg.id,
          shipmentId: pkg.shipmentId,
          orderId: pkg.orderId,
          subjectType: "PACKAGE",
          eventType: "COD_COLLECTED",
          previousStatus: "DELIVERED",
          newStatus: "DELIVERED",
          actorId: actor.userId,
          actorRole: actor.primaryRole,
          warehouseId: pkg.currentWarehouseId,
          deliveryAssignmentId: assignment.id,
          notes: cod.status === "MATCHED" ? "COD collected in full" : "COD collected with a recorded mismatch",
        },
      });
    }
    await tx.deliveryAssignment.update({
      where: { id: assignment.id },
      data: {
        status: "COMPLETED",
        completedAt: now,
        otpVerifiedAt: now,
        otpCodeHash: null,
        version: { increment: 1 },
      },
    });
    return { proofOfDeliveryId: pod.id, cod };
  });

  await auditOps(actor, "delivery.confirmed", "DeliveryAssignment", assignment.id, {
    after: { proofOfDeliveryId: outcome.proofOfDeliveryId, codStatus: outcome.cod?.status ?? null },
  });
  return {
    assignment: toAssignmentView(await loadAssignmentOr404(assignmentId)),
    proofOfDeliveryId: outcome.proofOfDeliveryId,
    cod: outcome.cod,
  };
}

// ---------------------------------------------------------------------------
// Warehouse scan-back — undelivered packages return to stock and any
// open return advances to RECEIVED (return-workflow §3.5)
// ---------------------------------------------------------------------------

export const scanBackSchema = z.object({
  warehouseId: z.string().uuid(),
  trackingId: z.string().min(1).max(40),
  condition: z.enum(PACKAGE_CONDITIONS).optional(),
});
export type ScanBackInput = z.input<typeof scanBackSchema>;

export interface ScanBackResult {
  packageId: string;
  trackingId: string;
  status: string;
  assignmentId: string;
  returnRequest: { id: string; returnNumber: string; status: string } | null;
}

export async function scanBackPackage(
  actor: ActorContext,
  input: ScanBackInput,
): Promise<ScanBackResult> {
  const data = parse(scanBackSchema, input);
  await requirePermAudited(actor, "package.receive", "Package");
  const warehouse = await loadWarehouseOr404(data.warehouseId);
  await assertWarehouseScope(actor, warehouse.id, "Package");
  if (warehouse.status !== "ACTIVE") {
    throw new DomainValidationError("Warehouse is not ACTIVE");
  }
  const trackingId = data.trackingId.trim();
  const pkg = await prisma.package.findUnique({ where: { trackingId } });
  if (!pkg) {
    await auditOps(actor, "package.scan_unknown", "Package", null, {
      warehouseId: warehouse.id,
      after: { trackingId },
    });
    throw new NotFoundError("No package with that tracking ID");
  }
  if (pkg.currentWarehouseId !== warehouse.id) {
    await auditAccessDenied(actor, "Package", {
      entityId: pkg.id,
      warehouseId: warehouse.id,
      reason: "scan_back_wrong_warehouse",
    });
    throw new ConflictError(
      `Package ${trackingId} belongs to warehouse ${pkg.currentWarehouseId ?? "—"}, not this one`,
    );
  }
  if (pkg.operationalStatus !== "OUT_FOR_DELIVERY" && pkg.operationalStatus !== "DELIVERY_ATTEMPTED") {
    throw new ConflictError(
      `Package ${trackingId} is ${pkg.operationalStatus} — only packages out with a rider can be scanned back`,
    );
  }
  const assignment = await prisma.deliveryAssignment.findFirst({
    where: { packageId: pkg.id, status: "IN_PROGRESS" },
    orderBy: { createdAt: "desc" },
  });
  if (!assignment) {
    throw new ConflictError(`Package ${trackingId} has no in-progress delivery assignment`);
  }

  const outcome = await prisma.$transaction(async (tx) => {
    await lockPackageRow(tx, pkg.id);
    const fresh = await tx.package.findUniqueOrThrow({ where: { id: pkg.id } });
    if (fresh.operationalStatus !== "OUT_FOR_DELIVERY" && fresh.operationalStatus !== "DELIVERY_ATTEMPTED") {
      throw new ConflictError(`Package is ${fresh.operationalStatus} — it can no longer be scanned back`);
    }
    const openReturn = await tx.returnRequest.findFirst({
      where: {
        packageId: pkg.id,
        status: { in: ["REQUESTED", "APPROVED"] },
      },
      orderBy: { createdAt: "asc" },
    });
    const zoneType = openReturn ? "RETURNS" : "RECEIVING";
    const zone = await tx.warehouseZone.findFirst({
      where: { warehouseId: warehouse.id, kind: zoneType, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    const location = zone
      ? await tx.storageLocation.findFirst({
          where: { zoneId: zone.id, isActive: true },
          orderBy: { createdAt: "asc" },
        })
      : null;
    if (!location) {
      throw new DomainValidationError(
        `Warehouse has no active ${zoneType} location to receive the package into`,
      );
    }
    const now = new Date();
    const transition = await transitionPackageInTx(tx, actor, pkg.id, "READY_FOR_DELIVERY", {
      deliveryAssignmentId: assignment.id,
      warehouseId: warehouse.id,
    });
    if (!transition.transitioned || !transition.eventId) {
      throw new ConflictError("Package could not be moved back to READY_FOR_DELIVERY");
    }
    // Custody rider → warehouse (the scan IS the physical handover).
    await tx.packageCustody.updateMany({
      where: { packageId: pkg.id, endedAt: null },
      data: { endedAt: now },
    });
    await tx.packageCustody.create({
      data: {
        packageId: pkg.id,
        custodianType: "WAREHOUSE",
        warehouseId: warehouse.id,
        storageLocationId: location.id,
        trackingEventId: transition.eventId,
      },
    });
    // Inventory reopens (return-workflow §3.5).
    const record = await tx.inventoryRecord.create({
      data: {
        packageId: pkg.id,
        warehouseId: warehouse.id,
        storageLocationId: location.id,
        receivingEventId: transition.eventId,
        receivedById: actor.userId,
        conditionOnArrival: data.condition ?? fresh.condition,
      },
    });
    await tx.inventoryMovement.create({
      data: {
        packageId: pkg.id,
        inventoryRecordId: record.id,
        type: "RETURN_RECEIVING",
        toWarehouseId: warehouse.id,
        toLocationId: location.id,
        actorId: actor.userId,
        trackingEventId: transition.eventId,
        reason: openReturn
          ? `Return ${openReturn.returnNumber} received back from rider`
          : "Undelivered package scanned back from rider",
      },
    });
    await tx.deliveryAssignment.update({
      where: { id: assignment.id },
      data: {
        status: "FAILED",
        completedAt: now,
        failureNote: "RETURNED_TO_WAREHOUSE — scanned back at the warehouse",
        otpCodeHash: null,
        version: { increment: 1 },
      },
    });
    let advancedReturn: ScanBackResult["returnRequest"] = null;
    if (openReturn) {
      await tx.returnRequest.update({
        where: { id: openReturn.id },
        data: { status: "RECEIVED", receivedById: actor.userId, receivedAt: now },
      });
      await tx.package.update({
        where: { id: pkg.id },
        data: { deliveryStatus: "RETURNED_TO_WAREHOUSE" },
      });
      await tx.trackingEvent.create({
        data: {
          packageId: pkg.id,
          shipmentId: fresh.shipmentId,
          orderId: fresh.orderId,
          subjectType: "PACKAGE",
          eventType: "RETURN_RECEIVED",
          previousStatus: "READY_FOR_DELIVERY",
          newStatus: "READY_FOR_DELIVERY",
          actorId: actor.userId,
          actorRole: actor.primaryRole,
          warehouseId: warehouse.id,
          notes: `Return ${openReturn.returnNumber} received at the warehouse`,
        },
      });
      advancedReturn = {
        id: openReturn.id,
        returnNumber: openReturn.returnNumber,
        status: "RECEIVED",
      };
    }
    return { advancedReturn };
  });

  await auditOps(actor, "delivery.scan_back", "Package", pkg.id, {
    warehouseId: warehouse.id,
    after: { assignmentId: assignment.id, returnNumber: outcome.advancedReturn?.returnNumber ?? null },
  });
  return {
    packageId: pkg.id,
    trackingId,
    status: "READY_FOR_DELIVERY",
    assignmentId: assignment.id,
    returnRequest: outcome.advancedReturn,
  };
}

// ---------------------------------------------------------------------------
// End-of-day batch closure (delivery-workflow §8): every package
// must be accounted for — delivered, formally returned, or formally
// rescheduled (assignment terminal + package physically back).
// ---------------------------------------------------------------------------

export interface CloseBatchResult {
  batch: DeliveryBatchView;
  delivered: number;
  returnedOrBack: number;
  cancelledOrReassigned: number;
}

export async function closeBatch(
  actor: ActorContext,
  batchId: string,
): Promise<CloseBatchResult> {
  const batch = await loadBatchOr404(batchId);
  const isRider = actor.driverId === batch.riderId;
  if (!isRider) {
    await requirePermAudited(actor, "delivery.assign", "DeliveryBatch");
    await assertWarehouseScope(actor, batch.warehouseId, "DeliveryBatch", batch.id);
  }
  if (batch.status === "COMPLETED") {
    throw new ConflictError("Batch is already closed");
  }
  if (batch.status === "CANCELLED") {
    throw new ConflictError("Batch was cancelled");
  }

  const outcome = await prisma.$transaction(async (tx) => {
    // Batch row lock first, then recount from the assignment rows
    // inside the transaction (P4-1/P5-5: never close from a
    // pre-transaction snapshot).
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "app"."DeliveryBatch" WHERE "id" = ${batch.id} FOR UPDATE`,
    );
    const fresh = await tx.deliveryBatch.findUniqueOrThrow({ where: { id: batch.id } });
    if (fresh.status === "COMPLETED" || fresh.status === "CANCELLED") {
      throw new ConflictError(`Batch is ${fresh.status} — it cannot be closed`);
    }
    const assignments = await tx.deliveryAssignment.findMany({
      where: { batchId: batch.id },
      include: {
        package: {
          select: {
            trackingId: true,
            inventoryRecords: {
              where: { releasedAt: null, warehouseId: batch.warehouseId },
              select: { id: true },
            },
            returnRequests: {
              where: { status: { in: ["RECEIVED", "INSPECTED", "COMPLETED"] } },
              select: { id: true },
            },
          },
        },
      },
    });
    const unaccounted: string[] = [];
    let delivered = 0;
    let returnedOrBack = 0;
    let cancelledOrReassigned = 0;
    for (const a of assignments) {
      if (a.status === "COMPLETED") {
        delivered += 1;
      } else if (a.status === "CANCELLED" || a.status === "REASSIGNED") {
        cancelledOrReassigned += 1;
      } else if (a.status === "FAILED") {
        // A failed assignment accounts for its package only when
        // the package is physically back: in stock here, or its
        // return was received. A pickup shortage (package never
        // left, still DELIVERY_ASSIGNED) also counts: stock is
        // open at this warehouse.
        if (a.package.inventoryRecords.length > 0 || a.package.returnRequests.length > 0) {
          returnedOrBack += 1;
        } else {
          unaccounted.push(a.package.trackingId);
        }
      } else {
        unaccounted.push(a.package.trackingId);
      }
    }
    if (unaccounted.length > 0) {
      throw new ConflictError(
        `Batch cannot close — ${unaccounted.length} package(s) unaccounted for: ${unaccounted.join(", ")}. Every package must be delivered, scanned back, or formally returned first.`,
      );
    }
    const now = new Date();
    await tx.deliveryBatch.update({
      where: { id: batch.id },
      data: { status: "COMPLETED", closedAt: now, closedById: actor.userId },
    });
    const otherOpen = await tx.deliveryBatch.count({
      where: { riderId: batch.riderId, status: "IN_PROGRESS", id: { not: batch.id } },
    });
    if (otherOpen === 0) {
      await tx.driver.updateMany({
        where: { id: batch.riderId, availabilityStatus: "ON_DELIVERY" },
        data: { availabilityStatus: "AVAILABLE" },
      });
    }
    return { delivered, returnedOrBack, cancelledOrReassigned };
  });

  await auditOps(actor, "delivery.batch_closed", "DeliveryBatch", batch.id, {
    warehouseId: batch.warehouseId,
    after: outcome,
  });
  return { batch: toBatchView(await loadBatchOr404(batchId)), ...outcome };
}

// ---------------------------------------------------------------------------
// Reads — dispatch side
// ---------------------------------------------------------------------------

export interface DeliveryRiderOption {
  userId: string;
  driverId: string;
  fullName: string;
  availabilityStatus: string;
  blockers: string[];
}

/** Users who can take a delivery batch at a warehouse (feeds the
 *  create-batch form): RIDER-role users with a Driver profile linked
 *  to the warehouse, with eligibility blockers spelled out instead
 *  of silently hiding people. */
export async function listDeliveryRiders(
  actor: ActorContext,
  warehouseId: string,
): Promise<DeliveryRiderOption[]> {
  await requirePermAudited(actor, "delivery.assign", "DeliveryBatch");
  await assertWarehouseScope(actor, warehouseId, "DeliveryBatch");
  const users = await prisma.user.findMany({
    where: {
      roles: { some: { role: { code: "RIDER" } } },
      driverProfile: { isNot: null },
    },
    include: {
      driverProfile: { include: { capabilities: true } },
      memberships: {
        where: { warehouseId, revokedAt: null },
        select: { id: true },
      },
    },
    orderBy: { fullName: "asc" },
  });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const options: DeliveryRiderOption[] = [];
  for (const user of users) {
    const driver = user.driverProfile;
    if (!driver) continue;
    const linked = driver.homeWarehouseId === warehouseId || user.memberships.length > 0;
    if (!linked) continue;
    const blockers: string[] = [];
    if (user.status !== "ACTIVE") blockers.push("Account is not active");
    if (driver.employmentStatus !== "ACTIVE") {
      blockers.push(`Employment status is ${driver.employmentStatus}`);
    }
    if (driver.licenseExpiry < today) blockers.push("Driving licence has expired");
    if (!driver.capabilities.some((c) => c.capability === "DELIVERY")) {
      blockers.push("Lacks the DELIVERY capability");
    }
    options.push({
      userId: user.id,
      driverId: driver.id,
      fullName: user.fullName,
      availabilityStatus: driver.availabilityStatus,
      blockers,
    });
  }
  return options;
}

export interface ListBatchesQuery {
  warehouseId?: string;
  riderUserId?: string;
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export async function listDeliveryBatches(
  actor: ActorContext,
  query: ListBatchesQuery = {},
): Promise<{ items: DeliveryBatchView[]; meta: ReturnType<typeof pageMeta> }> {
  const conditions: Prisma.DeliveryBatchWhereInput[] = [];
  if (actor.driverId && !isUnscoped(actor) && actor.warehouseIds.length === 0) {
    // Rider: own batches only.
    conditions.push({ riderId: actor.driverId });
  } else if (!isUnscoped(actor)) {
    conditions.push({ warehouseId: { in: actor.warehouseIds } });
  }
  if (query.warehouseId) {
    if (!isUnscoped(actor) && !actor.warehouseIds.includes(query.warehouseId) && actor.driverId) {
      // riders may still pass their own warehouse; scope condition above governs
    }
    conditions.push({ warehouseId: query.warehouseId });
  }
  if (query.riderUserId) {
    const driver = await prisma.driver.findUnique({
      where: { userId: query.riderUserId },
      select: { id: true },
    });
    conditions.push({ riderId: driver?.id ?? "__none__" });
  }
  if (query.status) conditions.push({ status: query.status });
  if (query.search) {
    const term = query.search.trim();
    if (term) {
      conditions.push({
        OR: [
          { rider: { user: { fullName: { contains: term, mode: "insensitive" } } } },
          { warehouse: { code: { contains: term, mode: "insensitive" } } },
        ],
      });
    }
  }
  const where: Prisma.DeliveryBatchWhereInput =
    conditions.length > 0 ? { AND: conditions } : {};
  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  const [total, rows] = await Promise.all([
    prisma.deliveryBatch.count({ where }),
    prisma.deliveryBatch.findMany({
      where,
      include: batchInclude,
      orderBy: [{ batchDate: "desc" }, { createdAt: "desc" }],
      skip,
      take,
    }),
  ]);
  return { items: rows.map(toBatchView), meta: pageMeta(total, page, pageSize) };
}

export async function getDeliveryBatch(
  actor: ActorContext,
  batchId: string,
): Promise<{ batch: DeliveryBatchView; assignments: DeliveryAssignmentView[] }> {
  const batch = await loadBatchOr404(batchId);
  await assertBatchVisible(actor, batch);
  const rows = await prisma.deliveryAssignment.findMany({
    where: { batchId: batch.id },
    include: assignmentInclude,
    orderBy: [{ routeSequence: "asc" }, { createdAt: "asc" }],
  });
  return { batch: toBatchView(batch), assignments: rows.map(toAssignmentView) };
}

export interface ListEligibleQuery {
  search?: string;
  page?: number;
  pageSize?: number;
}

/** Packages that can be assigned for delivery at a warehouse right
 *  now: ready (or wireable to ready), in stock here, not blocked by
 *  an exception, not already assigned, not under an open return. */
export async function listEligibleDeliveryPackages(
  actor: ActorContext,
  warehouseId: string,
  query: ListEligibleQuery = {},
): Promise<{
  items: {
    packageId: string;
    trackingId: string;
    status: string;
    recipientName: string;
    destinationCity: string | null;
    destinationDistrict: string | null;
    codAmountPaisa: string;
  }[];
  meta: ReturnType<typeof pageMeta>;
}> {
  await requirePermAudited(actor, "delivery.assign", "DeliveryBatch");
  await assertWarehouseScope(actor, warehouseId, "DeliveryBatch");
  const conditions: Prisma.PackageWhereInput[] = [
    { currentWarehouseId: warehouseId },
    {
      OR: [
        { operationalStatus: STATUS_READY_FOR_DELIVERY },
        { operationalStatus: STATUS_RECEIVED_AT_DESTINATION },
        {
          AND: [
            { operationalStatus: STATUS_READY_FOR_DISPATCH },
            { shipment: { destinationWarehouseId: warehouseId } },
          ],
        },
        { operationalStatus: STATUS_DELIVERY_ASSIGNED },
      ],
    },
    { exceptionStatus: { notIn: [...ASSIGNMENT_BLOCKING_EXCEPTIONS] } },
    { inventoryRecords: { some: { warehouseId, releasedAt: null } } },
    {
      deliveryAssignments: {
        none: { kind: "DELIVERY", status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
      },
    },
    {
      returnRequests: {
        none: {
          status: {
            in: [
              "REQUESTED",
              "APPROVED",
              "COLLECTION_ASSIGNED",
              "COLLECTED",
              "IN_TRANSIT",
              "RECEIVED",
              "INSPECTED",
            ],
          },
        },
      },
    },
  ];
  if (query.search) {
    const term = query.search.trim();
    if (term) {
      conditions.push({
        OR: [
          { trackingId: { contains: term, mode: "insensitive" } },
          { recipientName: { contains: term, mode: "insensitive" } },
          { recipientPhone: { contains: term } },
        ],
      });
    }
  }
  const where: Prisma.PackageWhereInput = { AND: conditions };
  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  const [total, rows] = await Promise.all([
    prisma.package.count({ where }),
    prisma.package.findMany({
      where,
      orderBy: { updatedAt: "asc" },
      skip,
      take,
      select: {
        id: true,
        trackingId: true,
        operationalStatus: true,
        recipientName: true,
        deliveryCity: true,
        deliveryDistrict: true,
        codAmountPaisa: true,
      },
    }),
  ]);
  return {
    items: rows.map((r) => ({
      packageId: r.id,
      trackingId: r.trackingId,
      status: r.operationalStatus,
      recipientName: r.recipientName,
      destinationCity: r.deliveryCity,
      destinationDistrict: r.deliveryDistrict,
      codAmountPaisa: r.codAmountPaisa.toString(),
    })),
    meta: pageMeta(total, page, pageSize),
  };
}

// ---------------------------------------------------------------------------
// Reads — rider side (own assignments ONLY; recipient contact details
// are exposed exclusively through these functions)
// ---------------------------------------------------------------------------

export async function listRiderBatches(
  actor: ActorContext,
  query: { date?: string } = {},
): Promise<DeliveryBatchView[]> {
  if (!actor.driverId) {
    throw new AuthorizationError("Only riders have delivery batches");
  }
  const where: Prisma.DeliveryBatchWhereInput = { riderId: actor.driverId };
  if (query.date) {
    where.batchDate = new Date(`${query.date}T00:00:00.000Z`);
  }
  const rows = await prisma.deliveryBatch.findMany({
    where,
    include: batchInclude,
    orderBy: [{ batchDate: "desc" }, { createdAt: "desc" }],
    take: 50,
  });
  return rows.map(toBatchView);
}

export async function getRiderBatch(
  actor: ActorContext,
  batchId: string,
): Promise<{ batch: DeliveryBatchView; assignments: RiderAssignmentView[] }> {
  const batch = await loadBatchOr404(batchId);
  await assertAssignedRider(actor, { id: batch.id, driverId: batch.riderId }, "batch_not_own");
  const rows = await prisma.deliveryAssignment.findMany({
    where: { batchId: batch.id },
    include: assignmentInclude,
    orderBy: [{ routeSequence: "asc" }, { createdAt: "asc" }],
  });
  return { batch: toBatchView(batch), assignments: rows.map(toRiderAssignmentView) };
}

export interface RiderDaySummary {
  date: string;
  batches: number;
  assigned: number;
  outForDelivery: number;
  delivered: number;
  failedOrReturned: number;
  codExpectedPaisa: string;
  codCollectedPaisa: string;
  codMismatches: number;
  openBatches: number;
}

/** End-of-day rider reconciliation summary (delivery-workflow §8),
 *  computed from the rider's own assignment + collection rows. */
export async function getRiderDaySummary(
  actor: ActorContext,
  date?: string,
): Promise<RiderDaySummary> {
  if (!actor.driverId) {
    throw new AuthorizationError("Only riders have a delivery day summary");
  }
  const day = date ?? new Date().toISOString().slice(0, 10);
  const batches = await prisma.deliveryBatch.findMany({
    where: { riderId: actor.driverId, batchDate: new Date(`${day}T00:00:00.000Z`) },
    select: { id: true, status: true },
  });
  const batchIds = batches.map((b) => b.id);
  const assignments = batchIds.length
    ? await prisma.deliveryAssignment.findMany({
        where: { batchId: { in: batchIds } },
        include: {
          package: { select: { codAmountPaisa: true } },
          codCollection: { select: { collectedPaisa: true, status: true } },
        },
      })
    : [];
  let assigned = 0;
  let outForDelivery = 0;
  let delivered = 0;
  let failedOrReturned = 0;
  let codExpected = BigInt(0);
  let codCollected = BigInt(0);
  let codMismatches = 0;
  for (const a of assignments) {
    assigned += 1;
    if (a.status === "IN_PROGRESS") outForDelivery += 1;
    if (a.status === "COMPLETED") delivered += 1;
    if (a.status === "FAILED") failedOrReturned += 1;
    if (a.status === "IN_PROGRESS" || a.status === "COMPLETED") {
      codExpected += a.package.codAmountPaisa;
    }
    if (a.codCollection) {
      codCollected += a.codCollection.collectedPaisa;
      if (a.codCollection.status === "MISMATCH") codMismatches += 1;
    }
  }
  return {
    date: day,
    batches: batches.length,
    assigned,
    outForDelivery,
    delivered,
    failedOrReturned,
    codExpectedPaisa: codExpected.toString(),
    codCollectedPaisa: codCollected.toString(),
    codMismatches,
    openBatches: batches.filter((b) => b.status === "OPEN" || b.status === "IN_PROGRESS").length,
  };
}

export { DELIVERY_ASSIGNMENT_STATUSES };
