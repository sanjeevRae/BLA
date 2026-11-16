// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { cleanup, render, screen } from "@testing-library/react";

import {
  RiderCurrentBatchCard,
  RiderFailedAttemptsList,
  RiderTodayStrip,
} from "@/components/deliveries/rider-home";

/**
 * Phase 6 (V2) — rider home presentational pieces: the today's
 * summary strip renders the real counts it is given, and the
 * failed-attempts tile/list carry the needs-attention (danger)
 * emphasis only when there is something to act on.
 */

afterEach(() => {
  cleanup();
});

describe("RiderTodayStrip", () => {
  it("renders assigned / delivered / remaining / failed counts", () => {
    render(
      <RiderTodayStrip assigned={7} delivered={2} remaining={4} failedAttemptsNeedingAction={1} />,
    );
    expect(screen.getByText("Assigned stops")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("Delivered")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("Remaining")).toBeTruthy();
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("Failed — need action")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("emphasises the failed tile (danger tint) only when failures need action", () => {
    const { rerender } = render(
      <RiderTodayStrip assigned={6} delivered={2} remaining={3} failedAttemptsNeedingAction={2} />,
    );
    const tile = screen.getByTestId("rider-failed-tile");
    expect(tile.className).toContain("bg-redbg");
    expect(tile.textContent).toContain("2");

    rerender(
      <RiderTodayStrip assigned={4} delivered={4} remaining={0} failedAttemptsNeedingAction={0} />,
    );
    const calm = screen.getByTestId("rider-failed-tile");
    expect(calm.className).not.toContain("bg-redbg");
    expect(calm.textContent).toContain("0");
  });
});

describe("RiderFailedAttemptsList", () => {
  it("shows the reason and a ≥48px re-attempt action into the batch flow", () => {
    render(
      <RiderFailedAttemptsList
        attempts={[
          {
            attemptId: "att-1",
            assignmentId: "asg-1",
            batchId: "batch-1",
            trackingId: "BLA-TEST-1",
            result: "RECIPIENT_UNAVAILABLE",
            failureReason: "Recipient not at home",
            nextAction: "REDELIVER",
            attemptedAt: new Date().toISOString(),
            recipientArea: "Baneshwor · Kathmandu",
            codExpectedPaisa: "150000",
          },
        ]}
      />,
    );
    expect(screen.getByText("BLA-TEST-1")).toBeTruthy();
    expect(screen.getByText(/Recipient not at home/)).toBeTruthy();
    const action = screen.getByRole("link", { name: /re-attempt or call recipient/ });
    expect(action.getAttribute("href")).toBe("/rider/batches/batch-1");
    expect(action.className).toContain("min-h-[48px]");
  });

  it("renders nothing when there are no failed attempts", () => {
    const { container } = render(<RiderFailedAttemptsList attempts={[]} />);
    expect(container.textContent).toBe("");
  });
});

describe("RiderCurrentBatchCard", () => {
  it("shows the next stop with COD due and a ≥48px primary action", () => {
    render(
      <RiderCurrentBatchCard
        batchId="batch-1"
        warehouseCode="WH-TST-10"
        batchDate="2026-11-16"
        batchStatus="IN_PROGRESS"
        totalPackages={6}
        deliveredPackages={2}
        nextStop={{
          assignmentId: "asg-1",
          trackingId: "BLA-TEST-9",
          status: "IN_PROGRESS",
          recipientName: "Asha Sharma",
          recipientArea: "Baneshwor · Kathmandu",
          codExpectedPaisa: "250000",
        }}
      />,
    );
    expect(screen.getByText("Next stop")).toBeTruthy();
    expect(screen.getByText("BLA-TEST-9")).toBeTruthy();
    expect(screen.getByText(/Asha Sharma/)).toBeTruthy();
    expect(screen.getByText(/COD due NPR 2,500\.00/)).toBeTruthy();
    const action = screen.getByRole("link", { name: /Open batch/ });
    expect(action.getAttribute("href")).toBe("/rider/batches/batch-1");
    expect(action.className).toContain("min-h-[48px]");
  });
});
