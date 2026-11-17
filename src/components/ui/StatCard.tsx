import type { ReactNode } from "react";
import Link from "next/link";

/**
 * StatCard (DS §7.5) — KPI card anatomy: top row = label (12.5px
 * uppercase ink-2) + icon container (32px, tint background, caller's
 * 18px icon); value in the kpi-value scale (30px / 650, tabular);
 * context line (12.5px ink-2) stating the window in words; optional
 * TrendIndicator (or other) node under the context.
 *
 * The icon tint is the status tint of the metric's MEANING (DS §7.5
 * icon tint rule) — brand = primary-light / primary-dark for neutral
 * operational metrics. Tint classes come only from the token classes;
 * no new hexes.
 *
 * The whole card is a <Link> only when `href` names a real filtered
 * list (KPI click → filtered list); without one it is a plain <div>
 * and never pretends to be a link. Radius: rounded-lg = 12px in this
 * codebase's scale (DS §5; same rounding as DataTable / EmptyState
 * cards). Cards rest on borders — no shadow.
 */
export type StatCardTint =
  | "brand"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "neutral";

const TINT_CONTAINER_CLASSES: Record<StatCardTint, string> = {
  brand: "bg-primary-light text-primary-dark",
  success: "bg-successbg text-success",
  warning: "bg-warningbg text-warning",
  danger: "bg-dangerbg text-danger",
  info: "bg-infobg text-info",
  neutral: "bg-neutralbg text-neutral",
};

export function StatCard({
  label,
  value,
  context,
  icon,
  tint,
  href,
  trend,
}: {
  label: string;
  value: string;
  context?: string;
  icon: ReactNode;
  tint: StatCardTint;
  href?: string;
  trend?: ReactNode;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-2">
          {label}
        </p>
        <span
          aria-hidden="true"
          data-testid="stat-card-icon"
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TINT_CONTAINER_CLASSES[tint]}`}
        >
          {icon}
        </span>
      </div>
      <p className="mt-2 text-[30px] font-[650] tabular-nums text-ink">{value}</p>
      {context ? <p className="mt-1 text-[12.5px] text-ink-2">{context}</p> : null}
      {trend ? <div className="mt-1.5">{trend}</div> : null}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className="block rounded-lg border border-border bg-card p-5 transition-colors hover:border-primary"
      >
        {body}
      </Link>
    );
  }
  return (
    <div className="rounded-lg border border-border bg-card p-5">{body}</div>
  );
}
