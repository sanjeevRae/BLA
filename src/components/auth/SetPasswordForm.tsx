"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { changePasswordAction } from "@/server/actions/users";

const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-brand";
const labelClass = "mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2";

/**
 * Change-password form. Used both for the forced set-password step
 * (mustChangePassword accounts land here before any dashboard) and for
 * voluntary changes. On success the service has revoked every other
 * session; this session survives and continues to /go.
 */
export function SetPasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await changePasswordAction({ currentPassword, newPassword });
      if (!result.success) {
        setError(result.error);
        setSubmitting(false);
        return;
      }
      router.push("/go");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      {forced && (
        <div className="mb-4 rounded-md border border-line bg-orangebg px-3 py-2 text-[13px] text-orange">
          Your account requires a new password before you can continue.
        </div>
      )}
      <div className="mb-4">
        <label htmlFor="current-password" className={labelClass}>
          Current password
        </label>
        <input
          id="current-password"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className={inputClass}
        />
      </div>
      <div className="mb-4">
        <label htmlFor="new-password" className={labelClass}>
          New password (min. 10 characters)
        </label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className={inputClass}
        />
      </div>
      <div className="mb-5">
        <label htmlFor="confirm-password" className={labelClass}>
          Confirm new password
        </label>
        <input
          id="confirm-password"
          type="password"
          autoComplete="new-password"
          required
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          className={inputClass}
        />
      </div>
      {error !== null && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-line bg-dangerbg px-3 py-2 text-[13px] text-red"
        >
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-brand px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
      >
        {submitting ? "Saving…" : "Set new password"}
      </button>
      <p className="mt-3 text-[12px] text-faint">
        Changing your password signs you out on every other device.
      </p>
    </form>
  );
}
