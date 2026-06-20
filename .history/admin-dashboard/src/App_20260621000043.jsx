import React, { useCallback, useEffect, useMemo, useState } from 'react';
import StatsBar from './components/StatsBar';
import OrdersList from './components/OrdersList';
import AssignPanel from './components/AssignPanel';
import LiveMap from './components/LiveMap';
import { supabase } from './lib/supabase';
import { api } from './lib/api';

const EMPTY_ORDER_FORM = {
  delivery_address: '',
  delivery_latitude: '',
  delivery_longitude: '',
  pickup_address: '',
  pickup_latitude: '',
  pickup_longitude: '',
  recipient_name: '',
  recipient_phone: '',
  notes: '',
  status: 'received',
};

const ORDER_STATUSES = [
  'received',
  'on_place',
  'went_for_delivery',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'failed',
];

export default function App() {
  const [stats, setStats] = useState(null);
  const [orders, setOrders] = useState([]);
  const [selected, setSelected] = useState(null);
  const [editingOrder, setEditingOrder] = useState(null);
  const [orderFormOpen, setOrderFormOpen] = useState(false);
  const [orderForm, setOrderForm] = useState(EMPTY_ORDER_FORM);
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderMessage, setOrderMessage] = useState('');
  const [landmarkBusy, setLandmarkBusy] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const [ov, list] = await Promise.all([api.getOverview(), api.listOrders()]);
      setStats(ov);
      setOrders(list);
      setSelected((prev) => list.find((o) => o.id === prev?.id) ?? null);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    refresh();
    const channel = supabase
      .channel('orders-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => refresh())
      .subscribe();

    return () => supabase.removeChannel(channel);
  }, [refresh]);

  const formTitle = useMemo(
    () => (editingOrder ? `Edit ${editingOrder.order_number}` : 'Create order'),
    [editingOrder]
  );

  function updateForm(field, value) {
    setOrderForm((prev) => ({ ...prev, [field]: value }));
  }

  function resetForm() {
    setEditingOrder(null);
    setOrderForm(EMPTY_ORDER_FORM);
    setOrderMessage('');
    setOrderFormOpen(false);
  }

  function startEdit(order) {
    setEditingOrder(order);
    setOrderFormOpen(true);
    setOrderForm({
      delivery_address: order.delivery_address ?? '',
      delivery_latitude: order.delivery_latitude ?? '',
      delivery_longitude: order.delivery_longitude ?? '',
      pickup_address: order.pickup_address ?? '',
      pickup_latitude: order.pickup_latitude ?? '',
      pickup_longitude: order.pickup_longitude ?? '',
      recipient_name: order.recipient_name ?? '',
      recipient_phone: order.recipient_phone ?? '',
      notes: order.notes ?? '',
      status: order.status ?? 'received',
    });
    setOrderMessage('');
  }

  async function fillCoordinatesFromLandmark(prefix) {
    const address = orderForm[`${prefix}_address`]?.trim();
    if (!address) {
      setOrderMessage(`Enter ${prefix} address or landmark first.`);
      return;
    }

    setLandmarkBusy(prefix);
    setOrderMessage('');

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(address)}`,
        { headers: { Accept: 'application/json' } }
      );

      if (!response.ok) {
        throw new Error('Landmark lookup failed.');
      }

      const results = await response.json();
      const best = results?.[0];
      if (!best?.lat || !best?.lon) {
        throw new Error('No matching place found.');
      }

      updateForm(`${prefix}_latitude`, Number(best.lat).toFixed(6));
      updateForm(`${prefix}_longitude`, Number(best.lon).toFixed(6));
      setOrderMessage(`Filled ${prefix} coordinates from landmark.`);
    } catch (error) {
      setOrderMessage(error.message || 'Could not find coordinates from landmark.');
    } finally {
      setLandmarkBusy(null);
    }
  }

  async function submitOrder(e) {
    e.preventDefault();
    setOrderBusy(true);
    setOrderMessage('');

    const payload = {
      delivery_address: orderForm.delivery_address,
      delivery_latitude:
        orderForm.delivery_latitude === '' ? null : Number(orderForm.delivery_latitude),
      delivery_longitude:
        orderForm.delivery_longitude === '' ? null : Number(orderForm.delivery_longitude),
      pickup_address: orderForm.pickup_address || null,
      pickup_latitude: orderForm.pickup_latitude === '' ? null : Number(orderForm.pickup_latitude),
      pickup_longitude:
        orderForm.pickup_longitude === '' ? null : Number(orderForm.pickup_longitude),
      recipient_name: orderForm.recipient_name || null,
      recipient_phone: orderForm.recipient_phone || null,
      notes: orderForm.notes || null,
      status: orderForm.status,
      items: [],
    };

    try {
      if (editingOrder) {
        await api.updateOrder(editingOrder.id, payload);
        setOrderMessage('Order updated.');
      } else {
        await api.createOrder(payload);
        setOrderMessage('Order created.');
      }
      await refresh();
      resetForm();
    } catch (err) {
      setOrderMessage(`Error: ${err.message}`);
    } finally {
      setOrderBusy(false);
    }
  }

  async function removeOrder(order) {
    if (!window.confirm(`Delete order ${order.order_number}?`)) return;
    setOrderMessage('');
    try {
      await api.deleteOrder(order.id);
      if (selected?.id === order.id) setSelected(null);
      if (editingOrder?.id === order.id) resetForm();
      setOrderMessage('Order deleted.');
      await refresh();
    } catch (err) {
      setOrderMessage(`Error: ${err.message}`);
    }
  }

  return (
    <div className="min-h-screen bg-[#f6f7fb] text-slate-900">
      <header className="border-b border-white/60 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-4 py-4 lg:px-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-slate-400">
              Delivery control
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">
              BLA Operations Dashboard
            </h1>
          </div>
          <button
            onClick={refresh}
            className="rounded-full bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-800"
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-[1600px] px-4 py-5 lg:px-6 lg:py-6">
        <StatsBar stats={stats} />

        <main className="mt-6 grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)_360px]">
          <section className="flex min-h-[calc(100vh-220px)] flex-col overflow-hidden rounded-[28px] border border-white/80 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.08)]">
            <div className="border-b border-slate-100 px-4 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                    Orders
                  </p>
                  <h2 className="mt-1 text-lg font-semibold text-slate-900">Order management</h2>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (orderFormOpen && !editingOrder) {
                      setOrderFormOpen(false);
                      setOrderMessage('');
                    } else {
                      setEditingOrder(null);
                      setOrderForm(EMPTY_ORDER_FORM);
                      setOrderMessage('');
                      setOrderFormOpen(true);
                    }
                  }}
                  className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-950 text-xl text-white shadow-lg shadow-slate-300/50 transition hover:bg-slate-800"
                  aria-label="Toggle order form"
                >
                  {orderFormOpen ? '−' : '+'}
                </button>
              </div>

              <div
                className={`grid transition-all duration-300 ease-in-out ${
                  orderFormOpen ? 'mt-4 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                }`}
              >
                <div className="overflow-hidden">
                  <div className="max-h-[72vh] overflow-y-auto rounded-[24px] border border-slate-200 bg-slate-50 p-4">
                    <form onSubmit={submitOrder} className="space-y-3">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-slate-900">{formTitle}</h3>
                        {editingOrder ? (
                          <button
                            type="button"
                            onClick={resetForm}
                            className="text-xs font-medium text-slate-500 transition hover:text-slate-800"
                          >
                            Cancel edit
                          </button>
                        ) : null}
                      </div>

                      <div className="space-y-2">
                        <label className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Delivery address
                        </label>
                        <input
                          value={orderForm.delivery_address}
                          onChange={(e) => updateForm('delivery_address', e.target.value)}
                          placeholder="Delivery address or landmark"
                          required
                          className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none transition focus:border-slate-400"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => fillCoordinatesFromLandmark('delivery')}
                            disabled={landmarkBusy === 'delivery'}
                            className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
                          >
                            {landmarkBusy === 'delivery' ? 'Finding…' : 'Auto fill lat/lon'}
                          </button>
                          <span className="text-[11px] text-slate-500">Landmark based</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            value={orderForm.delivery_latitude}
                            onChange={(e) => updateForm('delivery_latitude', e.target.value)}
                            placeholder="Latitude"
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                          <input
                            value={orderForm.delivery_longitude}
                            onChange={(e) => updateForm('delivery_longitude', e.target.value)}
                            placeholder="Longitude"
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <label className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                          Pickup address
                        </label>
                        <input
                          value={orderForm.pickup_address}
                          onChange={(e) => updateForm('pickup_address', e.target.value)}
                          placeholder="Pickup address or landmark"
                          className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none transition focus:border-slate-400"
                        />
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => fillCoordinatesFromLandmark('pickup')}
                            disabled={landmarkBusy === 'pickup'}
                            className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
                          >
                            {landmarkBusy === 'pickup' ? 'Finding…' : 'Auto fill lat/lon'}
                          </button>
                          <span className="text-[11px] text-slate-500">Landmark based</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            value={orderForm.pickup_latitude}
                            onChange={(e) => updateForm('pickup_latitude', e.target.value)}
                            placeholder="Latitude"
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                          <input
                            value={orderForm.pickup_longitude}
                            onChange={(e) => updateForm('pickup_longitude', e.target.value)}
                            placeholder="Longitude"
                            className="rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none transition focus:border-slate-400"
                          />
                        </div>
                      </div>

                      <input
                        value={orderForm.recipient_name}
                        onChange={(e) => updateForm('recipient_name', e.target.value)}
                        placeholder="Recipient name"
                        className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none transition focus:border-slate-400"
                      />
                      <input
                        value={orderForm.recipient_phone}
                        onChange={(e) => updateForm('recipient_phone', e.target.value)}
                        placeholder="Recipient phone"
                        className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none transition focus:border-slate-400"
                      />
                      <select
                        value={orderForm.status}
                        onChange={(e) => updateForm('status', e.target.value)}
                        className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none transition focus:border-slate-400"
                      >
                        {ORDER_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {status.replace(/_/g, ' ')}
                          </option>
                        ))}
                      </select>
                      <textarea
                        value={orderForm.notes}
                        onChange={(e) => updateForm('notes', e.target.value)}
                        placeholder="Notes"
                        rows={3}
                        className="w-full rounded-2xl border border-slate-200 bg-white px-3 py-3 text-sm outline-none transition focus:border-slate-400"
                      />
                      <button
                        type="submit"
                        disabled={orderBusy}
                        className="w-full rounded-2xl bg-slate-950 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
                      >
                        {orderBusy ? 'Saving…' : editingOrder ? 'Update order' : 'Create order'}
                      </button>
                      {orderMessage ? <p className="text-xs text-slate-600">{orderMessage}</p> : null}
                    </form>
                  </div>
                </div>
              </div>
            </div>

            <OrdersList
              orders={orders}
              selectedId={selected?.id}
              onSelect={setSelected}
              onEdit={startEdit}
              onDelete={removeOrder}
            />
          </section>

          <section className="min-h-[calc(100vh-220px)] overflow-hidden rounded-[32px] border border-white/80 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.08)]">
            <LiveMap order={selected} />
          </section>

          <section className="min-h-[calc(100vh-220px)] overflow-y-auto rounded-[28px] border border-white/80 bg-white p-4 shadow-[0_20px_60px_rgba(15,23,42,0.08)]">
            <div className="mb-4">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Dispatch
              </p>
              <h2 className="mt-1 text-lg font-semibold text-slate-900">Driver control</h2>
            </div>
            <AssignPanel order={selected} onAssigned={refresh} />
          </section>
        </main>
      </div>
    </div>
  );
}
