import { beforeAll, describe, expect, it, vi } from "vitest";

// mfa-crypto is server-only code; stub the marker module.
vi.mock("server-only", () => ({}));

// The MFA secret store reads its key from the environment lazily (per
// call), so a fixed test key can be installed before the first use.
process.env.MFA_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  totp,
  totpCounter,
  verifyTotp,
} from "@/lib/auth/totp";
import {
  evaluateSessionActivity,
  SESSION_TOUCH_THROTTLE_MS,
} from "@/lib/auth/session-policy";
import {
  requireAccessGranted,
  requireMfaSatisfied,
  type ActorContext,
} from "@/lib/auth/actor";

// RFC 6238 Appendix B reference secret: the ASCII string
// "12345678901234567890" (SHA-1 test seed).
const RFC_SECRET_BYTES = Buffer.from("12345678901234567890", "ascii");
const RFC_SECRET = base32Encode(RFC_SECRET_BYTES);

describe("TOTP primitives (Phase 10 gate F13)", () => {
  it("base32 round-trips arbitrary bytes and matches the RFC seed encoding", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(RFC_SECRET)).toEqual(RFC_SECRET_BYTES);
    const random = Buffer.from([0, 1, 2, 250, 251, 252, 13, 99, 7]);
    expect(base32Decode(base32Encode(random))).toEqual(random);
    // Lowercase and spaces are accepted (authenticator apps vary).
    expect(base32Decode(RFC_SECRET.toLowerCase())).toEqual(RFC_SECRET_BYTES);
  });

  it("generateTotpSecret returns 32 base32 characters (160 bits)", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(secret);
  });

  // RFC 6238 Appendix B, SHA-1 column, truncated to 6 digits.
  // 8-digit RFC values 94287082 / 07081804 / 14050471 / 89005924 /
  // 69279037 / 65353130, truncated to 6 digits (independently
  // cross-checked against a reference HMAC-SHA1 computation).
  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1_111_111_109, "081804"],
    [1_111_111_111, "050471"],
    [1_234_567_890, "005924"],
    [2_000_000_000, "279037"],
    [20_000_000_000, "353130"],
  ];
  it.each(vectors)("totp matches the RFC 6238 vector at T=%is", (seconds, expected) => {
    expect(totp(RFC_SECRET, new Date(seconds * 1000))).toBe(expected);
  });

  it("verifyTotp tolerates ±1 step and returns the matched counter", () => {
    const at = new Date(1_234_567_890 * 1000);
    const counter = totpCounter(at);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter), at)).toBe(counter);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter - 1), at)).toBe(counter - 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter + 1), at)).toBe(counter + 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter + 2), at)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "not-a-code", at)).toBeNull();
    expect(verifyTotp(RFC_SECRET, "12345", at)).toBeNull();
  });
});

describe("MFA secret encryption at rest", () => {
  let encryptMfaSecret: typeof import("@/lib/auth/mfa-crypto").encryptTotpSecret;
  let decryptMfaSecret: typeof import("@/lib/auth/mfa-crypto").decryptTotpSecret;

  beforeAll(async () => {
    ({ encryptTotpSecret: encryptMfaSecret, decryptTotpSecret: decryptMfaSecret } = await import("@/lib/auth/mfa-crypto"));
  });

  it("round-trips and never stores the plaintext", () => {
    const stored = encryptMfaSecret(RFC_SECRET);
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain(RFC_SECRET);
    expect(decryptMfaSecret(stored)).toBe(RFC_SECRET);
  });

  it("rejects tampered ciphertext", () => {
    const stored = encryptMfaSecret(RFC_SECRET);
    const parts = stored.split(".");
    parts[3] = Buffer.from("tampered-value").toString("base64");
    expect(() => decryptMfaSecret(parts.join("."))).toThrow();
    expect(() => decryptMfaSecret("garbage")).toThrow();
  });
});

describe("session idle policy (Phase 10 gate F8)", () => {
  const HOUR = 60 * 60 * 1000;
  const now = new Date("2026-11-15T12:00:00Z");

  it("a just-active session neither expires nor touches", () => {
    const decision = evaluateSessionActivity(new Date(now.getTime() - 60_000), 12 * HOUR, now);
    expect(decision).toEqual({ expired: false, shouldTouch: false });
  });

  it("activity older than the touch throttle re-stamps", () => {
    const decision = evaluateSessionActivity(
      new Date(now.getTime() - SESSION_TOUCH_THROTTLE_MS - 1),
      12 * HOUR,
      now,
    );
    expect(decision).toEqual({ expired: false, shouldTouch: true });
  });

  it("exactly at the limit survives; one millisecond beyond expires", () => {
    const atLimit = evaluateSessionActivity(new Date(now.getTime() - 12 * HOUR), 12 * HOUR, now);
    expect(atLimit.expired).toBe(false);
    const beyond = evaluateSessionActivity(
      new Date(now.getTime() - 12 * HOUR - 1),
      12 * HOUR,
      now,
    );
    expect(beyond.expired).toBe(true);
  });
});

describe("MFA access gate on the actor", () => {
  function actor(overrides: Partial<ActorContext>): ActorContext {
    return {
      userId: "user-1",
      email: "actor@test.local",
      fullName: "Actor",
      status: "ACTIVE",
      mustChangePassword: false,
      roles: ["ADMIN"],
      primaryRole: "ADMIN",
      permissions: new Set<string>(),
      warehouseIds: [],
      membershipRoles: [],
      vendorId: null,
      vendorRole: null,
      driverId: null,
      customerId: null,
      landingPath: "/admin",
      ...overrides,
    };
  }

  it("a clean actor passes both gates", () => {
    expect(() => requireAccessGranted(actor({}))).not.toThrow();
    expect(() => requireMfaSatisfied(actor({}))).not.toThrow();
  });

  it("an MFA-pending actor is refused", () => {
    expect(() => requireAccessGranted(actor({ mfaPending: true }))).toThrow(
      /MFA verification required/,
    );
  });

  it("an enrolment-required actor is refused", () => {
    expect(() => requireAccessGranted(actor({ mfaEnrolmentRequired: true }))).toThrow(
      /MFA enrolment required/,
    );
  });

  it("the plain unflagged gate still fires first for flagged actors", () => {
    // requireUnflagged's flag is mustChangePassword (account status is
    // enforced at session resolution, not in this gate).
    expect(() => requireAccessGranted(actor({ mustChangePassword: true }))).toThrow(
      /Password change required/,
    );
  });
});
