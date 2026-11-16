/**
 * Login eligibility and lockout rules (docs/security-architecture.md §2).
 * Pure functions — the credentials provider calls them, the unit tests
 * assert them. No database access here.
 */

export const MAX_FAILED_ATTEMPTS = 10;
export const LOCK_DURATION_MS = 15 * 60 * 1000;
/** Per-IP throttle: failed attempts inside the window that block an IP. */
export const IP_FAILURE_LIMIT = 20;
export const IP_FAILURE_WINDOW_MS = 10 * 60 * 1000;
/** Per-IP throttle for invitation redemption (Phase 2 V2): failed
 *  redemption attempts inside the window that block an IP. Mirrors
 *  the login budget — an exhausted IP gets the generic invalid-token
 *  response, never a distinguishable throttle error. */
export const INVITATION_IP_FAILURE_LIMIT = 20;
export const INVITATION_IP_FAILURE_WINDOW_MS = 10 * 60 * 1000;

export type LoginDenyReason = "suspended" | "deactivated" | "locked";

export type LoginEligibility = { ok: true } | { ok: false; reason: LoginDenyReason };

export interface LoginGuardUser {
  status: string;
  lockedUntil: Date | null;
}

/**
 * A user may attempt a password login only when the account is ACTIVE and
 * not inside a lockout window. A lock that has expired no longer blocks.
 */
export function evaluateLoginEligibility(user: LoginGuardUser, now: Date = new Date()): LoginEligibility {
  if (user.status === "SUSPENDED") return { ok: false, reason: "suspended" };
  if (user.status !== "ACTIVE") return { ok: false, reason: "deactivated" };
  if (user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime()) {
    return { ok: false, reason: "locked" };
  }
  return { ok: true };
}

export interface FailureState {
  failedLoginAttempts: number;
  lockedUntil: Date | null;
}

/**
 * State after one more failed attempt. Reaching MAX_FAILED_ATTEMPTS locks
 * the account for LOCK_DURATION_MS and resets the counter, so the count
 * after the lock expires starts from zero.
 */
export function nextFailureState(currentAttempts: number, now: Date = new Date()): FailureState {
  const attempts = currentAttempts + 1;
  if (attempts >= MAX_FAILED_ATTEMPTS) {
    return { failedLoginAttempts: 0, lockedUntil: new Date(now.getTime() + LOCK_DURATION_MS) };
  }
  return { failedLoginAttempts: attempts, lockedUntil: null };
}
