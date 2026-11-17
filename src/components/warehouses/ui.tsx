import type { ReactNode } from "react";

import { StatusBadge as SharedStatusBadge } from "@/components/ui/StatusBadge";

/** Shared form styling for the warehouse module (console token system). */
export const inputClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-[13px] text-ink outline-none focus:border-brand disabled:bg-cream disabled:text-faint";
export const labelClass =
  "mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2";
export const primaryButtonClass =
  "rounded-md bg-brand px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-60";
export const subtleButtonClass =
  "rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink disabled:opacity-60";
export const dangerButtonClass =
  "rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-red disabled:opacity-60";

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
    <section className="min-w-0 rounded-lg border border-line bg-surface p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function WarehouseStatusBadge({ status }: { status: string }) {
  return <SharedStatusBadge domain="generic" status={status} />;
}

export function ErrorBox({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-md border border-line bg-dangerbg px-3 py-2 text-[13px] text-red"
    >
      {message}
    </div>
  );
}

export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
