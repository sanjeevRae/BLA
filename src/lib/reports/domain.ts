/**
 * Phase 9 reporting vocabulary and shared math (docs/implementation-
 * roadmap.md Phase 9; docs/api-reference.md §16).
 *
 * Date boundaries: every report range is expressed in Asia/Kathmandu
 * calendar days and converted here to UTC instants. Nepal keeps a
 * fixed UTC+05:45 offset (no DST since 1986), so a Kathmandu day runs
 * from 18:15 UTC the previous day to 18:15 UTC on the day itself.
 * A range [from, to] covers BOTH named days in full:
 *   [ from 00:00 NPT, (to + 1 day) 00:00 NPT )
 * i.e. the `to` day is INCLUSIVE and the UTC upper bound exclusive.
 *
 * Percentages: computed from integer counts only, rounded half-up to
 * two decimals (percent(1, 3) = 33.33). A rate over an empty
 * denominator is null — never an invented 0 or 100.
 *
 * Money: integer paisa end-to-end. Report payloads carry paisa as
 * decimal strings, matching the Phase 3–8 service convention.
 */

export const KATHMANDU_TIME_ZONE = "Asia/Kathmandu";
const NPT_OFFSET_MS = (5 * 60 + 45) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Maximum report span — a guard against unbounded full-table scans. */
export const MAX_RANGE_DAYS = 366;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateString(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && toDateString(parsed) === value;
}

function toDateString(utcDate: Date): string {
  return utcDate.toISOString().slice(0, 10);
}

function parseDateString(value: string): { y: number; m: number; d: number } {
  const [y, m, d] = value.split("-").map((part) => Number(part));
  return { y, m, d };
}

/** The Kathmandu calendar date (YYYY-MM-DD) containing an instant. */
export function kathmanduDateString(instant: Date): string {
  return toDateString(new Date(instant.getTime() + NPT_OFFSET_MS));
}

/** Today in Asia/Kathmandu. */
export function kathmanduToday(now: Date = new Date()): string {
  return kathmanduDateString(now);
}

/** UTC instant of 00:00 Asia/Kathmandu on the given Kathmandu date. */
export function kathmanduDayStartUtc(date: string): Date {
  const { y, m, d } = parseDateString(date);
  return new Date(Date.UTC(y, m - 1, d) - NPT_OFFSET_MS);
}

export function addDays(date: string, days: number): string {
  const { y, m, d } = parseDateString(date);
  return toDateString(new Date(Date.UTC(y, m - 1, d) + days * DAY_MS));
}

export function daysBetween(from: string, to: string): number {
  const a = parseDateString(from);
  const b = parseDateString(to);
  const ms =
    Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d);
  return Math.round(ms / DAY_MS);
}

/** Every Kathmandu date in [from, to], inclusive both ends. */
export function enumerateDays(from: string, to: string): string[] {
  const days: string[] = [];
  const count = daysBetween(from, to);
  for (let i = 0; i <= count; i += 1) days.push(addDays(from, i));
  return days;
}

export interface ReportRange {
  /** First Kathmandu day of the range (inclusive). */
  fromDate: string;
  /** Last Kathmandu day of the range (inclusive). */
  toDate: string;
  /** UTC instant the range starts (fromDate 00:00 NPT). */
  fromUtc: Date;
  /** UTC instant the range ends, EXCLUSIVE ((toDate + 1) 00:00 NPT). */
  toUtc: Date;
}

/**
 * Resolve optional from/to filters into a concrete range. Defaults:
 * the last 30 Kathmandu days ending today (inclusive). Throws a plain
 * Error with a user-facing message on malformed input — callers wrap
 * it in DomainValidationError.
 */
export function resolveReportRange(
  fromInput?: string | null,
  toInput?: string | null,
  now: Date = new Date(),
): ReportRange {
  const toDate = toInput ?? kathmanduToday(now);
  const fromDate = fromInput ?? addDays(toDate, -29);
  if (!isDateString(fromDate)) throw new Error(`Invalid "from" date: ${fromDate}`);
  if (!isDateString(toDate)) throw new Error(`Invalid "to" date: ${toDate}`);
  if (fromDate > toDate) throw new Error("The range start must not be after its end");
  if (daysBetween(fromDate, toDate) + 1 > MAX_RANGE_DAYS) {
    throw new Error(`Report range is limited to ${MAX_RANGE_DAYS} days`);
  }
  return {
    fromDate,
    toDate,
    fromUtc: kathmanduDayStartUtc(fromDate),
    toUtc: kathmanduDayStartUtc(addDays(toDate, 1)),
  };
}

/** Percentage from integer counts, half-up to 2 decimals; null when
 *  the denominator is zero (the rate does not exist yet). */
export function percent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator * 10000) / denominator) / 100;
}

/** Mean of minute values, 1 decimal; null for an empty sample. */
export function avgMinutes(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, v) => sum + v, 0);
  return Math.round((total / values.length) * 10) / 10;
}

export function bigintToString(value: bigint | null | undefined): string {
  return (value ?? BigInt(0)).toString();
}

// ---------------------------------------------------------------------------
// CSV export (api-reference §16: authorized export of the same scoped
// data the report itself returns — the CSV is built from the report
// result, never from a second, differently-scoped query).
// ---------------------------------------------------------------------------

export function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function buildCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) lines.push(row.map(csvEscape).join(","));
  return `${lines.join("\r\n")}\r\n`;
}

/** Report names accepted by the export route. */
export const EXPORTABLE_REPORTS = [
  "overview",
  "daily",
  "warehouses",
  "drivers",
  "vendors",
  "finance",
  "cod",
  "transfers",
] as const;
export type ExportableReport = (typeof EXPORTABLE_REPORTS)[number];
