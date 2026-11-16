"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Dialog } from "@/components/ui/Dialog";
import { Select, TextArea, TextInput } from "@/components/ui/forms";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ROLE_CODES } from "@/lib/permissions/catalog";
import {
  approveInvitationAction,
  createInvitationAction,
  rejectInvitationAction,
  revokeInvitationAction,
} from "@/server/actions/invitations";
import type { InvitationView } from "@/server/services/invitations";
import { InvitationQueueRow } from "./InvitationQueueRow";
import {
  SectionCard,
  dangerButtonClass,
  formatDateTime,
  primaryButtonClass,
  roleLabel,
  subtleButtonClass,
} from "./ui";

/**
 * Invitations panel (Phase 6): create invitations, watch the pending
 * list, and work the four-eyes approval queue. Privileged invitations
 * (Super Admin / Admin) are created in PENDING_APPROVAL and only become
 * redeemable after a second approver approves them here.
 */
export function InvitePanel({
  currentUserId,
  queue,
  pending,
  warehouses,
  vendors,
}: {
  currentUserId: string;
  queue: InvitationView[];
  pending: InvitationView[];
  warehouses: { id: string; code: string; name: string }[];
  vendors: { id: string; businessName: string }[];
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [roleCode, setRoleCode] = useState<string>("WAREHOUSE_STAFF");
  const [warehouseId, setWarehouseId] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [approveTarget, setApproveTarget] = useState<InvitationView | null>(null);
  const [rejectTarget, setRejectTarget] = useState<InvitationView | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [revokeTarget, setRevokeTarget] = useState<InvitationView | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setLink(null);
    setBusy(true);
    try {
      const result = await createInvitationAction({
        email,
        roleCode: roleCode as (typeof ROLE_CODES)[number],
        warehouseId: warehouseId || null,
        vendorId: vendorId || null,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      setLink(`/accept-invitation?token=${result.data.token}`);
      if (roleCode === "SUPER_ADMIN" || roleCode === "ADMIN") {
        setNotice(
          "Privileged invitation created — it is NOT redeemable yet. A second approver must approve it in the queue below before the link works.",
        );
      }
      setEmail("");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function runAction(fn: () => Promise<{ success: boolean; error?: string }>) {
    setActionError(null);
    setBusy(true);
    try {
      const result = await fn();
      if (!result.success) {
        setActionError(result.error ?? "Action failed");
        return false;
      }
      router.refresh();
      return true;
    } catch {
      setActionError("Something went wrong. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionCard title="Approval queue — privileged invitations">
        {queue.length === 0 ? (
          <p className="text-[13px] text-slate2">
            No privileged invitations are waiting for approval. Super Admin and Admin invitations
            appear here until a second approver approves or rejects them.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {queue.map((invitation) => (
              <InvitationQueueRow
                key={invitation.id}
                invitation={invitation}
                currentUserId={currentUserId}
                busy={busy}
                onApprove={setApproveTarget}
                onReject={(inv) => {
                  setRejectReason("");
                  setRejectTarget(inv);
                }}
              />
            ))}
          </ul>
        )}
        {actionError ? (
          <p role="alert" className="mt-3 text-[13px] font-medium text-reddeep">
            {actionError}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title="Invite a new user">
        <form onSubmit={onCreate} noValidate className="grid gap-3 sm:grid-cols-2">
          <TextInput
            label="Email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="new.user@company.com"
          />
          <Select
            label="Role"
            value={roleCode}
            onChange={(e) => setRoleCode(e.target.value)}
            hint={
              roleCode === "SUPER_ADMIN" || roleCode === "ADMIN"
                ? "Privileged role — a second approver must approve this invitation before it can be used."
                : undefined
            }
          >
            {ROLE_CODES.map((code) => (
              <option key={code} value={code}>
                {roleLabel(code)}
              </option>
            ))}
          </Select>
          <Select
            label="Warehouse (optional)"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            hint="Only for Warehouse Admin, Warehouse Staff, Rider and Line-haul Driver roles."
          >
            <option value="">No warehouse</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.code} — {w.name}
              </option>
            ))}
          </Select>
          <Select
            label="Vendor (optional)"
            value={vendorId}
            onChange={(e) => setVendorId(e.target.value)}
            hint="Only for the Vendor role — the invitee joins this organisation."
          >
            <option value="">No vendor</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.businessName}
              </option>
            ))}
          </Select>
          <div className="sm:col-span-2">
            <button type="submit" disabled={busy} className={primaryButtonClass}>
              Create invitation
            </button>
          </div>
        </form>
        {notice ? (
          <div className="mt-3 rounded-md border border-line bg-amberbg px-3 py-2 text-[13px] text-amberdeep">
            {notice}
          </div>
        ) : null}
        {link ? (
          <div className="mt-3 rounded-md border border-line bg-greenbg px-3 py-2 text-[13px] text-ink">
            Share this one-time link with the invitee (valid 7 days):{" "}
            <span className="break-all font-mono text-[12px]">{link}</span>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 text-[13px] font-medium text-reddeep">
            {error}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title={`Pending invitations (${pending.length})`}>
        {pending.length === 0 ? (
          <p className="text-[13px] text-slate2">No invitations are waiting to be accepted.</p>
        ) : (
          <ul className="divide-y divide-line">
            {pending.map((invitation) => (
              <li key={invitation.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <div className="min-w-[200px] flex-1 leading-tight">
                  <div className="text-[13px] font-semibold text-ink">{invitation.email}</div>
                  <div className="text-[12px] text-slate2">
                    {roleLabel(invitation.roleCode)} · invited by {invitation.invitedByName} ·
                    expires {formatDateTime(invitation.expiresAt)}
                  </div>
                </div>
                <StatusBadge domain="generic" status={invitation.status} />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setRevokeTarget(invitation)}
                  className={dangerButtonClass}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <Dialog
        open={approveTarget !== null}
        onClose={() => setApproveTarget(null)}
        title="Approve invitation"
        footer={
          <>
            <button type="button" className={subtleButtonClass} onClick={() => setApproveTarget(null)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              className={primaryButtonClass}
              onClick={async () => {
                if (!approveTarget) return;
                if (await runAction(() => approveInvitationAction(approveTarget.id))) {
                  setApproveTarget(null);
                }
              }}
            >
              Approve invitation
            </button>
          </>
        }
      >
        <p className="text-[13px] text-ink">
          Approve the {approveTarget ? roleLabel(approveTarget.roleCode) : ""} invitation for{" "}
          <strong>{approveTarget?.email}</strong>? The invitation link becomes redeemable
          immediately and the invitee can create a privileged account.
        </p>
      </Dialog>

      <Dialog
        open={rejectTarget !== null}
        onClose={() => setRejectTarget(null)}
        title="Reject invitation"
        footer={
          <>
            <button type="button" className={subtleButtonClass} onClick={() => setRejectTarget(null)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              className={dangerButtonClass}
              onClick={async () => {
                if (!rejectTarget) return;
                if (
                  await runAction(() =>
                    rejectInvitationAction(rejectTarget.id, rejectReason || undefined),
                  )
                ) {
                  setRejectTarget(null);
                }
              }}
            >
              Reject invitation
            </button>
          </>
        }
      >
        <p className="text-[13px] text-ink">
          Reject the {rejectTarget ? roleLabel(rejectTarget.roleCode) : ""} invitation for{" "}
          <strong>{rejectTarget?.email}</strong>? This is final — the invitation link can never be
          used, and a new invitation would have to be created instead.
        </p>
        <div className="mt-3">
          <TextArea
            label="Reason (optional)"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={3}
            maxLength={500}
          />
        </div>
      </Dialog>

      <Dialog
        open={revokeTarget !== null}
        onClose={() => setRevokeTarget(null)}
        title="Revoke invitation"
        footer={
          <>
            <button type="button" className={subtleButtonClass} onClick={() => setRevokeTarget(null)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              className={dangerButtonClass}
              onClick={async () => {
                if (!revokeTarget) return;
                if (await runAction(() => revokeInvitationAction(revokeTarget.id))) {
                  setRevokeTarget(null);
                }
              }}
            >
              Revoke invitation
            </button>
          </>
        }
      >
        <p className="text-[13px] text-ink">
          Revoke the invitation for <strong>{revokeTarget?.email}</strong>? The link stops working
          immediately and cannot be restored.
        </p>
      </Dialog>
    </div>
  );
}
