"use server";

import { revalidatePath } from "next/cache";

import {
  AuthorizationError,
  getActorContext,
  requireAccessGranted,
  type ActorContext,
} from "@/lib/auth/permissions";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import type { ActionResult } from "@/server/actions/warehouses";
import {
  addBatchPackages,
  cancelAssignment,
  cancelBatch,
  closeBatch,
  confirmDelivery,
  confirmPickup,
  createDeliveryBatch,
  reassignAssignment,
  recordDeliveryAttempt,
  regenerateOtp,
  scanBackPackage,
  type AddBatchPackagesInput,
  type AddBatchPackagesResult,
  type CancelAssignmentInput,
  type CloseBatchResult,
  type ConfirmDeliveryInput,
  type ConfirmDeliveryResult,
  type ConfirmPickupInput,
  type ConfirmPickupResult,
  type CreateDeliveryBatchInput,
  type DeliveryAssignmentView,
  type DeliveryBatchView,
  type ReassignAssignmentInput,
  type RecordAttemptInput,
  type RecordAttemptResult,
  type ScanBackInput,
  type ScanBackResult,
} from "@/server/services/deliveries";
import {
  approveReturn,
  completeReturn,
  initiateReturn,
  inspectReturn,
  rejectReturn,
  type ApproveReturnInput,
  type CompleteReturnInput,
  type InitiateReturnInput,
  type InspectReturnInput,
  type RejectReturnInput,
  type ReturnRequestView,
} from "@/server/services/returns";

/**
 * Server Actions for Phase 6 last-mile delivery + returns — same
 * contract as the other modules (session actor, P2-3
 * mustChangePassword gate, service-side permission + scope checks
 * with audited denials).
 */

async function withActor<T>(
  fn: (actor: ActorContext) => Promise<T>,
): Promise<ActionResult<T>> {
  const actor = await getActorContext();
  if (!actor) return { success: false, error: "Authentication required" };
  try {
    requireAccessGranted(actor); // P2-3 gate
    return { success: true, data: await fn(actor) };
  } catch (error) {
    if (
      error instanceof AuthorizationError ||
      error instanceof NotFoundError ||
      error instanceof ConflictError ||
      error instanceof DomainValidationError
    ) {
      return { success: false, error: error.message };
    }
    throw error;
  }
}

function revalidateDeliverySurfaces() {
  for (const base of ["/warehouse", "/staff", "/rider"]) {
    revalidatePath(base);
    revalidatePath(`${base}/deliveries`);
    revalidatePath(`${base}/returns`);
  }
  revalidatePath("/rider");
}

// --- Batches & assignments ----------------------------------------------

export async function createDeliveryBatchAction(
  input: CreateDeliveryBatchInput,
): Promise<ActionResult<DeliveryBatchView>> {
  const result = await withActor((actor) => createDeliveryBatch(actor, input));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

export async function addBatchPackagesAction(
  batchId: string,
  input: AddBatchPackagesInput,
): Promise<ActionResult<AddBatchPackagesResult>> {
  const result = await withActor((actor) => addBatchPackages(actor, batchId, input));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

export async function cancelAssignmentAction(
  assignmentId: string,
  input: CancelAssignmentInput,
): Promise<ActionResult<DeliveryAssignmentView>> {
  const result = await withActor((actor) => cancelAssignment(actor, assignmentId, input));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

export async function reassignAssignmentAction(
  assignmentId: string,
  input: ReassignAssignmentInput,
): Promise<
  ActionResult<{
    previous: DeliveryAssignmentView;
    assignment: DeliveryAssignmentView;
    batch: DeliveryBatchView;
  }>
> {
  const result = await withActor((actor) => reassignAssignment(actor, assignmentId, input));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

export async function cancelBatchAction(
  batchId: string,
): Promise<ActionResult<DeliveryBatchView>> {
  const result = await withActor((actor) => cancelBatch(actor, batchId));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

export async function closeBatchAction(
  batchId: string,
): Promise<ActionResult<CloseBatchResult>> {
  const result = await withActor((actor) => closeBatch(actor, batchId));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

// --- Rider flow -----------------------------------------------------------

export async function confirmPickupAction(
  batchId: string,
  input: ConfirmPickupInput,
): Promise<ActionResult<ConfirmPickupResult>> {
  const result = await withActor((actor) => confirmPickup(actor, batchId, input));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

export async function recordDeliveryAttemptAction(
  assignmentId: string,
  input: RecordAttemptInput,
): Promise<ActionResult<RecordAttemptResult>> {
  const result = await withActor((actor) => recordDeliveryAttempt(actor, assignmentId, input));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

export async function confirmDeliveryAction(
  assignmentId: string,
  input: ConfirmDeliveryInput,
): Promise<ActionResult<ConfirmDeliveryResult>> {
  const result = await withActor((actor) => confirmDelivery(actor, assignmentId, input));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

export async function regenerateOtpAction(
  assignmentId: string,
): Promise<ActionResult<{ assignmentId: string; expiresAt: string; locked: boolean }>> {
  const result = await withActor((actor) => regenerateOtp(actor, assignmentId));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

export async function scanBackPackageAction(
  input: ScanBackInput,
): Promise<ActionResult<ScanBackResult>> {
  const result = await withActor((actor) => scanBackPackage(actor, input));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

// --- Returns ---------------------------------------------------------------

export async function initiateReturnAction(
  input: InitiateReturnInput,
): Promise<ActionResult<ReturnRequestView>> {
  const result = await withActor((actor) => initiateReturn(actor, input));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

export async function approveReturnAction(
  returnId: string,
  input: ApproveReturnInput,
): Promise<ActionResult<ReturnRequestView>> {
  const result = await withActor((actor) => approveReturn(actor, returnId, input));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

export async function rejectReturnAction(
  returnId: string,
  input: RejectReturnInput,
): Promise<ActionResult<ReturnRequestView>> {
  const result = await withActor((actor) => rejectReturn(actor, returnId, input));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

export async function inspectReturnAction(
  returnId: string,
  input: InspectReturnInput,
): Promise<ActionResult<ReturnRequestView>> {
  const result = await withActor((actor) => inspectReturn(actor, returnId, input));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}

export async function completeReturnAction(
  returnId: string,
  input: CompleteReturnInput,
): Promise<ActionResult<ReturnRequestView>> {
  const result = await withActor((actor) => completeReturn(actor, returnId, input));
  if (result.success) revalidateDeliverySurfaces();
  return result;
}
