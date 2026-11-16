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
import { normalizePhone } from "@/lib/bookings/phone";
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
  createNotificationInTx,
  notifyUsersInTx,
} from "@/server/services/notifications";
import { raiseIncidentInTx } from "@/server/services/incidents";
import { endTrackingSessionsInTx } from "@/server/services/tracking";
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
 * as a bcrypt hash on the assignment, expires after OTP_TTL_MS, and
 * locks after OTP_MAX_FAILURES wrong entries (delivery-workflow
 * §10). Phase 8 closed the Phase 6 review's P6-R1 finding: the
 * plaintext code is NEVER returned to the rider or any staff API.
 * At generation it is delivered to the RECIPIENT through the
 * notification system (a Notification addressed to the recipient's
 * phone, retrievable only through the phone-verified detailed
 * tracking view) — the rider asks the recipient for the code at the
 * door (delivery-workflow.md line 112). The only plaintext copy is
 * the recipient's own notification payload; staff notification
 * lists never surface recipient rows.
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

/** Lock the DeliveryAssignment row inside the caller's transaction
 *  (Phase 6 review P6-R2: OTP state — hash, failure counter, lock —
 *  is mutated by both confirmDelivery and regenerateOtp; the two
 *  must serialise on the assignment row, always taken AFTER the
 *  Package row lock, so the POD can never be written against a
 *  hash that a concurrent regeneration has already replaced). */
