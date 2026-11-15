"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import {
  assignMemberAction,
  removeMemberAction,
} from "@/server/actions/warehouses";
import { reactivateUserAction, suspendUserAction } from "@/server/actions/users";
import type { WarehouseMemberView } from "@/server/services/warehouses";
import {
  ErrorBox,
  SectionCard,
  dangerButtonClass,
  inputClass,
  labelClass,
  primaryButtonClass,
  subtleButtonClass,
} from "./ui";

/**
 * Membership management for one warehouse: assign an existing user by
 * email as Warehouse Admin or Warehouse Staff, remove memberships
 * (revoked, never deleted), and — for user.manage holders — suspend or
 * reactivate the member's whole account (suspension deletes all of the
 * user's sessions immediately).
 */
export function MembersPanel({
  warehouseId,
  members,
  canAssign,
  canSuspend,
  assignableRoles,
}: {
  warehouseId: string;
  members: WarehouseMemberView[];
  canAssign: boolean;
  canSuspend: boolean;
  assignableRoles: Array<"WAREHOUSE_ADMIN" | "WAREHOUSE_STAFF">;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [roleCode, setRoleCode] = useState<"WAREHOUSE_ADMIN" | "WAREHOUSE_STAFF">(
    assignableRoles[0] ?? "WAREHOUSE_STAFF",
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onAssign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await assignMemberAction(warehouseId, { email, roleCode });
      if (!result.success) {
        setError(result.error);
        setBusy(false);
        return;
      }
      setEmail("");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  async function onRemove(member: WarehouseMemberView) {
    if (!window.confirm(`Remove ${member.fullName} from this warehouse? Their access ends immediately.`)) {
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await removeMemberAction(warehouseId, member.membershipId);
      if (!result.success) {
        setError(result.error);
        setBusy(false);
        return;
      }
      if (result.data.warning) setNotice(result.data.warning);
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  async function onSuspendToggle(member: WarehouseMemberView) {
    const suspending = member.userStatus !== "SUSPENDED";
    if (
      suspending &&
      !window.confirm(
        `Suspend ${member.fullName}'s whole account? They are signed out everywhere immediately.`,
      )
    ) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = suspending
        ? await suspendUserAction(member.userId)
        : await reactivateUserAction(member.userId);
      if (!result.success) {
        setError(result.error);
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <SectionCard title={`Members (${members.length})`}>
      {members.length === 0 ? (
        <p className="text-[13px] text-slate2">
          No active members yet. Assign a Warehouse Admin before activating this warehouse.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {members.map((member) => (
            <li key={member.membershipId} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-[200px] flex-1 leading-tight">
                <div className="text-[13px] font-semibold text-ink">
                  {member.fullName}
                  {member.userStatus === "SUSPENDED" && (
                    <span className="ml-2 rounded-full bg-[#fdecec] px-2 py-0.5 text-[11px] font-semibold text-red">
                      Suspended
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-faint">{member.email}</div>
              </div>
              <span className="rounded-full bg-accentbg px-2.5 py-1 text-[11px] font-semibold text-brand">
                {member.roleCode === "WAREHOUSE_ADMIN" ? "Warehouse Admin" : "Warehouse Staff"}
              </span>
              {canSuspend && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onSuspendToggle(member)}
                  className={subtleButtonClass}
                >
                  {member.userStatus === "SUSPENDED" ? "Reactivate account" : "Suspend account"}
                </button>
              )}
              {canAssign && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRemove(member)}
                  className={dangerButtonClass}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canAssign && (
        <form onSubmit={onAssign} noValidate className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <label htmlFor="member-email" className={labelClass}>
              Assign existing user by email
            </label>
            <input
              id="member-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
              placeholder="staff@company.com"
              required
            />
          </div>
          <div>
            <label htmlFor="member-role" className={labelClass}>
              Role at this warehouse
            </label>
            <select
              id="member-role"
              value={roleCode}
              onChange={(e) => setRoleCode(e.target.value as typeof roleCode)}
              className={inputClass}
            >
              {assignableRoles.map((role) => (
                <option key={role} value={role}>
                  {role === "WAREHOUSE_ADMIN" ? "Warehouse Admin" : "Warehouse Staff"}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" disabled={busy} className={primaryButtonClass}>
            Assign
          </button>
        </form>
      )}
      {notice !== null && (
        <div className="mt-3 rounded-md border border-line bg-orangebg px-3 py-2 text-[13px] text-orange">
          {notice}
        </div>
      )}
      {error !== null && (
        <div className="mt-3">
          <ErrorBox message={error} />
        </div>
      )}
    </SectionCard>
  );
}
