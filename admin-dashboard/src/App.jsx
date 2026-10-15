import React, { useCallback, useEffect, useMemo, useState } from 'react';
import OrdersList from './components/OrdersList';
import AssignPanel from './components/AssignPanel';
import LiveMap from './components/LiveMap';
import TopBar from './components/TopBar';
import Sidebar, { NAV_ITEMS } from './components/Sidebar';
import PageHeader from './components/PageHeader';
import DataTable from './components/DataTable';
import Dashboard from './components/Dashboard';
import {
  ItemsPage,
  DriversPage,
  PackagesPage,
  PaymentsPage,
  VehiclesPage,
  WarehousesPage,
  ShipmentsPage,
  TripsPage,
  DriverTasksPage,
  VendorsPage,
} from './components/Pages';
import OrderDetail from './components/OrderDetail';
import ApprovalQueue from './components/ApprovalQueue';
import { supabase } from './lib/supabase';
import { api } from './lib/api';
import Login from './components/Login';

const CLIENT_COLUMNS = [
  {
    key: 'name',
    label: 'Name',
    render: (r) => <span className="font-semibold text-ink">{r.name || 'Unnamed'}</span>,
  },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'city', label: 'City' },
  {
    key: 'created_at',
    label: 'Created',
    render: (r) =>
      r.created_at
        ? new Date(r.created_at).toLocaleDateString(undefined, {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
          })
        : '—',
  },
];

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

const FIELD_CLASS =
  'h-11 w-full border border-line bg-surface px-3 text-sm text-ink focus:border-ink';

