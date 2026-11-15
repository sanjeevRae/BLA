import "server-only";

import { compare } from "bcryptjs";

import { prisma } from "@/lib/db/prisma";
import {
  evaluateLoginEligibility,
  nextFailureState,
  IP_FAILURE_LIMIT,
  IP_FAILURE_WINDOW_MS,
} from "@/lib/auth/login-guard";
import {
  isMfaPrivilegedRoleSet,
  isMfaRequiredForPrivileged,
} from "@/server/services/system-settings";

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

/** Dummy bcrypt hash so unknown-email logins cost the same compare as real
 *  ones. Cost 12 to match the password hashing cost (Phase 2 review
 *  P2-12) — a cheaper dummy would re-open the F7 timing channel. */
const DUMMY_HASH = "$2b$12$ZjhVh53BWy1oisBtzToUx.Ckzfy98BhdhQCOKonBg2cr0jaSCFrny";

export interface LoginRequestMeta {
  ipAddress: string | null;
  userAgent: string | null;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  /** When true the login flow must route the user to the set-password
   *  step before any dashboard access (security doc §2/§4). */
  mustChangePassword: boolean;
  /** Phase 10 (F13): privileged account that must complete TOTP
   *  enrolment before any dashboard access (policy in SystemSetting). */
  mfaEnrolmentRequired: boolean;
  /** Phase 10 (F13): privileged account with MFA enrolled — the new
   *  session is MFA-pending until the TOTP challenge stamps it. */
  mfaChallengeRequired: boolean;
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
  // attempts regardless of the account targeted. Rows recorded AS
  // ip_throttled are excluded from the count: they are a consequence of
  // throttling, and counting them would let continued attempts keep
  // refreshing the window so the block never lapses (self-extension).
  if (ipAddress) {
    const recentIpFailures = await prisma.loginAttempt.count({
      where: {
        ipAddress,
        success: false,
        reason: { not: "ip_throttled" },
        createdAt: { gte: new Date(Date.now() - IP_FAILURE_WINDOW_MS) },
      },
    });
    if (recentIpFailures >= IP_FAILURE_LIMIT) {
      await compare(password, DUMMY_HASH); // keep the timing uniform
      await recordAttempt(null, false, "ip_throttled");
      return null;
    }
  }

  const user = await prisma.user.findUnique({
    where: { email },
    include: { roles: { include: { role: true } } },
  });
  if (!user) {
    await compare(password, DUMMY_HASH); // blunt timing enumeration
    await recordAttempt(null, false, "unknown_user");
    return null;
  }

  // Every early return below still pays a dummy bcrypt compare, so a
  // suspended/locked/password-less account is indistinguishable by timing
  // from a wrong password (the error message is already uniform).
  const eligibility = evaluateLoginEligibility(user);
  if (!eligibility.ok) {
    await compare(password, DUMMY_HASH);
    await recordAttempt(user.id, false, eligibility.reason);
    return null;
  }

  if (!user.passwordHash) {
    await compare(password, DUMMY_HASH);
    await recordAttempt(user.id, false, "no_password_set");
    return null;
  }

  const passwordOk = await compare(password, user.passwordHash);
  if (!passwordOk) {
    // Atomic increment: the counter is bumped inside a single UPDATE, so
    // parallel failed logins can no longer snapshot the same value and
    // lose counts on write-back (which let an attacker batch guesses
    // inside one compare window and slip past the lockout threshold).
    // The returned row carries this statement's own post-increment value,
    // which is what the lockout decision is made from.
    const incremented = await prisma.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: { increment: 1 } },
      select: { failedLoginAttempts: true },
    });
    const failure = nextFailureState(incremented.failedLoginAttempts - 1);
    if (failure.lockedUntil) {
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: failure.failedLoginAttempts,
          lockedUntil: failure.lockedUntil,
        },
      });
    } else if (user.lockedUntil !== null) {
      // Below the threshold: clear a stale, already-expired lock stamp.
      await prisma.user.update({
        where: { id: user.id },
        data: { lockedUntil: null },
      });
    }
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

  // Phase 10 (F13): the login action routes on these flags — the
  // session it creates is restricted (ActorContext flags, computed
  // from the same state in getActorContext) until enrolment or the
  // challenge completes.
  const roleCodes = user.roles.filter((r) => r.role.isActive).map((r) => r.role.code);
  const mfaPrivileged = isMfaPrivilegedRoleSet(roleCodes);
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    mustChangePassword: user.mustChangePassword,
    mfaEnrolmentRequired:
      mfaPrivileged && !user.mfaEnabled && (await isMfaRequiredForPrivileged()),
    mfaChallengeRequired: mfaPrivileged && user.mfaEnabled,
  };
}
