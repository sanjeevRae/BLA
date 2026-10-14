import React from 'react';
import { Sparkline, fmtINR } from './widgets';

const ARROW_UP = (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M6 10.5V1.5 M2.5 5L6 1.5 9.5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const ARROW_FLAT = (
  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2 6h8 M7.5 3.5L10 6l-2.5 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function MetricIcon({ icon, tile, glyph }) {
  return (
    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tile}`}>
      <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d={icon} stroke={glyph} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

// Metrics keyed by the /analytics/trends response (`metrics` object).
const CARDS = [
  { key: 'total', label: 'Total orders', hint: 'All orders on record', icon: 'M10 3l6 3v8l-6 3-6-3V6z M4 6l6 3 6-3 M10 9v8', tile: 'bg-accentbg', glyph: '#2563EB', spark: '#2563EB' },
  { key: 'pending', label: 'Pending', hint: 'Received or on place', icon: 'M10 16.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M10 7.5V10l1.8 1.8', tile: 'bg-orangebg', glyph: '#EA580C', spark: '#EA580C' },
  { key: 'in_transit', label: 'In transit', hint: 'With drivers now', icon: 'M2 6.5h11V13H2z M13 9.5h2.6L17 11.5V13h-4z M5.5 16h.01 M15.5 16h.01', tile: 'bg-accentbg', glyph: '#2563EB', spark: '#60A5FA' },
  { key: 'delivered', label: 'Delivered', hint: 'Completed drops', icon: 'M4 10.5l4 4 8-9', tile: 'bg-greenbg', glyph: '#16A34A', spark: '#16A34A' },
  { key: 'active_drivers', label: 'Active drivers', hint: 'Available for dispatch', icon: 'M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M3 17c0-3 3-5 7-5s7 2 7 5', tile: 'bg-purplebg', glyph: '#7C3AED', spark: '#7C3AED' },
  { key: 'customers', label: 'Customers', hint: 'Customer records', icon: 'M7 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M2 16c0-2.5 2.5-4 5-4s5 1.5 5 4 M13 6a2 2 0 1 1 2 2 M14 12c2 .5 4 1.8 4 4', tile: 'bg-accentbg', glyph: '#2563EB', spark: '#60A5FA' },
  { key: 'collected_revenue', label: 'Collected revenue', hint: 'Paid orders', money: true, icon: 'M3 6.5h14v9H3z M3 9.5h14 M6.5 13h4', tile: 'bg-greenbg', glyph: '#16A34A', spark: '#7C3AED' },
  { key: 'pending_revenue', label: 'Pending revenue', hint: 'Awaiting payment', money: true, icon: 'M3 6.5h14v9H3z M3 9.5h14 M6.5 13h4', tile: 'bg-[#FFF4E0]', glyph: '#F59E0B', spark: '#F59E0B' },
];

const UP = 'text-green';
const FLAT = 'text-faint';

export function MetricCard({ card, value, change, spark }) {
  const display = value == null ? '—' : card.money ? fmtINR(value) : value;
  const up = Number(change) > 0;
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-center gap-2.5">
        <MetricIcon icon={card.icon} tile={card.tile} glyph={card.glyph} />
        <p className="text-[13px] font-medium text-slate2">{card.label}</p>
      </div>
      <div className="mt-3 flex items-end justify-between gap-2">
        <div>
          <p className="tnum text-[26px] font-bold leading-none text-ink">{display}</p>
          <p className={`mt-2 flex items-center gap-1 text-xs font-semibold ${up ? UP : FLAT}`}>
            {up ? ARROW_UP : ARROW_FLAT}
            {change == null ? '—' : `${Math.abs(Number(change))}%`}
          </p>
          <p className="mt-1.5 text-[11px] text-faint">{card.hint}</p>
        </div>
        <Sparkline data={spark ?? []} color={card.spark} id={card.key} />
      </div>
    </div>
  );
}

export default function StatsBar({ trends }) {
  const metrics = trends?.metrics ?? {};
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {CARDS.map((c) => {
        const m = metrics[c.key] ?? {};
        return <MetricCard key={c.key} card={c} value={m.value} change={m.change} spark={m.spark} />;
      })}
    </div>
  );
}

