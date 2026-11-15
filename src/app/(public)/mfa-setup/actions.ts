"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getActorContext } from "@/lib/auth/permissions";
import { sessionCookieName } from "@/lib/auth/session-cookie";
import { DomainValidationError } from "@/lib/errors";
import { AuthorizationError } from "@/lib/auth/actor";
import { confirmMfaEnrolment } from "@/server/services/mfa";

const codeSchema = z.object({ code: z.string().trim().min(1).max(12) });

export interface MfaActionResult {
  error: string | null;
}

/**
 * Confirm TOTP enrolment (Phase 10 gate F13). Exempt from the
 * access gate by design — like the password-change path, this flow
 * is how a restricted actor RESOLVES their restriction, so it
 * resolves the actor with getActorContext() only. The service
 * verifies the code against the pending secret; on success the
 * current session is stamped MFA-verified and the user continues.
 */
export async function confirmMfaEnrolmentAction(input: {
  code: string;
}): Promise<MfaActionResult> {
  const parsed = codeSchema.safeParse(input);
  if (!parsed.success) return { error: "Enter the 6-digit code from your authenticator app." };

  const actor = await getActorContext();
  if (!actor) return { error: "Your session has expired — sign in again." };

  const store = await cookies();
  const sessionToken = store.get(sessionCookieName())?.value ?? null;
  try {
    await confirmMfaEnrolment(actor, parsed.data.code, sessionToken);
  } catch (error) {
    if (error instanceof DomainValidationError || error instanceof AuthorizationError) {
      return { error: error.message };
    }
    throw error;
  }
  redirect("/go");
}
