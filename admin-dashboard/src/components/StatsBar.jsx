import React from 'react';

const CARDS = [
  { key: 'total', label: 'Total orders', color: 'bg-slate-700' },
  { key: 'pending', label: 'Pending', color: 'bg-amber-600' },
  { key: 'in_transit', label: 'In transit', color: 'bg-blue-600' },
  { key: 'delivered', label: 'Delivered', color: 'bg-emerald-600' },
  { key: 'active_drivers', label: 'Active drivers', color: 'bg-violet-600' },
];

export default function StatsBar({ stats }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {CARDS.map((c) => (
        <div key={c.key} className={`${c.color} rounded-lg p-3 text-white shadow`}>
          <div className="text-2xl font-bold">{stats?.[c.key] ?? '—'}</div>
          <div className="text-xs opacity-80">{c.label}</div>
        </div>
      ))}
    </div>
  );
}
