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
      <div className="border border-dashed border-line p-6 text-sm text-slate2">
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
      <div className="rounded-md bg-cream p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
          Selected order
        </p>
        <p className="mt-2 text-[13px] font-bold text-ink">{order.order_number}</p>
        <p className="mt-1 text-[13px] text-slate2">{order.delivery_address}</p>
      </div>

      <div className="border border-line bg-surface p-4">
        <label
          htmlFor="assign-driver"
          className="mb-2 block text-[13px] font-semibold uppercase tracking-[0.18em] text-brand"
        >
          Assign driver
        </label>
        <select
          id="assign-driver"
          value={driverId}
          onChange={(e) => setDriverId(e.target.value)}
          className="h-11 w-full border border-line bg-surface px-3 text-sm text-ink focus:border-ink"
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
          className="mt-3 h-11 w-full bg-brand text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
        >
          Assign route
        </button>
      </div>

      <div className="border border-line bg-surface p-4">
        <p className="mb-3 text-[13px] font-semibold uppercase tracking-[0.18em] text-brand">
          Quick status update
        </p>
        <div className="flex flex-wrap gap-2">
          {['on_place', 'went_for_delivery', 'out_for_delivery', 'delivered'].map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              disabled={busy}
              className="h-9 border border-line bg-surface px-3 text-xs font-semibold text-ink transition hover:border-ink hover:bg-cream disabled:opacity-50"
            >
              {s.replace(/_/g, ' ')}
            </button>
          ))}
        </div>
      </div>

      {msg && <p className="text-[13px] text-slate2">{msg}</p>}
    </div>
  );
}
