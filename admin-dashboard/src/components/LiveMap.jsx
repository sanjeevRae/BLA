import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as maptilersdk from '@maptiler/sdk';
import '@maptiler/sdk/dist/maptiler-sdk.css';
import { supabase } from '../lib/supabase';
import { api } from '../lib/api';

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_API_KEY;

const ROUTE_COLOR = '#2563EB';
const MARKER_ACTIVE = '#2563EB';
const MARKER_IDLE = '#94A3B8';

function markerStyle(available) {
  const color = available ? MARKER_ACTIVE : MARKER_IDLE;
  return (
    'width:14px;height:14px;border-radius:9999px;' +
    `background:${color};border:2px solid #fff;` +
    'box-shadow:0 0 0 1px rgba(15,23,42,.18);cursor:pointer'
  );
}


// Live map of drivers plus the selected order route.
//
// Modes:
//   default (Orders page): tall map, click a marker to select the driver,
//     show its trail and jump to the Drivers page.
//   compact (dashboard): mini live overview; the whole map click-through goes
//     to the Orders page. Set `interactive={false}` to render a static preview.
export default function LiveMap({ order, compact = false, interactive = true, onSelectDriver }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());
  const routeLoadedRef = useRef(false);
  const driversRef = useRef(new Map());
  const trailsRef = useRef(new Map());
  const [message, setMessage] = useState('');
  const [selectedDriver, setSelectedDriver] = useState(null);
  const [trailOn, setTrailOn] = useState(true);
  const [driverCount, setDriverCount] = useState(0);

  const rememberDriver = useCallback((driver) => {
    if (!driver?.id) return;
    driversRef.current.set(String(driver.id), driver);
  }, []);

  const popupHtml = useCallback((driver) => {
    const name = driver?.name ?? 'Driver';
    const status = driver?.is_available ? 'Available' : 'Busy';
    const seen = driver?.last_seen_at
      ? new Date(driver.last_seen_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '—';
    return (
      `<div style="min-width:150px;font-family:inherit">` +
      `<div style="font-weight:700;font-size:13px;color:#0F172A">${name}</div>` +
      `<div style="font-size:11px;color:#64748B;margin-top:2px">${status} · seen ${seen}</div>` +
      `<div style="font-size:11px;color:#2563EB;margin-top:4px">Click marker for trail</div>` +
      `</div>`
    );
  }, []);

  function fitToPoints(points) {
    const map = mapRef.current;
    if (!map || !points.length) return;
    if (points.length === 1) {
      map.flyTo({ center: points[0], zoom: 13 });
      return;
    }

    const bounds = new maptilersdk.LngLatBounds();
    points.forEach((point) => bounds.extend(point));
    map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 800 });
  }

  const selectDriver = useCallback(
    (driverId, { fly = true } = {}) => {
      const id = driverId != null ? String(driverId) : null;
      setSelectedDriver(id);
      const map = mapRef.current;
      const marker = id ? markersRef.current.get(id) : null;
      if (id && marker && fly && map) {
        map.flyTo({ center: marker.getLngLat(), zoom: Math.max(map.getZoom(), 13), duration: 700 });
      }
      if (id) {
        const driver = driversRef.current.get(id);
        if (driver && onSelectDriver) onSelectDriver(driver);
      }
    },
    [onSelectDriver]
  );

  const upsertMarker = useCallback(
    (driverId, lon, lat, driver = null) => {
      const map = mapRef.current;
      if (!map || lon == null || lat == null) return;
      const id = String(driverId);
      if (driver) rememberDriver({ ...driver, current_longitude: lon, current_latitude: lat });

      let entry = markersRef.current.get(id);
      if (entry) {
        entry.marker.setLngLat([lon, lat]);
        const known = driversRef.current.get(id);
        if (known) entry.marker.getElement().style.cssText = markerStyle(known.is_available);
      } else {
        const el = document.createElement('div');
        const known = driver ?? driversRef.current.get(id);
        el.style.cssText = markerStyle(known ? known.is_available : true);
        const marker = new maptilersdk.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
        const knownForPopup = () => driversRef.current.get(id) ?? { id, name: 'Driver' };
        marker.getElement().addEventListener('click', (e) => {
          e.stopPropagation();
          selectDriver(id);
          new maptilersdk.Popup({ offset: 14, closeButton: false })
            .setLngLat(marker.getLngLat())
            .setHTML(popupHtml(knownForPopup()))
            .addTo(map);
        });
        markersRef.current.set(id, { marker });
        setDriverCount(markersRef.current.size);
      }

      // Trail: last ~20 GPS points per driver.
      if (trailOn && id === selectedDriver) {
        drawTrail(id);
      }
    },
    [rememberDriver, popupHtml, selectDriver, selectedDriver, trailOn]
  );

  function clearTrail(id) {
    const map = mapRef.current;
    const layerId = `trail-${id}`;
    if (map && map.getLayer(layerId)) map.removeLayer(layerId);
    if (map && map.getSource(layerId)) map.removeSource(layerId);
    trailsRef.current.delete(id);
  }

  function drawTrail(id) {
    const map = mapRef.current;
    if (!map) return;
    const pts = trailsRef.current.get(id) ?? [];
    const layerId = `trail-${id}`;
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(layerId)) map.removeSource(layerId);
    if (pts.length < 2) return;
    map.addSource(layerId, {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: pts }, properties: {} },
    });
    map.addLayer({
      id: layerId,
      type: 'line',
      source: layerId,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ROUTE_COLOR, 'line-width': 3, 'line-opacity': 0.85, 'line-dasharray': [2, 2] },
    });
  }

  function pushTrailPoint(id, lon, lat) {
    const pts = trailsRef.current.get(id) ?? [];
    pts.push([lon, lat]);
    trailsRef.current.set(id, pts.slice(-20));
  }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    if (!MAPTILER_KEY) {
      setMessage('Map is unavailable: missing VITE_MAPTILER_API_KEY.');
      return;
    }

    maptilersdk.config.apiKey = MAPTILER_KEY;
    mapRef.current = new maptilersdk.Map({
      container: containerRef.current,
      style: maptilersdk.MapStyle.STREETS,
      zoom: 11,
    });

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
      markersRef.current.clear();
      routeLoadedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!mapRef.current) return;

    let cancelled = false;

    async function loadDrivers() {
      try {
        const drivers = await api.listDrivers();
        if (cancelled) return;
        const points = [];
        (drivers ?? []).forEach((d) => {
          rememberDriver(d);
          // Spec: micro drivers are NOT shown on the admin live map — only
          // big drivers (inter-warehouse journeys) appear here.
          if (d.driver_type !== 'big') return;
          if (d.current_latitude != null && d.current_longitude != null) {
            const point = [d.current_longitude, d.current_latitude];
            points.push(point);
            upsertMarker(d.id, d.current_longitude, d.current_latitude, d);
          }
        });

        if (points.length && !routeLoadedRef.current) {
          fitToPoints(points);
        } else if (!points.length) {
          setMessage('No live driver locations found in Supabase yet.');
        }
      } catch (e) {
        if (!cancelled) setMessage(`Failed to load live driver positions: ${e.message}`);
      }
    }

    loadDrivers();

    // Live GPS: move markers + extend trails as drivers insert gps_tracking rows.
    const channel = supabase
      .channel('drivers-live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'gps_tracking' },
        (payload) => {
          const row = payload.new;
          if (row?.driver_id && row?.latitude != null && row?.longitude != null) {
            const id = String(row.driver_id);
            // Big drivers only: micro-driver GPS stays off the admin map.
            const known = driversRef.current.get(id);
            if (known && known.driver_type !== 'big') return;
            pushTrailPoint(id, row.longitude, row.latitude);
            upsertMarker(id, row.longitude, row.latitude);
          }
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [order?.id]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (map.getLayer('selected-route-line')) {
      map.removeLayer('selected-route-line');
    }
    if (map.getSource('selected-route')) {
      map.removeSource('selected-route');
    }
    routeLoadedRef.current = false;

    if (!order?.id) return;

    api
      .getOrderAssignment(order.id)
      .then((assignment) => {
        const geometry = assignment?.route_geometry;
        if (!geometry || geometry.type !== 'LineString' || !Array.isArray(geometry.coordinates)) {
          setMessage('No route available for the selected order yet.');
          return;
        }

        setMessage('');
        const drawRoute = () => {
          if (!map.getSource('selected-route')) {
            map.addSource('selected-route', {
              type: 'geojson',
              data: {
                type: 'Feature',
                geometry,
                properties: {},
              },
            });
          }

          map.addLayer({
            id: 'selected-route-line',
            type: 'line',
            source: 'selected-route',
            layout: {
              'line-join': 'round',
              'line-cap': 'round',
            },
            paint: {
              'line-color': ROUTE_COLOR,
              'line-width': 4,
              'line-opacity': 0.9,
            },
          });

          fitToPoints(geometry.coordinates);
          routeLoadedRef.current = true;
        };

        if (map.isStyleLoaded()) {
          drawRoute();
        } else {
          map.once('load', drawRoute);
        }
      })
      .catch(() => {
        setMessage('No route available for the selected order yet.');
      });
  }, [order?.id]);

  const sel = selectedDriver ? driversRef.current.get(selectedDriver) : null;

  const inner = (
    <div className="map-shell relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {message ? (
        <div className="absolute left-3 top-3 rounded-md border border-line bg-surface px-3 py-2 text-xs text-slate2">
          {message}
        </div>
      ) : null}
      {driverCount > 0 && interactive && !compact ? (
        <div className="absolute right-3 top-3 flex items-center gap-2 rounded-md border border-line bg-surface/95 px-2.5 py-1.5 text-[11px] text-slate2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-green" />
          </span>
          {driverCount} live · {trailOn ? 'trail on' : 'trail off'}
        </div>
      ) : null}
      {sel ? (
        <div className="absolute bottom-3 left-3 right-3 flex items-center gap-2 rounded-lg border border-line bg-surface/95 px-3 py-2 shadow-sm">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: sel.is_available ? MARKER_ACTIVE : MARKER_IDLE }} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-ink">{sel.name ?? 'Driver'}</div>
            <div className="text-[11px] text-faint">
              {sel.is_available ? 'Available' : 'Busy'} · click Open drivers for full profile
            </div>
          </div>
          <button
            type="button"
            onClick={() => setTrailOn((v) => !v)}
            className="h-7 shrink-0 rounded-md border border-line px-2 text-[11px] font-semibold text-ink transition hover:bg-cream"
          >
            {trailOn ? 'Hide trail' : 'Trail'}
          </button>
          <button
            type="button"
            onClick={() => {
              if (selectedDriver) clearTrail(selectedDriver);
              setSelectedDriver(null);
            }}
            className="h-7 w-7 shrink-0 rounded-md border border-line text-slate2 transition hover:bg-cream"
            aria-label="Deselect driver"
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  );

  if (message && !MAPTILER_KEY) {
    return <div className="flex h-full items-center justify-center p-4 text-sm text-slate2">{message}</div>;
  }

  if (!compact || !interactive) return inner;

  // Compact dashboard mode: whole map click-through opens the Orders page.
  return (
    <div className="relative h-full w-full">
      {inner}
      <button
        type="button"
        aria-label="Open live map"
        onClick={() => onSelectDriver && onSelectDriver('__open__')}
        className="absolute inset-0 h-full w-full cursor-pointer bg-transparent"
      />
    </div>
  );
}
