import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";

import {
  generateTrackingId,
  isValidTrackingId,
  TRACKING_ID_PATTERN,
} from "@/lib/bookings/tracking";
import {
  allowedTransitionsFrom,
  findTransition,
  PACKAGE_TRANSITIONS,
} from "@/lib/bookings/lifecycle";
import { normalizePhone } from "@/lib/bookings/phone";
import {
  billableWeightKg,
  shippingChargePaisa,
  splitPaisa,
  volumetricWeightKg,
} from "@/lib/bookings/pricing-math";
import { VENDOR_VERIFICATION_TRANSITIONS } from "@/lib/bookings/domain";

/**
 * Pure Phase 3 domain rules: tracking-ID format + check digit, the
 * lifecycle transition allow-list, phone normalisation (the customer
 * dedupe key), pricing arithmetic, and the vendor verification graph.
 */

describe("tracking IDs", () => {
  it("generates well-formed IDs with a valid check digit", () => {
    for (let i = 0; i < 200; i++) {
      const id = generateTrackingId();
      expect(id).toMatch(TRACKING_ID_PATTERN);
      expect(isValidTrackingId(id)).toBe(true);
    }
  });

  it("rejects tampered or malformed codes", () => {
    const id = generateTrackingId();
    const tampered = id.slice(0, -1) + (id.endsWith("0") ? "1" : "0");
    expect(isValidTrackingId(tampered)).toBe(false);
    expect(isValidTrackingId("BLA-123")).toBe(false);
    expect(isValidTrackingId("4839201756")).toBe(false);
    expect(isValidTrackingId("")).toBe(false);
  });

  it("is not sequential (payloads differ across rapid generations)", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateTrackingId()));
    expect(ids.size).toBe(50);
  });
});

describe("package lifecycle transition table", () => {
  it("allows the documented forward chain", () => {
    expect(findTransition("BOOKED", "PICKUP_ASSIGNED")?.permission).toBe("pickup.assign");
    expect(findTransition("PICKED_UP", "RECEIVED_AT_ORIGIN")?.permission).toBe("package.receive");
    expect(findTransition("READY_FOR_DISPATCH", "TRANSFER_ASSIGNED")).toBeDefined();
    expect(findTransition("OUT_FOR_DELIVERY", "DELIVERED")?.operation).toBe("confirm_delivery");
  });

  it("includes the same-warehouse shortcut READY_FOR_DISPATCH → READY_FOR_DELIVERY", () => {
    expect(findTransition("READY_FOR_DISPATCH", "READY_FOR_DELIVERY")).toBeDefined();
  });

  it("rejects jumps that skip custody stages", () => {
    expect(findTransition("BOOKED", "DELIVERED")).toBeUndefined();
    expect(findTransition("BOOKED", "IN_TRANSIT")).toBeUndefined();
    expect(findTransition("DELIVERED", "BOOKED")).toBeUndefined();
    expect(findTransition("CANCELLED", "BOOKED")).toBeUndefined();
  });

  it("permits cancellation only before pickup (rule T9)", () => {
    const cancellableFrom = PACKAGE_TRANSITIONS.filter((t) => t.to === "CANCELLED").map(
      (t) => t.from,
    );
    expect(cancellableFrom.sort()).toEqual(["BOOKED", "DRAFT", "PICKUP_ASSIGNED"]);
  });

  it("treats DELIVERED and CANCELLED as terminal", () => {
    expect(allowedTransitionsFrom("DELIVERED")).toEqual([]);
    expect(allowedTransitionsFrom("CANCELLED")).toEqual([]);
  });

  it("grants no raw status-change permission anywhere in the table", () => {
    for (const t of PACKAGE_TRANSITIONS) {
      expect(t.permission).not.toBe("package.change_status");
    }
  });
});

describe("phone normalisation (customer dedupe key)", () => {
  it("normalises Nepal numbers to the 977-prefixed digit string", () => {
    expect(normalizePhone("9812345678")).toBe("9779812345678");
    expect(normalizePhone("+977 9812-345678")).toBe("9779812345678");
    expect(normalizePhone("09812345678")).toBe("9779812345678");
    expect(normalizePhone("9779812345678")).toBe("9779812345678");
  });
});

describe("pricing arithmetic", () => {
  it("computes volumetric weight with the configured divisor", () => {
    const volumetric = volumetricWeightKg(
      new Prisma.Decimal(60),
      new Prisma.Decimal(40),
      new Prisma.Decimal(30),
      5000,
    );
    expect(volumetric.toString()).toBe("14.4");
  });

  it("bills the greater of declared and volumetric weight", () => {
    expect(
      billableWeightKg(new Prisma.Decimal("2"), new Prisma.Decimal("14.4")).toString(),
    ).toBe("14.4");
    expect(billableWeightKg(new Prisma.Decimal("2"), null).toString()).toBe("2");
  });

  it("computes charges in integer paisa", () => {
    expect(shippingChargePaisa(BigInt(15000), BigInt(5000), new Prisma.Decimal("2.5"))).toBe(
      BigInt(27500),
    );
  });

  it("splits paisa exactly across parcels", () => {
    expect(splitPaisa(BigInt(100), 3)).toEqual([BigInt(34), BigInt(33), BigInt(33)]);
    expect(splitPaisa(BigInt(10001), 5).reduce((a, b) => a + b, BigInt(0))).toBe(BigInt(10001));
    expect(splitPaisa(BigInt(0), 4)).toEqual([BigInt(0), BigInt(0), BigInt(0), BigInt(0)]);
  });
});

describe("vendor verification graph", () => {
  it("requires review before approval", () => {
    expect(VENDOR_VERIFICATION_TRANSITIONS.PENDING_VERIFICATION).not.toContain("APPROVED");
    expect(VENDOR_VERIFICATION_TRANSITIONS.UNDER_REVIEW).toContain("APPROVED");
  });
  it("allows suspension only from APPROVED", () => {
    for (const [from, targets] of Object.entries(VENDOR_VERIFICATION_TRANSITIONS)) {
      if (from !== "APPROVED") expect(targets).not.toContain("SUSPENDED");
    }
  });
});
