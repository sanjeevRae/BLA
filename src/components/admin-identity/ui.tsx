import type { ReactNode } from "react";

import { ROLES } from "@/lib/permissions/catalog";

/** Shared chrome for the Super Admin / Admin identity surfaces
 *  (Phase 6, audit H-4). Token classes only, per docs/ui-ux-guidelines.md. */

export function SectionCard({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-line bg-surface p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
}: {
  eyebrow: string;
  title: string;
  subtitle?: string;
}) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
        {eyebrow}
      </div>
      <h1 className="mt-0.5 text-[22px] font-bold text-ink">{title}</h1>
      {subtitle ? <p className="text-[13px] text-slate2">{subtitle}</p> : null}
    </div>
  );
}

/** Display an ISO timestamp in the operating timezone (Asia/Kathmandu). */
export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Kathmandu",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const ROLE_NAMES = new Map(ROLES.map((r) => [r.code, r.name]));

export function roleLabel(code: string): string {
  return ROLE_NAMES.get(code as never) ?? code;
}

export const primaryButtonClass =
  "inline-flex min-h-[44px] items-center rounded-md bg-brand px-3 text-[13px] font-semibold text-white disabled:opacity-60";
export const subtleButtonClass =
  "inline-flex min-h-[44px] items-center rounded-md border border-line bg-surface px-3 text-[13px] font-semibold text-ink disabled:opacity-60";
export const dangerButtonClass =
  "inline-flex min-h-[44px] items-center rounded-md border border-line bg-surface px-3 text-[13px] font-semibold text-reddeep disabled:opacity-60";
