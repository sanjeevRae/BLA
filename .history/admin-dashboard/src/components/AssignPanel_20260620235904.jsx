import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';

export default function AssignPanel({ order, onAssigned }) {
  const [drivers, setDrivers] = useState([]);
  const [driverId, setDriverId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    let active = true;
    api
      .listDrivers()
      .then((data) => {
        if (active) setDrivers(data ?? []);
      })
      .catch((e) => {
        if (active) setMsg(`Error: ${e.message}`);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!order) {
    return (
      <div className="rounded-3xl border border-dashed border-slate-300 p-6 text-sm text-slate-400">
        Select an order to assign a driver.
      </div>
    );
  }

  async function assign() {
    if (!driverId) return;
    setBusy(true);
    setMsg('');
    try {
      const driver = drivers.find((d) => d.id === driverId);
      await api.assignDriver(order.id, driverId, driver?.vehicle_id ?? null);
      setMsg('Driver assigned and route computed.');
      onAssigned?.();
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status) {
    setBusy(true);
    setMsg('');
    try {
      await api.updateOrderStatus(order.id, status);
      setMsg(`Status set to ${status.replace(/_/g, ' ')}.`);
      onAssigned?.();
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-3xl bg-slate-950 p-4 text-white shadow-lg">
        <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Selected order</div>
        <div className="mt-2 text-base font-semibold">{order.order_number}</div>
        <div className="mt-1 text-sm text-slate-300">{order.delivery_address}</div>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
        <label className="mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Assign driver
        </label>
        <select
          value={driverId}
          onChange={(e) => setDriverId(e.target.value)}
          className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm outline-none transition focus:border-slate-400"
        >
          <option value="">Select a driver…</option>
          {drivers.map((d) => (
            <option key={d.id} value={d.id} disabled={!d.is_available}>
              {d.name} {d.is_available ? '' : '(busy)'}
            </option>
          ))}
        </select>
        <button
          onClick={assign}
          disabled={busy || !driverId}
          className="mt-3 w-full rounded-2xl bg-slate-950 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
        >
          Assign route
        </button>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
        <label className="mb-3 block text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
          Quick status update
        </label>
        <div className="flex flex-wrap gap-2">
          {['on_place', 'went_for_delivery', 'out_for_delivery', 'delivered'].map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              disabled={busy}
              className="rounded-full border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
            >
              {s.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </div>

      {msg && <p className="text-xs text-slate-600">{msg}</p>}
    </div>
  );
}
