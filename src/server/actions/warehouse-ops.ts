"use server";

import { revalidatePath } from "next/cache";

import {
  AuthorizationError,
  getActorContext,
  requireUnflagged,
  type ActorContext,
} from "@/lib/auth/permissions";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import {
  markReadyForDispatch,
  moveInternal,
  moveToInspection,
  previewReceiving,
  putAwayPackage,
  receivePackage,
  recordInspection,
  startInspection,
  type MoveInternalInput,
  type ReceivePackageInput,
  type RecordInspectionInput,
} from "@/server/services/inventory";
import {
  closeHandoverBatch,
  confirmHandoverPackage,
  initiateHandover,
  type ConfirmHandoverInput,
  type InitiateHandoverInput,
} from "@/server/services/custody";
import {
  createStockItem,
  recordStockMovement,
  updateStockItem,
  type CreateStockItemInput,
  type RecordStockMovementInput,
  type UpdateStockItemInput,
} from "@/server/services/supplies";
import type { ActionResult } from "@/server/actions/warehouses";

/**
 * Server Actions for Phase 4 warehouse operations — same contract as
 * the other modules (session actor, P2-3 mustChangePassword gate,
 * service-side permission + scope checks with audited denials).
 */

async function withActor<T>(fn: (actor: ActorContext) => Promise<T>): Promise<ActionResult<T>> {
  const actor = await getActorContext();
  if (!actor) return { success: false, error: "Authentication required" };
  try {
    requireUnflagged(actor); // P2-3 gate
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

function revalidateOpsPaths(): void {
  for (const base of ["/warehouse", "/staff"]) {
    revalidatePath(base);
    revalidatePath(`${base}/operations`);
    revalidatePath(`${base}/inventory`);
    revalidatePath(`${base}/handovers`);
    revalidatePath(`${base}/supplies`);
  }
}

// -- Receiving / inspection / sorting ----------------------------------------

export async function previewReceivingAction(warehouseId: string, trackingId: string) {
  return withActor((actor) => previewReceiving(actor, warehouseId, trackingId));
}

export async function receivePackageAction(input: ReceivePackageInput) {
  const result = await withActor((actor) => receivePackage(actor, input));
  if (result.success) revalidateOpsPaths();
  return result;
}

export async function moveToInspectionAction(packageId: string) {
  const result = await withActor((actor) => moveToInspection(actor, packageId));
  if (result.success) revalidateOpsPaths();
  return result;
}

export async function startInspectionAction(packageId: string) {
  const result = await withActor((actor) => startInspection(actor, packageId));
  if (result.success) revalidateOpsPaths();
  return result;
}

export async function recordInspectionAction(input: RecordInspectionInput) {
  const result = await withActor((actor) => recordInspection(actor, input));
  if (result.success) revalidateOpsPaths();
  return result;
}

export async function putAwayPackageAction(packageId: string, storageLocationId: string) {
  const result = await withActor((actor) => putAwayPackage(actor, packageId, storageLocationId));
  if (result.success) revalidateOpsPaths();
  return result;
}

export async function moveInternalAction(input: MoveInternalInput) {
  const result = await withActor((actor) => moveInternal(actor, input));
  if (result.success) revalidateOpsPaths();
  return result;
}

export async function markReadyForDispatchAction(
  packageId: string,
  dispatchLocationId?: string | null,
) {
  const result = await withActor((actor) =>
    markReadyForDispatch(actor, packageId, dispatchLocationId ?? null),
  );
  if (result.success) revalidateOpsPaths();
  return result;
}

// -- Custody handovers ---------------------------------------------------------

export async function initiateHandoverAction(input: InitiateHandoverInput) {
  const result = await withActor((actor) => initiateHandover(actor, input));
  if (result.success) revalidateOpsPaths();
  return result;
}

export async function confirmHandoverAction(input: ConfirmHandoverInput) {
  const result = await withActor((actor) => confirmHandoverPackage(actor, input));
  if (result.success) revalidateOpsPaths();
  return result;
}

export async function closeHandoverBatchAction(batchId: string) {
  const result = await withActor((actor) => closeHandoverBatch(actor, batchId));
  if (result.success) revalidateOpsPaths();
  return result;
}

// -- Supplies ------------------------------------------------------------------

export async function createStockItemAction(input: CreateStockItemInput) {
  const result = await withActor((actor) => createStockItem(actor, input));
  if (result.success) revalidateOpsPaths();
  return result;
}

export async function updateStockItemAction(input: UpdateStockItemInput) {
  const result = await withActor((actor) => updateStockItem(actor, input));
  if (result.success) revalidateOpsPaths();
  return result;
}

export async function recordStockMovementAction(input: RecordStockMovementInput) {
  const result = await withActor((actor) => recordStockMovement(actor, input));
  if (result.success) revalidateOpsPaths();
  return result;
}
