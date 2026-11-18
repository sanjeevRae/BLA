import { SectionCard } from "@/components/warehouses/ui";
import { TransferLifecycleButtons } from "@/components/transfers/forms";
import { hasTransferLifecycleActions } from "@/lib/transfers/lifecycle-actions";
import type { TransferView } from "@/server/services/transfers";

/**
 * TransferActionsCard (V3 Step 11) — the transfer detail page's
 * "Transfer actions" card: the transfer's instructions plus the
 * lifecycle buttons. It renders ONLY when it has content — the
 * transfer carries instructions OR at least one lifecycle action is
 * available to this actor for this status (availability decided by
 * the shared predicate hasTransferLifecycleActions in
 * @/lib/transfers/lifecycle-actions — a NEUTRAL module, because this
 * server component may not call a function from the client module
 * forms.tsx; the Step 11 run-through caught exactly that). Before
 * Step 11 the card rendered
 * unconditionally, leaving an empty card on screen for states like
 * an arrived transfer viewed by a role with no available action
 * (Step 10 verification §9). Presentation only: which actions exist,
 * their permissions and the lifecycle are unchanged.
 */
export function TransferActionsCard({
  transfer,
  canCreate,
  canApprove,
}: {
  transfer: Pick<TransferView, "id" | "status" | "instructions">;
  canCreate: boolean;
  canApprove: boolean;
}) {
  if (
    !transfer.instructions &&
    !hasTransferLifecycleActions(transfer.status, canCreate, canApprove)
  ) {
    return null;
  }
  return (
    <SectionCard title="Transfer actions">
      {transfer.instructions ? (
        <p className="text-[13px] text-ink-2">Instructions: {transfer.instructions}</p>
      ) : null}
      <div className={transfer.instructions ? "mt-4" : ""}>
        <TransferLifecycleButtons
          transferId={transfer.id}
          status={transfer.status}
          canCreate={canCreate}
          canApprove={canApprove}
        />
      </div>
    </SectionCard>
  );
}
