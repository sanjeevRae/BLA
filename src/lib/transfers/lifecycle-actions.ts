/**
 * Which transfer lifecycle actions are available for a (status,
 * permissions) pair — the single source of truth shared by the
 * client-side TransferLifecycleButtons (which renders them) and the
 * server-side TransferActionsCard (which decides whether the card
 * has any content at all, V3 Step 11). This module is deliberately
 * NEUTRAL (no "use client"): a server component may not CALL a
 * function imported from a client module — the first Step 11 draft
 * kept the predicate in forms.tsx and the detail page threw at
 * render time; the Step 11 run-through caught it.
 *
 * Presentation only — the actions, their permissions and the
 * lifecycle itself are unchanged.
 */
export function transferLifecycleAvailability(
  status: string,
  canCreate: boolean,
  canApprove: boolean,
): { submit: boolean; approveReject: boolean; revise: boolean; cancel: boolean } {
  return {
    submit: canCreate && (status === "DRAFT" || status === "PREPARING"),
    approveReject: canApprove && status === "REQUESTED",
    revise: canCreate && status === "REJECTED",
    cancel:
      canCreate &&
      ["DRAFT", "PREPARING", "REQUESTED", "APPROVED", "REJECTED", "READY_FOR_DISPATCH"].includes(
        status,
      ),
  };
}

export function hasTransferLifecycleActions(
  status: string,
  canCreate: boolean,
  canApprove: boolean,
): boolean {
  const a = transferLifecycleAvailability(status, canCreate, canApprove);
  return a.submit || a.approveReject || a.revise || a.cancel;
}
