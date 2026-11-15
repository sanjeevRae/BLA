"use client";

import { useState, type FormEvent } from "react";

import { createInvitationAction } from "@/server/actions/invitations";
import {
  ErrorBox,
  SectionCard,
  inputClass,
  labelClass,
  primaryButtonClass,
} from "./ui";

/**
 * Invite a new user to this warehouse. The accept link (containing the
 * one-time token) is shown exactly once — the admin delivers it to the
 * invitee out of band. Only the token's hash is stored server-side.
 */
export function InviteUserForm({ warehouseId }: { warehouseId: string }) {
  const [email, setEmail] = useState("");
  const [roleCode, setRoleCode] = useState<"WAREHOUSE_ADMIN" | "WAREHOUSE_STAFF">(
    "WAREHOUSE_STAFF",
  );
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setLink(null);
    setBusy(true);
    try {
      const result = await createInvitationAction({ email, roleCode, warehouseId });
      if (!result.success) {
        setError(result.error);
        setBusy(false);
        return;
      }
      setLink(`/accept-invitation?token=${result.data.token}`);
      setEmail("");
      setBusy(false);
    } catch {
      setError("Something went wrong. Please try again.");
      setBusy(false);
    }
  }

  return (
    <SectionCard title="Invite a new user">
      <form onSubmit={onSubmit} noValidate className="flex flex-wrap items-end gap-3">
        <div className="min-w-[220px] flex-1">
          <label htmlFor="invite-email" className={labelClass}>
            Email
          </label>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
            placeholder="new.staff@company.com"
            required
          />
        </div>
        <div>
          <label htmlFor="invite-role" className={labelClass}>
            Role at this warehouse
          </label>
          <select
            id="invite-role"
            value={roleCode}
            onChange={(e) => setRoleCode(e.target.value as typeof roleCode)}
            className={inputClass}
          >
            <option value="WAREHOUSE_ADMIN">Warehouse Admin</option>
            <option value="WAREHOUSE_STAFF">Warehouse Staff</option>
          </select>
        </div>
        <button type="submit" disabled={busy} className={primaryButtonClass}>
          Create invitation
        </button>
      </form>
      {link !== null && (
        <div className="mt-3 rounded-md border border-line bg-greenbg px-3 py-2 text-[13px] text-ink">
          Share this one-time link with the invitee (valid 7 days):{" "}
          <span className="break-all font-mono text-[12px]">{link}</span>
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
