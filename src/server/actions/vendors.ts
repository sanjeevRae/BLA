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
  addVendorAddress,
  addVendorDocument,
  approveVendorAddress,
  assignVendorWarehouse,
  createVendor,
  reviewVendorDocument,
  setVendorVerificationStatus,
  updateVendor,
  type CreateVendorInput,
  type UpdateVendorInput,
  type VendorAddressInput,
  type VendorDocumentInput,
  type VerificationTransitionInput,
} from "@/server/services/vendors";
import type { ActionResult } from "@/server/actions/warehouses";

/**
 * Server Actions for the vendor module. Same contract as the warehouse
 * actions: the actor is resolved from the session + database, the
 * mustChangePassword gate (P2-3) applies, and VendorService performs
 * every permission and scope check. No client-sent role or vendor
 * field is ever trusted.
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

function revalidateVendorPaths(vendorId?: string): void {
  revalidatePath("/admin/vendors");
  revalidatePath("/super-admin/vendors");
  revalidatePath("/vendor");
  revalidatePath("/vendor/profile");
  if (vendorId) {
    revalidatePath(`/admin/vendors/${vendorId}`);
    revalidatePath(`/super-admin/vendors/${vendorId}`);
  }
}

export async function createVendorAction(input: CreateVendorInput) {
  const result = await withActor((actor) => createVendor(actor, input));
  if (result.success) revalidateVendorPaths(result.data.id);
  return result;
}

export async function updateVendorAction(vendorId: string, input: UpdateVendorInput) {
  const result = await withActor((actor) => updateVendor(actor, vendorId, input));
  if (result.success) revalidateVendorPaths(vendorId);
  return result;
}

export async function vendorVerificationAction(vendorId: string, input: VerificationTransitionInput) {
  const result = await withActor((actor) => setVendorVerificationStatus(actor, vendorId, input));
  if (result.success) revalidateVendorPaths(vendorId);
  return result;
}

export async function addVendorAddressAction(vendorId: string, input: VendorAddressInput) {
  const result = await withActor((actor) => addVendorAddress(actor, vendorId, input));
  if (result.success) revalidateVendorPaths(vendorId);
  return result;
}

export async function approveVendorAddressAction(vendorId: string, addressId: string) {
  const result = await withActor((actor) => approveVendorAddress(actor, addressId));
  if (result.success) revalidateVendorPaths(vendorId);
  return result;
}

export async function addVendorDocumentAction(vendorId: string, input: VendorDocumentInput) {
  const result = await withActor((actor) => addVendorDocument(actor, vendorId, input));
  if (result.success) revalidateVendorPaths(vendorId);
  return result;
}

export async function reviewVendorDocumentAction(
  vendorId: string,
  documentId: string,
  decision: "APPROVED" | "REJECTED",
  notes?: string | null,
) {
  const result = await withActor((actor) => reviewVendorDocument(actor, documentId, decision, notes));
  if (result.success) revalidateVendorPaths(vendorId);
  return result;
}

export async function assignVendorWarehouseAction(vendorId: string, warehouseId: string) {
  const result = await withActor((actor) => assignVendorWarehouse(actor, vendorId, warehouseId));
  if (result.success) revalidateVendorPaths(vendorId);
  return result;
}
