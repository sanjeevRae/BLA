import "server-only";

import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";

import { prisma } from "@/lib/db/prisma";
import type { LoginRequestMeta } from "@/server/services/authentication";

/**
 * Database-session creation for the login flow.
 *
 * Sessions live in the Session table and are resolved by Auth.js
 * (adapter + database strategy) on every request — Auth.js owns the
 * cookie contract and expiry handling. The installed Auth.js version
 * cannot pair its Credentials provider with database sessions
 * (UnsupportedStrategy), so the login action creates the session row
 * here, following Auth.js's own cookie conventions:
 * name `authjs.session-token` (`__Secure-` prefixed on https), HttpOnly,
 * SameSite=Lax, 7-day lifetime (docs/security-architecture.md §2).
 */

export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function shouldUseSecureCookie(): boolean {
  return (process.env.AUTH_URL ?? "").startsWith("https://");
}

export function sessionCookieName(): string {
  return shouldUseSecureCookie() ? "__Secure-authjs.session-token" : "authjs.session-token";
}

/** Create a Session row for the user and set the session cookie. */
export async function createDatabaseSession(
  userId: string,
  meta: LoginRequestMeta,
): Promise<void> {
  const sessionToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);

  await prisma.session.create({
    data: {
      sessionToken,
      userId,
      expires,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    },
  });

  const store = await cookies();
  store.set(sessionCookieName(), sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: shouldUseSecureCookie(),
    expires,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/** Delete the current session row (revocation) and clear the cookie. */
export async function destroyDatabaseSession(): Promise<void> {
  const store = await cookies();
  const name = sessionCookieName();
  const token = store.get(name)?.value;
  if (token) {
    await prisma.session.deleteMany({ where: { sessionToken: token } });
  }
  store.delete(name);
}
