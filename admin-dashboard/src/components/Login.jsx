import React, { useState } from 'react';
import { supabase } from '../lib/supabase';

const FIELD =
  'h-11 w-full border border-line bg-surface px-3 text-sm text-ink placeholder:text-slate2/60 focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20';

// Sign-in screen shown when the backend requires auth (REQUIRE_AUTH=true)
// and no Supabase session exists. Dev mode (REQUIRE_AUTH=false) never sees it.
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function signIn(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) throw signInError;
      // Auth state change flips App out of this screen automatically.
    } catch (err) {
      setError(err.message || 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-page px-4">
      <div className="w-full max-w-sm border border-line bg-surface p-8">
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-ink text-sm font-bold text-white">
            B
          </span>
          <div>
            <div className="text-[15px] font-bold leading-none text-ink">BLA Logistics</div>
            <div className="mt-1 text-xs text-slate2">Operations platform</div>
          </div>
        </div>

        <h1 className="mt-6 text-xl font-bold text-ink">Sign in</h1>
        <p className="mt-1 text-[13px] text-slate2">
          Use your BLA account. Your role decides what you can see.
        </p>

        <form onSubmit={signIn} className="mt-6 space-y-4">
          <div>
            <label htmlFor="login-email" className="mb-1 block text-sm font-semibold text-ink">
              Email
            </label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@bla.test"
              required
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="login-password" className="mb-1 block text-sm font-semibold text-ink">
              Password
            </label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              className={FIELD}
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="h-11 w-full bg-brand text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {error ? <p className="text-[13px] text-red">{error}</p> : null}
        </form>
      </div>
    </div>
  );
}
