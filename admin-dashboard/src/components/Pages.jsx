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

// Generic list page bound to one backend endpoint.
function ListPage({ eyebrow, title, description, loader, columns, emptyText, keyField, search }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
  }, []);

  const q = (search ?? '').trim().toLowerCase();
  const visible = q
    ? rows.filter((r) =>
        Object.values(r).some((v) => {
          if (v == null || typeof v === 'object') return false;
          return String(v).toLowerCase().includes(q);
        })
      )
    : rows;

  return (
    <div className="mt-5 rounded-lg border border-line bg-surface pb-5">
      <PageHeader eyebrow={eyebrow} title={title} description={description} />
      <div className="px-6 pt-4">
        <p className="mb-3 text-[13px] text-slate2">
          {loading ? 'Loading…' : `${visible.length} of ${rows.length} records`}
          {!loading && q ? ` matching “${q}”` : ''}
        </p>
        <DataTable
          columns={columns}
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
