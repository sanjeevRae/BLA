import { describe, expect, it } from "vitest";

import {
  OPERATIONAL_STATUSES,
} from "@/lib/bookings/lifecycle";
import {
  PACKAGE_CONDITIONS,
  PACKAGE_DELIVERY_STATUSES,
  PACKAGE_EXCEPTION_STATUSES,
  PACKAGE_PAYMENT_STATUSES,
} from "@/lib/bookings/domain";
import {
  statusLabel,
  statusTone,
  TONE_CLASSES,
  TONE_HEX,
  TONE_ICONS,
} from "@/lib/status/status-tones";

/**
 * V2 Phase 1 — the shared StatusBadge tone mapping (audit M-11).
 * Every value of every package status domain must map to a deliberate
 * tone; the domain lists are imported from the domain modules so a
 * newly added status fails this suite until it is classified.
 */

describe("status tones — package domains", () => {
  it("operational: delivered is success, cancelled is danger, in-motion is info", () => {
    expect(statusTone("operational", "DELIVERED")).toBe("success");
    expect(statusTone("operational", "CANCELLED")).toBe("danger");
    expect(statusTone("operational", "IN_TRANSIT")).toBe("info");
    expect(statusTone("operational", "OUT_FOR_DELIVERY")).toBe("info");
    expect(statusTone("operational", "INSPECTION_PENDING")).toBe("warning");
    expect(statusTone("operational", "DELIVERY_ATTEMPTED")).toBe("warning");
    expect(statusTone("operational", "BOOKED")).toBe("neutral");
    for (const status of OPERATIONAL_STATUSES) {
      expect(statusTone("operational", status)).toBeDefined();
    }
  });

  it("condition: good/damaged are the poles, suspicion warns", () => {
    expect(statusTone("condition", "GOOD")).toBe("success");
    expect(statusTone("condition", "DAMAGED")).toBe("danger");
    expect(statusTone("condition", "SUSPECTED_DAMAGE")).toBe("warning");
    expect(statusTone("condition", "PACKAGING_COMPROMISED")).toBe("warning");
    for (const status of PACKAGE_CONDITIONS) {
      expect(statusTone("condition", status)).not.toBe("info");
    }
  });

  it("payment: paid/settled success, due warns, refunded neutral", () => {
    expect(statusTone("payment", "PAID")).toBe("success");
    expect(statusTone("payment", "COD_SETTLED")).toBe("success");
    expect(statusTone("payment", "COD_COLLECTED")).toBe("info");
    expect(statusTone("payment", "COD_DUE")).toBe("warning");
    expect(statusTone("payment", "REFUNDED")).toBe("neutral");
    expect(statusTone("payment", "NOT_APPLICABLE")).toBe("neutral");
    for (const status of PACKAGE_PAYMENT_STATUSES) {
      expect(statusTone("payment", status)).toBeDefined();
    }
  });

  it("delivery: delivered success, failed/refused danger, attempted warns", () => {
    expect(statusTone("delivery", "DELIVERED")).toBe("success");
    expect(statusTone("delivery", "FAILED")).toBe("danger");
    expect(statusTone("delivery", "REFUSED")).toBe("danger");
    expect(statusTone("delivery", "ATTEMPTED")).toBe("warning");
    expect(statusTone("delivery", "OUT_FOR_DELIVERY")).toBe("info");
    expect(statusTone("delivery", "NOT_STARTED")).toBe("neutral");
    for (const status of PACKAGE_DELIVERY_STATUSES) {
      expect(statusTone("delivery", status)).toBeDefined();
    }
  });

  it("exception: none is neutral, missing/lost are danger, holds warn", () => {
    expect(statusTone("exception", "NONE")).toBe("neutral");
    expect(statusTone("exception", "RESOLVED")).toBe("success");
    expect(statusTone("exception", "MISSING")).toBe("danger");
    expect(statusTone("exception", "LOST_UNDER_INVESTIGATION")).toBe("danger");
    expect(statusTone("exception", "ON_HOLD")).toBe("warning");
    expect(statusTone("exception", "DELAYED")).toBe("warning");
    for (const status of PACKAGE_EXCEPTION_STATUSES) {
      expect(statusTone("exception", status)).toBeDefined();
    }
  });

  it("generic: legacy module statuses keep sensible tones; unknown falls back to neutral", () => {
    expect(statusTone("generic", "APPROVED")).toBe("success");
    expect(statusTone("generic", "ACTIVE")).toBe("success");
    expect(statusTone("generic", "REJECTED")).toBe("danger");
    expect(statusTone("generic", "PENDING")).toBe("warning");
    expect(statusTone("generic", "IN_PROGRESS")).toBe("info");
    expect(statusTone("generic", "DRAFT")).toBe("neutral");
    expect(statusTone("generic", "SOMETHING_UNLISTED")).toBe("neutral");
    expect(statusTone("operational", "SOMETHING_UNLISTED")).toBe("neutral");
  });

  it("labels humanise underscores", () => {
    expect(statusLabel("OUT_FOR_DELIVERY")).toBe("OUT FOR DELIVERY");
    expect(statusLabel("COD_DUE")).toBe("COD DUE");
    expect(statusLabel("ACTIVE")).toBe("ACTIVE");
  });
});

describe("status tones — V3 hex values (design system §4)", () => {
  it("each tone carries exactly the DS text/bg hex pair", () => {
    expect(TONE_HEX.success).toEqual({ text: "#18794E", bg: "#E3F4E8" });
    expect(TONE_HEX.warning).toEqual({ text: "#99610A", bg: "#FFF0D6" });
    expect(TONE_HEX.danger).toEqual({ text: "#B42318", bg: "#FDE8E7" });
    expect(TONE_HEX.info).toEqual({ text: "#285EA8", bg: "#E7EFFB" });
    expect(TONE_HEX.neutral).toEqual({ text: "#53635D", bg: "#EDF1EE" });
  });

  it("tone classes reference the dedicated status tokens", () => {
    expect(TONE_CLASSES.success).toBe("bg-successbg text-success");
    expect(TONE_CLASSES.warning).toBe("bg-warningbg text-warning");
    expect(TONE_CLASSES.danger).toBe("bg-dangerbg text-danger");
    expect(TONE_CLASSES.info).toBe("bg-infobg text-info");
    expect(TONE_CLASSES.neutral).toBe("bg-neutralbg text-neutral");
  });

  it("each tone has its DS icon", () => {
    expect(TONE_ICONS.success).toBe("check-circle");
    expect(TONE_ICONS.warning).toBe("clock");
    expect(TONE_ICONS.danger).toBe("alert-octagon");
    expect(TONE_ICONS.info).toBe("info");
    expect(TONE_ICONS.neutral).toBe("minus-circle");
  });
});
