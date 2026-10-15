import React, { useEffect, useState } from 'react';
import { api } from '../lib/api';
import PageHeader from './PageHeader';
import DataTable, { Badge } from './DataTable';

function fmtDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString(undefined, {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(value);
  }
}

function fmtMoney(value, currency = 'INR') {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

// Shared form-control styles (match App.jsx order form look).
const FIELD =
  'h-10 w-full border border-line bg-surface px-3 text-sm text-ink focus:border-ink';
const BTN =
  'h-10 rounded-md bg-brand px-4 text-[13px] font-semibold text-white hover:opacity-90 disabled:opacity-50';
const BTN_SM =
  'h-7 rounded-md border border-line bg-surface px-2.5 text-[12px] font-semibold text-slate2 hover:bg-cream disabled:opacity-50';

// Advance helper for linear status tracks (returns null at the end).
function nextOf(flow, current) {
  const i = flow.indexOf(current);
  return i === -1 || i === flow.length - 1 ? null : flow[i + 1];
}

const PARCEL_FLOW = [
  'registered', 'picked_up', 'at_origin_hub', 'in_transit',
  'at_dest_hub', 'out_for_delivery', 'delivered',
];
const TASK_FLOW = ['pending', 'accepted', 'picked_up', 'out_for_delivery', 'delivered'];
const TRIP_FLOW = [
  'assigned', 'loading', 'departed', 'at_checkpoint',
  'arrived_dest', 'unloading', 'completed',
];
const SCAN_EVENT_OPTIONS = [
  'registered', 'sorted', 'dispatched', 'arrived',
  'picked_up', 'handed_to_driver', 'received_from_driver',
];

// Generic list page bound to one backend endpoint.
// Write hooks: headerAction (e.g. "＋ New" form toggle), refreshToken (parent
// bump to reload), rowActions (buttons rendered per row with busy states).
function ListPage({
  eyebrow, title, description, loader, columns, emptyText, keyField, search,
  headerAction, refreshToken = 0, rowActions,
}) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyKey, setBusyKey] = useState(null);
  const [tick, setTick] = useState(0);

  const reload = () => setTick((t) => t + 1);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    loader()
      .then((data) => {
        if (active) setRows(Array.isArray(data) ? data : []);
      })
      .catch((e) => {
        if (active) setError(`Failed to load: ${e.message}`);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, refreshToken]);

  const runRowAction = async (action, row) => {
    const label = typeof action.label === 'function' ? action.label(row) : action.label;
    const k = `${row[keyField] ?? row.id}:${label}`;
    setBusyKey(k);
    setError('');
    try {
      await action.run(row);
      reload();
    } catch (e) {
      setError(`${label} failed: ${e.message}`);
    } finally {
      setBusyKey(null);
    }
  };

  const q = (search ?? '').trim().toLowerCase();
  const visible = q
    ? rows.filter((r) =>
        Object.values(r).some((v) => {
          if (v == null || typeof v === 'object') return false;
          return String(v).toLowerCase().includes(q);
        })
      )
    : rows;

  const allColumns = rowActions?.length
    ? [
        ...columns,
        {
          key: '__actions',
          label: 'Actions',
          render: (r) => (
            <div className="flex flex-wrap items-center gap-1.5">
              {rowActions.map((a) => {
                if (a.when && !a.when(r)) return null;
                const label = typeof a.label === 'function' ? a.label(r) : a.label;
                const k = `${r[keyField] ?? r.id}:${label}`;
                const busy = busyKey === k;
                return (
                  <button
                    key={label}
                    type="button"
                    disabled={busy}
                    onClick={() => runRowAction(a, r)}
                    className={BTN_SM}
                  >
                    {busy ? '…' : label}
                  </button>
                );
              })}
            </div>
          ),
        },
      ]
    : columns;

  return (
    <div className="mt-5 rounded-lg border border-line bg-surface pb-5">
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      <div className="px-6 pt-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] text-slate2">
            {loading ? 'Loading…' : `${visible.length} of ${rows.length} records`}
            {!loading && q ? ` matching “${q}”` : ''}
          </p>
          {headerAction}
        </div>
        <DataTable
          columns={allColumns}
          rows={visible}
          keyField={keyField}
          loading={loading}
          error={error}
          emptyText={emptyText}
        />
      </div>
    </div>
  );
}

