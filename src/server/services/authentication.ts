import "server-only";

import { compare } from "bcryptjs";

import { prisma } from "@/lib/db/prisma";
import {
  evaluateLoginEligibility,
  nextFailureState,
  IP_FAILURE_LIMIT,
  IP_FAILURE_WINDOW_MS,
} from "@/lib/auth/login-guard";

/**
 * Credential verification (docs/security-architecture.md §2).
 *
 * Verifies email + bcrypt password hash and owns every side effect of a
 * login attempt: LoginAttempt recording, per-IP throttling, the failure
 * counter and lockout, and the audit entries. Returns the user on success
 * and null on ANY failure — callers must not learn which check failed.
 *
 * This service is called by the login Server Action (see
 * src/app/(public)/login/actions.ts). Auth.js owns session resolution
 * over the database sessions this flow creates; the installed Auth.js
 * version cannot pair its Credentials provider with database sessions,
 * so the sign-in endpoint is ours while the session store, cookie
 * contract and expiry remain Auth.js's.
 */

/** Dummy bcrypt hash so unknown-email logins cost the same compare as real ones. */
const DUMMY_HASH = "$2b$10$CwTycUXWue0Thq9StjUM0uJ8hOCPFPoGJvJBjBJveS0hBJpGJMjVy";

export interface LoginRequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
}

export async function verifyCredentials(
  emailRaw: string,
  password: string,
  meta: LoginRequestMeta,
): Promise<AuthenticatedUser | null> {
  const email = emailRaw.trim().toLowerCase();
  const { ipAddress, userAgent } = meta;

  const recordAttempt = async (
    userId: string | null,
    success: boolean,
    reason: string | null,
  ): Promise<void> => {
    await prisma.loginAttempt.create({
      data: { email, userId, success, reason, ipAddress, userAgent },
    });
  };

  // Per-IP throttle: too many recent failures from this IP blocks further
  // attempts regardless of the account targeted.
  if (ipAddress) {
    const recentIpFailures = await prisma.loginAttempt.count({
      where: {
        ipAddress,
        success: false,
        createdAt: { gte: new Date(Date.now() - IP_FAILURE_WINDOW_MS) },
      },
    });
    if (recentIpFailures >= IP_FAILURE_LIMIT) {
      await recordAttempt(null, false, "ip_throttled");
      return null;
    }
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    await compare(password, DUMMY_HASH); // blunt timing enumeration
    await recordAttempt(null, false, "unknown_user");
    return null;
  }

  const eligibility = evaluateLoginEligibility(user);
  if (!eligibility.ok) {
    await recordAttempt(user.id, false, eligibility.reason);
    return null;
  }

  if (!user.passwordHash) {
    await recordAttempt(user.id, false, "no_password_set");
    return null;
  }

  const passwordOk = await compare(password, user.passwordHash);
  if (!passwordOk) {
    const failure = nextFailureState(user.failedLoginAttempts);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: failure.failedLoginAttempts,
        lockedUntil: failure.lockedUntil,
      },
    });
    await recordAttempt(user.id, false, "bad_password");
    if (failure.lockedUntil) {
      await prisma.auditLog.create({
        data: {
          actorId: user.id,
          action: "login.locked",
          entityType: "User",
          entityId: user.id,
          ipAddress,
          userAgent,
        },
      });
    }
    return null;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  });
  await recordAttempt(user.id, true, null);
  await prisma.auditLog.create({
    data: {
      actorId: user.id,
      action: "auth.login",
      entityType: "User",
      entityId: user.id,
      ipAddress,
      userAgent,
    },
  });

  return { id: user.id, email: user.email, fullName: user.fullName };
}
