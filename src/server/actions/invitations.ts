"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getClientIp } from "@/lib/auth/client-ip";
import {
  AuthorizationError,
  getActorContext,
  requireAccessGranted,
} from "@/lib/auth/permissions";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import {
  acceptInvitation,
  approveInvitation,
  createInvitation,
  rejectInvitation,
  revokeInvitation,
  type AcceptInvitationInput,
  type CreateInvitationInput,
} from "@/server/services/invitations";
import type { ActionResult } from "@/server/actions/warehouses";

/** Create an invitation (user.invite). The raw token comes back exactly
 *  once so the admin can deliver the accept link out of band. */
export async function createInvitationAction(
  input: CreateInvitationInput,
): Promise<ActionResult<{ token: string; expiresAt: string }>> {
  const actor = await getActorContext();
  if (!actor) return { success: false, error: "Authentication required" };
  try {
    requireAccessGranted(actor); // P2-3: flagged accounts act nowhere but password change
    const created = await createInvitation(actor, input);
    return { success: true, data: { token: created.token, expiresAt: created.expiresAt } };
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

/** Public acceptance: the token is the credential. On success the new
 *  user is sent to the single login page to sign in with the password
 *  they just set. */
export async function acceptInvitationAction(
  input: AcceptInvitationInput,
): Promise<ActionResult<never>> {
  try {
    const ipAddress = getClientIp(await headers());
    await acceptInvitation(input, { ipAddress });
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
  redirect("/login?invited=1");
}

/** Approve a privileged invitation (Phase 6 four-eyes): the service
 *  refuses self-approval and mirrors the invite rights per role. */
export async function approveInvitationAction(
  invitationId: string,
): Promise<ActionResult<{ approved: true }>> {
  const actor = await getActorContext();
  if (!actor) return { success: false, error: "Authentication required" };
  try {
    requireAccessGranted(actor); // P2-3
    await approveInvitation(actor, invitationId);
    revalidatePath("/admin/users");
    revalidatePath("/super-admin/users");
    return { success: true, data: { approved: true } };
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

/** Reject a privileged invitation (Phase 6 four-eyes): terminal — the
 *  token can never be redeemed afterwards. */
export async function rejectInvitationAction(
  invitationId: string,
  reason?: string,
): Promise<ActionResult<{ rejected: true }>> {
  const actor = await getActorContext();
  if (!actor) return { success: false, error: "Authentication required" };
  try {
    requireAccessGranted(actor); // P2-3
    await rejectInvitation(actor, invitationId, reason);
    revalidatePath("/admin/users");
    revalidatePath("/super-admin/users");
    return { success: true, data: { rejected: true } };
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

/** Revoke a live invitation (PENDING or PENDING_APPROVAL). */
export async function revokeInvitationAction(
  invitationId: string,
): Promise<ActionResult<{ revoked: true }>> {
  const actor = await getActorContext();
  if (!actor) return { success: false, error: "Authentication required" };
  try {
    requireAccessGranted(actor); // P2-3
    await revokeInvitation(actor, invitationId);
    revalidatePath("/admin/users");
    revalidatePath("/super-admin/users");
    return { success: true, data: { revoked: true } };
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
