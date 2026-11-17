// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { cleanup, render } from "@testing-library/react";

afterEach(() => cleanup());

import type { FinanceConsoleData } from "@/server/services/finance-home";
import { FinanceHomeView, ageLabel } from "@/components/finance-home/FinanceHomeView";

/**
 * Step 8 (V3) — FinanceHomeView rendering contract:
 *  - link-only approvals: no <form>, no <button> at all (so no
 *    approve/decide affordance can exist), and the settlements
 *    group carries the read-only Admin/Super Admin note;
 *  - amounts render NPR-formatted via formatPaisa;
 *  - no raw enum strings appear as visible text (statuses are
 *    humanised by StatusBadge);
 *  - no account code containing ":" (a per-owner UUID code) renders;
 *  - ageLabel is real arithmetic on stored timestamps.
 */

const HOUR = 60 * 60 * 1000;
const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * HOUR).toISOString();

function fixture(): FinanceConsoleData {
  return {
    today: "2026-11-17",
    period: {
      from: "2026-10-19",
      to: "2026-11-17",
      invoiced: { count: 3, totalPaisa: "600000" },
      paymentsReceived: { count: 2, totalPaisa: "65000" },
      refunds: { processedCount: 1, processedPaisa: "15000", requestedOpen: 1 },
    },
    summary: {
      revenueLast30DaysPaisa: "50000",
      outstandingReceivablesPaisa: "260000",
      openInvoicesCount: 2,
      vendorPayablePaisa: "200000",
      cod: {
        collectedPaisa: "600000",
        awaitingRemittancePaisa: "100000",
        inOpenRemittancePaisa: "200000",
        remittedVerifiedPaisa: "300000",
        outstandingPaisa: "300000",
      },
    },
    operationsToday: {
      invoicesIssued: { count: 2, totalPaisa: "300000" },
      paymentsReceived: { count: 1, totalPaisa: "40000" },
    },
    pending: {
      settlements: {
        count: 1,
        netPayablePaisa: "80000",
        items: [
          {
            id: "set-1",
            settlementNumber: "SET-101",
            vendorName: "Fixture Vendor",
            netPayablePaisa: "80000",
            createdAt: hoursAgo(72),
          },
        ],
      },
      adjustments: {
        count: 1,
        items: [
          {
            id: "adj-1",
            creatorName: "Other Finance",
            amountPaisa: "5000",
            reason: "Credit note fixture",
            awaiting: "ACTIONABLE_BY_ACTOR",
            createdAt: hoursAgo(5),
          },
        ],
      },
      refunds: {
        count: 1,
        items: [
          {
            id: "ref-1",
            requesterName: "Fixture Finance",
            amountPaisa: "3000",
            reason: "Duplicate payment fixture",
            awaiting: "AWAITING_ANOTHER_APPROVER",
            createdAt: hoursAgo(26),
          },
        ],
      },
      remittances: {
        count: 1,
        items: [
          {
            id: "rem-1",
            remittanceNumber: "RMT-101",
            driverName: "Fixture Rider",
            declaredAmountPaisa: "200000",
            status: "UNDER_VERIFICATION",
            submittedAt: hoursAgo(2),
          },
        ],
      },
      remittanceDiscrepancies: {
        count: 1,
        items: [
          {
            id: "rem-2",
            remittanceNumber: "RMT-102",
            declaredAmountPaisa: "20000",
            discrepancyPaisa: "-2000",
            submittedAt: hoursAgo(50),
          },
        ],
      },
    },
    recentInvoices: [
      {
        id: "inv-1",
        invoiceNumber: "INV-101",
        vendorName: "Fixture Vendor",
        totalPaisa: "200000",
        status: "PARTIALLY_PAID",
        issuedAt: hoursAgo(30),
      },
    ],
    recentPayments: [
      {
        id: "pay-1",
        amountPaisa: "40000",
        method: "BANK_TRANSFER",
        status: "PAID",
        payerType: "VENDOR",
        payerName: "Fixture Vendor",
        invoiceId: "inv-1",
        createdAt: hoursAgo(4),
      },
      {
        id: "pay-2",
        amountPaisa: "25000",
        method: "CASH",
        status: "PAID",
        payerType: "CUSTOMER",
        payerName: "Fixture Customer",
        invoiceId: null,
        createdAt: hoursAgo(3),
      },
    ],
    accounts: [
      { id: "acc-1", code: "SHIPPING_REVENUE", label: "Shipping revenue", kind: "REVENUE", balancePaisa: "50000" },
      {
        id: "acc-2",
        code: "VENDOR_PAYABLE:123e4567-e89b-12d3-a456-426614174000",
        label: "Vendor payable 123e4567",
        kind: "LIABILITY",
        balancePaisa: "99900",
      },
    ],
    can: {
      createInvoice: true,
      recordPayment: true,
      viewLedger: true,
      codRemittances: true,
      settlements: true,
      reports: true,
    },
  };
}

