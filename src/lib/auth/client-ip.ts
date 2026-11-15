/**
 * Client IP derivation for login throttling and audit records.
 *
 * The IP is read from the header named by the TRUSTED_IP_HEADER env var
 * (default `x-forwarded-for`, first entry), falling back to `x-real-ip`.
 *
 * TRUST ASSUMPTION: a forwarding header is only meaningful when the
 * deployment sits behind a proxy/platform that OVERWRITES it with the
 * real peer address (Vercel does this for `x-forwarded-for`). On any
 * other topology the value is client-spoofable and must be treated as
 * untrusted input — it keys the per-IP login throttle and lands in
 * LoginAttempt/AuditLog forensics, so a deployment that cannot guarantee
 * the header must not rely on either. See docs/deployment-guide.md.
 */

interface HeaderReader {
  get(name: string): string | null;
}

export function getClientIp(headers: HeaderReader): string | null {
  const trustedHeader =
    process.env.TRUSTED_IP_HEADER?.trim().toLowerCase() || "x-forwarded-for";

  const trustedValue = headers.get(trustedHeader);
  if (trustedValue) {
    const first = trustedValue.split(",")[0]?.trim();
    if (first) return first;
  }

  if (trustedHeader !== "x-real-ip") {
    const realIp = headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }

  return null;
}