async function lockAssignmentRow(
  tx: Prisma.TransactionClient,
  assignmentId: string,
): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "app"."DeliveryAssignment" WHERE "id" = ${assignmentId} FOR UPDATE`,
  );
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

/** Scan-back of a package that is OUT FOR DELIVERY severs the
 *  rider's custody on a tracking ID alone (Phase 6 review P6-R7):
 *  it is restricted to a Warehouse Admin OF THAT WAREHOUSE (P2-4
 *  membership-role rule, same as return authorisation) or an
 *  unscoped actor. Ordinary warehouse staff keep scan-back for
 *  packages that are not out with a rider. Denials are audited. */
async function assertScanBackAdmin(
  actor: ActorContext,
  warehouseId: string,
  packageId: string,
): Promise<void> {
  if (isUnscoped(actor)) return;
  const isWa = actor.membershipRoles.some(
    (m) => m.warehouseId === warehouseId && m.roleCode === "WAREHOUSE_ADMIN",
  );
  if (isWa) return;
  await auditAccessDenied(actor, "Package", {
    entityId: packageId,
    warehouseId,
    reason: "scan_back_out_for_delivery_requires_warehouse_admin",
  });
  throw new AuthorizationError(
    "Scanning back a package that is out for delivery requires a Warehouse Admin of this warehouse",
  );
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
        // Phase 8 trigger: delivery assignment notifies the rider,
        // in the assignment transaction.
        const rider = await tx.driver.findUnique({
          where: { id: batch.riderId },
          select: { userId: true },
        });
        if (rider?.userId && rider.userId !== actor.userId) {
          await notifyUsersInTx(tx, [rider.userId], {
            category: "DELIVERY_ASSIGNED",
            title: `Delivery assigned: ${pkg.trackingId}`,
            body: `Package ${pkg.trackingId} was added to your delivery batch.`,
            entityType: "DeliveryAssignment",
            entityId: assignment.id,
            dedupeKey: `delivery-assigned:${assignment.id}`,
          });
        }
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
    // Re-validate under the lock (Phase 6 review P6-R3, the P5-5
    // stale-snapshot class): the pre-transaction status check above
    // races a concurrent pickup — cancelling on the stale snapshot
    // left an assignment CANCELLED while its package was
    // OUT_FOR_DELIVERY in the rider's custody. Mirror
    // reassignAssignment: re-read and refuse if the status moved.
    const fresh = await tx.deliveryAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
      select: { status: true },
    });
    if (fresh.status !== "PENDING" && fresh.status !== "ACCEPTED") {
      throw new ConflictError(
        `Assignment is ${fresh.status} — only PENDING/ACCEPTED assignments can be cancelled`,
      );
    }
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
    // Phase 8 trigger: the new rider is notified in-transaction.
    if (rider.userId !== actor.userId) {
      await notifyUsersInTx(tx, [rider.userId], {
        category: "DELIVERY_ASSIGNED",
        title: `Delivery assigned: ${assignment.package.trackingId}`,
        body: `Package ${assignment.package.trackingId} was reassigned to you.`,
        entityType: "DeliveryAssignment",
        entityId: created.id,
        dedupeKey: `delivery-assigned:${created.id}`,
      });
    }
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

export const reassignBatchSchema = z.object({
  riderUserId: z.string().uuid(),
  reason: z.string().min(3).max(500),
});
export type ReassignBatchInput = z.input<typeof reassignBatchSchema>;

export interface ReassignBatchResult {
  previousBatch: DeliveryBatchView;
  batch: DeliveryBatchView;
  assignments: DeliveryAssignmentView[];
  moved: { pending: number; accepted: number; inProgress: number; total: number };
  oldBatchClosed: boolean;
}

/**
 * Whole-batch rider swap (Phase 7 reassignment): every still-active
 * assignment (PENDING / ACCEPTED / IN_PROGRESS) on the batch moves
 * to a new rider, in ONE transaction. Per-package reassignAssignment
 * cannot do this: it only handles not-yet-collected assignments and
 * creates one batch per package.
 *
 * Race safety: the transaction locks the DeliveryBatch row first,
 * then every candidate Package row (and its assignment row) in
 * packageId-sorted order — the same package-before-assignment order
 * confirmDelivery uses — and re-reads all state under those locks.
 * A concurrent confirmDelivery on an IN_PROGRESS assignment of this
 * batch therefore serialises with the swap: whichever transaction
 * takes the package lock first wins, and the loser re-reads the
 * assignment as terminal (COMPLETED vs REASSIGNED) and refuses.
 *
 * Collected (IN_PROGRESS) packages: custody moves old rider → new
 * rider in-transaction, exactly as confirmPickup writes it (close
 * the open row, open a USER custody for the new rider linked to a
 * CUSTODY_TRANSFERRED tracking event — the reassignment reference
 * the custody model supports), and a FRESH delivery OTP is minted
 * for the new assignment and delivered to the recipient through the
 * same notification intent confirmPickup emits
 * (deliverOtpToRecipientInTx). The old assignment's hash is cleared
 * and the old assignment is terminal, so the old code can never
 * confirm the new assignment.
 *
 * Old-batch closure: after the swap every assignment that was
 * active is REASSIGNED, so the old batch closes in-transaction with
 * closeBatch's terminal writes (COMPLETED + closedAt/closedById +
 * rider availability release) ONLY when no active assignment
 * remains AND no delivered-COD close-out is pending on it. The case
 * that leaves the old batch OPEN is a batch on which the old rider
 * already DELIVERED packages whose COD collections are not yet on a
 * verified/closed remittance (or, racily, an assignment added while
 * the swap ran): the batch must stay open so the old rider's
 * end-of-day COD reconciliation stays attached to the batch they
 * collected it on; a dispatcher closes it with closeBatch once the
 * COD close-out settles. Its tracking session is ended either way.
 */
export async function reassignBatch(
  actor: ActorContext,
  batchId: string,
  input: ReassignBatchInput,
): Promise<ReassignBatchResult> {
  const data = parse(reassignBatchSchema, input);
  const reason = data.reason.trim();
  if (reason.length < 3) {
    throw new DomainValidationError("A reason of at least 3 characters is required");
  }
  await requirePermAudited(actor, "delivery.assign", "DeliveryBatch");
  const batch = await loadBatchOr404(batchId);
  await assertWarehouseScope(actor, batch.warehouseId, "DeliveryBatch", batch.id);
  if (batch.status === "COMPLETED" || batch.status === "CANCELLED") {
    throw new ConflictError(
      `Batch is ${batch.status} — a closed or cancelled batch cannot be reassigned`,
    );
  }
  if (batch.status !== "OPEN" && batch.status !== "IN_PROGRESS") {
    throw new ConflictError(`Batch is ${batch.status} — it cannot be reassigned`);
  }
  const rider = await loadEligibleRider(prisma, data.riderUserId, batch.warehouseId, batch.kind);
  if (rider.driverId === batch.riderId) {
    throw new DomainValidationError("The batch is already assigned to this rider");
  }
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const outcome = await prisma.$transaction(
    async (tx) => {
      // Batch row lock first, then package rows in sorted order
      // (see the race note above); all state below is re-read
      // inside the transaction under those locks.
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "app"."DeliveryBatch" WHERE "id" = ${batch.id} FOR UPDATE`,
      );
      const freshBatch = await tx.deliveryBatch.findUniqueOrThrow({
        where: { id: batch.id },
      });
      if (freshBatch.status !== "OPEN" && freshBatch.status !== "IN_PROGRESS") {
        throw new ConflictError(
          `Batch is ${freshBatch.status} — it can no longer be reassigned`,
        );
      }
      // Eligibility is re-checked in-transaction (the pre-transaction
      // call is a fast path): licence/employment may have changed,
      // and the new rider must differ from the CURRENT batch rider.
      const freshRider = await loadEligibleRider(
        tx,
        data.riderUserId,
        freshBatch.warehouseId,
        freshBatch.kind,
      );
      if (freshRider.driverId === freshBatch.riderId) {
        throw new DomainValidationError("The batch is already assigned to this rider");
      }
      const oldRider = await tx.driver.findUniqueOrThrow({
        where: { id: freshBatch.riderId },
        select: { userId: true, user: { select: { fullName: true } } },
      });

      const candidates = await tx.deliveryAssignment.findMany({
        where: { batchId: batch.id, status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
        select: { id: true, packageId: true },
        orderBy: { packageId: "asc" },
      });
      for (const candidate of candidates) {
        await lockPackageRow(tx, candidate.packageId);
        await lockAssignmentRow(tx, candidate.id);
      }
      const freshAssignments = await tx.deliveryAssignment.findMany({
        where: { batchId: batch.id, id: { in: candidates.map((c) => c.id) } },
        include: {
          package: {
            select: {
              trackingId: true,
              recipientPhone: true,
              recipientCustomerId: true,
              shipmentId: true,
              orderId: true,
              operationalStatus: true,
            },
          },
        },
        orderBy: { packageId: "asc" },
      });
      const movable = freshAssignments.filter((a) =>
        (ACTIVE_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status),
      );
      if (movable.length === 0) {
        // The race loser lands here: every active assignment moved
        // to a terminal state (e.g. a delivery just confirmed) while
        // this transaction waited on the package locks.
        throw new ConflictError(
          "Batch has no active assignments left to reassign — they may have just been completed or cancelled",
        );
      }

      const now = new Date();
      const hasInProgress = movable.some((a) => a.status === "IN_PROGRESS");
      const newBatch = await tx.deliveryBatch.create({
        data: {
          riderId: freshRider.driverId,
          warehouseId: freshBatch.warehouseId,
          serviceAreaId: freshBatch.serviceAreaId,
          batchDate: today,
          kind: freshBatch.kind,
          // A batch holding already-collected packages is in
          // progress, exactly as confirmPickup leaves it.
          status: hasInProgress ? "IN_PROGRESS" : "OPEN",
          createdById: actor.userId,
        },
      });

      const moved = { pending: 0, accepted: 0, inProgress: 0, total: movable.length };
      const newAssignmentIds: string[] = [];
      for (const a of movable) {
        const isInProgress = a.status === "IN_PROGRESS";
        if (a.status === "PENDING") moved.pending += 1;
        else if (a.status === "ACCEPTED") moved.accepted += 1;
        else if (isInProgress) moved.inProgress += 1;

        // Fresh OTP material for collected packages, minted before
        // the new assignment row exists so the hash lands on it in
        // one write (confirmPickup's generation shape).
        let otp: string | null = null;
        let otpHash: string | null = null;
        if (isInProgress) {
          otp = generateOtpCode();
          otpHash = await hashOtpCode(otp);
        }

        await tx.deliveryAssignment.update({
          where: { id: a.id },
          data: {
            status: "REASSIGNED",
            completedAt: now,
            failureNote: reason,
            // The old code dies with the old assignment.
            otpCodeHash: null,
            version: { increment: 1 },
          },
        });
        const created = await tx.deliveryAssignment.create({
          data: {
            packageId: a.packageId,
            driverId: freshRider.driverId,
            batchId: newBatch.id,
            kind: a.kind,
            status: a.status,
            assignedById: actor.userId,
            reassignedFromId: a.id,
            routeSequence: a.routeSequence,
            deliveryInstructions: a.deliveryInstructions,
            vehicleId: a.vehicleId,
            acceptedAt: a.acceptedAt,
            startedAt: isInProgress ? a.startedAt : null,
            otpCodeHash: otpHash,
            otpGeneratedAt: isInProgress ? now : null,
            otpExpiresAt: isInProgress ? new Date(now.getTime() + OTP_TTL_MS) : null,
            otpFailedAttempts: 0,
            otpLockedAt: null,
            otpVerifiedAt: null,
          },
        });
        newAssignmentIds.push(created.id);

        if (isInProgress) {
          // Custody transfer, mirroring confirmPickup's writes:
          // close the old rider's open row, open a USER custody for
          // the new rider. The linking tracking event is the
          // CUSTODY_TRANSFERRED record the handover flow also uses.
          const open = await tx.packageCustody.findFirst({
            where: { packageId: a.packageId, endedAt: null },
          });
          if (
            !open ||
            open.custodianType !== "USER" ||
            open.custodianUserId !== oldRider.userId
          ) {
            throw new ConflictError(
              `Package ${a.package.trackingId} is IN_PROGRESS but is not in the current rider's custody — batch reassignment halted`,
            );
          }
          await tx.packageCustody.update({
            where: { id: open.id },
            data: { endedAt: now },
          });
          const event = await tx.trackingEvent.create({
            data: {
              packageId: a.packageId,
              shipmentId: a.package.shipmentId,
              orderId: a.package.orderId,
              subjectType: "PACKAGE",
              eventType: "CUSTODY_TRANSFERRED",
              previousStatus: a.package.operationalStatus,
              newStatus: a.package.operationalStatus,
              actorId: actor.userId,
              actorRole: actor.primaryRole,
              warehouseId: freshBatch.warehouseId,
              deliveryAssignmentId: created.id,
              source: "WEB",
              notes: `Custody reassigned from ${oldRider.user.fullName} to ${freshRider.fullName} (batch reassignment): ${reason}`,
            },
          });
          await tx.packageCustody.create({
            data: {
              packageId: a.packageId,
              custodianType: "USER",
              custodianUserId: freshRider.userId,
              trackingEventId: event.id,
            },
          });
          // The fresh code goes to the RECIPIENT through the same
          // notification intent confirmPickup emits, in this
          // transaction — if the swap rolls back, no code was ever
          // delivered for the new assignment.
          await deliverOtpToRecipientInTx(tx, {
            assignmentId: created.id,
            trackingId: a.package.trackingId,
            recipientPhone: a.package.recipientPhone,
            recipientCustomerId: a.package.recipientCustomerId,
            otp: otp!,
            generatedAt: now,
          });
        }

        // Phase 8 trigger, mirrored from reassignAssignment: the new
        // rider is notified in-transaction, per package.
        if (freshRider.userId !== actor.userId) {
          await notifyUsersInTx(tx, [freshRider.userId], {
            category: "DELIVERY_ASSIGNED",
            title: `Delivery assigned: ${a.package.trackingId}`,
            body: `Package ${a.package.trackingId} was reassigned to you.`,
            entityType: "DeliveryAssignment",
            entityId: created.id,
            dedupeKey: `delivery-assigned:${created.id}`,
          });
        }
      }

      // The old rider's live tracking belonged to the old batch;
      // it ends here with the reassignment reason, in-transaction.
      await endTrackingSessionsInTx(tx, { deliveryBatchId: batch.id }, "REASSIGNED");
      if (oldRider.userId !== actor.userId) {
        await notifyUsersInTx(tx, [oldRider.userId], {
          category: "GENERAL",
          title: "Delivery batch reassigned",
          body: `${movable.length} package(s) from your delivery batch were reassigned to ${freshRider.fullName}. Reason: ${reason}`,
          entityType: "DeliveryBatch",
          entityId: batch.id,
          dedupeKey: `delivery-batch-reassigned-away:${batch.id}:${newBatch.id}`,
        });
      }
      if (hasInProgress) {
        // Mirror confirmPickup: a rider holding collected packages
        // is ON_DELIVERY.
        await tx.driver.updateMany({
          where: { id: freshRider.driverId, availabilityStatus: "AVAILABLE" },
          data: { availabilityStatus: "ON_DELIVERY" },
        });
      }

      // Old-batch closure (see the function doc comment for the
      // rule and the case that leaves the batch OPEN).
      const remainingActive = await tx.deliveryAssignment.count({
        where: { batchId: batch.id, status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
      });
      const collections = await tx.deliveryCodCollection.findMany({
        where: { batchId: batch.id },
        include: {
          remittanceLines: {
            include: { remittance: { select: { status: true } } },
          },
        },
      });
      const codCloseoutPending = collections.some((c) => {
        const line = c.remittanceLines[0];
        return (
          !line ||
          (line.remittance.status !== "VERIFIED" && line.remittance.status !== "CLOSED")
        );
      });
      let oldBatchClosed = false;
      if (remainingActive === 0 && !codCloseoutPending) {
        await tx.deliveryBatch.update({
          where: { id: batch.id },
          data: { status: "COMPLETED", closedAt: now, closedById: actor.userId },
        });
        // closeBatch's own terminal write; a no-op here because the
        // REASSIGNED end above already ended any live session.
        await endTrackingSessionsInTx(
          tx,
          { deliveryBatchId: batch.id },
          "ASSIGNMENT_COMPLETED",
        );
        const otherOpen = await tx.deliveryBatch.count({
          where: {
            riderId: freshBatch.riderId,
            status: "IN_PROGRESS",
            id: { not: batch.id },
          },
        });
        if (otherOpen === 0) {
          await tx.driver.updateMany({
            where: { id: freshBatch.riderId, availabilityStatus: "ON_DELIVERY" },
            data: { availabilityStatus: "AVAILABLE" },
          });
        }
        oldBatchClosed = true;
      }
      return { newBatchId: newBatch.id, newAssignmentIds, moved, oldBatchClosed };
    },
    { timeout: 30_000 },
  );

  await auditOps(actor, "delivery.batch_reassigned", "DeliveryBatch", batch.id, {
    warehouseId: batch.warehouseId,
    after: {
      newBatchId: outcome.newBatchId,
      newRiderId: rider.driverId,
      previousRiderId: batch.riderId,
      reason,
      moved: outcome.moved,
      oldBatchClosed: outcome.oldBatchClosed,
    },
  });
  const assignments: DeliveryAssignmentView[] = [];
  for (const id of outcome.newAssignmentIds) {
    assignments.push(toAssignmentView(await loadAssignmentOr404(id)));
  }
  return {
    previousBatch: toBatchView(await loadBatchOr404(batchId)),
    batch: toBatchView(await loadBatchOr404(outcome.newBatchId)),
    assignments,
    moved: outcome.moved,
    oldBatchClosed: outcome.oldBatchClosed,
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
    // Lock the batch row and re-validate its status inside the
    // transaction (Phase 6 review P6-R3): the pre-transaction check
    // races a concurrent close/cancel — acting on the stale
    // snapshot could overwrite a COMPLETED batch or re-cancel
    // assignments another operation already settled.
    await tx.$queryRaw(
      Prisma.sql`SELECT "id" FROM "app"."DeliveryBatch" WHERE "id" = ${batch.id} FOR UPDATE`,
    );
    const freshBatch = await tx.deliveryBatch.findUniqueOrThrow({
      where: { id: batch.id },
      select: { status: true },
    });
    if (freshBatch.status !== "OPEN" && freshBatch.status !== "IN_PROGRESS") {
      throw new ConflictError(`Batch is ${freshBatch.status} — it can no longer be cancelled`);
    }
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
      // Per-assignment re-check under the package lock (P6-R3):
      // a pickup may have committed since the findMany above.
      const freshAssignment = await tx.deliveryAssignment.findUniqueOrThrow({
        where: { id: a.id },
        select: { status: true },
      });
      if (freshAssignment.status === "IN_PROGRESS") {
        throw new ConflictError(
          "Batch has packages out with the rider — it cannot be cancelled; close it at end of day instead",
        );
      }
      if (freshAssignment.status !== "PENDING" && freshAssignment.status !== "ACCEPTED") {
        continue; // already terminal — nothing to cancel
      }
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
    await endTrackingSessionsInTx(
      tx,
      { deliveryBatchId: batch.id },
      "ASSIGNMENT_CANCELLED",
    );
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
  /** OTP state only — the code itself goes to the RECIPIENT via
   *  the notification system (P6-R1 closure); it is never part of
   *  any rider/staff response. */
  otpGenerated: boolean;
  otpExpiresAt: string;
}

