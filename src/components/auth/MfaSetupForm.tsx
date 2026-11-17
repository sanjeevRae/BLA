"use client";

import { useState, type FormEvent } from "react";

import { confirmMfaEnrolmentAction } from "@/app/(public)/mfa-setup/actions";

const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-center font-mono text-[16px] tracking-[0.3em] text-ink outline-none focus:border-brand";
const labelClass = "mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2";

/**
 * Enrolment confirmation form: one TOTP code proves the user scanned
 * the secret into their authenticator; the action activates MFA and
 * redirects to /go on success.
 */
export function MfaSetupForm() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await confirmMfaEnrolmentAction({ code });
      if (result.error) {
        setError(result.error);
        setSubmitting(false);
      }
      // On success the action redirects to /go.
    } catch {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <div className="mb-5">
        <label htmlFor="mfa-code" className={labelClass}>
          Authenticator code
        </label>
        <input
          id="mfa-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          required
          value={code}
          onChange={(event) => setCode(event.target.value)}
          className={inputClass}
          placeholder="000000"
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
        {submitting ? "Activating…" : "Activate two-factor authentication"}
      </button>
    </form>
  );
}
