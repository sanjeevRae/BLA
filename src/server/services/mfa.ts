import "server-only";

import { prisma } from "@/lib/db/prisma";
import { AuthorizationError, type ActorContext } from "@/lib/auth/actor";
import { decryptTotpSecret, encryptTotpSecret } from "@/lib/auth/mfa-crypto";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "@/lib/auth/totp";
import { DomainValidationError } from "@/lib/errors";
import type { LoginRequestMeta } from "@/server/services/authentication";
import { isMfaPrivilegedRoleSet } from "@/server/services/system-settings";

/**
 * TOTP MFA for privileged roles (Phase 10 hard gate F13;
 * docs/security-architecture.md §2: MFA required for super_admin and
 * admin, enrolment is part of first login).
 *
 * State machine on the User row:
 *  - no secret, mfaEnabled=false → not enrolled. A privileged login
 *    lands in the enrolment-restricted state (ActorContext
 *    .mfaEnrolmentRequired) until enrolment completes.
 *  - secret stored, mfaEnabled=false → enrolment in progress. The
 *    pending secret is inert; begin is idempotent so reloading the
 *    setup page re-displays the same secret instead of rotating it.
 *  - mfaEnabled=true → every new session starts MFA-pending
 *    (Session.mfaVerifiedAt null) and is restricted to the challenge
 *    flow until verifyMfaChallenge stamps it.
 *
 * Secrets are stored AES-256-GCM-encrypted (mfa-crypto.ts). Accepted
 * TOTP counters are watermarked on the user row, so a code can never
 * be replayed inside its ±1-step validity window. Challenge failures
 * are recorded as LoginAttempt rows (reason "mfa_failed"); reaching
 * MFA_CHALLENGE_MAX_FAILURES inside the window DESTROYS the pending
 * session — the lockout forces a fresh password login.
 */

export const MFA_CHALLENGE_MAX_FAILURES = 5;
export const MFA_CHALLENGE_WINDOW_MS = 15 * 60 * 1000;

function assertMfaPrivileged(actor: ActorContext): void {
  if (!isMfaPrivilegedRoleSet(actor.roles)) {
    throw new AuthorizationError("MFA enrolment applies to Super Admin and Admin accounts only");
  }
}

export interface MfaEnrolmentStart {
  secretBase32: string;
  otpauthUrl: string;
}

/**
 * Begin (or resume) enrolment for the signed-in privileged user.
 * Idempotent while unenrolled: an existing pending secret is
 * re-displayed, never rotated, so a page reload cannot strand a user
 * who already scanned the QR code.
 */
export async function beginMfaEnrolment(actor: ActorContext): Promise<MfaEnrolmentStart> {
  assertMfaPrivileged(actor);
  const user = await prisma.user.findUnique({
    where: { id: actor.userId },
    select: { email: true, mfaEnabled: true, mfaSecretEncrypted: true },
  });
  if (!user) throw new DomainValidationError("Account not found");
  if (user.mfaEnabled) {
    throw new DomainValidationError("MFA is already enabled for this account");
  }

  if (user.mfaSecretEncrypted) {
    const secret = decryptTotpSecret(user.mfaSecretEncrypted);
    return { secretBase32: secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  const secret = generateTotpSecret();
  await prisma.user.update({
    where: { id: actor.userId },
    data: { mfaSecretEncrypted: encryptTotpSecret(secret) },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "auth.mfa_enrolment_started",
      entityType: "User",
      entityId: actor.userId,
    },
  });
  return { secretBase32: secret, otpauthUrl: otpauthUrl(secret, user.email) };
}

/**
 * Confirm enrolment by proving possession of the authenticator: the
 * first valid code activates MFA and watermarks its counter. The
 * session performing the enrolment (when its token is supplied) is
 * stamped MFA-verified — the user just proved the second factor, so
 * they are not immediately challenged again.
 */
export async function confirmMfaEnrolment(
  actor: ActorContext,
  code: string,
  sessionToken?: string | null,
): Promise<{ enabled: true }> {
  assertMfaPrivileged(actor);
  const user = await prisma.user.findUnique({
    where: { id: actor.userId },
    select: { mfaEnabled: true, mfaSecretEncrypted: true, mfaLastUsedCounter: true },
  });
  if (!user) throw new DomainValidationError("Account not found");
  if (user.mfaEnabled) {
    throw new DomainValidationError("MFA is already enabled for this account");
  }
  if (!user.mfaSecretEncrypted) {
    throw new DomainValidationError("MFA enrolment has not been started");
  }

  const secret = decryptTotpSecret(user.mfaSecretEncrypted);
  const counter = verifyTotp(secret, code);
  if (counter === null || (user.mfaLastUsedCounter !== null && counter <= user.mfaLastUsedCounter)) {
    throw new DomainValidationError("That code was not accepted — check the authenticator and try again");
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: actor.userId },
      data: { mfaEnabled: true, mfaLastUsedCounter: counter },
    });
    if (sessionToken) {
      await tx.session.updateMany({
        where: { sessionToken, userId: actor.userId },
        data: { mfaVerifiedAt: new Date() },
      });
    }
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        action: "auth.mfa_enrolled",
        entityType: "User",
        entityId: actor.userId,
      },
    });
  });
  return { enabled: true };
}

