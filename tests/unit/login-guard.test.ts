import { describe, expect, it } from "vitest";

import {
  evaluateLoginEligibility,
  nextFailureState,
  LOCK_DURATION_MS,
  MAX_FAILED_ATTEMPTS,
} from "@/lib/auth/login-guard";

const NOW = new Date("2026-11-15T10:00:00.000Z");

describe("login eligibility (docs/security-architecture.md §2)", () => {
  it("allows an ACTIVE, unlocked account", () => {
    expect(evaluateLoginEligibility({ status: "ACTIVE", lockedUntil: null }, NOW)).toEqual({
      ok: true,
    });
  });

  it("denies a SUSPENDED account even with no lock", () => {
    expect(evaluateLoginEligibility({ status: "SUSPENDED", lockedUntil: null }, NOW)).toEqual({
      ok: false,
      reason: "suspended",
    });
  });

  it("denies a DEACTIVATED account", () => {
    expect(evaluateLoginEligibility({ status: "DEACTIVATED", lockedUntil: null }, NOW)).toEqual({
      ok: false,
      reason: "deactivated",
    });
  });

  it("denies an ACTIVE account inside its lockout window", () => {
    const lockedUntil = new Date(NOW.getTime() + 60_000);
    expect(evaluateLoginEligibility({ status: "ACTIVE", lockedUntil }, NOW)).toEqual({
      ok: false,
      reason: "locked",
    });
  });

  it("allows an ACTIVE account whose lock has expired", () => {
    const lockedUntil = new Date(NOW.getTime() - 1_000);
    expect(evaluateLoginEligibility({ status: "ACTIVE", lockedUntil }, NOW)).toEqual({
      ok: true,
    });
  });
});

describe("failed-attempt lockout", () => {
  it("increments the counter below the threshold without locking", () => {
    expect(nextFailureState(0, NOW)).toEqual({ failedLoginAttempts: 1, lockedUntil: null });
    expect(nextFailureState(3, NOW)).toEqual({ failedLoginAttempts: 4, lockedUntil: null });
  });

  it("locks for 15 minutes when the threshold is reached and resets the counter", () => {
    const state = nextFailureState(MAX_FAILED_ATTEMPTS - 1, NOW);
    expect(state.failedLoginAttempts).toBe(0);
    expect(state.lockedUntil?.getTime()).toBe(NOW.getTime() + LOCK_DURATION_MS);
  });
});
