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
  approveBooking,
  cancelBooking,
  createBooking,
  createBulkBookings,
  rejectBooking,
  updateBooking,
  type CreateBookingInput,
  type CreateBulkBookingsInput,
  type UpdateBookingInput,
} from "@/server/services/bookings";
import type { ActionResult } from "@/server/actions/warehouses";

/** Server Actions for bookings — same contract as the other modules
 *  (session actor, P2-3 mustChangePassword gate, service-side
 *  permission + scope checks). */

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

function revalidateBookingPaths(orderId?: string): void {
  revalidatePath("/admin/bookings");
  revalidatePath("/super-admin/bookings");
  revalidatePath("/vendor");
  revalidatePath("/vendor/bookings");
  revalidatePath("/warehouse");
  revalidatePath("/staff");
  revalidatePath("/customer");
  if (orderId) {
    revalidatePath(`/admin/bookings/${orderId}`);
    revalidatePath(`/super-admin/bookings/${orderId}`);
    revalidatePath(`/vendor/bookings/${orderId}`);
  }
}

export async function createBookingAction(input: CreateBookingInput) {
  const result = await withActor((actor) => createBooking(actor, input));
  if (result.success) revalidateBookingPaths(result.data.id);
  return result;
}

/** Phase 7 bulk booking: one submission creates 1–50 bookings
 *  all-or-nothing (see createBulkBookings). Errors — including the
 *  "Row N: …" row context — surface verbatim so the form can show
 *  exactly which row failed; entered values stay in the form. */
export async function createBulkBookingsAction(input: CreateBulkBookingsInput) {
  const result = await withActor((actor) => createBulkBookings(actor, input));
  if (result.success) revalidateBookingPaths();
  return result;
}

export async function approveBookingAction(orderId: string, note?: string | null) {
  const result = await withActor((actor) => approveBooking(actor, orderId, note));
  if (result.success) revalidateBookingPaths(orderId);
  return result;
}

export async function rejectBookingAction(orderId: string, reason: string) {
  const result = await withActor((actor) => rejectBooking(actor, orderId, reason));
  if (result.success) revalidateBookingPaths(orderId);
  return result;
}

export async function cancelBookingAction(orderId: string, reason: string) {
  const result = await withActor((actor) => cancelBooking(actor, orderId, reason));
  if (result.success) revalidateBookingPaths(orderId);
  return result;
}

export async function updateBookingAction(orderId: string, input: UpdateBookingInput) {
  const result = await withActor((actor) => updateBooking(actor, orderId, input));
  if (result.success) revalidateBookingPaths(orderId);
  return result;
}