/**
 * Deliver a freshly generated delivery code to the package's
 * RECIPIENT, inside the generation transaction (P6-R1 closure).
 * The TRACKING-channel notification is the retrievable copy (the
 * recipient reads it back through the phone-verified detailed
 * tracking view); the SMS row records intent only — no SMS provider
 * is connected, so it honestly reads NOT_SENT_NO_PROVIDER. The
 * dedupe key binds the code to this exact generation event, so a
 * retry can never deliver two different codes for one generation.
 */
async function deliverOtpToRecipientInTx(
  tx: Prisma.TransactionClient,
  args: {
    assignmentId: string;
    trackingId: string;
    recipientPhone: string;
    recipientCustomerId: string | null;
    otp: string;
    generatedAt: Date;
  },
): Promise<void> {
  await createNotificationInTx(tx, {
    recipientPhone: normalizePhone(args.recipientPhone),
    recipientCustomerId: args.recipientCustomerId,
    category: "DELIVERY_OTP",
    title: `Delivery code for ${args.trackingId}`,
    body:
      `Your BLA delivery code for package ${args.trackingId} is ${args.otp}. ` +
      "Share it with the rider only when your package is at your door.",
    entityType: "DeliveryAssignment",
    entityId: args.assignmentId,
    payload: { otpCode: args.otp, trackingId: args.trackingId },
    dedupeKey: `otp:${args.assignmentId}:${args.generatedAt.getTime()}`,
    channels: ["TRACKING", "SMS"],
  });
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
    let takenOtpExpiresAt: Date | null = null;
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
        const otpExpiresAt = new Date(now.getTime() + OTP_TTL_MS);
        await tx.deliveryAssignment.update({
          where: { id: assignment.id },
          data: {
            status: "IN_PROGRESS",
            startedAt: now,
            otpCodeHash: otpHash,
            otpGeneratedAt: now,
            otpExpiresAt,
            otpFailedAttempts: 0,
            otpLockedAt: null,
            otpVerifiedAt: null,
            version: { increment: 1 },
          },
        });
        // P6-R1 closure: the code goes to the RECIPIENT through the
        // notification system, in the same transaction — if pickup
        // rolls back, no code was ever delivered.
        await deliverOtpToRecipientInTx(tx, {
          assignmentId: assignment.id,
          trackingId: assignment.package.trackingId,
          recipientPhone: pkg.recipientPhone,
          recipientCustomerId: pkg.recipientCustomerId,
          otp,
          generatedAt: now,
        });
        takenOtpExpiresAt = otpExpiresAt;
      });
      taken.push({
        assignmentId: assignment.id,
        trackingId: assignment.package.trackingId,
        otpGenerated: true,
        otpExpiresAt: (takenOtpExpiresAt as Date | null)?.toISOString() ?? new Date(Date.now() + OTP_TTL_MS).toISOString(),
      });
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
): Promise<{ assignmentId: string; expiresAt: string; locked: boolean }> {
  await requirePermAudited(actor, "delivery.confirm", "DeliveryAssignment");
  const assignment = await loadAssignmentOr404(assignmentId);
  const batch = assignment.batchId ? await loadBatchOr404(assignment.batchId) : null;
  const warehouseId = batch?.warehouseId ?? assignment.package.currentWarehouseId ?? "";
  const isRider = actor.driverId !== null && actor.driverId === assignment.driverId;
  if (!isRider) {
    // Phase 6 review P6-R1 (interim restriction; the full fix —
    // recipient-side code delivery — is Phase 8): minting a fresh
    // delivery code is restricted to the assigned rider, a
    // Warehouse Admin OF THE BATCH'S WAREHOUSE (P2-4 membership
    // role, e.g. the recipient calls the warehouse and the WA
    // re-issues), or an unscoped actor. Ordinary warehouse staff
    // in scope can no longer mint codes.
    const isWa = actor.membershipRoles.some(
      (m) => m.warehouseId === warehouseId && m.roleCode === "WAREHOUSE_ADMIN",
    );
    if (!isUnscoped(actor) && !isWa) {
      await auditAccessDenied(actor, "DeliveryAssignment", {
        entityId: assignment.id,
        warehouseId,
        reason: "otp_regenerate_requires_rider_or_warehouse_admin",
      });
      throw new AuthorizationError(
        "Only the assigned rider or a Warehouse Admin of this warehouse can regenerate the delivery code",
      );
    }
  }
  if (assignment.status !== "IN_PROGRESS") {
    throw new ConflictError(`Assignment is ${assignment.status} — the package is not out for delivery`);
  }
  const otp = generateOtpCode();
  const otpHash = await hashOtpCode(otp);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + OTP_TTL_MS);
  // Phase 6 review P6-R2: the reset happens inside a transaction
  // under the Package + assignment row locks (the same locks, in
  // the same order, as confirmDelivery), with the status re-read
  // in-transaction — a regeneration landing mid-delivery can no
  // longer swap the hash between the delivery's OTP verification
  // and its proof-of-delivery write.
  await prisma.$transaction(async (tx) => {
    await lockPackageRow(tx, assignment.packageId);
    await lockAssignmentRow(tx, assignment.id);
    const fresh = await tx.deliveryAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
      select: { status: true },
    });
    if (fresh.status !== "IN_PROGRESS") {
      throw new ConflictError(
        `Assignment is ${fresh.status} — the package is not out for delivery`,
      );
    }
    await tx.deliveryAssignment.update({
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
    // P6-R1 closure: the fresh code is delivered to the RECIPIENT
    // through the notification system, in the same transaction as
    // the hash swap — the caller learns only the new expiry.
    const pkg = await tx.package.findUniqueOrThrow({
      where: { id: assignment.packageId },
      select: { trackingId: true, recipientPhone: true, recipientCustomerId: true },
    });
    await deliverOtpToRecipientInTx(tx, {
      assignmentId: assignment.id,
      trackingId: pkg.trackingId,
      recipientPhone: pkg.recipientPhone,
      recipientCustomerId: pkg.recipientCustomerId,
      otp,
      generatedAt: now,
    });
  });
  await auditOps(actor, "delivery.otp_regenerated", "DeliveryAssignment", assignment.id, {
    after: { expiresAt: expiresAt.toISOString() },
  });
  return { assignmentId: assignment.id, expiresAt: expiresAt.toISOString(), locked: false };
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

  // --- COD gate: exact paisa; a mismatch needs an explanation and
  // is recorded as MISMATCH — never silently accepted (Phase 7 owns
  // the ledger; this records the collection event only). Reads the
  // booking snapshot (immutable), so it can run before the
  // transaction.
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

  type DeliveryOutcome =
    | { kind: "otp_failed"; failures: number; locksNow: boolean }
    | { kind: "delivered"; proofOfDeliveryId: string; cod: ConfirmDeliveryResult["cod"] };

  const outcome = await prisma.$transaction(async (tx): Promise<DeliveryOutcome> => {
    await lockPackageRow(tx, assignment.packageId);
    await lockAssignmentRow(tx, assignment.id);
    const fresh = await tx.deliveryAssignment.findUniqueOrThrow({
      where: { id: assignment.id },
    });
    if (fresh.status !== "IN_PROGRESS") {
      throw new ConflictError(`Assignment is ${fresh.status} — it can no longer be delivered`);
    }

    // --- OTP gate (security-architecture §7, delivery-workflow
    // §10), Phase 6 review P6-R2: verification and failure counting
    // run INSIDE this transaction, under the Package + assignment
    // row locks, against the in-transaction hash. The previous
    // shape — verify a pre-transaction snapshot, then write
    // snapshot+1 back — let concurrent wrong codes each read the
    // same counter and overwrite each other (6 parallel guesses
    // left the counter at 1 and never locked), and let a
    // regeneration swap the hash between verification and the POD
    // write. A wrong code returns an outcome (committing ONLY the
    // atomic increment + the lock write) instead of throwing, so
    // the failure count persists without a partial delivery.
    if (!fresh.otpCodeHash || !fresh.otpExpiresAt) {
      throw new DomainValidationError("No delivery code was generated for this package");
    }
    if (fresh.otpLockedAt) {
      throw new DomainValidationError(
        "The delivery code is locked after too many wrong entries — request a new code",
      );
    }
    if (fresh.otpExpiresAt.getTime() < Date.now()) {
      throw new DomainValidationError("The delivery code has expired — request a new code");
    }
    const otpOk = await verifyOtpCode(data.otpCode, fresh.otpCodeHash);
    if (!otpOk) {
      const updated = await tx.deliveryAssignment.update({
        where: { id: assignment.id },
        data: { otpFailedAttempts: { increment: 1 } },
      });
      const failures = updated.otpFailedAttempts;
      const locksNow = failures >= OTP_MAX_FAILURES;
      if (locksNow && !updated.otpLockedAt) {
        await tx.deliveryAssignment.update({
          where: { id: assignment.id },
          data: { otpLockedAt: new Date() },
        });
      }
      return { kind: "otp_failed", failures, locksNow };
    }

    const pkg = await tx.package.findUniqueOrThrow({ where: { id: assignment.packageId } });
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
        // The hash verified above, read inside this transaction
        // under the row locks (P6-R2) — never the pre-transaction
        // snapshot, which a concurrent regeneration may have
        // already replaced.
        otpCodeHash: fresh.otpCodeHash,
        otpExpiresAt: fresh.otpExpiresAt,
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
          batchId: fresh.batchId,
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
    return { kind: "delivered", proofOfDeliveryId: pod.id, cod };
  }, { timeout: 30_000 });

  if (outcome.kind === "otp_failed") {
    // The transaction committed ONLY the failure increment (+ the
    // lock write at the threshold); no delivery artefacts exist.
    await auditOps(actor, "delivery.otp_failed", "DeliveryAssignment", assignment.id, {
      after: { failedAttempts: outcome.failures, locked: outcome.locksNow },
    });
    throw new DomainValidationError(
      outcome.locksNow
        ? "Incorrect delivery code — the code is now locked after too many wrong entries; request a new code"
        : "Incorrect delivery code",
    );
  }

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
// Warehouse scan-back — undelivered packages return to stock and an
// APPROVED open return advances to RECEIVED (return-workflow §3.5).
// A REQUESTED return blocks the scan (P6-R4): receiving must never
// substitute for the Warehouse Admin's authorisation.
// ---------------------------------------------------------------------------

