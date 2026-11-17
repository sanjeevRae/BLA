import type { ReactNode } from "react";

/**
 * PageHeader + PageActionBar (DS §7.4) — new shared primitives for the
 * V3 dashboards; pages adopt them step by step (Steps 4–8). They render
 * structure only: every action passed in maps to an existing page action.
 */

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className = "",
}: {
  /** Role/context line above the title (ink-2, uppercase). */
  eyebrow?: ReactNode;
  title: ReactNode;
  /** One-line description in ink-2. */
  description?: ReactNode;
  /** Right-aligned action group (primary + up to two secondary). */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-wrap items-start justify-between gap-4 ${className}`}>
      <div className="min-w-0">
        {eyebrow ? (
          <p className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-2">
            {eyebrow}
          </p>
        ) : null}
        <h1 className="text-page-title font-semibold text-ink">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-body text-ink-2">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

/**
 * The sticky bar under the header on work pages: filters left, view
 * toggles centre, actions right (bulk actions appear here on selection
 * with the count stated by the caller). Sticks below the 60px app
 * header (DS §5).
 */
export function PageActionBar({
  left,
  center,
  right,
  className = "",
}: {
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`sticky top-[60px] z-30 flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-2 ${className}`}
    >
      {left ? <div className="flex flex-wrap items-center gap-2">{left}</div> : null}
      {center ? (
        <div className="flex flex-wrap items-center gap-2">{center}</div>
      ) : null}
      {right ? (
        <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>
      ) : null}
    </div>
  );
}
