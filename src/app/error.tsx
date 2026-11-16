"use client";

import Link from "next/link";

/**
 * Root error boundary for non-dashboard routes (V2 Phase 1). The
 * dashboard group has its own in-shell boundary; this one covers
 * public pages with a plain, branded fallback.
 */
export default function RootError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-page px-4">
      <div
        role="alert"
        className="w-full max-w-[440px] rounded-lg border border-red/30 bg-redbg px-5 py-6 text-center"
      >
        <h1 className="text-[18px] font-bold text-reddeep">Something went wrong</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-ink">
          This page could not be loaded. Your data is unchanged — please retry.
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="flex min-h-[44px] items-center rounded-md bg-brand px-4 text-[13px] font-semibold text-white hover:opacity-90"
          >
            Retry
          </button>
          <Link
            href="/track"
            className="flex min-h-[44px] items-center rounded-md border border-line bg-surface px-4 text-[13px] font-semibold text-ink hover:bg-cream"
          >
            Track a package
          </Link>
        </div>
      </div>
    </main>
  );
}
