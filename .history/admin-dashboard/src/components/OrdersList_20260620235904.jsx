import React from 'react';

const STATUS_STYLES = {
  received: 'bg-slate-100 text-slate-700',
  on_place: 'bg-indigo-100 text-indigo-700',
  went_for_delivery: 'bg-sky-100 text-sky-700',
  out_for_delivery: 'bg-amber-100 text-amber-700',
  delivered: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-rose-100 text-rose-700',
  failed: 'bg-rose-100 text-rose-700',
};

export default function OrdersList({ orders, selectedId, onSelect, onEdit, onDelete }) {
  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
      {orders.length === 0 && (
        <p className="rounded-2xl border border-dashed border-slate-200 p-4 text-sm text-slate-400">
          No orders yet.
        </p>
      )}
      {orders.map((o) => (
        <div
          key={o.id}
          className={`rounded-3xl border p-3 shadow-sm transition ${
            selectedId === o.id
              ? 'border-slate-900 bg-slate-900 text-white shadow-lg shadow-slate-300/50'
              : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
          }`}
        >
          <button
            onClick={() => onSelect(o)}
            className="flex w-full items-start justify-between gap-3 text-left"
          >
            <div className="min-w-0">
              <div className={`truncate text-sm font-semibold ${selectedId === o.id ? 'text-white' : 'text-slate-800'}`}>
                {o.order_number}
              </div>
              <div className={`mt-1 line-clamp-2 text-xs ${selectedId === o.id ? 'text-slate-300' : 'text-slate-500'}`}>
                {o.delivery_address}
              </div>
            </div>
            <span
              className={`shrink-0 rounded-full px-3 py-1 text-[10px] font-semibold ${
                selectedId === o.id
                  ? 'bg-white/15 text-white'
                  : STATUS_STYLES[o.status] ?? 'bg-slate-100 text-slate-700'
              }`}
            >
              {o.status.replace(/_/g, ' ')}
            </span>
          </button>
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => onEdit?.(o)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                selectedId === o.id
                  ? 'bg-white text-slate-900'
                  : 'border border-slate-300 text-slate-700 hover:bg-slate-100'
              }`}
            >
              Edit
            </button>
            <button
              onClick={() => onDelete?.(o)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                selectedId === o.id
                  ? 'bg-rose-500 text-white'
                  : 'border border-rose-200 text-rose-600 hover:bg-rose-50'
              }`}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
