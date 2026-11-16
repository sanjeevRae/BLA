"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getClientIp } from "@/lib/auth/client-ip";
import {
  AuthorizationError,
  getActorContext,
  requireAccessGranted,
} from "@/lib/auth/permissions";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import {
  acceptInvitation,
  createInvitation,
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
