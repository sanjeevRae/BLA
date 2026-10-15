import React from 'react';

// Light data table: faint header row, thin dividers, empty/loading states.
// Pass onRowClick to make rows clickable (fleet/detail drill-down).
export default function DataTable({ columns, rows, keyField = 'id', loading, error, emptyText, onRowClick }) {
  if (loading) {
    return (
      <div className="rounded-md border border-line bg-surface p-8 text-center text-sm text-slate2">
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-line bg-surface p-8 text-center text-sm text-red">
        {error}
      </div>
    );
  }
  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-md border border-line bg-surface p-8 text-center text-sm text-slate2">
        {emptyText ?? 'No records found.'}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md bg-surface">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-line text-[11px] font-medium text-faint">
            {columns.map((col) => (
              <th key={col.key} className="whitespace-nowrap px-4 py-2.5 font-medium">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#F1F5F9]">
          {rows.map((row) => (
            <tr
              key={row[keyField]}
              className={`bg-surface ${onRowClick ? 'cursor-pointer transition hover:bg-cream/60' : ''}`}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((col) => (
                <td key={col.key} className="px-4 py-3 align-top text-slate2">
                  {col.render ? col.render(row) : row[col.key] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Small pill badge: neutral by default, green only for positive states.
export function Badge({ tone = 'neutral', children }) {
  const tones = {
    neutral: 'bg-cream text-slate2',
    positive: 'bg-greenbg text-green',
    blue: 'bg-accentbg text-brand',
  };
  return (
    <span className={`inline-block rounded-full px-2.5 py-1 text-[11px] font-semibold ${tones[tone] ?? tones.neutral}`}>
      {children}
    </span>
  );
}
