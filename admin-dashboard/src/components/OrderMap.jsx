import React, { useEffect, useRef } from 'react';
import * as maptilersdk from '@maptiler/sdk';
import '@maptiler/sdk/dist/maptiler-sdk.css';

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_API_KEY;

const ROLE_COLOR = {
  origin: '#2563EB',      // blue — origin warehouse
  current: '#F59E0B',     // amber — current/intermediate warehouse
  destination: '#7C3AED',  // violet — destination warehouse
  delivery: '#16A34A',     // green — final delivery address
};

function pin(color, label) {
  const el = document.createElement('div');
  el.style.cssText =
    'width:16px;height:16px;border-radius:9999px;' +
    `background:${color};border:3px solid #fff;` +
    'box-shadow:0 0 0 2px rgba(15,23,42,.25);cursor:pointer;' +
    'display:flex;align-items:center;justify-content:center;' +
    'color:#fff;font-size:9px;font-weight:700';
  el.textContent = label;
  return el;
}

function vehiclePin() {
  const el = document.createElement('div');
  el.style.cssText =
    'width:22px;height:22px;border-radius:4px;background:#0F172A;' +
    'border:2px solid #fff;box-shadow:0 0 0 2px #2563EB;cursor:pointer;' +
    'display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px';
  el.textContent = '🚚';
  return el;
}

/**
 * Per-order (or per-vehicle) interactive map. Draws ONLY this record's
 * waypoints — not the shared fleet view — so each order shows its own
 * origin warehouse, current/intermediate hub, destination and delivery pin,
 * plus the assigned vehicle's live position while in transit.
 *
 * Props:
 *   waypoints      [{ role, name, lng, lat }]
 *   vehiclePosition { lat, lng, driver_name, trip_status } | null
 *   height         css height (default 320px)
 */
export default function OrderMap({ waypoints = [], vehiclePosition = null, height = 320 }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef([]);

  const points = (waypoints || []).filter((w) => w?.lat != null && w?.lng != null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    if (!MAPTILER_KEY) return;
    maptilersdk.config.apiKey = MAPTILER_KEY;
    const map = new maptilersdk.Map({
      container: containerRef.current,
      style: maptilersdk.MapStyle.STREETS,
      zoom: 11,
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current = [];
    };
  }, []);

  // (Re)draw markers whenever waypoints / vehicle position change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const draw = () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      const bounds = new maptilersdk.LngLatBounds();

      points.forEach((w, i) => {
        const label = { origin: 'O', current: 'C', destination: 'D', delivery: '✓' }[w.role] || '?';
        const color = ROLE_COLOR[w.role] || '#64748B';
        const m = new maptilersdk.Marker({ element: pin(color, label) })
          .setLngLat([w.lng, w.lat])
          .addTo(map);
        m.setPopup(
          new maptilersdk.Popup({ closeButton: false }).setHTML(
            `<div style="font-family:inherit;font-size:12px">` +
              `<b>${w.name || w.role}</b><br/>` +
              `<span style="color:#64748B">${w.role}${
                w.city ? ' · ' + w.city : ''
              }</span></div>`,
          ),
        );
        markersRef.current.push(m);
        bounds.extend([w.lng, w.lat]);
      });

      if (vehiclePosition?.lat != null) {
        const vm = new maptilersdk.Marker({ element: vehiclePin() })
          .setLngLat([vehiclePosition.lng, vehiclePosition.lat])
          .addTo(map);
        vm.setPopup(
          new maptilersdk.Popup({ closeButton: false }).setHTML(
            `<div style="font-family:inherit;font-size:12px">` +
              `<b>${vehiclePosition.driver_name || 'Vehicle'}</b><br/>` +
              `<span style="color:#64748B">${vehiclePosition.trip_status || 'in transit'}</span>` +
              `<br/><span style="color:#2563EB">updated ${vehiclePosition.last_seen_at
                ? new Date(vehiclePosition.last_seen_at).toLocaleTimeString()
                : '—'}</span></div>`,
          ),
        );
        markersRef.current.push(vm);
        bounds.extend([vehiclePosition.lng, vehiclePosition.lat]);
      }

      if (points.length || vehiclePosition) {
        if (bounds.isEmpty()) return;
        map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 700 });
      }
    };
    if (map.isStyleLoaded()) draw();
    else map.once('load', draw);
  }, [JSON.stringify(points), JSON.stringify(vehiclePosition)]);

  if (!MAPTILER_KEY) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-line bg-cream text-xs text-slate2"
        style={{ height }}
      >
        Set VITE_MAPTILER_API_KEY to enable the map.
      </div>
    );
  }

  return (
    <div className="relative overflow-hidden rounded-md border border-line" style={{ height }}>
      <div ref={containerRef} className="h-full w-full" />
      {/* Legend */}
      <div className="absolute bottom-2 left-2 flex flex-wrap gap-2 rounded-md border border-line bg-surface/95 px-2 py-1 text-[10px] text-slate2">
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: ROLE_COLOR.origin }} />Origin</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: ROLE_COLOR.current }} />Current hub</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: ROLE_COLOR.destination }} />Destination</span>
        <span><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: ROLE_COLOR.delivery }} />Delivery</span>
      </div>
    </div>
  );
}