export function ItemsPage({ search }) {
  return (
    <ListPage
      eyebrow="Warehouse"
      title="Items and inventory"
      description="Stock levels across warehouses, with reorder alerts."
      loader={api.listInventory}
      search={search}
      keyField="sku"
      emptyText="No inventory records."
      columns={[
        { key: 'sku', label: 'SKU', render: (r) => <span className="font-semibold text-ink">{r.sku}</span> },
        { key: 'description', label: 'Description' },
        { key: 'quantity', label: 'Quantity', render: (r) => <span className="tnum font-semibold text-ink">{r.quantity}</span> },
        { key: 'reorder_level', label: 'Reorder level' },
        {
          key: 'warehouse',
          label: 'Warehouse',
          render: (r) => (r.warehouses ? `${r.warehouses.code} · ${r.warehouses.name}` : '—'),
        },
        {
          key: 'status',
          label: 'Status',
          render: (r) =>
            Number(r.quantity) <= Number(r.reorder_level) ? (
              <Badge tone="neutral">Reorder</Badge>
            ) : (
              <Badge tone="positive">In stock</Badge>
            ),
        },
      ]}
    />
  );
}

export function VehiclesPage({ search }) {
  return (
    <ListPage
      eyebrow="Fleet"
      title="Vehicles"
      description="Registered vehicles and their capacity."
      loader={api.listVehicles}
      search={search}
      emptyText="No vehicles registered."
      columns={[
        { key: 'registration', label: 'Registration', render: (r) => <span className="font-semibold text-ink">{r.registration}</span> },
        { key: 'type', label: 'Type', render: (r) => <Badge>{r.type}</Badge> },
        { key: 'capacity_kg', label: 'Capacity (kg)', render: (r) => <span className="tnum">{r.capacity_kg ?? '—'}</span> },
        {
          key: 'warehouse',
          label: 'Warehouse',
          render: (r) => (r.warehouse_id ? String(r.warehouse_id).slice(0, 8) : '—'),
        },
      ]}
    />
  );
}

export function WarehousesPage({ search }) {
  return (
    <ListPage
      eyebrow="Network"
      title="Warehouses"
      description="Hubs where stock is stored and orders are dispatched."
      loader={api.listWarehouses}
      search={search}
      emptyText="No warehouses configured."
      columns={[
        { key: 'code', label: 'Code', render: (r) => <span className="font-semibold text-ink">{r.code}</span> },
        { key: 'name', label: 'Name' },
        { key: 'city', label: 'City' },
        { key: 'postal_code', label: 'Postal code' },
        { key: 'address', label: 'Address' },
      ]}
    />
  );
}


export function PackagesPage({ search }) {
  return (
    <ListPage
      eyebrow="Shipments"
      title="Packages"
      description="Parcels with proof-of-delivery state."
      loader={api.listPackages}
      search={search}
      emptyText="No packages yet. They appear when orders define them."
      columns={[
        {
          key: 'tracking_code',
          label: 'Tracking',
          render: (r) => <span className="font-semibold text-ink">{r.tracking_code ?? '—'}</span>,
        },
        {
          key: 'order',
          label: 'Order',
          render: (r) => (r.orders ? r.orders.order_number : '—'),
        },
        { key: 'weight_kg', label: 'Weight (kg)', render: (r) => <span className="tnum">{r.weight_kg ?? '—'}</span> },
        {
          key: 'size',
          label: 'Size (cm)',
          render: (r) => [r.length_cm, r.width_cm, r.height_cm].filter(Boolean).join(' × ') || '—',
        },
        {
          key: 'pod',
          label: 'Proof of delivery',
          render: (r) =>
            r.pod_photo_url ? (
              <Badge tone="positive">Signed {fmtDate(r.pod_signed_at)}</Badge>
            ) : (
              <Badge>Awaiting</Badge>
            ),
        },
      ]}
    />
  );
}

export function PaymentsPage({ search }) {
  return (
    <ListPage
      eyebrow="Finance"
      title="Payments"
      description="Payment records linked to orders."
      loader={api.listPayments}
      search={search}
      emptyText="No payments recorded yet."
      columns={[
        {
          key: 'order',
          label: 'Order',
          render: (r) => <span className="font-semibold text-ink">{r.orders?.order_number ?? '—'}</span>,
        },
        {
          key: 'amount',
          label: 'Amount',
          render: (r) => (
            <span className="tnum font-semibold text-ink">{fmtMoney(r.amount, r.currency)}</span>
          ),
        },
        { key: 'method', label: 'Method', render: (r) => <Badge>{r.method}</Badge> },
        {
          key: 'status',
          label: 'Status',
          render: (r) =>
            r.status === 'paid' ? (
              <Badge tone="positive">Paid</Badge>
            ) : (
              <Badge>{r.status ?? 'pending'}</Badge>
            ),
        },
        { key: 'paid_at', label: 'Paid at', render: (r) => fmtDate(r.paid_at) },
      ]}
    />
  );
}

