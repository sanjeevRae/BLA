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

function Row({ k, v }) {
  return (
    <div className="flex justify-between gap-3 py-1 text-[12px]">
      <span className="text-faint">{k}</span>
      <span className="text-ink text-right">{v || '—'}</span>
    </div>
  );
}

/** Dedicated vehicle details: live map, route progress, cargo, checkpoints. */
export default function VehicleDetail({ vehicle, onChanged, onClose }) {
  const [d, setD] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    if (!vehicle?.id) return;
    setLoading(true);
    setErr('');
    try {
      setD(await api.vehicleDetail(vehicle.id));
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [vehicle?.id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!vehicle) return null;
  const v = d?.vehicle || vehicle;
  const trip = d?.trip;

  const waypoints = [];
  if (d?.origin_warehouse?.latitude != null)
    waypoints.push({ role: 'origin', name: d.origin_warehouse.name, lng: d.origin_warehouse.longitude, lat: d.origin_warehouse.latitude, city: d.origin_warehouse.city });
  if (d?.dest_warehouse?.latitude != null)
    waypoints.push({ role: 'destination', name: d.dest_warehouse.name, lng: d.dest_warehouse.longitude, lat: d.dest_warehouse.latitude, city: d.dest_warehouse.city });

  const pct = d?.route_progress != null ? Math.round(d.route_progress * 100) : null;

  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Vehicle</p>
          <h3 className="text-[17px] font-bold text-ink">{v.registration}</h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{v.type}</Badge>
            <Badge tone={d?.trip_status === 'in_transit' ? 'positive' : 'neutral'}>{d?.trip_status || 'idle'}</Badge>
            {d?.driver && <Badge tone="neutral">{d.driver.name}</Badge>}
          </div>
        </div>
        {onClose && (
          <button onClick={onClose} className="h-8 w-8 rounded-md border border-line text-slate2 hover:bg-cream">×</button>
        )}
      </div>

      <div className="space-y-4 px-5 py-4">
        {err && <p className="text-[13px] font-medium text-red-600">{err}</p>}
        {loading ? (
          <p className="text-[13px] text-slate2">Loading vehicle…</p>
        ) : (
          <>
            <OrderMap waypoints={waypoints} vehiclePosition={d?.position || null} height={260} />

            <div>
              <div className="mb-1 flex items-center justify-between text-[12px]">
                <span className="text-faint">Route progress</span>
                <span className="text-ink font-semibold">{pct != null ? `${pct}%` : '—'}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-cream">
                <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct || 0}%` }} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-x-4">
              <Row k="Driver" v={d?.driver?.name} />
              <Row k="Status" v={d?.trip_status} />
              <Row k="From" v={d?.origin_warehouse?.name} />
              <Row k="To" v={d?.dest_warehouse?.name} />
              <Row k="Departed" v={fmt(trip?.departed_at)} />
              <Row k="ETA" v={fmt(trip?.estimated_arrival)} />
              <Row k="Parcels onboard" v={d?.shipments?.length ?? 0} />
              <Row k="Last ping" v={fmt(d?.position?.last_seen_at)} />
            </div>

            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
                Parcels loaded · {d?.shipments?.length || 0}
              </p>
              {(d?.shipments || []).length ? (
                <ul className="divide-y divide-line">
                  {d.shipments.map((s) => (
                    <li key={s.id} className="flex items-center justify-between py-1.5 text-[12px]">
                      <span className="font-mono text-ink">{s.tracking_code}</span>
                      <span className="truncate px-2 text-slate2">{s.recipient_name || s.destination_address}</span>
                      <Badge tone={s.loaded ? 'positive' : 'neutral'}>{s.loaded ? 'loaded' : 'pending'}</Badge>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-slate2">No parcels on board.</p>
              )}
            </div>

            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
                Loading records
              </p>
              {(d?.loading_records || []).length ? (
                <ul className="divide-y divide-line">
                  {d.loading_records.map((r, i) => (
                    <li key={i} className="py-1.5 text-[12px]">
                      <div className="flex items-center justify-between">
                        <span className="text-ink">
                          {r.from_warehouse?.name || '?'} → {r.to_warehouse?.name || '?'}
                        </span>
                        <Badge tone="neutral">{r.status}</Badge>
                      </div>
                      <div className="text-faint">
                        dispatched {fmt(r.dispatched_at)} · received {fmt(r.received_at)}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-slate2">No transfer records.</p>
              )}
            </div>

            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.1em] text-faint">
                Trip checkpoints
              </p>
              {(d?.checkpoints || []).length ? (
                <ul className="space-y-1">
                  {d.checkpoints.map((c) => (
                    <li key={c.id} className="flex items-center justify-between text-[12px]">
                      <span className="text-ink">{c.label}</span>
                      <span className="text-faint">{fmt(c.passed_at || c.created_at)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12px] text-slate2">No checkpoints passed yet.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

