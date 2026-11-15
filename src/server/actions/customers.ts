"use server";

import { revalidatePath } from "next/cache";

import {
  AuthorizationError,
  getActorContext,
  requireAccessGranted,
  type ActorContext,
} from "@/lib/auth/permissions";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import {
  addCustomerAddress,
  createCustomer,
  mergeCustomers,
  updateCustomer,
  type CreateCustomerInput,
  type CustomerAddressInput,
  type UpdateCustomerInput,
} from "@/server/services/customers";
import type { ActionResult } from "@/server/actions/warehouses";

/** Server Actions for the customer module — same contract as the
 *  vendor/warehouse actions (session actor, P2-3 gate, service-side
 *  permission checks). */

async function withActor<T>(fn: (actor: ActorContext) => Promise<T>): Promise<ActionResult<T>> {
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

function revalidateCustomerPaths(): void {
  revalidatePath("/admin/customers");
  revalidatePath("/super-admin/customers");
}

export async function createCustomerAction(input: CreateCustomerInput) {
  const result = await withActor((actor) => createCustomer(actor, input));
  if (result.success) revalidateCustomerPaths();
  return result;
}

export async function updateCustomerAction(customerId: string, input: UpdateCustomerInput) {
  const result = await withActor((actor) => updateCustomer(actor, customerId, input));
  if (result.success) revalidateCustomerPaths();
  return result;
}

export async function addCustomerAddressAction(customerId: string, input: CustomerAddressInput) {
  const result = await withActor((actor) => addCustomerAddress(actor, customerId, input));
  if (result.success) revalidateCustomerPaths();
  return result;
}

export async function mergeCustomersAction(winnerId: string, loserId: string) {
  const result = await withActor((actor) => mergeCustomers(actor, winnerId, loserId));
  if (result.success) revalidateCustomerPaths();
  return result;
}
