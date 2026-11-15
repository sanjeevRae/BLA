import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { AuthorizationError, type ActorContext } from "@/lib/auth/actor";
import { decryptTotpSecret, encryptTotpSecret } from "@/lib/auth/mfa-crypto";
import { evaluateSessionActivity } from "@/lib/auth/session-policy";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "@/lib/auth/totp";
import { DomainValidationError } from "@/lib/errors";
import type { LoginRequestMeta } from "@/server/services/authentication";
import {
  getIdleTimeoutMs,
  isMfaPrivilegedRoleSet,
} from "@/server/services/system-settings";

type Tx = Prisma.TransactionClient;

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
  // Phase 10 review P10-R3: claim the pending secret with ONE
  // conditional update — it only lands while mfaSecretEncrypted is
  // still NULL and MFA is not enabled. Two concurrent begins (a
  // double-render / double-submit of the setup page) race on this
  // statement and exactly one wins; the previous read-then-write
  // shape let both callers generate their own secret, and the
  // last write stranded the QR code the loser had displayed.
  const claimed = await prisma.$transaction(async (tx) => {
    const res = await tx.user.updateMany({
      where: { id: actor.userId, mfaEnabled: false, mfaSecretEncrypted: null },
      data: { mfaSecretEncrypted: encryptTotpSecret(secret) },
    });
    if (res.count !== 1) return false;
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        action: "auth.mfa_enrolment_started",
        entityType: "User",
        entityId: actor.userId,
      },
    });
    return true;
  });
  if (claimed) {
    return { secretBase32: secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  // Lost the claim: re-read and re-display the stored secret, so
  // both callers leave with the SAME secret (the idempotent-begin
  // contract above).
  const fresh = await prisma.user.findUnique({
    where: { id: actor.userId },
    select: { email: true, mfaEnabled: true, mfaSecretEncrypted: true },
  });
  if (!fresh) throw new DomainValidationError("Account not found");
  if (fresh.mfaEnabled) {
    throw new DomainValidationError("MFA is already enabled for this account");
  }
  if (!fresh.mfaSecretEncrypted) {
    // The pending secret was cleared between the first read and the
    // claim (e.g. a super-admin MFA reset landed in between) — the
    // caller simply retries the begin.
    throw new DomainValidationError("MFA enrolment could not be started — please try again");
  }
  const stored = decryptTotpSecret(fresh.mfaSecretEncrypted);
  return { secretBase32: stored, otpauthUrl: otpauthUrl(stored, fresh.email) };
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

async function countRecentChallengeFailures(tx: Tx, userId: string): Promise<number> {
  return tx.loginAttempt.count({
    where: {
      userId,
      success: false,
      reason: "mfa_failed",
      createdAt: { gt: new Date(Date.now() - MFA_CHALLENGE_WINDOW_MS) },
    },
  });
}

async function destroyPendingSessionInTx(
  tx: Tx,
  sessionId: string,
  userId: string,
  meta: LoginRequestMeta,
) {
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
}

/**
 * Verify the TOTP challenge for an MFA-pending session. Every
 * failure is indistinguishable to the caller ({ ok: false }); the
 * lockout outcome additionally reports `locked` so the action can
 * route the user back to the login page (their session is gone).
 *
 * Phase 10 review P10-R1/R2 (the P6-R2 class): the failure-budget
 * count, the failure recording, the lockout decision AND the
 * success-path replay-watermark claim all run inside ONE
 * transaction that locks the User row FOR UPDATE, against
 * in-transaction state. The previous shape read the count and the
 * watermark outside any lock, so a concurrent burst was evaluated
 * against stale values: 16 parallel wrong codes recorded 11
 * failures before the lockout engaged (budget: 5), and one valid
 * code submitted to 4 pending sessions of the same user stamped
 * all 4. Serialised on the user row, the budget is exact and a
 * code satisfies at most one session.
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
          roles: { select: { role: { select: { code: true } } } },
        },
      },
    },
  });
  if (!session || session.user.status !== "ACTIVE" || !session.user.mfaEnabled) {
    return { ok: false, locked: false };
  }
  const user = session.user;
  if (session.mfaVerifiedAt) return { ok: true }; // already satisfied

  // Phase 10 review P10-R4: the F8 idle policy applies on the
  // challenge path too — a session idle past its role's limit must
  // not be able to complete the challenge. Read-only evaluation:
  // the row is left untouched for applySessionPolicy, which owns
  // expiry (deletes the row and resolves the request
  // unauthenticated) on the next gated resolution.
  const idleLimitMs = await getIdleTimeoutMs(user.roles.map((r) => r.role.code));
  if (evaluateSessionActivity(session.lastActivityAt, idleLimitMs, new Date()).expired) {
    return { ok: false, locked: false };
  }

  // Code verification is pure computation over the secret snapshot;
  // the replay decision is NOT made from this snapshot — the
  // watermark is re-checked inside the locked transaction below.
  // A missing secret is simply a failure, recorded like a wrong code.
  const counter = user.mfaSecretEncrypted
    ? verifyTotp(decryptTotpSecret(user.mfaSecretEncrypted), code)
    : null;

  return prisma.$transaction(
    async (tx): Promise<MfaChallengeResult> => {
      await tx.$queryRaw`SELECT "id" FROM "app"."User" WHERE "id" = ${user.id} FOR UPDATE`;

      const freshSession = await tx.session.findUnique({
        where: { id: session.id },
        select: { id: true, mfaVerifiedAt: true },
      });
      if (!freshSession) {
        // Destroyed mid-flight — the lockout of a concurrent call
        // (or an MFA reset, which deletes all sessions) landed first.
        return { ok: false, locked: true };
      }
      if (freshSession.mfaVerifiedAt) return { ok: true }; // satisfied concurrently

      const freshUser = await tx.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { status: true, mfaEnabled: true, mfaLastUsedCounter: true },
      });
      if (freshUser.status !== "ACTIVE" || !freshUser.mfaEnabled) {
        return { ok: false, locked: false };
      }

      const failuresBefore = await countRecentChallengeFailures(tx, user.id);

      const recordFailure = async (): Promise<MfaChallengeResult> => {
        if (failuresBefore >= MFA_CHALLENGE_MAX_FAILURES) {
          await destroyPendingSessionInTx(tx, session.id, user.id, meta);
          return { ok: false, locked: true };
        }
        await tx.loginAttempt.create({
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
          await destroyPendingSessionInTx(tx, session.id, user.id, meta);
          return { ok: false, locked: true };
        }
        return { ok: false, locked: false };
      };

      if (
        counter === null ||
        (freshUser.mfaLastUsedCounter !== null && counter <= freshUser.mfaLastUsedCounter)
      ) {
        return recordFailure();
      }

      // Success: claim the watermark and stamp the session in the
      // same locked transaction, so the code can never be replayed
      // into a second session.
      await tx.user.update({
        where: { id: user.id },
        data: { mfaLastUsedCounter: counter },
      });
      await tx.session.update({
        where: { id: session.id },
        data: { mfaVerifiedAt: new Date() },
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
      return { ok: true };
    },
    { timeout: 30_000 },
  );
}
