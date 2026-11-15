"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

import {
  AuthorizationError,
  getActorContext,
  requireUnflagged,
} from "@/lib/auth/permissions";
import { sessionCookieName } from "@/lib/auth/session-cookie";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import {
  changePassword,
  reactivateUser,
  suspendUser,
  type ChangePasswordInput,
} from "@/server/services/users";
import type { ActionResult } from "@/server/actions/warehouses";

/** Change the signed-in user's password (also the forced set-password
 *  step for mustChangePassword accounts). Other sessions are revoked
 *  by the service; the current session survives. */
export async function changePasswordAction(
  input: ChangePasswordInput,
): Promise<ActionResult<{ changed: true }>> {
  const actor = await getActorContext();
  if (!actor) return { success: false, error: "Authentication required" };
  const store = await cookies();
  const currentSessionToken = store.get(sessionCookieName())?.value ?? null;
  try {
    const data = await changePassword(actor, input, currentSessionToken);
    return { success: true, data };
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

/** Suspend a user account (user.manage): status flip + deletion of all
 *  of the user's sessions + audit event, in the service. */
export async function suspendUserAction(
  userId: string,
  reason?: string,
): Promise<ActionResult<{ suspended: true }>> {
  const actor = await getActorContext();
  if (!actor) return { success: false, error: "Authentication required" };
  try {
    requireUnflagged(actor); // P2-3: flagged accounts act nowhere but password change
    const data = await suspendUser(actor, userId, reason);
    revalidatePath("/admin/warehouses");
    revalidatePath("/super-admin/warehouses");
    return { success: true, data };
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

export async function reactivateUserAction(
  userId: string,
): Promise<ActionResult<{ reactivated: true }>> {
  const actor = await getActorContext();
  if (!actor) return { success: false, error: "Authentication required" };
  try {
    requireUnflagged(actor); // P2-3
    const data = await reactivateUser(actor, userId);
    revalidatePath("/admin/warehouses");
    revalidatePath("/super-admin/warehouses");
    return { success: true, data };
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
