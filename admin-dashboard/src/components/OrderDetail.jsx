import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import OrderMap from './OrderMap';
import { Badge } from './DataTable';

function fmt(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString(undefined, {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return String(v);
  }
}

function Field({ label, value }) {
  return (
    <div>
      <span className="block text-[10px] uppercase tracking-wide text-faint">{label}</span>
      <span className="text-ink">{value || '—'}</span>
    </div>
  );
}

function StageBar({ stage }) {
  const steps = ['Approved', 'Intake', 'Dispatch', 'In transit', 'Last-mile', 'Delivered'];
  const key = (stage || '').toLowerCase();
  let idx = 0;
  if (key.includes('approval')) idx = -1;
  else if (key.includes('intake')) idx = 1;
  else if (key.includes('origin warehouse')) idx = 2;
  else if (key.includes('transit')) idx = 3;
  else if (key.includes('last-mile') || key.includes('destination warehouse')) idx = 4;
  else if (key.includes('delivered')) idx = 5;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {steps.map((s, i) => (
        <span
          key={s}
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
            idx < 0 ? 'bg-cream text-slate2'
            : i < idx ? 'bg-brand/10 text-brand'
            : i === idx ? 'bg-brand text-white'
            : 'bg-cream text-slate2'}`}
        >
          {s}
        </span>
      ))}
    </div>
  );
}

/**
 * Full order details: per-order interactive map, multi-stage journey,
 * timestamped tracking history, and workflow actions.
 */
export default function OrderDetail({ order, onChanged, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!order?.id) return;
    setLoading(true);
    setErr('');
    try {
      setDetail(await api.getOrderDetail(order.id));
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [order?.id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!order) return null;
  const o = detail?.order || order;
  const shipment = detail?.shipment;
  const approval = o.approval_status || 'approved';

  async function act(fn) {
    setBusy(true);
    setErr('');
    try {
      await fn();
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Order</p>
          <h3 className="text-[17px] font-bold text-ink">{o.order_number}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone={approval === 'pending' ? 'neutral' : 'positive'}>
              {approval === 'pending' ? 'Pending approval' : approval}
            </Badge>
            <Badge tone="neutral">{detail?.stage || o.status}</Badge>
            {detail?.route_kind && (
              <Badge tone="neutral">
                {detail.route_kind === 'last_mile' ? 'Last-mile' : 'Inter-warehouse'}
              </Badge>
            )}
          </div>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-md border border-line text-slate2 hover:bg-cream"
          >
            ×
          </button>
        )}
      </div>

      <div className="space-y-4 px-5 py-4">
        {err && <p className="text-[13px] font-medium text-red-600">{err}</p>}
        {loading ? (
          <p className="text-[13px] text-slate2">Loading order…</p>
        ) : (
          <>
            <OrderMap
              waypoints={detail?.waypoints || []}
              vehiclePosition={detail?.vehicle_position || null}
            />

            {detail?.route_reason && (
              <div className="rounded-md border border-line bg-cream px-3 py-2 text-[12px] text-slate2">
                <b className="text-ink">Route:</b> {detail.route_reason}
              </div>
            )}

            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
                Journey
              </p>
              <StageBar stage={detail?.stage} />
              <div className="mt-2 grid grid-cols-2 gap-2 text-[12px]">
                <Field label="Origin" value={detail?.waypoints?.find((w) => w.role === 'origin')?.name} />
                <Field label="Destination hub" value={detail?.waypoints?.find((w) => w.role === 'destination')?.name} />
                <Field label="Dispatched" value={fmt(detail?.trip?.departed_at)} />
                <Field label="ETA / arrived" value={fmt(detail?.trip?.estimated_arrival || detail?.trip?.arrived_at)} />
                <Field label="Final delivery" value={o.delivery_address} />
                <Field label="Vehicle" value={detail?.vehicle?.registration || (detail?.route_kind === 'last_mile' ? 'Micro driver' : '—')} />
                <Field label="Payment" value={`${o.payment_method || 'cod'} · ${o.payment_status || 'unpaid'}`} />
                <Field label="Recipient" value={`${o.recipient_name || '—'} ${o.recipient_phone || ''}`} />
              </div>
            </div>

            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
                Tracking history
              </p>
              {(detail?.timeline || []).length ? (
                <ul className="space-y-1.5">
                  {detail.timeline.map((t, i) => (
                    <li key={i} className="flex items-start gap-2 text-[12px]">
                      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />
                      <span className="text-ink font-medium">{t.event}</span>
                      <span className="text-slate2">{t.note}</span>
                      <span className="ml-auto shrink-0 text-faint">{fmt(t.at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-slate2">No events yet.</p>
              )}
            </div>

            <WorkflowActions order={o} shipment={shipment} detail={detail} busy={busy} act={act} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Context-sensitive workflow controls: approve/reject (pending), warehouse
 * intake (approved, no shipment), dispatch + payment (intaken).
 */
function WorkflowActions({ order, shipment, detail, busy, act }) {
  const [intakeOpen, setIntakeOpen] = useState(false);
  const approval = order.approval_status || 'approved';

  // 1) Pending approval → admin approve/reject.
  if (approval === 'pending') {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-cream p-3">
        <span className="text-[13px] text-slate2">Awaiting admin approval.</span>
        <button
          disabled={busy}
          onClick={() => act(() => api.approveOrder(order.id, 'approved'))}
          className="h-9 rounded-md bg-brand px-4 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          disabled={busy}
          onClick={() => act(() => api.approveOrder(order.id, 'rejected'))}
          className="h-9 rounded-md border border-line px-4 text-[13px] font-semibold text-slate2 hover:bg-cream disabled:opacity-50"
        >
          Reject
        </button>
      </div>
    );
  }

  // 2) Approved but not yet intaken → warehouse intake form.
  if (!shipment) {
    return intakeOpen ? (
      <IntakeForm order={order} busy={busy} act={act} onClose={() => setIntakeOpen(false)} />
    ) : (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-line bg-cream p-3">
        <span className="text-[13px] text-slate2">
          Approved — record warehouse intake to verify the parcel.
        </span>
        <button
          disabled={busy}
          onClick={() => setIntakeOpen(true)}
          className="h-9 rounded-md bg-brand px-4 text-[13px] font-semibold text-white hover:brightness-110 disabled:opacity-50"
        >
          Receive parcel
        </button>
      </div>
    );
  }

  // 3) Intaken → dispatch + payment controls.
  return <DispatchAndPayment order={order} shipment={shipment} detail={detail} busy={busy} act={act} />;
}

const FIELD =
  'h-10 w-full border border-line bg-surface px-3 text-sm text-ink focus:border-ink';

function IntakeForm({ order, busy, act, onClose }) {
  const [f, setF] = useState({
    weight_kg: '', parcel_type: 'package', quantity: '1',
    length_cm: '', width_cm: '', height_cm: '',
    handling_requirements: '', destination_district: order.destination_district || '',
    origin_district: order.origin_district || '',
    declared_value: String(order.total_amount || ''), payment_method: order.payment_method || 'cod',
    sender_name: order.sender_name || '', sender_phone: order.sender_phone || '',
  });
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = (e) => {
    e.preventDefault();
    act(() =>
      api.intakeOrder(order.id, {
        ...f,
        weight_kg: Number(f.weight_kg || 0),
        quantity: Number(f.quantity || 1),
        length_cm: f.length_cm ? Number(f.length_cm) : null,
        width_cm: f.width_cm ? Number(f.width_cm) : null,
        height_cm: f.height_cm ? Number(f.height_cm) : null,
        declared_value: Number(f.declared_value || 0),
        destination_address: order.delivery_address,
      }),
    ).then(() => onClose());
  };

  return (
    <form onSubmit={submit} className="grid grid-cols-2 gap-2 rounded-md border border-line bg-cream p-3">
      <input className={FIELD} placeholder="Weight (kg) *" value={f.weight_kg} onChange={set('weight_kg')} required />
      <select className={FIELD} value={f.parcel_type} onChange={set('parcel_type')}>
        {['package', 'document', 'fragile', 'perishable', 'liquid', 'other'].map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
      <input className={FIELD} placeholder="Quantity" type="number" value={f.quantity} onChange={set('quantity')} />
      <input className={FIELD} placeholder="Declared value" type="number" value={f.declared_value} onChange={set('declared_value')} />
      <input className={FIELD} placeholder="Length (cm)" type="number" value={f.length_cm} onChange={set('length_cm')} />
      <input className={FIELD} placeholder="Width (cm)" type="number" value={f.width_cm} onChange={set('width_cm')} />
      <input className={FIELD} placeholder="Height (cm)" type="number" value={f.height_cm} onChange={set('height_cm')} />
      <select className={FIELD} value={f.payment_method} onChange={set('payment_method')}>
        <option value="cod">COD</option>
        <option value="online">Paid online</option>
        <option value="advance">Paid in advance</option>
      </select>
      <input className={FIELD} placeholder="Origin district" value={f.origin_district} onChange={set('origin_district')} />
      <input className={FIELD} placeholder="Destination district *" value={f.destination_district} onChange={set('destination_district')} required />
      <input className={FIELD} placeholder="Sender name" value={f.sender_name} onChange={set('sender_name')} />
      <input className={FIELD} placeholder="Sender phone" value={f.sender_phone} onChange={set('sender_phone')} />
      <input className={`${FIELD} col-span-2`} placeholder="Handling requirements" value={f.handling_requirements} onChange={set('handling_requirements')} />
      <div className="col-span-2 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="h-9 rounded-md border border-line px-4 text-[13px] font-semibold text-slate2">Cancel</button>
        <button type="submit" disabled={busy} className="h-9 rounded-md bg-brand px-4 text-[13px] font-semibold text-white disabled:opacity-50">
          {busy ? 'Saving…' : 'Save verified details'}
        </button>
      </div>
    </form>
  );
}

function DispatchAndPayment({ order, shipment, detail, busy, act }) {
  const [drivers, setDrivers] = useState([]);
  const [vehicles, setVehicles] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [sel, setSel] = useState({
    driver_id: '',
    vehicle_id: '',
    dest_warehouse_id: shipment?.dest_warehouse_id || '',
  });
  const [pay, setPay] = useState({
    payment_status: order.payment_status || 'unpaid',
    payment_method: order.payment_method || 'cod',
  });

  useEffect(() => {
    let alive = true;
    Promise.all([api.listDrivers(), api.vehicleFleet(), api.listWarehouses()])
      .then(([d, v, w]) => {
        if (!alive) return;
        setDrivers((d || []).filter((x) => x.driver_type !== 'big'));
        setVehicles(v || []);
        setWarehouses(w || []);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const routeKind = detail?.route_kind || 'inter_warehouse';
  const alreadyDispatched = ['out_for_delivery', 'in_transit', 'delivered'].includes(shipment.parcel_status);

  const doDispatch = () => {
    if (routeKind === 'last_mile') {
      return act(() =>
        api.dispatchShipment({
          shipment_id: shipment.id, mode: 'last_mile', driver_id: sel.driver_id,
          cod_required: shipment.payment_method === 'cod',
          cod_amount: shipment.declared_value || 0,
        }),
      );
    }
    return act(() =>
      api.dispatchShipment({
        shipment_id: shipment.id, mode: 'inter_warehouse',
        vehicle_id: sel.vehicle_id,
        origin_warehouse_id: shipment.origin_warehouse_id,
        dest_warehouse_id: sel.dest_warehouse_id || shipment.dest_warehouse_id,
      }),
    );
  };

  return (
    <div className="space-y-3">
      {!alreadyDispatched ? (
        <div className="rounded-md border border-line bg-cream p-3">
          <p className="mb-2 text-[13px] font-semibold text-ink">
            Dispatch — {routeKind === 'last_mile' ? 'same district → micro driver' : 'different district → vehicle + warehouse transfer'}
          </p>
          {routeKind === 'last_mile' ? (
            <div className="flex flex-wrap items-center gap-2">
              <select
                className={`${FIELD} max-w-[240px]`}
                value={sel.driver_id}
                onChange={(e) => setSel((s) => ({ ...s, driver_id: e.target.value }))}
              >
                <option value="">Micro driver…</option>
                {drivers.map((d) => (<option key={d.id} value={d.id}>{d.name}</option>))}
              </select>
              <button
                disabled={busy || !sel.driver_id}
                onClick={doDispatch}
                className="h-9 rounded-md bg-brand px-4 text-[13px] font-semibold text-white disabled:opacity-50"
              >
                Assign driver
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select
                className={`${FIELD} max-w-[180px]`}
                value={sel.vehicle_id}
                onChange={(e) => setSel((s) => ({ ...s, vehicle_id: e.target.value }))}
              >
                <option value="">Vehicle…</option>
                {vehicles.map((v) => (<option key={v.id} value={v.id}>{v.registration} ({v.type})</option>))}
              </select>
              <select
                className={`${FIELD} max-w-[200px]`}
                value={sel.dest_warehouse_id}
                onChange={(e) => setSel((s) => ({ ...s, dest_warehouse_id: e.target.value }))}
              >
                <option value="">Destination hub…</option>
                {warehouses.map((w) => (<option key={w.id} value={w.id}>{w.name}</option>))}
              </select>
              <button
                disabled={busy || !sel.vehicle_id}
                onClick={doDispatch}
                className="h-9 rounded-md bg-brand px-4 text-[13px] font-semibold text-white disabled:opacity-50"
              >
                Load + dispatch
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-md border border-line bg-cream px-3 py-2 text-[13px] text-slate2">
          Dispatched · <b className="text-ink">{shipment.parcel_status}</b>
        </div>
      )}

      {/* Payment — independent of delivery status */}
      <div className="rounded-md border border-line bg-cream p-3">
        <p className="mb-2 text-[13px] font-semibold text-ink">
          Payment <span className="font-normal text-slate2">(independent of delivery)</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={`${FIELD} max-w-[160px]`}
            value={pay.payment_method}
            onChange={(e) => setPay((s) => ({ ...s, payment_method: e.target.value }))}
          >
            <option value="cod">COD</option>
            <option value="online">Paid online</option>
            <option value="advance">Paid in advance</option>
          </select>
          <select
            className={`${FIELD} max-w-[160px]`}
            value={pay.payment_status}
            onChange={(e) => setPay((s) => ({ ...s, payment_status: e.target.value }))}
          >
            <option value="unpaid">Unpaid</option>
            <option value="pending">Pending</option>
            <option value="paid">Paid</option>
            <option value="refunded">Refunded</option>
          </select>
          <button
            disabled={busy}
            onClick={() => act(() => api.updatePayment(order.id, pay))}
            className="h-9 rounded-md border border-line px-4 text-[13px] font-semibold text-slate2 hover:bg-cream disabled:opacity-50"
          >
            Update payment
          </button>
        </div>
      </div>
    </div>
  );
}





