import { randomInt } from "node:crypto";

import bcrypt from "bcryptjs";

/**
 * Delivery OTP primitives (docs/delivery-workflow.md §6/§10,
 * docs/database-schema.md §8 ProofOfDelivery). The code is a 6-digit
 * numeric challenge generated per package at pickup; ONLY its bcrypt
 * hash is ever stored (DeliveryAssignment.otpCodeHash, copied onto
 * the ProofOfDelivery as evidence at confirmation). The plaintext
 * code is returned exactly once, by the pickup operation, so the
 * caller can deliver it to the recipient — in production that is the
 * notification channel (Phase 8); it is never written to a log, an
 * audit row, or a tracking event.
 */

export const OTP_CODE_LENGTH = 6;

export function generateOtpCode(): string {
  return randomInt(0, 10 ** OTP_CODE_LENGTH)
    .toString()
    .padStart(OTP_CODE_LENGTH, "0");
}

export async function hashOtpCode(code: string): Promise<string> {
  return bcrypt.hash(code, 10);
}

export async function verifyOtpCode(code: string, hash: string): Promise<boolean> {
  return bcrypt.compare(code, hash);
}