describe("Step 8 FinanceHomeView", () => {
  it("renders no forms and no buttons — approvals are link-only", () => {
    const { container } = render(<FinanceHomeView data={fixture()} />);
    expect(container.querySelectorAll("form")).toHaveLength(0);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    const text = container.textContent ?? "";
    expect(text.toLowerCase()).not.toContain("approve settlement");
    expect(text.toLowerCase()).not.toContain("decide");
  });

  it("settlements group carries the read-only note and vendor/amount/age rows (no maker)", () => {
    const { container } = render(<FinanceHomeView data={fixture()} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Approval sits with Admin / Super Admin — Finance prepares and reviews.");
    expect(text).toContain("SET-101");
    expect(text).toContain("Fixture Vendor");
    expect(text).toContain("NPR 800.00");
    expect(text).toContain("3d");
  });

  it("amounts render NPR-formatted via formatPaisa", () => {
    const { container } = render(<FinanceHomeView data={fixture()} />);
    const text = container.textContent ?? "";
    expect(text).toContain("NPR 6,000.00"); // total invoiced + COD collected
    expect(text).toContain("NPR 2,600.00"); // outstanding
    expect(text).toContain("NPR 400.00"); // recent payment
    expect(text).not.toContain("600000");
  });

  it("no raw enum strings appear as visible text", () => {
    const { container } = render(<FinanceHomeView data={fixture()} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("UNDER_VERIFICATION");
    expect(text).not.toContain("PARTIALLY_PAID");
    expect(text).not.toContain("BANK_TRANSFER");
    expect(text).toContain("Under verification");
    expect(text).toContain("Partially paid");
    expect(text).toContain("Bank transfer");
  });

  it("no account code containing ':' renders, and neither does its UUID", () => {
    const { container } = render(<FinanceHomeView data={fixture()} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("VENDOR_PAYABLE:");
    expect(text).not.toContain("123e4567");
    expect(text).toContain("Shipping revenue");
  });

  it("four-eyes awaiting labels render honestly", () => {
    const { container } = render(<FinanceHomeView data={fixture()} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Awaiting a decision");
    expect(text).toContain("Awaiting another approver (four-eyes)");
  });

  it("recent payment rows link to their invoice, or to the ledger when unallocated", () => {
    const { container } = render(<FinanceHomeView data={fixture()} />);
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("/finance/invoices/inv-1");
    expect(hrefs).toContain("/finance/ledger");
    expect(hrefs.every((h) => h !== null && !h.includes("?"))).toBe(true);
  });

  it("an all-zero pending model reads as the honest empty state", () => {
    const data = fixture();
    data.pending = {
      settlements: { count: 0, netPayablePaisa: "0", items: [] },
      adjustments: { count: 0, items: [] },
      refunds: { count: 0, items: [] },
      remittances: { count: 0, items: [] },
      remittanceDiscrepancies: { count: 0, items: [] },
    };
    const { container } = render(<FinanceHomeView data={data} />);
    expect(container.textContent ?? "").toContain("Nothing is waiting on Finance right now.");
  });
});

describe("ageLabel", () => {
  const fixedNow = new Date("2026-11-17T12:00:00Z");
  it("computes minutes, hours and days from stored timestamps", () => {
    expect(ageLabel("2026-11-17T11:48:00Z", fixedNow)).toBe("12m");
    expect(ageLabel("2026-11-17T07:00:00Z", fixedNow)).toBe("5h");
    expect(ageLabel("2026-11-14T12:00:00Z", fixedNow)).toBe("3d");
    expect(ageLabel("2026-11-17T11:59:30Z", fixedNow)).toBe("just now");
  });
});
