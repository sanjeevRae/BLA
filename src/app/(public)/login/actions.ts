"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { verifyCredentials } from "@/server/services/authentication";
import { createDatabaseSession } from "@/lib/auth/session-cookie";
import { getClientIp } from "@/lib/auth/client-ip";

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
});

export interface LoginActionResult {
  error: boolean;
}

/**
 * The single login action for every role. Server Actions carry Next.js's
 * built-in CSRF/origin protection (docs/security-architecture.md §7).
 * On success a database session is created and the user is sent to /go,
 * which routes them to their role dashboard. On failure the result is a
 * single generic error — the form never reveals which check failed.
 */
export async function loginAction(input: {
  email: string;
  password: string;
}): Promise<LoginActionResult> {
  const parsed = loginSchema.safeParse(input);
  if (!parsed.success) return { error: true };

  const headerStore = await headers();
  // IP comes from the configured trusted forwarding header — see
  // src/lib/auth/client-ip.ts for the trust assumption behind it.
  const ipAddress = getClientIp(headerStore);
  const userAgent = headerStore.get("user-agent");

  const user = await verifyCredentials(parsed.data.email, parsed.data.password, {
    ipAddress,
    userAgent,
  });
  if (!user) return { error: true };

  await createDatabaseSession(user.id, { ipAddress, userAgent });
  // A flagged account must set a new password before any dashboard
  // access (docs/security-architecture.md §2/§4).
  redirect(user.mustChangePassword ? "/set-password" : "/go");
}
