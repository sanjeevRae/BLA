import React from 'react';

const STATUS_STYLES = {
  received: 'bg-slate-200 text-slate-800',
  on_place: 'bg-indigo-200 text-indigo-800',
  went_for_delivery: 'bg-blue-200 text-blue-800',
  out_for_delivery: 'bg-amber-200 text-amber-800',
  delivered: 'bg-emerald-200 text-emerald-800',
  cancelled: 'bg-red-200 text-red-800',
  failed: 'bg-red-200 text-red-800',
};

export default function OrdersList({ orders, selectedId, onSelect }) {
  return (
    <div className="divide-y divide-slate-100 overflow-y-auto">
      {orders.length === 0 && (
        <p className="p-4 text-sm text-slate-400">No orders yet.</p>
      )}
      {orders.map((o) => (
        <button
          key={o.id}
          onClick={() => onSelect(o)}
          className={`flex w-full items-center justify-between gap-2 p-3 text-left hover:bg-slate-50 ${
            selectedId === o.id ? 'bg-slate-100' : ''
          }`}
        >
          <div className="min-w-0">
            <div className="truncate font-medium text-slate-800">{o.order_number}</div>
            <div className="truncate text-xs text-slate-500">{o.delivery_address}</div>
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              STATUS_STYLES[o.status] ?? 'bg-slate-200 text-slate-700'
            }`}
          >
            {o.status.replace(/_/g, ' ')}
          </span>
        </button>
      ))}
    </div>
  );
}
