import React from 'react';

const STATUS_STYLES = {
  received: 'bg-badgebg text-badgetx',
  on_place: 'bg-badgebg text-badgetx',
  went_for_delivery: 'bg-badgebg text-badgetx',
  out_for_delivery: 'bg-badgebg text-badgetx',
  delivered: 'bg-successbg text-successtx',
  cancelled: 'bg-badgebg text-badgetx',
  failed: 'bg-badgebg text-badgetx',
};

export default function OrdersList({ orders, selectedId, onSelect, onEdit, onDelete }) {
  return (
    <div className="quiet-scroll flex-1 space-y-2 overflow-y-auto">
      {orders.length === 0 && (
        <p className="border border-dashed border-line p-4 text-center text-sm text-slate2">
          No orders found for this period.
        </p>
      )}
      {orders.map((o) => {
        const active = selectedId === o.id;
        return (
          <div
            key={o.id}
            className={`rounded-md border p-3 transition ${
              active ? 'border-brand bg-accentbg' : 'border-line bg-surface hover:border-slate2'
            }`}
          >
            <button
              onClick={() => onSelect(o)}
              className="flex w-full items-start justify-between gap-3 text-left"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-ink">
                  {o.order_number}
                </div>
                <div className="mt-1 line-clamp-2 text-[13px] text-slate2">
                  {o.delivery_address}
                </div>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-1 text-[11px] font-semibold ${
                  active
                    ? 'bg-surface text-brand'
                    : STATUS_STYLES[o.status] ?? 'bg-cream text-slate2'
                }`}
              >
                {o.status.replace(/_/g, ' ')}
              </span>
            </button>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => onEdit?.(o)}
                className="h-8 rounded-md border border-line bg-surface px-3 text-xs font-semibold text-ink transition hover:bg-cream"
              >
                Edit
              </button>
              <button
                onClick={() => onDelete?.(o)}
                className="h-8 rounded-md px-3 text-xs font-semibold text-brand transition hover:bg-surface"
              >
                Delete
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

