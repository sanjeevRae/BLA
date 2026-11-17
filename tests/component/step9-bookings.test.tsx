// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { cleanup, render, screen } from "@testing-library/react";

import {
  PackageSummaryCard,
  type PackageSummary,
} from "@/components/packages/PackageSummaryCard";

/**
 * V3 Step 9 — PackageSummaryCard (DS §4): the booking-detail package
 * surface. The five labelled domain chips render in the fixed order
 * Operational · Condition · Payment · Delivery · Exception (Exception
 * always, including NONE), status text is always the friendly
 * dictionary label, and no raw SCREAMING_SNAKE enum ever appears.
 */

afterEach(() => {
  cleanup();
});

const FIXTURE: PackageSummary = {
  trackingId: "BLA-2026-000123",
  recipientName: "Asha Sharma",
  deliveryCity: "Pokhara",
  deliveryDistrict: "Kaski",
  description: "Books and stationery",
  billableWeightKg: "2.5",
  declaredWeightKg: "2",
  codAmountPaisa: "150000",
  operationalStatus: "RECEIVED_AT_DESTINATION",
  condition: "GOOD",
  paymentStatus: "COD_COLLECTED",
  deliveryStatus: "NOT_STARTED",
  exceptionStatus: "NONE",
};

const DOMAIN_LABELS = ["Operational", "Condition", "Payment", "Delivery", "Exception"];

describe("PackageSummaryCard (DS §4 domain chips)", () => {
  it("renders all five domain labels in the fixed order", () => {
    const { container } = render(<PackageSummaryCard pkg={FIXTURE} />);
    const text = container.textContent ?? "";
    let lastIndex = -1;
    for (const label of DOMAIN_LABELS) {
      const index = text.indexOf(label);
      expect(index, `domain label ${label}`).toBeGreaterThan(lastIndex);
      lastIndex = index;
    }
  });

  it("renders friendly dictionary labels, the tracking ID, and the mapped body fields", () => {
    render(<PackageSummaryCard pkg={FIXTURE} />);
    // Friendly labels from src/lib/status/labels.ts — not raw enums.
    expect(screen.getByText("Received at destination")).toBeTruthy();
    expect(screen.getByText("COD collected")).toBeTruthy();
    // Exception chip always renders, including NONE → "None".
    expect(screen.getByText("None")).toBeTruthy();
    // Header identifier + body rows from the field map.
    expect(screen.getByText("BLA-2026-000123")).toBeTruthy();
    expect(screen.getByText(/Asha Sharma — Pokhara, Kaski/)).toBeTruthy();
    expect(screen.getByText("Books and stationery")).toBeTruthy();
    // billableWeightKg wins over declaredWeightKg.
    expect(screen.getByText("2.5 kg")).toBeTruthy();
    expect(screen.getByText("NPR 1,500.00")).toBeTruthy();
  });

  it("never renders a raw SCREAMING_SNAKE status string", () => {
    const { container } = render(<PackageSummaryCard pkg={FIXTURE} />);
    const text = container.textContent ?? "";
    for (const raw of [
      FIXTURE.operationalStatus,
      FIXTURE.condition,
      FIXTURE.paymentStatus,
      FIXTURE.deliveryStatus,
      FIXTURE.exceptionStatus,
    ]) {
      expect(text).not.toContain(raw);
    }
    expect(text).not.toMatch(/[A-Z]{2,}_[A-Z_]+/);
  });

  it("falls back to declaredWeightKg when billableWeightKg is null", () => {
    render(<PackageSummaryCard pkg={{ ...FIXTURE, billableWeightKg: null }} />);
    expect(screen.getByText("2 kg")).toBeTruthy();
  });
});
