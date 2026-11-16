import type { ReactNode } from "react";
import Link from "next/link";

/**
 * Shared loading / empty / error states (V2 Phase 1 design system).
 * Server-safe: no hooks, no event handlers. ErrorState takes a
 * `retryHref` link instead of an onRetry callback for that reason.
 */

export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded-md bg-cream ${className}`} />;
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

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-md border border-line bg-surface px-4 py-10 text-center">
      <p className="text-[14px] font-semibold text-ink">{title}</p>
      {description ? (
        <p className="mt-1 max-w-md text-[13px] text-slate2">{description}</p>
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
      className="flex flex-col items-center justify-center rounded-md border border-red/30 bg-redbg px-4 py-10 text-center"
    >
      <p className="text-[14px] font-semibold text-reddeep">{title}</p>
      <p className="mt-1 max-w-md text-[13px] text-reddeep">{message}</p>
      {retryHref ? (
        <Link
          href={retryHref}
          className="mt-4 inline-flex min-h-[44px] items-center rounded-md border border-red/30 bg-surface px-3 text-[13px] font-semibold text-reddeep"
        >
          Retry
        </Link>
      ) : null}
    </div>
  );
}
