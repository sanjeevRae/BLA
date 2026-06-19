import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';

// Driver-assignment UI for the currently selected order.
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
    return <p className="p-4 text-sm text-slate-400">Select an order to assign a driver.</p>;
  }

  async function assign() {
    if (!driverId) return;
    setBusy(true);
    setMsg('');
    try {
      const driver = drivers.find((d) => d.id === driverId);
      await api.assignDriver(order.id, driverId, driver?.vehicle_id ?? null);
      setMsg('Driver assigned — route computed.');
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
    <div className="space-y-3 p-4">
      <div>
        <div className="text-sm font-semibold text-slate-800">{order.order_number}</div>
        <div className="text-xs text-slate-500">{order.delivery_address}</div>
      </div>

      <label className="block text-xs font-medium text-slate-600">Assign driver</label>
      <select
        value={driverId}
        onChange={(e) => setDriverId(e.target.value)}
        className="w-full rounded border border-slate-300 p-2 text-sm"
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
        className="w-full rounded bg-blue-600 py-2 text-sm font-semibold text-white disabled:opacity-50"
      >
        Assign &amp; compute route
      </button>

      <label className="block pt-2 text-xs font-medium text-slate-600">Quick status update</label>
      <div className="flex flex-wrap gap-2">
        {['on_place', 'went_for_delivery', 'out_for_delivery', 'delivered'].map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            disabled={busy}
            className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 disabled:opacity-50"
          >
            {s.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      {msg && <p className="text-xs text-slate-600">{msg}</p>}
    </div>
  );
}
