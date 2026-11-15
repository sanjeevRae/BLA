import "server-only";

import { prisma } from "@/lib/db/prisma";
import type { RoleCode } from "@/lib/permissions/catalog";
import { evaluateSessionActivity } from "@/lib/auth/session-policy";
import {
  getIdleTimeoutMs,
  isMfaPrivilegedRoleSet,
} from "@/server/services/system-settings";

/**
 * The Phase 10 session-row policy (hard gates F8 + F13), enforced by
 * getActorContext on the SAME database session Auth.js resolved for
 * the request. Factored into its own module — free of the Auth.js
 * import chain — so the integration suites can drive it against real
 * Session rows (getActorContext itself needs a live request context).
 *
 *  - F8 idle timeout: a session idle beyond its role's limit
 *    (SystemSetting; 24h staff / 12h privileged per security doc §2)
 *    is DELETED and reported expired — the caller resolves the
 *    request unauthenticated. Activity is re-stamped at most once
 *    per touch-throttle window (session-policy.ts).
 *  - F13 MFA state: an MFA-enrolled privileged user's session is
 *    "pending" until its mfaVerifiedAt is stamped by the challenge.
 *    The pending state is exposed on the ActorContext; the wrappers'
 *    requireAccessGranted and the dashboard page guards do the
 *    restricting, so the MFA flows themselves can still resolve
 *    their actor through getActorContext.
 */
export async function applySessionPolicy(
  sessionToken: string,
  userId: string,
  roles: readonly RoleCode[],
  mfaEnabled: boolean,
): Promise<{ expired: boolean; mfaPending: boolean }> {
  const sessionRow = await prisma.session.findUnique({
    where: { sessionToken },
    select: { id: true, userId: true, lastActivityAt: true, mfaVerifiedAt: true },
  });
  if (!sessionRow || sessionRow.userId !== userId) {
    return { expired: false, mfaPending: false };
  }
  const idleLimitMs = await getIdleTimeoutMs(roles);
  const decision = evaluateSessionActivity(sessionRow.lastActivityAt, idleLimitMs, new Date());
  if (decision.expired) {
    await prisma.session.deleteMany({ where: { id: sessionRow.id } });
    return { expired: true, mfaPending: false };
  }
  if (decision.shouldTouch) {
    await prisma.session.updateMany({
      where: { id: sessionRow.id },
      data: { lastActivityAt: new Date() },
    });
  }
  return {
    expired: false,
    mfaPending:
      isMfaPrivilegedRoleSet(roles) && mfaEnabled && sessionRow.mfaVerifiedAt === null,
  };
}
