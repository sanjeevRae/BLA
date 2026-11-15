import { describe, expect, it } from "vitest";

import {
  addDays,
  buildCsv,
  enumerateDays,
  kathmanduDateString,
  kathmanduDayStartUtc,
  kathmanduToday,
  percent,
  resolveReportRange,
} from "@/lib/reports/domain";

/**
 * Phase 9 unit tests: the Asia/Kathmandu boundary math and the
 * rounding rules every report shares. Nepal is UTC+05:45, so a
 * Kathmandu day starts at 18:15 UTC the day before.
 */
describe("Kathmandu day boundaries", () => {
  it("maps a Kathmandu date to its UTC start instant", () => {
    expect(kathmanduDayStartUtc("2026-11-15").toISOString()).toBe(
      "2026-11-14T18:15:00.000Z",
    );
    expect(kathmanduDayStartUtc("2026-01-01").toISOString()).toBe(
      "2025-12-31T18:15:00.000Z",
    );
  });

  it("assigns instants to the right Kathmandu day", () => {
    // 18:14 UTC = 23:59 NPT same day; 18:15 UTC = 00:00 NPT next day.
    expect(kathmanduDateString(new Date("2026-11-14T18:14:59Z"))).toBe("2026-11-14");
    expect(kathmanduDateString(new Date("2026-11-14T18:15:00Z"))).toBe("2026-11-15");
    expect(kathmanduDateString(new Date("2026-11-15T10:00:00Z"))).toBe("2026-11-15");
    expect(kathmanduToday(new Date("2026-11-14T18:15:00Z"))).toBe("2026-11-15");
  });

  it("enumerates inclusive day ranges", () => {
    expect(enumerateDays("2026-11-13", "2026-11-15")).toEqual([
      "2026-11-13",
      "2026-11-14",
      "2026-11-15",
    ]);
    expect(addDays("2026-11-15", -29)).toBe("2026-10-17");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("report ranges", () => {
  it("treats [from, to] as both days fully included", () => {
    const range = resolveReportRange("2026-11-15", "2026-11-15");
    expect(range.fromUtc.toISOString()).toBe("2026-11-14T18:15:00.000Z");
    // Exclusive upper bound = start of the NEXT Kathmandu day.
    expect(range.toUtc.toISOString()).toBe("2026-11-15T18:15:00.000Z");
  });

  it("defaults to the last 30 Kathmandu days ending today", () => {
    const range = resolveReportRange(null, null, new Date("2026-11-15T10:00:00Z"));
    expect(range.toDate).toBe("2026-11-15");
    expect(range.fromDate).toBe("2026-10-17");
  });

  it("rejects inverted, malformed and oversized ranges", () => {
    expect(() => resolveReportRange("2026-11-16", "2026-11-15")).toThrow(/start/);
    expect(() => resolveReportRange("15-11-2026", "2026-11-15")).toThrow(/Invalid/);
    expect(() => resolveReportRange("2025-01-01", "2026-11-15")).toThrow(/366/);
  });
});

describe("percent rounding", () => {
  it("rounds half-up to two decimals from integer counts", () => {
    expect(percent(1, 3)).toBe(33.33);
    expect(percent(2, 3)).toBe(66.67);
    expect(percent(1, 8)).toBe(12.5);
    expect(percent(0, 5)).toBe(0);
    expect(percent(5, 5)).toBe(100);
  });

  it("is null over an empty denominator — never an invented rate", () => {
    expect(percent(0, 0)).toBeNull();
    expect(percent(3, 0)).toBeNull();
  });
});

describe("CSV building", () => {
  it("quotes fields containing commas, quotes and newlines", () => {
    const csv = buildCsv(["a", "b"], [["x,y", 'he said "hi"'], ["plain", null]]);
    expect(csv).toBe('a,b\r\n"x,y","he said ""hi"""\r\nplain,\r\n');
  });
});