export function DriversPage({ search }) {
  return (
    <ListPage
      eyebrow="Dispatch"
      title="Drivers"
      description="Driver roster with availability and last known location."
      loader={api.listDrivers}
      search={search}
      emptyText="No drivers registered."
      columns={[
        { key: 'name', label: 'Name', render: (r) => <span className="font-semibold text-ink">{r.name}</span> },
        { key: 'phone', label: 'Phone' },
        {
          key: 'is_available',
          label: 'Availability',
          render: (r) =>
            r.is_available ? <Badge tone="positive">Available</Badge> : <Badge tone="neutral">Busy</Badge>,
        },
        { key: 'license_number', label: 'License' },
        {
          key: 'location',
          label: 'Last location',
          render: (r) =>
            r.current_latitude != null && r.current_longitude != null
              ? `${Number(r.current_latitude).toFixed(4)}, ${Number(r.current_longitude).toFixed(4)}`
              : '—',
        },
        { key: 'last_seen_at', label: 'Last seen', render: (r) => fmtDate(r.last_seen_at) },
      ]}
    />
  );
}

// ---- Phase 2: parcel lifecycle (4 independent status tracks) ----
export function ShipmentsPage({ search }) {
  const [showForm, setShowForm] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [scanSel, setScanSel] = useState({});
  const [form, setForm] = useState({
    recipient_name: '',
    recipient_phone: '',
    destination_address: '',
    weight_kg: '',
    declared_value: '',
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      await api.createShipment({
        recipient_name: form.recipient_name || undefined,
        recipient_phone: form.recipient_phone || undefined,
        destination_address: form.destination_address,
        weight_kg: Number(form.weight_kg || 0),
        declared_value: Number(form.declared_value || 0),
      });
      setForm({
        recipient_name: '', recipient_phone: '',
        destination_address: '', weight_kg: '', declared_value: '',
      });
      setShowForm(false);
      setRefreshToken((t) => t + 1);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const headerAction = (
    <div className="flex flex-col items-end gap-2">
      <button
        type="button"
        className={BTN}
        onClick={() => setShowForm((v) => !v)}
      >
        {showForm ? 'Close' : '＋ Register parcel'}
      </button>
      {showForm && (
        <form
          onSubmit={submit}
          className="grid w-[520px] max-w-full grid-cols-2 gap-2 rounded-md border border-line bg-cream p-3"
        >
          <input className={FIELD} placeholder="Recipient name" value={form.recipient_name} onChange={set('recipient_name')} />
          <input className={FIELD} placeholder="Recipient phone" value={form.recipient_phone} onChange={set('recipient_phone')} />
          <input
            className={`${FIELD} col-span-2`}
            placeholder="Destination address *"
            value={form.destination_address}
            onChange={set('destination_address')}
            required
          />
          <input className={FIELD} placeholder="Weight (kg)" type="number" step="0.1" value={form.weight_kg} onChange={set('weight_kg')} />
          <input className={FIELD} placeholder="Declared value" type="number" value={form.declared_value} onChange={set('declared_value')} />
          {formError && (
            <p className="col-span-2 text-[12px] font-medium text-red-600">{formError}</p>
          )}
          <div className="col-span-2 flex justify-end">
            <button type="submit" disabled={busy} className={BTN}>
              {busy ? 'Saving…' : 'Register'}
            </button>
          </div>
        </form>
      )}
    </div>
  );

  const rowActions = [
    {
      label: 'Advance',
      when: (r) => nextOf(PARCEL_FLOW, r.parcel_status) != null,
      run: (r) =>
        api.updateShipmentStatus(r.id, nextOf(PARCEL_FLOW, r.parcel_status)),
    },
    {
      label: 'Scan',
      run: (r) => api.scanShipment(r.id, scanSel[r.id] ?? 'sorted'),
    },
  ];

  return (
    <ListPage
      eyebrow="Logistics"
      title="Parcels"
      description="Registered shipments across the 4 status tracks — warehouse, driver task, trip, settlement."
      loader={() => api.listShipments()}
      keyField="tracking_code"
      emptyText="No parcels registered yet — use “Register parcel” above."
      search={search}
      headerAction={headerAction}
      refreshToken={refreshToken}
      rowActions={rowActions}
      columns={[
        {
          key: 'tracking_code',
          label: 'Tracking',
          render: (r) => (
            <span className="font-mono text-[12px] font-semibold text-ink">{r.tracking_code}</span>
          ),
        },
        {
          key: 'parcel_status',
          label: 'Status',
          render: (r) => <Badge tone="neutral">{String(r.parcel_status || 'registered')}</Badge>,
        },
        { key: 'recipient_name', label: 'Recipient' },
        { key: 'destination_address', label: 'Destination' },
        {
          key: 'weight_kg',
          label: 'Weight',
          render: (r) => (r.weight_kg ? `${Number(r.weight_kg)} kg` : '—'),
        },
        { key: 'created_at', label: 'Registered', render: (r) => fmtDate(r.created_at) },
        {
          key: '__scan',
          label: 'Scan as',
          render: (r) => (
            <select
              className="h-7 rounded-md border border-line bg-surface px-1.5 text-[12px] text-ink"
              value={scanSel[r.id] ?? 'sorted'}
              onChange={(e) => setScanSel((s) => ({ ...s, [r.id]: e.target.value }))}
            >
              {SCAN_EVENT_OPTIONS.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ),
        },
      ]}
    />
  );
}

export function TripsPage({ search }) {
  const [showForm, setShowForm] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [drivers, setDrivers] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [form, setForm] = useState({
    big_driver_id: '',
    origin_warehouse_id: '',
    dest_warehouse_id: '',
  });

  useEffect(() => {
    if (!showForm) return;
    let alive = true;
    Promise.all([api.listDrivers(), api.listWarehouses()])
      .then(([d, w]) => {
        if (!alive) return;
        setDrivers((d || []).filter((x) => x.driver_type === 'big'));
        setWarehouses(w || []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      await api.createTrip({
        big_driver_id: form.big_driver_id,
        origin_warehouse_id: form.origin_warehouse_id || null,
        dest_warehouse_id: form.dest_warehouse_id || null,
      });
      setForm({ big_driver_id: '', origin_warehouse_id: '', dest_warehouse_id: '' });
      setShowForm(false);
      setRefreshToken((t) => t + 1);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const headerAction = (
    <div className="flex flex-col items-end gap-2">
      <button type="button" className={BTN} onClick={() => setShowForm((v) => !v)}>
        {showForm ? 'Close' : '＋ New trip'}
      </button>
      {showForm && (
        <form
          onSubmit={submit}
          className="grid w-[480px] max-w-full grid-cols-2 gap-2 rounded-md border border-line bg-cream p-3"
        >
          <select
            className={`${FIELD} col-span-2`}
            value={form.big_driver_id}
            onChange={set('big_driver_id')}
            required
          >
            <option value="">Big driver…</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
            {!drivers.length && <option value="" disabled>No big drivers yet</option>}
          </select>
          <select className={FIELD} value={form.origin_warehouse_id} onChange={set('origin_warehouse_id')}>
            <option value="">Origin hub…</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name || w.id}
              </option>
            ))}
          </select>
          <select className={FIELD} value={form.dest_warehouse_id} onChange={set('dest_warehouse_id')}>
            <option value="">Destination hub…</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name || w.id}
              </option>
            ))}
          </select>
          {formError && (
            <p className="col-span-2 text-[12px] font-medium text-red-600">{formError}</p>
          )}
          <div className="col-span-2 flex justify-end">
            <button type="submit" disabled={busy || !form.big_driver_id} className={BTN}>
              {busy ? 'Creating…' : 'Create trip'}
            </button>
          </div>
        </form>
      )}
    </div>
  );

  const rowActions = [
    {
      label: 'Advance',
      when: (r) => nextOf(TRIP_FLOW, r.status) != null,
      run: (r) => api.advanceTrip(r.id, nextOf(TRIP_FLOW, r.status)),
    },
  ];

  return (
    <ListPage
      eyebrow="Long haul"
      title="Big-driver trips"
      description="Inter-warehouse journeys with manifests, checkpoints and big drivers only."
      loader={() => api.listTrips()}
      keyField="id"
      emptyText="No trips yet — use “New trip” to assign a big driver."
      search={search}
      headerAction={headerAction}
      refreshToken={refreshToken}
      rowActions={rowActions}
      columns={[
        {
          key: 'id',
          label: 'Trip',
          render: (r) => <span className="font-mono text-[12px]">{String(r.id).slice(0, 8)}</span>,
        },
        {
          key: 'big_driver_id',
          label: 'Big driver',
          render: (r) => (
            <span className="font-mono text-[12px]">{String(r.big_driver_id || '').slice(0, 8)}</span>
          ),
        },
        {
          key: 'status',
          label: 'Status',
          render: (r) => <Badge tone="neutral">{String(r.status || 'assigned')}</Badge>,
        },
        { key: 'departed_at', label: 'Departed', render: (r) => fmtDate(r.departed_at) },
        { key: 'arrived_at', label: 'Arrived', render: (r) => fmtDate(r.arrived_at) },
      ]}
    />
  );
}

