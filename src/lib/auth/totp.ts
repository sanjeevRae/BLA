import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP primitives (RFC 6238 over HOTP, RFC 4226) for the Phase 10
 * MFA hard gate (F13, docs/security-architecture.md §2). Implemented
 * in-repo on node:crypto HMAC-SHA1 — no new dependency. Pure
 * functions: the unit tests assert the RFC 6238 reference vectors.
 *
 * Policy: 6-digit codes, 30-second step, ±1 step tolerance at
 * verification (clock skew), and the caller records the accepted
 * counter so a code can never be replayed inside its window
 * (User.mfaLastUsedCounter).
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accepted steps on either side of the current one (skew tolerance). */
export const TOTP_WINDOW_STEPS = 1;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** A fresh 160-bit secret, base32-encoded (32 chars) for authenticator apps. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secretBase32: string, counter: number): string {
  const key = base32Decode(secretBase32);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const modulus = 10 ** TOTP_DIGITS;
  return (binary % modulus).toString().padStart(TOTP_DIGITS, "0");
}

export function totpCounter(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_STEP_SECONDS);
}

export function totp(secretBase32: string, at: Date = new Date()): string {
  return hotp(secretBase32, totpCounter(at));
}

/**
 * Verify a user-supplied code. Returns the matched time-step counter
 * (so the caller can persist it as the replay watermark) or null.
 * Candidates are compared in constant time.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  at: Date = new Date(),
): number | null {
  const candidate = code.trim();
  if (!/^\d{6}$/.test(candidate)) return null;
  const current = totpCounter(at);
  const candidateBuffer = Buffer.from(candidate, "utf8");
  for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset += 1) {
    const counter = current + offset;
    if (counter < 0) continue;
    const expected = Buffer.from(hotp(secretBase32, counter), "utf8");
    if (expected.length === candidateBuffer.length && timingSafeEqual(expected, candidateBuffer)) {
      return counter;
    }
  }
  return null;
}

/** otpauth:// URL rendered as the enrolment QR code. */
export function otpauthUrl(secretBase32: string, accountEmail: string): string {
  const issuer = "BLA Logistics";
  const label = `${issuer}:${accountEmail}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}
