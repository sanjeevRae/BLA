/**
 * Phone normalisation (docs/database-schema.md §3): `Customer.
 * normalizedPhone` is the deduplication key, so every write path
 * normalises through here. Nepal numbers: strip punctuation, drop a
 * leading 0 trunk, and prefix the 977 country code when absent.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return digits;
  if (digits.startsWith("977")) return digits;
  if (digits.startsWith("0")) return `977${digits.slice(1)}`;
  if (digits.length === 10) return `977${digits}`;
  return digits;
}
