"use client";

import { useState, type FormEvent } from "react";

import { loginAction } from "@/app/(public)/login/actions";

const inputClass =
  "w-full rounded-md border border-border-control bg-card px-3 py-2 text-[13px] text-ink outline-none focus:border-primary";
const labelClass = "mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await loginAction({ email, password });
      if (result.error) {
        // One generic message: never reveal whether the email exists,
        // the password was wrong, or the account is suspended/locked.
        setError("Invalid email or password, or this account is not active.");
        setSubmitting(false);
      }
      // On success the action redirects to /go; nothing more to do here.
    } catch {
      // A redirect thrown by the action surfaces as a navigation, not an
      // error; anything else is a genuine failure.
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} noValidate>
      <div className="mb-4">
        <label htmlFor="email" className={labelClass}>
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={inputClass}
          placeholder="you@company.com"
        />
      </div>
      <div className="mb-5">
        <label htmlFor="password" className={labelClass}>
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className={inputClass}
          placeholder="••••••••"
        />
      </div>
      {error !== null && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-danger/30 bg-dangerbg px-3 py-2 text-[13px] text-danger"
        >
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={submitting}
        className="w-full rounded-md bg-primary px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-60"
      >
        {submitting ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
