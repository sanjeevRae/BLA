"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { getClientIp } from "@/lib/auth/client-ip";
import { destroyDatabaseSession, sessionCookieName } from "@/lib/auth/session-cookie";
import { verifyMfaChallenge } from "@/server/services/mfa";

const codeSchema = z.object({ code: z.string().trim().min(1).max(12) });

export interface MfaChallengeActionResult {
  error: string | null;
}

/**
 * The TOTP challenge step of login (Phase 10 gate F13). The password
 * step already created the database session; it stays MFA-pending —
 * restricted to this flow — until the challenge stamps it. Failures
 * are recorded by the service as LoginAttempt rows; when the failure
 * budget is exhausted the service destroys the pending session, and
 * this action clears the now-dead cookie and returns the user to the
 * login page for a fresh password login.
 */
export async function verifyMfaChallengeAction(input: {
  code: string;
}): Promise<MfaChallengeActionResult> {
  const parsed = codeSchema.safeParse(input);
  if (!parsed.success) return { error: "Enter the 6-digit code from your authenticator app." };

  const store = await cookies();
  const sessionToken = store.get(sessionCookieName())?.value;
  if (!sessionToken) return { error: "Your session has expired — sign in again." };

  const headerStore = await headers();
  const result = await verifyMfaChallenge(sessionToken, parsed.data.code, {
    ipAddress: getClientIp(headerStore),
    userAgent: headerStore.get("user-agent"),
  });

  if (result.ok) redirect("/go");
  if (result.locked) {
    await destroyDatabaseSession();
    redirect("/login");
  }
  // One generic message: never reveal how close the attempt was.
  return { error: "That code was not accepted — check the authenticator and try again." };
}
