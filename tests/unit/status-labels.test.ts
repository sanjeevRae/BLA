import { describe, expect, it } from "vitest";

import { humaniseStatusValue, STATUS_LABELS, statusLabel } from "@/lib/status/labels";
import { DOMAIN_TONES, type StatusDomain } from "@/lib/status/status-tones";

/**
 * V3 Step 3 — the friendly-label dictionary (design system §4).
 * Coverage is programmatic: every value in every domain table of
 * status-tones.ts must have an explicit dictionary entry, so a newly
 * classified status fails this suite until it gets a friendly label.
 * No value may silently fall back.
 */

const DOMAINS = Object.keys(DOMAIN_TONES) as StatusDomain[];

describe("status labels — dictionary coverage", () => {
  it("covers every value in every domain table of status-tones.ts", () => {
    let covered = 0;
    for (const domain of DOMAINS) {
      for (const value of Object.keys(DOMAIN_TONES[domain])) {
        covered += 1;
        expect(
          STATUS_LABELS[domain][value],
          `${domain}.${value} has no friendly label`,
        ).toBeDefined();
        expect(statusLabel(domain, value)).toBe(STATUS_LABELS[domain][value]);
      }
    }
    // 10 operational + 4 condition + 8 payment + 10 delivery
    // + 15 exception + 43 generic = 90 classified values.
    expect(covered).toBe(90);
  });

  it("labels are sentence case, never the raw enum", () => {
    for (const domain of DOMAINS) {
      for (const [value, label] of Object.entries(STATUS_LABELS[domain])) {
        expect(label, `${domain}.${value}`).not.toContain("_");
        if (value.includes("_")) {
          expect(label, `${domain}.${value}`).not.toBe(value.replaceAll("_", " "));
        }
      }
    }
  });

  it("matches the design system's named examples", () => {
    expect(statusLabel("operational", "RECEIVED_AT_DESTINATION")).toBe(
      "Received at destination",
    );
    expect(statusLabel("payment", "COD_COLLECTED")).toBe("COD collected");
    expect(statusLabel("generic", "RECONCILIATION_PENDING")).toBe(
      "Reconciliation pending",
    );
    expect(statusLabel("operational", "OUT_FOR_DELIVERY")).toBe("Out for delivery");
  });
});

describe("status labels — humanise fallback", () => {
  it("humanises an unknown value (underscores → spaces, sentence case)", () => {
    expect(statusLabel("generic", "SOME_NEW_STATE")).toBe("Some new state");
    expect(humaniseStatusValue("AWAITING_DOCK_ASSIGNMENT")).toBe(
      "Awaiting dock assignment",
    );
  });

  it("preserves acronyms in the fallback", () => {
    expect(statusLabel("generic", "COD_REVIEW_PENDING")).toBe("COD review pending");
    expect(humaniseStatusValue("OTP_VERIFICATION_FAILED")).toBe(
      "OTP verification failed",
    );
    expect(humaniseStatusValue("NPR_AMOUNT_MISMATCH")).toBe("NPR amount mismatch");
  });

  it("dictionary entries keep acronyms uppercase too", () => {
    expect(statusLabel("payment", "COD_DUE")).toBe("COD due");
    expect(statusLabel("payment", "COD_SETTLED")).toBe("COD settled");
    expect(statusLabel("payment", "COD_REMITTED")).toBe("COD remitted");
  });
});
