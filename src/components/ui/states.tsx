import type { ReactNode } from "react";
import Link from "next/link";

import { ToneIcon } from "./ToneIcon";

/**
 * Shared loading / empty / error states (V2 Phase 1 design system,
 * V3 re-skin DS §7.9). Server-safe: no hooks, no event handlers.
 * ErrorState takes a `retryHref` link instead of an onRetry callback
 * for that reason.
 */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-surface-2 ${className}`} />;
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="grid gap-2 p-3">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-4 w-full" />
      ))}
    </div>
  );
}

/** Default EmptyState glyph (inbox) in the shell stroke style. */
function EmptyStateGlyph() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
    >
      <path d="M3 13 5.5 5h13L21 13v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M3 13h5l1.5 2.5h5L16 13h5" />
    </svg>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  /** Overrides the default glyph; rendered inside the neutral tint
   * container either way (DS §7.9). */
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card px-4 py-10 text-center">
      <div
        aria-hidden="true"
        className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-neutralbg text-neutral"
      >
        {icon ?? <EmptyStateGlyph />}
      </div>
      <p className="text-[14px] font-semibold text-ink">{title}</p>
      {description ? (
        <p className="mt-1 max-w-md text-[13px] text-ink-2">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorState({
  title = "Something went wrong",
  message,
  retryHref,
}: {
  title?: string;
  message: string;
  retryHref?: string;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-lg border border-danger/30 bg-dangerbg px-4 py-10 text-center"
    >
      <div
        aria-hidden="true"
        className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-card text-danger"
      >
        <ToneIcon tone="danger" className="h-5 w-5" />
      </div>
      <p className="text-[14px] font-semibold text-danger">{title}</p>
      <p className="mt-1 max-w-md text-[13px] text-danger">{message}</p>
      {retryHref ? (
        <Link
          href={retryHref}
          className="mt-4 inline-flex min-h-[44px] items-center rounded-lg border border-border-control bg-card px-3 text-[13px] font-semibold text-danger hover:bg-surface-2"
        >
          Retry
        </Link>
      ) : null}
    </div>
  );
}
