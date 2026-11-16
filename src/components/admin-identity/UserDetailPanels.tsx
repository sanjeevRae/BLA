"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { Dialog } from "@/components/ui/Dialog";
import { Select } from "@/components/ui/forms";
import { ROLE_CODES } from "@/lib/permissions/catalog";
import {
  reactivateUserAction,
  resetUserMfaAction,
  setUserRolesAction,
  suspendUserAction,
} from "@/server/actions/users";
import { assignMemberAction, removeMemberAction } from "@/server/actions/warehouses";
import type { UserListView } from "@/server/services/users";
import {
  SectionCard,
  dangerButtonClass,
  primaryButtonClass,
  roleLabel,
  subtleButtonClass,
} from "./ui";

function useActionRunner() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function run(
    fn: () => Promise<{ success: boolean; error?: string }>,
    successNotice?: string,
  ): Promise<boolean> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await fn();
      if (!result.success) {
        setError(result.error ?? "Action failed");
        return false;
      }
      if (successNotice) setNotice(successNotice);
      router.refresh();
      return true;
    } catch {
      setError("Something went wrong. Please try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, notice, run, setError };
}

function Feedback({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {notice ? (
        <div className="mt-3 rounded-md border border-line bg-greenbg px-3 py-2 text-[13px] text-ink">
          {notice}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-[13px] font-medium text-reddeep">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** Role editor: checkboxes per role, saved as one set. Read-only when
 *  the actor lacks role.manage (Admin) — the service enforces it too. */
export function RolesEditor({ user, canManage }: { user: UserListView; canManage: boolean }) {
  const { busy, error, notice, run } = useActionRunner();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(user.roles));
  const [confirmOpen, setConfirmOpen] = useState(false);

  const removed = user.roles.filter((code) => !selected.has(code));
  const added = [...selected].filter((code) => !user.roles.includes(code));
  const dirty = removed.length > 0 || added.length > 0;

  function toggle(code: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(code);
      else next.delete(code);
      return next;
    });
  }

  return (
    <SectionCard title="Roles">
      {!canManage ? (
        <div className="flex flex-wrap gap-1.5">
          {user.roles.length === 0 ? (
            <span className="text-[13px] text-slate2">No roles assigned.</span>
          ) : (
            user.roles.map((code) => (
              <span
                key={code}
                className="rounded-md bg-accentbg px-2.5 py-1 text-[11px] font-semibold text-brand"
              >
                {roleLabel(code)}
              </span>
            ))
          )}
          <p className="w-full text-[12px] text-slate2">
            Role changes require the role.manage permission (Super Admin).
          </p>
        </div>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {ROLE_CODES.map((code) => (
              <label
                key={code}
                htmlFor={`role-${code}`}
                className="flex min-h-[44px] cursor-pointer items-center gap-2 text-[13px] text-ink"
              >
                <input
                  id={`role-${code}`}
                  type="checkbox"
                  checked={selected.has(code)}
                  onChange={(e) => toggle(code, e.target.checked)}
                />
                <span>{roleLabel(code)}</span>
                <span className="text-[12px] text-faint">{code}</span>
              </label>
            ))}
          </div>
          <div className="mt-3">
            <button
              type="button"
              disabled={busy || !dirty}
              className={primaryButtonClass}
              onClick={() => setConfirmOpen(true)}
            >
              Save roles
            </button>
          </div>
          <Dialog
            open={confirmOpen}
            onClose={() => setConfirmOpen(false)}
            title="Change roles"
            footer={
              <>
                <button
                  type="button"
                  className={subtleButtonClass}
                  onClick={() => setConfirmOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className={primaryButtonClass}
                  onClick={async () => {
                    if (await run(() => setUserRolesAction(user.id, [...selected]), "Roles updated.")) {
                      setConfirmOpen(false);
                    }
                  }}
                >
                  Save roles
                </button>
              </>
            }
          >
            <div className="grid gap-2 text-[13px] text-ink">
              {added.length > 0 ? (
                <p>
                  Grant: <strong>{added.map(roleLabel).join(", ")}</strong>
                </p>
              ) : null}
              {removed.length > 0 ? (
                <p>
                  Remove: <strong>{removed.map(roleLabel).join(", ")}</strong> — the user loses the
                  access those roles grant on their next request.
                </p>
              ) : null}
              {added.length === 0 && removed.length === 0 ? <p>No changes.</p> : null}
            </div>
          </Dialog>
        </>
      )}
      <Feedback error={error} notice={notice} />
    </SectionCard>
  );
}

/** Suspend / reactivate / reset-MFA account actions (existing services). */
export function UserAccountActions({ user, isSelf }: { user: UserListView; isSelf: boolean }) {
  const { busy, error, notice, run } = useActionRunner();
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [mfaOpen, setMfaOpen] = useState(false);
  const suspended = user.status === "SUSPENDED";

  return (
    <SectionCard title="Account actions">
      <div className="flex flex-wrap gap-2">
        {suspended ? (
          <button
            type="button"
            disabled={busy}
            className={primaryButtonClass}
            onClick={() => run(() => reactivateUserAction(user.id), "Account reactivated.")}
          >
            Reactivate account
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || isSelf}
            className={dangerButtonClass}
            onClick={() => setSuspendOpen(true)}
          >
            Suspend account
          </button>
        )}
        <button
          type="button"
          disabled={busy || isSelf || !user.mfaEnrolled}
          className={subtleButtonClass}
          onClick={() => setMfaOpen(true)}
        >
          Reset MFA enrolment
        </button>
      </div>
      {isSelf ? (
        <p className="mt-2 text-[12px] text-slate2">
          You cannot suspend your own account or reset your own MFA — another Super Admin does
          that.
        </p>
      ) : null}
      {!user.mfaEnrolled ? (
        <p className="mt-2 text-[12px] text-slate2">MFA is not enrolled for this account.</p>
      ) : null}

      <Dialog
        open={suspendOpen}
        onClose={() => setSuspendOpen(false)}
        title="Suspend account"
        footer={
          <>
            <button type="button" className={subtleButtonClass} onClick={() => setSuspendOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              className={dangerButtonClass}
              onClick={async () => {
                if (await run(() => suspendUserAction(user.id), "Account suspended.")) {
                  setSuspendOpen(false);
                }
              }}
            >
              Suspend account
            </button>
          </>
        }
      >
        <p className="text-[13px] text-ink">
          Suspend <strong>{user.fullName}</strong> ({user.email})? They are signed out everywhere
          immediately and cannot sign in until the account is reactivated.
        </p>
      </Dialog>

      <Dialog
        open={mfaOpen}
        onClose={() => setMfaOpen(false)}
        title="Reset MFA enrolment"
        footer={
          <>
            <button type="button" className={subtleButtonClass} onClick={() => setMfaOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              className={dangerButtonClass}
              onClick={async () => {
                if (await run(() => resetUserMfaAction(user.id), "MFA enrolment reset.")) {
                  setMfaOpen(false);
                }
              }}
            >
              Reset MFA
            </button>
          </>
        }
      >
        <p className="text-[13px] text-ink">
          Reset MFA for <strong>{user.fullName}</strong>? Their authenticator enrolment is cleared
          and all of their sessions are deleted — they must enrol again at next sign-in.
        </p>
      </Dialog>
      <Feedback error={error} notice={notice} />
    </SectionCard>
  );
}

/** Warehouse memberships for one user: assign (by the user's email,
 *  through the warehouse service) and remove. */
export function UserMembershipsPanel({
  user,
  warehouses,
  canAssign,
}: {
  user: UserListView;
  warehouses: { id: string; code: string; name: string }[];
  canAssign: boolean;
}) {
  const { busy, error, notice, run } = useActionRunner();
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? "");
  const [roleCode, setRoleCode] = useState<"WAREHOUSE_ADMIN" | "WAREHOUSE_STAFF">("WAREHOUSE_STAFF");
  const [removeTarget, setRemoveTarget] = useState<UserListView["memberships"][number] | null>(null);

  async function onAssign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await run(
      () => assignMemberAction(warehouseId, { email: user.email, roleCode }),
      "Membership assigned.",
    );
  }

  return (
    <SectionCard title={`Warehouse memberships (${user.memberships.length})`}>
      {user.memberships.length === 0 ? (
        <p className="text-[13px] text-slate2">No active warehouse memberships.</p>
      ) : (
        <ul className="divide-y divide-line">
          {user.memberships.map((m) => (
            <li key={m.membershipId} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-[200px] flex-1 leading-tight">
                <div className="text-[13px] font-semibold text-ink">
                  {m.warehouseName}{" "}
                  <span className="font-mono text-[12px] text-slate2">{m.warehouseCode}</span>
                </div>
                <div className="text-[12px] text-slate2">
                  {roleLabel(m.roleCode)}
                  {m.isPrimary ? " · primary" : ""}
                </div>
              </div>
              {canAssign ? (
                <button
                  type="button"
                  disabled={busy}
                  className={dangerButtonClass}
                  onClick={() => setRemoveTarget(m)}
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canAssign && warehouses.length > 0 ? (
        <form onSubmit={onAssign} className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1">
            <Select
              label="Warehouse"
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
            >
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} — {w.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Select
              label="Role at this warehouse"
              value={roleCode}
              onChange={(e) => setRoleCode(e.target.value as typeof roleCode)}
            >
              <option value="WAREHOUSE_ADMIN">Warehouse Admin</option>
              <option value="WAREHOUSE_STAFF">Warehouse Staff</option>
            </Select>
          </div>
          <button type="submit" disabled={busy} className={primaryButtonClass}>
            Assign membership
          </button>
        </form>
      ) : null}

      <Dialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        title="Remove membership"
        footer={
          <>
            <button type="button" className={subtleButtonClass} onClick={() => setRemoveTarget(null)}>
              Cancel
            </button>
            <button
              type="button"
              disabled={busy}
              className={dangerButtonClass}
              onClick={async () => {
                if (!removeTarget) return;
                if (
                  await run(
                    () => removeMemberAction(removeTarget.warehouseId, removeTarget.membershipId),
                    "Membership removed.",
                  )
                ) {
                  setRemoveTarget(null);
                }
              }}
            >
              Remove membership
            </button>
          </>
        }
      >
        <p className="text-[13px] text-ink">
          Remove <strong>{user.fullName}</strong> from{" "}
          <strong>{removeTarget?.warehouseName}</strong>? Their access to that warehouse ends
          immediately; if it was their only membership carrying the role, the role is removed too.
        </p>
      </Dialog>
      <Feedback error={error} notice={notice} />
    </SectionCard>
  );
}

/** Read-only identity summary for the detail page header card. */
export function UserIdentityCard({ user }: { user: UserListView }) {
  const rows: Array<[string, string]> = [
    ["Email", user.email],
    ["Status", user.status],
    ["Password", user.hasPassword ? "Set" : "Not set (invitation pending)"],
    ["MFA", user.mfaEnrolled ? "Enrolled" : "Not enrolled"],
    [
      "Vendor",
      user.vendor ? `${user.vendor.businessName} (${user.vendor.vendorRole})` : "—",
    ],
  ];
  return (
    <SectionCard title="Identity">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex justify-between gap-4 border-b border-line py-1.5 last:border-0"
          >
            <dt className="text-[12px] font-medium text-slate2">{label}</dt>
            <dd className="text-right text-[13px] font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  );
}
