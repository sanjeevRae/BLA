import "server-only";

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption at rest for TOTP secrets (User.mfaSecretEncrypted,
 * Phase 10 gate F13). AES-256-GCM with a per-secret random IV; the
 * key comes from MFA_SECRET_ENCRYPTION_KEY (base64, 32 bytes — see
 * .env.example for generation). TOTP secrets must be recoverable
 * (verification needs the plaintext), so this is reversible
 * encryption, NOT a hash. A missing or malformed key fails closed
 * with a configuration error at enrolment/verification time; it
 * never affects non-MFA logins.
 */

const FORMAT_VERSION = "v1";
const IV_BYTES = 12;

function encryptionKey(): Buffer {
  const raw = process.env.MFA_SECRET_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error(
      "MFA_SECRET_ENCRYPTION_KEY is not set — MFA enrolment is unavailable (see .env.example).",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "MFA_SECRET_ENCRYPTION_KEY must be base64 for exactly 32 bytes (generate: openssl rand -base64 32).",
    );
  }
  return key;
}

export function encryptTotpSecret(plaintext: string): string {
  const key = encryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    FORMAT_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptTotpSecret(payload: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error("Unrecognised encrypted MFA secret format");
  }
  const [, ivB64, tagB64, ciphertextB64] = parts;
  const key = encryptionKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