export const scanBackSchema = z.object({
  warehouseId: z.string().uuid(),
  trackingId: z.string().min(1).max(40),
  condition: z.enum(PACKAGE_CONDITIONS).optional(),
  /** Phase 6 review P6-R7: mandatory when the package is
   *  OUT_FOR_DELIVERY (enforced in the service, where the
   *  authoritative status is read) — a scan-back severs the
   *  rider's custody, and the reason is part of the record. */
  reason: z.string().min(3).max(500).optional(),
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
  if (pkg.operationalStatus === "OUT_FOR_DELIVERY") {
    // P6-R7 fast path (re-checked in-transaction below): a
    // Warehouse Admin + a recorded reason are required to sever
    // an out-for-delivery rider's custody.
    await assertScanBackAdmin(actor, warehouse.id, pkg.id);
    if (!data.reason) {
      throw new DomainValidationError(
        "A reason is required when scanning back a package that is out for delivery",
      );
    }
  }
  const assignment = await prisma.deliveryAssignment.findFirst({
    where: { packageId: pkg.id, status: "IN_PROGRESS" },
    orderBy: { createdAt: "desc" },
    include: {
      driver: { select: { userId: true, user: { select: { fullName: true } } } },
    },
  });
  if (!assignment) {
    throw new ConflictError(`Package ${trackingId} has no in-progress delivery assignment`);
  }

  let displacedFromRider = false;
  const outcome = await prisma.$transaction(async (tx) => {
    await lockPackageRow(tx, pkg.id);
    const fresh = await tx.package.findUniqueOrThrow({ where: { id: pkg.id } });
    if (fresh.operationalStatus !== "OUT_FOR_DELIVERY" && fresh.operationalStatus !== "DELIVERY_ATTEMPTED") {
      throw new ConflictError(`Package is ${fresh.operationalStatus} — it can no longer be scanned back`);
    }
    // Phase 8 link point (P6-R7 follow-up): an OUT_FOR_DELIVERY
    // scan-back severs a rider's custody — that displacement raises
    // an incident below. DELIVERY_ATTEMPTED scan-backs are the
    // normal end-of-round return and do not.
    displacedFromRider = fresh.operationalStatus === "OUT_FOR_DELIVERY";
    if (fresh.operationalStatus === "OUT_FOR_DELIVERY") {
      // P6-R7, authoritative in-transaction check (the status may
      // have moved since the pre-transaction read).
      await assertScanBackAdmin(actor, warehouse.id, pkg.id);
      if (!data.reason) {
        throw new DomainValidationError(
          "A reason is required when scanning back a package that is out for delivery",
        );
      }
    }
    const openReturn = await tx.returnRequest.findFirst({
      where: {
        packageId: pkg.id,
        status: { in: ["REQUESTED", "APPROVED"] },
      },
      orderBy: { createdAt: "asc" },
    });
    if (openReturn && openReturn.status === "REQUESTED") {
      // Phase 6 review P6-R4: receiving the package back must not
      // advance a return that was never authorised — doing so
      // permanently skipped the Warehouse Admin's authorisation
      // and the mandatory charge-bearer decision (approveReturn
      // refuses anything not REQUESTED). The scan is rejected
      // until the return is APPROVED. (Alternative considered by
      // the reviewer: a RECEIVED_UNAUTHORISED holding state —
      // rejection is the smaller change and keeps one clear rule:
      // no authorisation, no receiving.)
      throw new ConflictError(
        `Return ${openReturn.returnNumber} is still REQUESTED — a Warehouse Admin must authorise it before the package can be received back`,
      );
    }
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
      // P6-R7: the scan-back reason rides on the tracking event.
      notes: data.reason ? `Scanned back at the warehouse: ${data.reason}` : undefined,
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
        failureNote: data.reason
          ? `RETURNED_TO_WAREHOUSE — scanned back at the warehouse: ${data.reason}`
          : "RETURNED_TO_WAREHOUSE — scanned back at the warehouse",
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
    if (displacedFromRider && data.reason) {
      // Phase 8 review P8-R8: the displacement incident raises
      // INSIDE the scan-back transaction. It previously ran in a
      // separate transaction after the scan-back committed, so a
      // failure in between lost the incident permanently — the
      // scan-back cannot be retried once the package has moved.
      // Idempotent per assignment (sourceKey): the assignment is
      // terminal after a scan-back, so this fires exactly once.
      await raiseIncidentInTx(tx, {
        sourceKey: `scan-back:${assignment.id}`,
        category: "DELIVERY_FAILURE",
        description:
          `Rider ${assignment.driver.user.fullName} was displaced from package ${trackingId} ` +
          `(assignment ${assignment.id}) by a warehouse scan-back. Reason: ${data.reason}`,
        reporterId: actor.userId,
        warehouseId: warehouse.id,
        packageId: pkg.id,
        deliveryAssignmentId: assignment.id,
      });
    }
    return { advancedReturn };
  });

  await auditOps(actor, "delivery.scan_back", "Package", pkg.id, {
    warehouseId: warehouse.id,
    after: {
      assignmentId: assignment.id,
      returnNumber: outcome.advancedReturn?.returnNumber ?? null,
      // P6-R7: the reason and the displaced rider's identity are
      // part of the scan-back record.
      reason: data.reason ?? null,
      displacedRiderId: assignment.driverId,
      displacedRiderUserId: assignment.driver.userId,
      displacedRiderName: assignment.driver.user.fullName,
    },
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
    const rider = await tx.driver.findUniqueOrThrow({
      where: { id: batch.riderId },
      select: { userId: true },
    });
    const riderUserId = rider.userId;
    const assignments = await tx.deliveryAssignment.findMany({
      where: { batchId: batch.id },
      include: {
        package: {
          select: {
            trackingId: true,
            operationalStatus: true,
            custodies: {
              where: { endedAt: null },
              select: { custodianType: true, custodianUserId: true },
            },
            deliveryAssignments: {
              where: { status: { in: [...ACTIVE_ASSIGNMENT_STATUSES] } },
              select: { id: true },
            },
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
        continue;
      }
      // Phase 6 review P6-R3 (defence in depth behind the
      // cancelAssignment/cancelBatch in-transaction re-checks): a
      // non-completed assignment NEVER accounts for a package that
      // is physically out with THIS batch's rider —
      // OUT_FOR_DELIVERY / DELIVERY_ATTEMPTED, or an open custody
      // row held by the rider — no matter what the assignment's
      // own status says. The reviewer's reproduced end-state
      // (assignment CANCELLED, package out, batch closed
      // COMPLETED) must stay impossible even if such a row is
      // ever produced by another path. (A USER custody held by
      // someone else — e.g. the vendor owner after a completed
      // return handover — is not "out": the FAILED branch below
      // accounts for it via the received/completed return.)
      // Exception: the package has since been committed to
      // ANOTHER active assignment — that batch accounts for it.
      const physicallyOut =
        a.package.operationalStatus === "OUT_FOR_DELIVERY" ||
        a.package.operationalStatus === "DELIVERY_ATTEMPTED" ||
        a.package.custodies.some(
          (c) => c.custodianType === "USER" && c.custodianUserId === riderUserId,
        );
      const committedElsewhere = a.package.deliveryAssignments.some(
        (other) => other.id !== a.id,
      );
      if (physicallyOut && !committedElsewhere) {
        unaccounted.push(a.package.trackingId);
      } else if (a.status === "CANCELLED" || a.status === "REASSIGNED") {
        cancelledOrReassigned += 1;
      } else if (a.status === "FAILED") {
        // A failed assignment accounts for its package only when
        // the package is physically back: in stock here, or its
        // return was received. A pickup shortage (package never
        // left, still DELIVERY_ASSIGNED) also counts: stock is
        // open at this warehouse.
        if (
          a.package.inventoryRecords.length > 0 ||
          a.package.returnRequests.length > 0 ||
          committedElsewhere
        ) {
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
    await endTrackingSessionsInTx(
      tx,
      { deliveryBatchId: batch.id },
      "ASSIGNMENT_COMPLETED",
    );
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

/** One failed attempt from today that still needs rider action:
 *  the package is still out with the rider (assignment IN_PROGRESS),
 *  so a re-attempt or a call to the recipient is the next step.
 *  Attempts on assignments that have since completed or failed
 *  terminally are history, not action items, and are excluded. */
export interface RiderFailedAttemptView {
  attemptId: string;
  assignmentId: string;
  batchId: string | null;
  trackingId: string;
  result: string;
  failureReason: string | null;
  nextAction: string;
  notes: string | null;
  attemptedAt: string;
  recipientArea: string;
  codExpectedPaisa: string;
}

export interface RiderHomeToday {
  date: string;
  /** Every assignment on today's batches. */
  assigned: number;
  delivered: number;
  /** Stops still to do: waiting pickup + out for delivery. */
  remaining: number;
  failedAttemptsNeedingAction: number;
  failedAttempts: RiderFailedAttemptView[];
  codExpectedPaisa: string;
  codCollectedPaisa: string;
  /** The rider's first open batch today, with its next stop. */
  currentBatch: {
    batch: DeliveryBatchView;
    nextStop: {
      assignmentId: string;
      trackingId: string;
      status: string;
      recipientName: string;
      recipientArea: string;
      codExpectedPaisa: string;
    } | null;
  } | null;
}

/**
 * Phase 6 (V2) rider-home read: today's summary counts, the failed
 * attempts that still need action, and the current batch's next
 * stop — in one rider-scoped read. Rider isolation matches every
 * other rider read: the actor's own driver profile only.
 */
export async function getRiderHomeToday(
  actor: ActorContext,
  date?: string,
): Promise<RiderHomeToday> {
  if (!actor.driverId) {
    throw new AuthorizationError("Only riders have a delivery day summary");
  }
  const day = date ?? new Date().toISOString().slice(0, 10);
  const batchRows = await prisma.deliveryBatch.findMany({
    where: { riderId: actor.driverId, batchDate: new Date(`${day}T00:00:00.000Z`) },
    include: batchInclude,
    orderBy: { createdAt: "asc" },
  });
  const batches = batchRows.map(toBatchView);
  const batchIds = batches.map((b) => b.id);

  const assignmentRows = batchIds.length
    ? await prisma.deliveryAssignment.findMany({
        where: { batchId: { in: batchIds } },
        include: assignmentInclude,
      })
    : [];
  let delivered = 0;
  let remaining = 0;
  let codExpected = BigInt(0);
  let codCollected = BigInt(0);
  for (const row of assignmentRows) {
    if (row.status === "COMPLETED") delivered += 1;
    if (row.status === "PENDING" || row.status === "ACCEPTED" || row.status === "IN_PROGRESS") {
      remaining += 1;
    }
    if (row.status === "IN_PROGRESS" || row.status === "COMPLETED") {
      codExpected += row.package.codAmountPaisa;
    }
    if (row.codCollection) codCollected += row.codCollection.collectedPaisa;
  }

  const dayStart = new Date(`${day}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  const attemptRows = batchIds.length
    ? await prisma.deliveryAttempt.findMany({
        where: {
          assignment: { driverId: actor.driverId, batchId: { in: batchIds } },
          attemptedAt: { gte: dayStart, lt: dayEnd },
          result: { not: "DELIVERED" },
        },
        include: {
          assignment: {
            select: {
              id: true,
              batchId: true,
              status: true,
              package: {
                select: {
                  trackingId: true,
                  deliveryCity: true,
                  deliveryDistrict: true,
                  codAmountPaisa: true,
                },
              },
            },
          },
        },
        orderBy: { attemptedAt: "desc" },
      })
    : [];
  const failedAttempts: RiderFailedAttemptView[] = attemptRows
    .filter((a) => a.assignment.status === "IN_PROGRESS")
    .map((a) => ({
      attemptId: a.id,
      assignmentId: a.assignment.id,
      batchId: a.assignment.batchId,
      trackingId: a.assignment.package.trackingId,
      result: a.result,
      failureReason: a.failureReason,
      nextAction: a.nextAction,
      notes: a.notes,
      attemptedAt: a.attemptedAt.toISOString(),
      recipientArea: [a.assignment.package.deliveryCity, a.assignment.package.deliveryDistrict]
        .filter(Boolean)
        .join(" · "),
      codExpectedPaisa: a.assignment.package.codAmountPaisa.toString(),
    }));

  const openBatch = batches.find((b) => b.status === "OPEN" || b.status === "IN_PROGRESS") ?? null;
  let currentBatch: RiderHomeToday["currentBatch"] = null;
  if (openBatch) {
    const { assignments } = await getRiderBatch(actor, openBatch.id);
    const next = assignments.find(
      (a) => a.status === "PENDING" || a.status === "ACCEPTED" || a.status === "IN_PROGRESS",
    );
    currentBatch = {
      batch: openBatch,
      nextStop: next
        ? {
            assignmentId: next.id,
            trackingId: next.trackingId,
            status: next.status,
            recipientName: next.recipientName,
            recipientArea: [next.destinationCity, next.destinationDistrict]
              .filter(Boolean)
              .join(" · "),
            codExpectedPaisa: next.codExpectedPaisa,
          }
        : null,
    };
  }

  return {
    date: day,
    assigned: assignmentRows.length,
    delivered,
    remaining,
    failedAttemptsNeedingAction: failedAttempts.length,
    failedAttempts,
    codExpectedPaisa: codExpected.toString(),
    codCollectedPaisa: codCollected.toString(),
    currentBatch,
  };
}

export { DELIVERY_ASSIGNMENT_STATUSES };