export default function App() {
  const [stats, setStats] = useState(null);
  const [cashflow, setCashflow] = useState(null);
  const [adminFeed, setAdminFeed] = useState(null);
  const [profile, setProfile] = useState(null);
  const [orders, setOrders] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [selected, setSelected] = useState(null);
  const [editingOrder, setEditingOrder] = useState(null);
  const [orderFormOpen, setOrderFormOpen] = useState(false);
  const [orderForm, setOrderForm] = useState(EMPTY_ORDER_FORM);
  const [orderBusy, setOrderBusy] = useState(false);
  const [orderMessage, setOrderMessage] = useState('');
  const [landmarkBusy, setLandmarkBusy] = useState(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('orders');
  const [refreshing, setRefreshing] = useState(false);
  const [page, setPage] = useState('dashboard');
  const [days, setDays] = useState(120);

  // Supabase session: undefined = still checking, null = signed out.
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    let mounted = true;
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (mounted) setSession(data?.session ?? null);
      })
      .catch(() => {
        if (mounted) setSession(null);
      });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next ?? null);
    });
    return () => {
      mounted = false;
      listener?.subscription?.unsubscribe();
    };
  }, []);

  const dateLabel = useMemo(() => {
    const fmt = (d) =>
      d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - (days - 1));
    return `${fmt(start)} – ${fmt(end)}`;
  }, [days]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [ov, list, flow, feed, cust, prof] = await Promise.all([
        api.getOverview(),
        api.listOrders(),
        api.getCashflow(),
        api.getAdminFeed(),
        api.listCustomers(''),
        api.getProfile(),
      ]);
      setStats(ov);
      setOrders(list);
      setCashflow(flow);
      setAdminFeed(feed);
      setCustomers(cust);
      setProfile(prof);
      setSelected((prev) => list.find((o) => o.id === prev?.id) ?? null);
    } catch (e) {
      console.error(e);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const visibleOrders = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base =
      tab === 'attention'
        ? orders.filter((o) => ['failed', 'cancelled'].includes(o.status) || o.status === 'received')
        : orders;
    if (!q) return base;
    return base.filter((o) =>
      [o.order_number, o.delivery_address, o.recipient_name, o.recipient_phone, o.status]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [orders, search, tab]);

  const visibleCustomers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) =>
      [c.name, c.email, c.phone, c.city]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q))
    );
  }, [customers, search]);

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const list = await api.listCustomers(search.trim());
        setCustomers(list);
      } catch (error) {
        console.error(error);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [search]);

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

  function openCreate() {
    setEditingOrder(null);
    setOrderForm(EMPTY_ORDER_FORM);
    setOrderMessage('');
    setOrderFormOpen(true);
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

  // Production auth gate: when the backend requires auth and there is no
  // Supabase session, show the sign-in screen. Dev (REQUIRE_AUTH=false) is open.
  if (profile?.auth_required) {
    if (session === undefined) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-page text-sm text-slate2">
          Loading…
        </div>
      );
    }
    if (!session) return <Login />;
  }

  return (
    <div className="flex min-h-screen bg-page text-ink">
      <Sidebar page={page} onPageChange={setPage} profile={profile} />

      <div className="min-w-0 flex-1">
        {/* Mobile section nav */}
        <nav className="border-b border-line bg-surface px-3 py-2 lg:hidden" aria-label="Sections">
          <div className="flex gap-1 overflow-x-auto">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setPage(item.id)}
                className={`h-9 shrink-0 rounded-md px-3 text-xs font-semibold transition ${
                  page === item.id ? 'bg-accentbg text-brand' : 'text-slate2 hover:bg-cream'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </nav>

        <div className="mx-auto max-w-content px-4 py-6 lg:px-8 lg:py-8">
          <TopBar
            search={search}
            onSearchChange={setSearch}
            dateLabel={dateLabel}
            operator={profile?.operator}
            notifCount={profile?.badges?.notifications ?? 0}
            onSignOut={session ? () => supabase.auth.signOut() : undefined}
          />

          {page === 'dashboard' && (
            <Dashboard
              days={days}
              onOpenPage={(id) => setPage(id)}
              onCreateOrder={openCreate}
              onAssignDriver={() => setPage('orders')}
              onOpenCustomers={() => setPage('clients')}
              onAddItem={() => setPage('inventory')}
              online={profile?.online}
            />
          )}

          {page === 'orders' && (
            <>


        {/* Admin approval queue (vendor orders awaiting review) */}
        <ApprovalQueue onChanged={refresh} />

        {/* Live operations: orders + map + dispatch */}
        <section className="mt-5 rounded-lg border border-line bg-surface">
          <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-4">
            <div>
              <h2 className="text-[15px] font-bold text-ink">Orders and dispatch</h2>
              <p className="mt-0.5 text-xs text-faint">Live from Supabase · {visibleOrders.length} shown</p>
            </div>
            <div className="flex items-center gap-3">
              <div role="tablist" aria-label="Order views" className="flex rounded-full bg-[#F1F5F9] p-1">
                {[
                  { id: 'orders', label: `All · ${orders.length}` },
                  { id: 'attention', label: 'Attention' },
                ].map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className={`h-8 rounded-full px-3.5 text-xs font-semibold transition ${
                      tab === t.id ? 'bg-surface text-ink shadow-sm' : 'text-slate2 hover:text-ink'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <button
                onClick={openCreate}
                className="h-9 rounded-md bg-brand px-4 text-[13px] font-semibold text-white transition hover:brightness-110"
              >
                New order
              </button>
            </div>
          </div>

          <div className="grid gap-0 lg:grid-cols-[330px_minmax(0,1fr)_340px]">
            {/* Orders column */}
            <div className="flex min-h-[480px] flex-col border-b border-line p-4 lg:border-b-0 lg:border-r">
              <OrdersList
                orders={visibleOrders}
                selectedId={selected?.id}
                onSelect={setSelected}
                onEdit={startEdit}
                onDelete={removeOrder}
              />
            </div>

            {/* Map column */}
            <div className="min-h-[480px] border-b border-line lg:border-b-0 lg:border-r">
              <LiveMap
                onSelectDriver={(driver) => {
                  if (driver && driver !== '__open__') setPage('drivers');
                }}
              />
            </div>

            {/* Dispatch column */}
            <div className="min-h-[480px] p-4">
              <div className="mt-1">
                <AssignPanel order={selected} onAssigned={refresh} />
              </div>
            </div>
          </div>
        </section>

        {/* Selected order details: per-order map, journey, timeline, workflow */}
        {selected && (
          <div className="mt-5">
            <OrderDetail
              order={selected}
              onChanged={refresh}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
            </>
          )}

          {page === 'clients' && (
            <div className="mt-5 rounded-lg border border-line bg-surface pb-5">
              <PageHeader
                eyebrow="CRM"
                title="Clients"
                description="Customer records from the backend — search by name, email, phone or city."
              />
              <div className="px-6 pt-4">
                <p className="mb-3 text-[13px] text-slate2">
                  {visibleCustomers.length} client{visibleCustomers.length === 1 ? '' : 's'}
                  {search.trim() ? ` matching “${search.trim()}”` : ''}
                </p>
                <DataTable
                  columns={CLIENT_COLUMNS}
                  rows={visibleCustomers}
                  emptyText="No clients found."
                />
              </div>
            </div>
          )}

          {page === 'inventory' && <ItemsPage search={search} />}
          {page === 'drivers' && <DriversPage search={search} />}
          {page === 'packages' && <PackagesPage search={search} />}
          {page === 'payments' && <PaymentsPage search={search} />}
          {page === 'vehicles' && <VehiclesPage search={search} />}
          {page === 'warehouses' && <WarehousesPage search={search} />}
          {page === 'parcels' && <ShipmentsPage search={search} />}
          {page === 'trips' && <TripsPage search={search} />}
          {page === 'vendors' && <VendorsPage search={search} />}
          {page === 'tasks' && <DriverTasksPage search={search} />}

        {/* Order create/edit dialog */}
        {orderFormOpen ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
            <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto border border-line bg-surface">
              <div className="border-b border-line px-6 py-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
                  {editingOrder ? 'Edit order' : 'New order'}
                </p>
                <h2 className="mt-1 text-[20px] font-bold text-ink">{formTitle}</h2>
              </div>
              <div className="px-6 py-5">
                <form onSubmit={submitOrder} className="space-y-4">
                  <div>
                    <label htmlFor="f-delivery-address" className="mb-1 block text-sm font-semibold text-ink">
                      Delivery address
                    </label>
                    <input
                      id="f-delivery-address"
                      value={orderForm.delivery_address}
                      onChange={(e) => updateForm('delivery_address', e.target.value)}
                      placeholder="Delivery address or landmark"
                      required
                      className={FIELD_CLASS}
                    />
                    <button
                      type="button"
                      onClick={() => fillCoordinatesFromLandmark('delivery')}
                      disabled={landmarkBusy === 'delivery'}
                      className="mt-2 h-9 border border-line bg-surface px-3 text-xs font-semibold text-ink transition hover:border-ink hover:bg-cream disabled:opacity-50"
                    >
                      {landmarkBusy === 'delivery' ? 'Finding...' : 'Auto fill lat/lon'}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="f-del-lat" className="mb-1 block text-sm font-semibold text-ink">
                        Delivery latitude
                      </label>
                      <input
                        id="f-del-lat"
                        value={orderForm.delivery_latitude}
                        onChange={(e) => updateForm('delivery_latitude', e.target.value)}
                        placeholder="Latitude"
                        className={FIELD_CLASS}
                      />
                    </div>
                    <div>
                      <label htmlFor="f-del-lon" className="mb-1 block text-sm font-semibold text-ink">
                        Delivery longitude
                      </label>
                      <input
                        id="f-del-lon"
                        value={orderForm.delivery_longitude}
                        onChange={(e) => updateForm('delivery_longitude', e.target.value)}
                        placeholder="Longitude"
                        className={FIELD_CLASS}
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="f-pickup-address" className="mb-1 block text-sm font-semibold text-ink">
                      Pickup address
                    </label>
                    <input
                      id="f-pickup-address"
                      value={orderForm.pickup_address}
                      onChange={(e) => updateForm('pickup_address', e.target.value)}
                      placeholder="Pickup address or landmark"
                      className={FIELD_CLASS}
                    />
                    <button
                      type="button"
                      onClick={() => fillCoordinatesFromLandmark('pickup')}
                      disabled={landmarkBusy === 'pickup'}
                      className="mt-2 h-9 border border-line bg-surface px-3 text-xs font-semibold text-ink transition hover:border-ink hover:bg-cream disabled:opacity-50"
                    >
                      {landmarkBusy === 'pickup' ? 'Finding...' : 'Auto fill lat/lon'}
                    </button>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="f-pick-lat" className="mb-1 block text-sm font-semibold text-ink">
                        Pickup latitude
                      </label>
                      <input
                        id="f-pick-lat"
                        value={orderForm.pickup_latitude}
                        onChange={(e) => updateForm('pickup_latitude', e.target.value)}
                        placeholder="Latitude"
                        className={FIELD_CLASS}
                      />
                    </div>
                    <div>
                      <label htmlFor="f-pick-lon" className="mb-1 block text-sm font-semibold text-ink">
                        Pickup longitude
                      </label>
                      <input
                        id="f-pick-lon"
                        value={orderForm.pickup_longitude}
                        onChange={(e) => updateForm('pickup_longitude', e.target.value)}
                        placeholder="Longitude"
                        className={FIELD_CLASS}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="f-recipient" className="mb-1 block text-sm font-semibold text-ink">
                        Recipient name
                      </label>
                      <input
                        id="f-recipient"
                        value={orderForm.recipient_name}
                        onChange={(e) => updateForm('recipient_name', e.target.value)}
                        placeholder="Recipient name"
                        className={FIELD_CLASS}
                      />
                    </div>
                    <div>
                      <label htmlFor="f-phone" className="mb-1 block text-sm font-semibold text-ink">
                        Recipient phone
                      </label>
                      <input
                        id="f-phone"
                        value={orderForm.recipient_phone}
                        onChange={(e) => updateForm('recipient_phone', e.target.value)}
                        placeholder="Recipient phone"
                        className={FIELD_CLASS}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor="f-status" className="mb-1 block text-sm font-semibold text-ink">
                        Status
                      </label>
                      <select
                        id="f-status"
                        value={orderForm.status}
                        onChange={(e) => updateForm('status', e.target.value)}
                        className={FIELD_CLASS}
                      >
                        {ORDER_STATUSES.map((status) => (
                          <option key={status} value={status}>
                            {status.replace(/_/g, ' ')}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label htmlFor="f-notes" className="mb-1 block text-sm font-semibold text-ink">
                        Notes
                      </label>
                      <textarea
                        id="f-notes"
                        value={orderForm.notes}
                        onChange={(e) => updateForm('notes', e.target.value)}
                        placeholder="Notes"
                        rows={2}
                        className="w-full border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-ink"
                      />
                    </div>
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <button
                      type="submit"
                      disabled={orderBusy}
                      className="h-11 flex-1 bg-brand text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
                    >
                      {orderBusy ? 'Saving...' : editingOrder ? 'Update order' : 'Create order'}
                    </button>
                    <button
                      type="button"
                      onClick={resetForm}
                      className="h-11 border border-line bg-surface px-6 text-sm font-semibold text-ink transition hover:bg-cream"
                    >
                      Cancel
                    </button>
                  </div>
                  {orderMessage ? <p className="text-[13px] text-slate2">{orderMessage}</p> : null}
                </form>
              </div>
            </div>
          </div>
        ) : null}
        </div>
      </div>
    </div>
  );
}