export type MfaChallengeResult =
  | { ok: true }
  | { ok: false; locked: boolean };

async function countRecentChallengeFailures(userId: string): Promise<number> {
  return prisma.loginAttempt.count({
    where: {
      userId,
      success: false,
      reason: "mfa_failed",
      createdAt: { gt: new Date(Date.now() - MFA_CHALLENGE_WINDOW_MS) },
    },
  });
}

async function destroyPendingSession(sessionId: string, userId: string, meta: LoginRequestMeta) {
  await prisma.$transaction(async (tx) => {
    await tx.session.deleteMany({ where: { id: sessionId } });
    await tx.auditLog.create({
      data: {
        actorId: userId,
        action: "auth.mfa_challenge_locked",
        entityType: "User",
        entityId: userId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });
  });
}

/**
 * Verify the TOTP challenge for an MFA-pending session. Every
 * failure is indistinguishable to the caller ({ ok: false }); the
 * lockout outcome additionally reports `locked` so the action can
 * route the user back to the login page (their session is gone).
 */
export async function verifyMfaChallenge(
  sessionToken: string,
  code: string,
  meta: LoginRequestMeta,
): Promise<MfaChallengeResult> {
  const session = await prisma.session.findUnique({
    where: { sessionToken },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          status: true,
          mfaEnabled: true,
          mfaSecretEncrypted: true,
          mfaLastUsedCounter: true,
        },
      },
    },
  });
  if (!session || session.user.status !== "ACTIVE" || !session.user.mfaEnabled) {
    return { ok: false, locked: false };
  }
  const user = session.user;
  if (session.mfaVerifiedAt) return { ok: true }; // already satisfied

  const failuresBefore = await countRecentChallengeFailures(user.id);
  if (failuresBefore >= MFA_CHALLENGE_MAX_FAILURES) {
    await destroyPendingSession(session.id, user.id, meta);
    return { ok: false, locked: true };
  }

  const recordFailure = async (): Promise<MfaChallengeResult> => {
    await prisma.loginAttempt.create({
      data: {
        email: user.email,
        userId: user.id,
        success: false,
        reason: "mfa_failed",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });
    if (failuresBefore + 1 >= MFA_CHALLENGE_MAX_FAILURES) {
      await destroyPendingSession(session.id, user.id, meta);
      return { ok: false, locked: true };
    }
    return { ok: false, locked: false };
  };

  if (!user.mfaSecretEncrypted) return recordFailure();
  const secret = decryptTotpSecret(user.mfaSecretEncrypted);
  const counter = verifyTotp(secret, code);
  if (counter === null || (user.mfaLastUsedCounter !== null && counter <= user.mfaLastUsedCounter)) {
    return recordFailure();
  }

  await prisma.$transaction(async (tx) => {
    await tx.session.update({
      where: { id: session.id },
      data: { mfaVerifiedAt: new Date() },
    });
    await tx.user.update({
      where: { id: user.id },
      data: { mfaLastUsedCounter: counter },
    });
    await tx.loginAttempt.create({
      data: {
        email: user.email,
        userId: user.id,
        success: true,
        reason: "mfa_verified",
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        action: "auth.mfa_challenge_passed",
        entityType: "User",
        entityId: user.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      },
    });
  });
  return { ok: true };
}
