import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge } from './DataTable';

/**
 * Admin review queue for vendor-created orders (approval_status = pending).
 * Hides itself when the queue is empty.
 */
export default function ApprovalQueue({ onChanged }) {
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api
      .pendingOrders()
      .then((d) => setRows(Array.isArray(d) ? d : []))
      .catch((e) => setErr(e.message))
      .finally(() => setLoaded(true));
  }, []);

  useEffect(load, [load]);

  async function decide(id, approval_status) {
    setBusy(id);
    setErr('');
    try {
      await api.approveOrder(id, approval_status);
      load();
      onChanged?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  }

  if (!loaded || (!rows.length && !err)) return null;

  return (
    <div className="mt-5 rounded-lg border border-line bg-surface px-5 py-4">
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full bg-amber-500" />
        <h3 className="text-[14px] font-bold text-ink">
          Pending approval · {rows.length}
        </h3>
        <span className="text-[12px] text-slate2">Vendor orders awaiting admin review</span>
      </div>
      {err && <p className="mt-2 text-[13px] font-medium text-red-600">{err}</p>}
      <ul className="mt-3 divide-y divide-line">
        {rows.map((o) => (
          <li key={o.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12px] font-semibold text-ink">{o.order_number}</span>
                <Badge tone="neutral">{o.destination_district || 'district n/a'}</Badge>
              </div>
              <p className="truncate text-[12px] text-slate2">
                {o.recipient_name || '—'} · {o.delivery_address}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                disabled={busy === o.id}
                onClick={() => decide(o.id, 'approved')}
                className="h-8 rounded-md bg-brand px-3 text-[12px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
              >
                {busy === o.id ? '…' : 'Approve'}
              </button>
              <button
                disabled={busy === o.id}
                onClick={() => decide(o.id, 'rejected')}
                className="h-8 rounded-md border border-line px-3 text-[12px] font-semibold text-slate2 hover:bg-cream disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
