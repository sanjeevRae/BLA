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
      // eslint-disable-next-line no-console
      console.error(e);
    }
  }, []);

  useEffect(() => {
    refresh();
    const channel = supabase
      .channel('orders-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders' },
        () => refresh()
      )
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
        {
          headers: {
            Accept: 'application/json',
          },
        }
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
      if (!orderForm[`${prefix}_address`]?.trim()) {
        updateForm(`${prefix}_address`, best.display_name ?? address);
      }
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
    <div className="flex h-full flex-col bg-slate-100">
      <header className="flex items-center justify-between bg-slate-900 px-4 py-3 text-white">
        <h1 className="text-lg font-bold">BLA — Operations Dashboard</h1>
        <button
          onClick={refresh}
          className="rounded bg-slate-700 px-3 py-1 text-sm hover:bg-slate-600"
        >
          Refresh
        </button>
      </header>

      <div className="p-4">
        <StatsBar stats={stats} />
      </div>

      <main className="grid flex-1 grid-cols-1 gap-4 overflow-hidden px-4 pb-4 xl:grid-cols-[24rem_1fr_18rem]">
        <section className="flex flex-col overflow-hidden rounded-lg bg-white shadow">
          <div className="border-b border-slate-100 p-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">Orders</h2>
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
                className="flex h-7 w-7 items-center justify-center rounded border border-slate-300 text-lg leading-none text-slate-700 hover:bg-slate-100"
                aria-label="Toggle order management"
                title="Create order"
              >
                {orderFormOpen ? '−' : '+'}
              </button>
            </div>

            <div
              className={`grid transition-all duration-300 ease-in-out ${orderFormOpen ? 'mt-3 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}
            >
              <div className="overflow-hidden">
                <div className="max-h-[70vh] overflow-y-auto border-t border-slate-100 pt-3 pr-1">
                  <form onSubmit={submitOrder} className="space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-slate-800">{formTitle}</h3>
                      {editingOrder ? (
                        <button
                          type="button"
                          onClick={resetForm}
                          className="text-xs text-slate-500 hover:text-slate-700"
                        >
                        Cancel edit
                      </button>
                    ) : null}
                  </div>

                  <div className="space-y-2">
                    <input
                      value={orderForm.delivery_address}
                      onChange={(e) => updateForm('delivery_address', e.target.value)}
                      placeholder="Delivery address or landmark"
                      required
                      className="w-full rounded border border-slate-300 p-2 text-sm"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => fillCoordinatesFromLandmark('delivery')}
                        disabled={landmarkBusy === 'delivery'}
                        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                      >
                        {landmarkBusy === 'delivery' ? 'Finding…' : 'Auto fill lat/lon'}
                      </button>
                      <span className="text-[11px] text-slate-500">Type landmark and click once.</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={orderForm.delivery_latitude}
                        onChange={(e) => updateForm('delivery_latitude', e.target.value)}
                        placeholder="Delivery lat"
                        className="rounded border border-slate-300 bg-slate-50 p-2 text-sm"
                      />
                      <input
                        value={orderForm.delivery_longitude}
                        onChange={(e) => updateForm('delivery_longitude', e.target.value)}
                        placeholder="Delivery lon"
                        className="rounded border border-slate-300 bg-slate-50 p-2 text-sm"
                      />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <input
                      value={orderForm.pickup_address}
                      onChange={(e) => updateForm('pickup_address', e.target.value)}
                      placeholder="Pickup address or landmark"
                      className="w-full rounded border border-slate-300 p-2 text-sm"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => fillCoordinatesFromLandmark('pickup')}
                        disabled={landmarkBusy === 'pickup'}
                        className="rounded border border-slate-300 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                      >
                        {landmarkBusy === 'pickup' ? 'Finding…' : 'Auto fill lat/lon'}
                      </button>
                      <span className="text-[11px] text-slate-500">Type landmark and click once.</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        value={orderForm.pickup_latitude}
                        onChange={(e) => updateForm('pickup_latitude', e.target.value)}
                        placeholder="Pickup lat"
                        className="rounded border border-slate-300 bg-slate-50 p-2 text-sm"
                      />
                      <input
                        value={orderForm.pickup_longitude}
                        onChange={(e) => updateForm('pickup_longitude', e.target.value)}
                        placeholder="Pickup lon"
                        className="rounded border border-slate-300 bg-slate-50 p-2 text-sm"
                      />
                    </div>
                  </div>
                  <input
                    value={orderForm.recipient_name}
                    onChange={(e) => updateForm('recipient_name', e.target.value)}
                    placeholder="Recipient name"
                    className="w-full rounded border border-slate-300 p-2 text-sm"
                  />
                  <input
                    value={orderForm.recipient_phone}
                    onChange={(e) => updateForm('recipient_phone', e.target.value)}
                    placeholder="Recipient phone"
                    className="w-full rounded border border-slate-300 p-2 text-sm"
                  />
                  <select
                    value={orderForm.status}
                    onChange={(e) => updateForm('status', e.target.value)}
                    className="w-full rounded border border-slate-300 p-2 text-sm"
                  >
                    {['received', 'on_place', 'went_for_delivery', 'out_for_delivery', 'delivered', 'cancelled', 'failed'].map((status) => (
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
                    className="w-full rounded border border-slate-300 p-2 text-sm"
                  />
                    <button
                      type="submit"
                      disabled={orderBusy}
                      className="w-full rounded bg-slate-900 py-2 text-sm font-semibold text-white disabled:opacity-50"
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

        <section className="overflow-hidden rounded-lg bg-white shadow">
          <LiveMap order={selected} />
        </section>

        <section className="overflow-y-auto rounded-lg bg-white shadow">
          <div className="p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-800">Dispatch</h3>
            <AssignPanel order={selected} onAssigned={refresh} />
          </div>
        </section>
      </main>
    </div>
  );
}
