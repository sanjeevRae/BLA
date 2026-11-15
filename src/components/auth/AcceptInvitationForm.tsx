"use client";

import { useState, type FormEvent } from "react";

import { acceptInvitationAction } from "@/server/actions/invitations";

const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-brand";
const labelClass = "mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2";

/**
 * Invitation acceptance: the one-time token from the link plus a name
 * and a self-chosen password. On success the action redirects to the
 * login page; the token can never be used again.
 */
export function AcceptInvitationForm({ token }: { token: string }) {
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError("Password and confirmation do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await acceptInvitationAction({ token, fullName, password });
      if (result && !result.success) {
        setError(result.error);
        setSubmitting(false);
      }
      // On success the action redirects to /login.
    } catch {
      // A redirect thrown by the action surfaces as a navigation.
      setSubmitting(false);
    }
  }

  if (!token) {
    return (
      <div
        role="alert"
        className="rounded-md border border-line bg-[#fdecec] px-3 py-2 text-[13px] text-red"
      >
        This invitation link is incomplete. Ask your administrator for a new link.
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <div className="mb-4">
        <label htmlFor="full-name" className={labelClass}>
          Full name
        </label>
        <input
          id="full-name"
          autoComplete="name"
          required
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          className={inputClass}
        />
      </div>
      <div className="mb-4">
        <label htmlFor="password" className={labelClass}>
          Choose a password (min. 10 characters)
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </div>
      <div className="mb-5">
        <label htmlFor="confirm-password" className={labelClass}>
          Confirm password
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
          className="mb-4 rounded-md border border-line bg-[#fdecec] px-3 py-2 text-[13px] text-red"
        >
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-brand px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
      >
        {submitting ? "Activating…" : "Activate account"}
      </button>
    </form>
  );
}
