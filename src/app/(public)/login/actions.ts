"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { verifyCredentials } from "@/server/services/authentication";
import { createDatabaseSession } from "@/lib/auth/session-cookie";

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
  const forwardedFor = headerStore.get("x-forwarded-for");
  const ipAddress = forwardedFor
    ? (forwardedFor.split(",")[0]?.trim() ?? null)
    : headerStore.get("x-real-ip");
  const userAgent = headerStore.get("user-agent");

  const user = await verifyCredentials(parsed.data.email, parsed.data.password, {
    ipAddress,
    userAgent,
  });
  if (!user) return { error: true };

  await createDatabaseSession(user.id, { ipAddress, userAgent });
  redirect("/go");
}
