import React from 'react';

const CARDS = [
  { key: 'total', label: 'Total orders', accent: 'from-slate-900 to-slate-700' },
  { key: 'pending', label: 'Pending', accent: 'from-amber-500 to-orange-500' },
  { key: 'in_transit', label: 'In transit', accent: 'from-blue-600 to-cyan-500' },
  { key: 'delivered', label: 'Delivered', accent: 'from-emerald-600 to-teal-500' },
  { key: 'active_drivers', label: 'Active drivers', accent: 'from-violet-600 to-fuchsia-500' },
];

export default function StatsBar({ stats }) {
  return (
    <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
      {CARDS.map((c) => (
        <div
          key={c.key}
          className={`rounded-3xl bg-gradient-to-br ${c.accent} p-[1px] shadow-lg shadow-slate-200/60`}
        >
          <div className="rounded-[calc(1.5rem-1px)] bg-white/95 px-4 py-4 backdrop-blur">
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">
              {c.label}
            </div>
            <div className="mt-3 text-3xl font-bold text-slate-900">{stats?.[c.key] ?? '—'}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
