import { randomInt } from "node:crypto";

/**
 * Public tracking IDs (docs/database-schema.md §4; docs/security-
 * architecture.md §7). The docs fix no literal format beyond
 * "the public tracking code", so Phase 3 defines:
 *
 *   BLA-<9 payload digits><1 check digit>     e.g. BLA-4839201756
 *
 * The payload is cryptographically random — deliberately NOT
 * sequential, so tracking codes cannot be enumerated — and the final
 * digit is a Luhn check digit over the payload, so a mistyped code is
 * rejected before any database lookup. Uniqueness is enforced by the
 * database constraint; the booking service retries on collision.
 */

export const TRACKING_ID_PATTERN = /^BLA-\d{10}$/;

function luhnCheckDigit(payloadDigits: string): number {
  // Compute the digit that makes the full number pass Luhn: walking the
  // payload right-to-left, double every digit at an odd offset from the
  // right (the check digit itself occupies offset 0 and is not doubled).
  let sum = 0;
  const digits = payloadDigits.split("").map(Number);
  for (let i = 0; i < digits.length; i++) {
    let d = digits[digits.length - 1 - i];
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function generateTrackingId(): string {
  const payload = randomInt(0, 1_000_000_000).toString().padStart(9, "0");
  return `BLA-${payload}${luhnCheckDigit(payload)}`;
}

export function isValidTrackingId(value: string): boolean {
  if (!TRACKING_ID_PATTERN.test(value)) return false;
  const digits = value.slice(4);
  const payload = digits.slice(0, 9);
  return luhnCheckDigit(payload) === Number(digits[9]);
}
