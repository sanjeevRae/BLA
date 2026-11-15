"use server";

import { revalidatePath } from "next/cache";

import {
  AuthorizationError,
  getActorContext,
  requireUnflagged,
  type ActorContext,
} from "@/lib/auth/permissions";
import type { PACKAGE_CONDITIONS } from "@/lib/bookings/domain";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import type { ActionResult } from "@/server/actions/warehouses";
import {
  addTransferItems,
  approveTransfer,
  assignTransferCrew,
  cancelTransfer,
  closeTransfer,
  completePackageReceiving,
  createTransfer,
  dispatchTransfer,
  finishReceiving,
  generateManifest,
  loadTransferPackage,
  reconcileTransfer,
  rejectTransfer,
  removeTransferItem,
  reviseTransfer,
  scanDestinationPackage,
  submitTransferForApproval,
  unloadTransferPackage,
  type AddItemsResult,
  type AssignCrewInput,
  type CreateTransferInput,
  type DestinationScanInput,
  type DestinationScanResult,
  type LoadScanResult,
  type TransferView,
} from "@/server/services/transfers";
import {
  arriveTrip,
  departTrip,
  recordCheckpoint,
  reportTripDelay,
  resumeTrip,
  type CheckpointInput,
  type DelayInput,
  type TripView,
} from "@/server/services/trips";

/**
 * Server Actions for Phase 5 transfers + trips — same contract as the
 * other modules (session actor, P2-3 mustChangePassword gate,
 * service-side permission + scope checks with audited denials).
 */

async function withActor<T>(
  fn: (actor: ActorContext) => Promise<T>,
): Promise<ActionResult<T>> {
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

function revalidateTransferSurfaces() {
  for (const base of ["/warehouse", "/staff", "/transport-driver"]) {
    revalidatePath(base);
    revalidatePath(`${base}/transfers`);
    revalidatePath(`${base}/arrivals`);
  }
}

// --- Transfer lifecycle -------------------------------------------------

export async function createTransferAction(
  input: CreateTransferInput,
): Promise<ActionResult<TransferView>> {
  const result = await withActor((actor) => createTransfer(actor, input));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function addTransferItemsAction(
  transferId: string,
  packageIds: string[],
): Promise<ActionResult<AddItemsResult>> {
  const result = await withActor((actor) => addTransferItems(actor, transferId, packageIds));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function removeTransferItemAction(
  transferId: string,
  packageId: string,
  reason?: string,
): Promise<ActionResult<TransferView>> {
  const result = await withActor((actor) =>
    removeTransferItem(actor, transferId, packageId, reason),
  );
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function submitTransferAction(
  transferId: string,
): Promise<ActionResult<TransferView>> {
  const result = await withActor((actor) => submitTransferForApproval(actor, transferId));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function approveTransferAction(
  transferId: string,
): Promise<ActionResult<TransferView>> {
  const result = await withActor((actor) => approveTransfer(actor, transferId));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function rejectTransferAction(
  transferId: string,
  reason: string,
): Promise<ActionResult<TransferView>> {
  const result = await withActor((actor) => rejectTransfer(actor, transferId, reason));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function reviseTransferAction(
  transferId: string,
): Promise<ActionResult<TransferView>> {
  const result = await withActor((actor) => reviseTransfer(actor, transferId));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function generateManifestAction(
  transferId: string,
): Promise<ActionResult<TransferView>> {
  const result = await withActor((actor) => generateManifest(actor, transferId));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function assignTransferCrewAction(
  input: AssignCrewInput,
): Promise<ActionResult<TransferView>> {
  const result = await withActor((actor) => assignTransferCrew(actor, input));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function loadTransferPackageAction(
  transferId: string,
  trackingId: string,
  idempotencyKey?: string,
): Promise<ActionResult<LoadScanResult>> {
  const result = await withActor((actor) =>
    loadTransferPackage(actor, transferId, { trackingId, idempotencyKey }),
  );
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function unloadTransferPackageAction(
  transferId: string,
  trackingId: string,
): Promise<ActionResult<LoadScanResult>> {
  const result = await withActor((actor) => unloadTransferPackage(actor, transferId, trackingId));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function dispatchTransferAction(
  transferId: string,
): Promise<ActionResult<TransferView>> {
  const result = await withActor((actor) => dispatchTransfer(actor, transferId));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function cancelTransferAction(
  transferId: string,
  reason?: string,
): Promise<ActionResult<TransferView>> {
  const result = await withActor((actor) => cancelTransfer(actor, transferId, reason));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

// --- Destination receiving + reconciliation -----------------------------

export async function scanDestinationPackageAction(
  transferId: string,
  input: DestinationScanInput,
): Promise<ActionResult<DestinationScanResult>> {
  const result = await withActor((actor) => scanDestinationPackage(actor, transferId, input));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function completePackageReceivingAction(
  transferId: string,
  packageId: string,
  condition: (typeof PACKAGE_CONDITIONS)[number],
  notes?: string,
): Promise<ActionResult<TransferView>> {
  const result = await withActor((actor) =>
    completePackageReceiving(actor, transferId, { packageId, condition, notes }),
  );
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function finishReceivingAction(
  transferId: string,
): Promise<ActionResult<TransferView>> {
  const result = await withActor((actor) => finishReceiving(actor, transferId));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function reconcileTransferAction(
  transferId: string,
): Promise<ActionResult<TransferView>> {
  const result = await withActor((actor) => reconcileTransfer(actor, transferId));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function closeTransferAction(
  transferId: string,
): Promise<ActionResult<TransferView>> {
  const result = await withActor((actor) => closeTransfer(actor, transferId));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

// --- Trips ---------------------------------------------------------------

export async function departTripAction(tripId: string): Promise<ActionResult<TripView>> {
  const result = await withActor((actor) => departTrip(actor, tripId));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function arriveTripAction(tripId: string): Promise<ActionResult<TripView>> {
  const result = await withActor((actor) => arriveTrip(actor, tripId));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function recordCheckpointAction(
  tripId: string,
  input: CheckpointInput,
): Promise<ActionResult<TripView>> {
  const result = await withActor((actor) => recordCheckpoint(actor, tripId, input));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function reportTripDelayAction(
  tripId: string,
  input: DelayInput,
): Promise<ActionResult<TripView>> {
  const result = await withActor((actor) => reportTripDelay(actor, tripId, input));
  if (result.success) revalidateTransferSurfaces();
  return result;
}

export async function resumeTripAction(tripId: string): Promise<ActionResult<TripView>> {
  const result = await withActor((actor) => resumeTrip(actor, tripId));
  if (result.success) revalidateTransferSurfaces();
  return result;
}
