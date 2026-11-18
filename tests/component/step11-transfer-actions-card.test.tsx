// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/server/actions/transfers", () => {
  const ok = vi.fn(async () => ({ success: true as const }));
  return {
    addTransferItemsAction: ok,
    approveTransferAction: ok,
    assignTransferCrewAction: ok,
    cancelTransferAction: ok,
    closeTransferAction: ok,
    completePackageReceivingAction: ok,
    createTransferAction: ok,
    dispatchTransferAction: ok,
    finishReceivingAction: ok,
    generateManifestAction: ok,
    loadTransferPackageAction: ok,
    reconcileTransferAction: ok,
    rejectTransferAction: ok,
    removeTransferItemAction: ok,
    replaceTripDriverAction: ok,
    reviseTransferAction: ok,
    scanDestinationPackageAction: ok,
    submitTransferAction: ok,
    unloadTransferPackageAction: ok,
    arriveTripAction: ok,
    departTripAction: ok,
    recordCheckpointAction: ok,
    reportTripDelayAction: ok,
    resumeTripAction: ok,
  };
});

vi.mock("@/lib/tracking/client-registry", () => ({
  sendTrackingEventUpdate: vi.fn(),
}));

import { cleanup, render, screen } from "@testing-library/react";

import { TransferActionsCard } from "@/components/transfers/TransferActionsCard";
import { TransferLifecycleButtons } from "@/components/transfers/forms";
import {
  hasTransferLifecycleActions,
  transferLifecycleAvailability,
} from "@/lib/transfers/lifecycle-actions";
import { TRANSFER_STATUSES } from "@/lib/transfers/domain";
import type { TransferView } from "@/server/services/transfers";

/**
 * V3 Step 11 — the transfer detail "Transfer actions" card renders
 * ONLY when it has content: instructions on the transfer OR at least
 * one lifecycle action available to the actor (Step 10 verification
 * §9 — the card previously rendered empty for e.g. an ARRIVED
 * transfer). Availability is the buttons component's own predicate,
 * so the card and the buttons can never disagree; the sweep below
 * pins that agreement for every status × permission combination.
 */

afterEach(() => {
  cleanup();
});

type CardTransfer = Pick<TransferView, "id" | "status" | "instructions">;
const transfer = (overrides: Partial<CardTransfer> = {}): CardTransfer => ({
  id: "transfer-1",
  status: "ARRIVED",
  instructions: null,
  ...overrides,
});

describe("hasTransferLifecycleActions — availability matrix", () => {
  it("offers submit/cancel to creators in DRAFT and PREPARING only", () => {
    for (const status of ["DRAFT", "PREPARING"]) {
      expect(hasTransferLifecycleActions(status, true, false)).toBe(true);
      expect(hasTransferLifecycleActions(status, false, false)).toBe(false);
      expect(transferLifecycleAvailability(status, true, false).submit).toBe(true);
    }
  });

  it("offers approve/reject to approvers in REQUESTED; cancel still needs create", () => {
    expect(transferLifecycleAvailability("REQUESTED", false, true)).toEqual({
      submit: false,
      approveReject: true,
      revise: false,
      cancel: false,
    });
    expect(hasTransferLifecycleActions("REQUESTED", false, true)).toBe(true);
    expect(hasTransferLifecycleActions("REQUESTED", false, false)).toBe(false);
    expect(hasTransferLifecycleActions("REQUESTED", true, false)).toBe(true); // cancel
  });

  it("offers revise/cancel to creators in REJECTED, cancel in APPROVED and READY_FOR_DISPATCH", () => {
    expect(hasTransferLifecycleActions("REJECTED", true, false)).toBe(true);
    expect(hasTransferLifecycleActions("APPROVED", true, false)).toBe(true);
    expect(hasTransferLifecycleActions("READY_FOR_DISPATCH", true, false)).toBe(true);
    expect(hasTransferLifecycleActions("APPROVED", false, true)).toBe(false);
  });

  it("offers nothing in any post-dispatch or terminal state, whatever the permissions", () => {
    for (const status of [
      "DISPATCHED",
      "IN_TRANSIT",
      "ARRIVED",
      "PARTIALLY_RECEIVED",
      "RECEIVED",
      "RECONCILIATION_PENDING",
      "RECONCILED",
      "CLOSED",
      "EXCEPTION",
      "CANCELLED",
    ]) {
      expect(hasTransferLifecycleActions(status, true, true)).toBe(false);
    }
  });
});

describe("TransferActionsCard — renders only when it has content", () => {
  it("renders nothing for an ARRIVED transfer with no instructions and no available action (the Step 10 case)", () => {
    const { container } = render(
      <TransferActionsCard transfer={transfer()} canCreate canApprove />,
    );
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Transfer actions")).toBeNull();
  });

  it("renders nothing in IN_TRANSIT with no instructions", () => {
    const { container } = render(
      <TransferActionsCard
        transfer={transfer({ status: "IN_TRANSIT" })}
        canCreate
        canApprove
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the card with instructions even when no action is available", () => {
    render(
      <TransferActionsCard
        transfer={transfer({ instructions: "Call the hub on arrival" })}
        canCreate={false}
        canApprove={false}
      />,
    );
    expect(screen.getByText("Transfer actions")).toBeTruthy();
    expect(screen.getByText(/Instructions: Call the hub on arrival/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders submit + cancel for a creator viewing a DRAFT", () => {
    render(
      <TransferActionsCard
        transfer={transfer({ status: "DRAFT" })}
        canCreate
        canApprove={false}
      />,
    );
    expect(screen.getByText("Transfer actions")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit for approval" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel transfer" })).toBeTruthy();
  });

  it("renders approve + reject (and no cancel) for an approver viewing a REQUESTED transfer", () => {
    render(
      <TransferActionsCard
        transfer={transfer({ status: "REQUESTED" })}
        canCreate={false}
        canApprove
      />,
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel transfer" })).toBeNull();
  });
});

describe("card/buttons agreement sweep", () => {
  it("TransferLifecycleButtons renders non-null exactly when hasTransferLifecycleActions is true, for every status × permissions", () => {
    for (const status of TRANSFER_STATUSES) {
      for (const canCreate of [false, true]) {
        for (const canApprove of [false, true]) {
          const { container, unmount } = render(
            <TransferLifecycleButtons
              transferId="transfer-1"
              status={status}
              canCreate={canCreate}
              canApprove={canApprove}
            />,
          );
          expect(container.firstChild !== null).toBe(
            hasTransferLifecycleActions(status, canCreate, canApprove),
          );
          unmount();
        }
      }
    }
  });
});
