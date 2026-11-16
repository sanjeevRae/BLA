import { StatusBadge } from "@/components/ui/StatusBadge";
import type { InvitationView } from "@/server/services/invitations";
import { formatDateTime, roleLabel } from "./ui";

/**
 * One approval-queue row (Phase 6 four-eyes). Presentational only —
 * the parent owns the approve/reject state and dialogs. An invitation
 * the current user created themselves renders WITHOUT approve/reject
 * actions plus the reason why: the service refuses self-approval, and
 * the UI says so up front instead of offering a button that fails.
 */
export function InvitationQueueRow({
  invitation,
  currentUserId,
  busy,
  onApprove,
  onReject,
}: {
  invitation: InvitationView;
  currentUserId: string;
  busy?: boolean;
  onApprove?: (invitation: InvitationView) => void;
  onReject?: (invitation: InvitationView) => void;
}) {
  const isOwn = invitation.invitedById === currentUserId;
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-[220px] flex-1 leading-tight">
        <div className="text-[13px] font-semibold text-ink">{invitation.email}</div>
        <div className="text-[12px] text-slate2">
          Invited by {invitation.invitedByName} · {formatDateTime(invitation.createdAt)} ·
          expires {formatDateTime(invitation.expiresAt)}
        </div>
      </div>
      <span className="rounded-md bg-accentbg px-2.5 py-1 text-[11px] font-semibold text-brand">
        {roleLabel(invitation.roleCode)}
      </span>
      <StatusBadge domain="generic" status={invitation.status} />
      {isOwn ? (
        <p className="w-full text-[12px] text-slate2 sm:w-auto">
          Awaiting another approver — you invited this user, so you cannot approve it yourself.
        </p>
      ) : (
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onApprove?.(invitation)}
            className="inline-flex min-h-[44px] items-center rounded-md bg-brand px-3 text-[13px] font-semibold text-white disabled:opacity-60"
          >
            Approve
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onReject?.(invitation)}
            className="inline-flex min-h-[44px] items-center rounded-md border border-line bg-surface px-3 text-[13px] font-semibold text-reddeep disabled:opacity-60"
          >
            Reject
          </button>
        </div>
      )}
    </li>
  );
}
