// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => cleanup());

import { InvitationQueueRow } from "@/components/admin-identity/InvitationQueueRow";
import type { InvitationView } from "@/server/services/invitations";

function invitation(overrides: Partial<InvitationView> = {}): InvitationView {
  return {
    id: "inv-1",
    email: "new.admin@test.local",
    roleCode: "ADMIN",
    warehouseId: null,
    vendorId: null,
    vendorRole: null,
    status: "PENDING_APPROVAL",
    invitedById: "inviter-1",
    invitedByName: "Inviting Admin",
    invitedByEmail: "inviter@test.local",
    approvedById: null,
    approvedAt: null,
    rejectedById: null,
    rejectedAt: null,
    rejectionReason: null,
    expiresAt: "2026-11-23T00:00:00.000Z",
    acceptedAt: null,
    createdAt: "2026-11-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("InvitationQueueRow — four-eyes approval queue (Phase 6)", () => {
  it("renders a pending-approval row with Approve and Reject actions for another approver", () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <ul>
        <InvitationQueueRow
          invitation={invitation()}
          currentUserId="approver-9"
          onApprove={onApprove}
          onReject={onReject}
        />
      </ul>,
    );
    expect(screen.getByText("new.admin@test.local")).toBeTruthy();
    expect(screen.getByText("Pending approval")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /approve/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /reject/i }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("hides the actions on the inviter's own invitation and explains why", () => {
    render(
      <ul>
        <InvitationQueueRow
          invitation={invitation()}
          currentUserId="inviter-1"
          onApprove={vi.fn()}
          onReject={vi.fn()}
        />
      </ul>,
    );
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reject/i })).toBeNull();
    expect(screen.getByText(/awaiting another approver/i)).toBeTruthy();
    expect(screen.getByText(/cannot approve it yourself/i)).toBeTruthy();
  });
});
