"use client";

import Link from "next/link";

/**
 * Dashboard error boundary (V2 Phase 1, audit defect L-3/M-7): until
 * now a service error in any dashboard produced Next's raw default
 * error page. This boundary keeps the shell, names the failure
 * plainly, and offers retry + a route back to the dashboard home.
 * The underlying error is still logged by the framework — nothing is
 * swallowed here.
 */
export default function DashboardError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-lg border border-red/30 bg-redbg px-4 py-4"
    >
      <h2 className="text-[15px] font-bold text-reddeep">This page could not be loaded</h2>
      <p className="mt-1 max-w-[560px] text-[13px] leading-relaxed text-ink">
        Something went wrong while loading this screen. Your data is unchanged —
        you can retry, or go back to your dashboard and try again from there.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={reset}
          className="flex min-h-[44px] items-center rounded-md bg-brand px-4 text-[13px] font-semibold text-white hover:opacity-90"
        >
          Retry
        </button>
        <Link
          href="/go"
          className="flex min-h-[44px] items-center rounded-md border border-line bg-surface px-4 text-[13px] font-semibold text-ink hover:bg-cream"
        >
          Back to my dashboard
        </Link>
      </div>
    </div>
  );
}
