import type { ReactNode } from "react";

import { formatPaisa } from "@/components/bookings/ui";
import { SectionCard } from "@/components/warehouses/ui";

/**
 * Phase 9 report presentation primitives. Everything here renders
 * figures the ReportingService already computed — the components do
 * no arithmetic of their own beyond display formatting, so a chart
 * can never disagree with the table beside it.
 */

export function ReportStat({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md border border-line bg-page px-4 py-3">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
        {label}
      </dt>
      <dd className="tnum mt-1 text-[15px] font-semibold text-ink">{value}</dd>
      {sub ? <dd className="text-[12px] text-faint">{sub}</dd> : null}
    </div>
  );
}

export function formatPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

export function formatMinutes(value: number | null): string {
  if (value === null) return "—";
  if (value < 60) return `${value.toFixed(1)} min`;
  const hours = Math.floor(value / 60);
  const minutes = Math.round(value - hours * 60);
  return `${hours}h ${minutes}m`;
}

export function money(paisa: string): string {
  return formatPaisa(paisa);
}

/**
 * Filter bar: a plain GET form (no client JS) — the page re-renders
 * server-side with the chosen range/filters in the query string, and
 * the same parameters feed the CSV export link.
 */
export function ReportFilterBar({
  action,
  from,
  to,
  warehouseId,
  vendorId,
  driverId,
  warehouses,
  vendors,
  drivers,
  exportHref,
}: {
  action: string;
  from: string;
  to: string;
  warehouseId?: string | null;
  vendorId?: string | null;
  driverId?: string | null;
  warehouses?: { id: string; label: string }[];
  vendors?: { id: string; label: string }[];
  drivers?: { id: string; label: string }[];
  exportHref?: string;
}) {
  const selectClass =
    "rounded-md border border-line bg-surface px-2 py-1.5 text-[13px] text-ink";
  return (
    <form
      method="get"
      action={action}
      className="flex flex-wrap items-end gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
        From (Kathmandu)
        <input type="date" name="from" defaultValue={from} className={selectClass} />
      </label>
      <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
        To (Kathmandu)
        <input type="date" name="to" defaultValue={to} className={selectClass} />
      </label>
      {warehouses ? (
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Warehouse
          <select name="warehouseId" defaultValue={warehouseId ?? ""} className={selectClass}>
            <option value="">All warehouses</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {vendors ? (
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Vendor
          <select name="vendorId" defaultValue={vendorId ?? ""} className={selectClass}>
            <option value="">All vendors</option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {drivers ? (
        <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Driver
          <select name="driverId" defaultValue={driverId ?? ""} className={selectClass}>
            <option value="">All drivers</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button
        type="submit"
        className="rounded-md bg-brand px-3 py-2 text-[13px] font-semibold text-white"
      >
        Apply
      </button>
      {exportHref ? (
        <a
          href={exportHref}
          className="rounded-md border border-line bg-surface px-3 py-2 text-[13px] font-semibold text-ink"
        >
          Export CSV
        </a>
      ) : null}
    </form>
  );
}

/**
 * Server-rendered bar chart: horizontal bars whose widths are the
 * service-computed values scaled to the series maximum. No client
 * code, no fabricated smoothing — each bar is one report figure.
 */
export function BarSeries({
  title,
  points,
  format,
}: {
  title: string;
  points: { label: string; value: number }[];
  format?: (value: number) => string;
}) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const render = format ?? ((v: number) => String(v));
  return (
    <SectionCard title={title}>
      {points.length === 0 ? (
        <p className="text-[13px] text-faint">No data in this range.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {points.map((point) => (
            <div key={point.label} className="flex items-center gap-3">
              <div className="w-[110px] shrink-0 text-right text-[12px] text-slate2">
                {point.label}
              </div>
              <div className="h-[14px] flex-1 rounded-sm bg-cream">
                <div
                  className="h-full rounded-sm bg-brand"
                  style={{ width: `${Math.max(0, (point.value / max) * 100)}%` }}
                />
              </div>
              <div className="tnum w-[90px] shrink-0 text-[12px] font-medium text-ink">
                {render(point.value)}
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

export function ReportTable({
  title,
  headers,
  rows,
  emptyText,
  action,
}: {
  title: string;
  headers: string[];
  rows: ReactNode[][];
  emptyText?: string;
  action?: ReactNode;
}) {
  return (
    <SectionCard title={title} action={action}>
      {rows.length === 0 ? (
        <p className="text-[13px] text-faint">{emptyText ?? "No records in this range."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-[0.12em] text-slate2">
                {headers.map((header) => (
                  <th key={header} className="py-2 pr-3 font-semibold">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-line/60 last:border-0">
                  {row.map((cell, j) => (
                    <td key={j} className="tnum py-1.5 pr-3 text-ink">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

export function ReportPageHeader({
  title,
  range,
  note,
}: {
  title: string;
  range: { from: string; to: string };
  note?: string;
}) {
  return (
    <div>
      <h1 className="text-[20px] font-bold text-ink">{title}</h1>
      <p className="text-[13px] text-faint">
        {range.from} → {range.to} (Asia/Kathmandu, both days inclusive)
        {note ? ` · ${note}` : ""}
      </p>
    </div>
  );
}