export function DriverTasksPage({ search }) {
  const [showForm, setShowForm] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [shipments, setShipments] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [form, setForm] = useState({
    shipment_id: '',
    driver_id: '',
    task_type: 'delivery',
    cod_required: false,
    cod_amount: '',
  });

  useEffect(() => {
    if (!showForm) return;
    let alive = true;
    Promise.all([api.listShipments(), api.listDrivers()])
      .then(([s, d]) => {
        if (!alive) return;
        setShipments(s || []);
        // Micro drivers only — big drivers work from trips, not tasks.
        setDrivers((d || []).filter((x) => x.driver_type !== 'big'));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showForm]);

  const set = (k) => (e) =>
    setForm((f) => ({
      ...f,
      [k]: k === 'cod_required' ? e.target.checked : e.target.value,
    }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      await api.createTask(
        form.shipment_id,
        form.driver_id,
        form.task_type,
        form.cod_required,
        Number(form.cod_amount || 0),
      );
      setForm({
        shipment_id: '', driver_id: '',
        task_type: 'delivery', cod_required: false, cod_amount: '',
      });
      setShowForm(false);
      setRefreshToken((t) => t + 1);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const headerAction = (
    <div className="flex flex-col items-end gap-2">
      <button type="button" className={BTN} onClick={() => setShowForm((v) => !v)}>
        {showForm ? 'Close' : '＋ Assign task'}
      </button>
      {showForm && (
        <form
          onSubmit={submit}
          className="grid w-[520px] max-w-full grid-cols-2 gap-2 rounded-md border border-line bg-cream p-3"
        >
          <select
            className={`${FIELD} col-span-2`}
            value={form.shipment_id}
            onChange={set('shipment_id')}
            required
          >
            <option value="">Parcel…</option>
            {shipments.map((s) => (
              <option key={s.id} value={s.id}>
                {s.tracking_code} — {s.recipient_name || s.destination_address}
              </option>
            ))}
          </select>
          <select
            className={FIELD}
            value={form.driver_id}
            onChange={set('driver_id')}
            required
          >
            <option value="">Micro driver…</option>
            {drivers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <select className={FIELD} value={form.task_type} onChange={set('task_type')}>
            <option value="delivery">delivery</option>
            <option value="pickup">pickup</option>
          </select>
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={form.cod_required}
              onChange={set('cod_required')}
            />
            COD required
          </label>
          <input
            className={FIELD}
            placeholder="COD amount"
            type="number"
            value={form.cod_amount}
            onChange={set('cod_amount')}
            disabled={!form.cod_required}
          />
          {formError && (
            <p className="col-span-2 text-[12px] font-medium text-red-600">{formError}</p>
          )}
          <div className="col-span-2 flex justify-end">
            <button
              type="submit"
              disabled={busy || !form.shipment_id || !form.driver_id}
              className={BTN}
            >
              {busy ? 'Assigning…' : 'Assign'}
            </button>
          </div>
        </form>
      )}
    </div>
  );

  const rowActions = [
    {
      label: 'Advance',
      when: (r) => nextOf(TASK_FLOW, r.status) != null,
      run: (r) => api.updateTaskStatus(r.id, nextOf(TASK_FLOW, r.status)),
    },
  ];

  return (
    <ListPage
      eyebrow="Micro drivers"
      title="Driver tasks"
      description="Pickup / delivery tasks with COD collection status."
      loader={() => api.listDriverTasks()}
      keyField="id"
      emptyText="No driver tasks yet — use “Assign task” above."
      search={search}
      headerAction={headerAction}
      refreshToken={refreshToken}
      rowActions={rowActions}
      columns={[
        {
          key: 'task_type',
          label: 'Type',
          render: (r) => <Badge tone="neutral">{String(r.task_type)}</Badge>,
        },
        {
          key: 'status',
          label: 'Status',
          render: (r) => <Badge tone="neutral">{String(r.status)}</Badge>,
        },
        {
          key: 'driver_id',
          label: 'Driver',
          render: (r) => (
            <span className="font-mono text-[12px]">{String(r.driver_id || '').slice(0, 8)}</span>
          ),
        },
        {
          key: 'cod_required',
          label: 'COD',
          render: (r) =>
            r.cod_required ? <Badge tone="positive">{fmtMoney(r.cod_amount)}</Badge> : '—',
        },
        { key: 'created_at', label: 'Created', render: (r) => fmtDate(r.created_at) },
      ]}
    />
  );
}

export function VendorsPage({ search }) {
  const [showForm, setShowForm] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({
    name: '',
    contact_name: '',
    email: '',
    phone: '',
    city: '',
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const openCreate = () => {
    setEditingId(null);
    setForm({ name: '', contact_name: '', email: '', phone: '', city: '' });
    setFormError('');
    setShowForm(true);
  };

  const openEdit = (r) => {
    setEditingId(r.id);
    setForm({
      name: r.name ?? '',
      contact_name: r.contact_name ?? '',
      email: r.email ?? '',
      phone: r.phone ?? '',
      city: r.city ?? '',
    });
    setFormError('');
    setShowForm(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      const payload = { ...form, country: 'NP' };
      if (editingId) {
        await api.updateVendor(editingId, payload);
      } else {
        await api.createVendor(payload);
      }
      setShowForm(false);
      setRefreshToken((t) => t + 1);
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const headerAction = (
    <div className="flex flex-col items-end gap-2">
      <button type="button" className={BTN} onClick={() => (showForm ? setShowForm(false) : openCreate())}>
        {showForm ? 'Close' : '＋ Add vendor'}
      </button>
      {showForm && (
        <form
          onSubmit={submit}
          className="grid w-[520px] max-w-full grid-cols-2 gap-2 rounded-md border border-line bg-cream p-3"
        >
          <input className={FIELD} placeholder="Vendor name *" value={form.name} onChange={set('name')} required />
          <input className={FIELD} placeholder="Contact person" value={form.contact_name} onChange={set('contact_name')} />
          <input className={FIELD} placeholder="Email" type="email" value={form.email} onChange={set('email')} />
          <input className={FIELD} placeholder="Phone" value={form.phone} onChange={set('phone')} />
          <input className={`${FIELD} col-span-2`} placeholder="City" value={form.city} onChange={set('city')} />
          {formError && (
            <p className="col-span-2 text-[12px] font-medium text-red-600">{formError}</p>
          )}
          <div className="col-span-2 flex justify-end">
            <button type="submit" disabled={busy || !form.name} className={BTN}>
              {busy ? 'Saving…' : editingId ? 'Save changes' : 'Create vendor'}
            </button>
          </div>
        </form>
      )}
    </div>
  );

  const rowActions = [
    { label: 'Edit', run: async (r) => openEdit(r) },
    {
      label: (r) => (r.is_active ? 'Deactivate' : 'Activate'),
      run: (r) => api.updateVendor(r.id, { is_active: !r.is_active }),
    },
  ];

  return (
    <ListPage
      eyebrow="Business"
      title="Vendors"
      description="Business-vendor accounts (B2B shops) — they register parcels against orders."
      loader={() => api.listVendors()}
      keyField="id"
      emptyText="No vendors registered yet — use “Add vendor” above."
      search={search}
      headerAction={headerAction}
      refreshToken={refreshToken}
      rowActions={rowActions}
      columns={[
        {
          key: 'name',
          label: 'Vendor',
          render: (r) => <span className="font-semibold text-ink">{r.name}</span>,
        },
        { key: 'contact_name', label: 'Contact' },
        { key: 'email', label: 'Email' },
        { key: 'phone', label: 'Phone' },
        { key: 'city', label: 'City' },
        {
          key: 'is_active',
          label: 'Status',
          render: (r) =>
            r.is_active ? <Badge tone="positive">Active</Badge> : <Badge tone="neutral">Inactive</Badge>,
        },
      ]}
    />
  );
}

