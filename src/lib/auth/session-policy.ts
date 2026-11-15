/**
 * Session idle-timeout policy (Phase 10 hard gate F8;
 * docs/security-architecture.md §2). Pure decision function — the
 * database-backed enforcement lives in getActorContext
 * (src/lib/auth/permissions.ts), the unit/integration tests assert
 * this function and the enforcement against real Session rows.
 *
 * The idle clock is Session.lastActivityAt. Enforcement deletes the
 * session row once the idle age exceeds the role's limit (24h staff
 * / 12h privileged, values from SystemSetting). Activity touches
 * are throttled: lastActivityAt is rewritten at most once per
 * SESSION_TOUCH_THROTTLE_MS per session, so a busy console does not
 * pay a session write on every request — the throttle is far below
 * either limit, so it cannot extend a session past its limit by
 * more than the throttle window.
 */

export const SESSION_TOUCH_THROTTLE_MS = 5 * 60 * 1000;

export interface SessionActivityDecision {
  /** Idle age exceeded the limit: the session must be deleted and
   *  the request treated as unauthenticated. */
  expired: boolean;
  /** Activity should be stamped now (lastActivityAt is older than
   *  the touch throttle). Always false when expired. */
  shouldTouch: boolean;
}

export function evaluateSessionActivity(
  lastActivityAt: Date,
  idleLimitMs: number,
  now: Date,
): SessionActivityDecision {
  const idleAgeMs = now.getTime() - lastActivityAt.getTime();
  if (idleAgeMs > idleLimitMs) {
    return { expired: true, shouldTouch: false };
  }
  return { expired: false, shouldTouch: idleAgeMs >= SESSION_TOUCH_THROTTLE_MS };
}
