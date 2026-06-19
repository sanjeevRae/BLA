import React, { useEffect, useRef, useState } from 'react';
import * as maptilersdk from '@maptiler/sdk';
import '@maptiler/sdk/dist/maptiler-sdk.css';
import { api } from '../lib/api';

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_API_KEY;
const DEFAULT_CENTER = [85.324, 27.7172]; // Kathmandu fallback
const DEFAULT_ZOOM = 11;

// Live map of every driver. Initial positions come from the backend.
export default function LiveMap() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map()); // driver_id -> maptilersdk.Marker
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    if (!MAPTILER_KEY) {
      setMessage('Map is unavailable: missing VITE_MAPTILER_API_KEY.');
      return;
    }

    maptilersdk.config.apiKey = MAPTILER_KEY;

    const map = new maptilersdk.Map({
      container: containerRef.current,
      style: maptilersdk.MapStyle.STREETS,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
    });
    mapRef.current = map;

    function fitToPoints(points) {
      if (!points.length) return;
      if (points.length === 1) {
        map.flyTo({ center: points[0], zoom: 13 });
        return;
      }

      const bounds = new maptilersdk.LngLatBounds();
      points.forEach((point) => bounds.extend(point));
      map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 800 });
    }

    function upsertMarker(driverId, lon, lat) {
      let marker = markersRef.current.get(driverId);
      if (marker) {
        marker.setLngLat([lon, lat]);
      } else {
        const el = document.createElement('div');
        el.style.cssText =
          'width:16px;height:16px;border-radius:50%;background:#2563eb;border:2px solid #fff;box-shadow:0 0 0 2px #2563eb55';
        marker = new maptilersdk.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
        markersRef.current.set(driverId, marker);
      }
    }

    api
      .listDrivers()
      .then((drivers) => {
        const points = [];
        (drivers ?? []).forEach((d) => {
          if (d.current_latitude != null && d.current_longitude != null) {
            const point = [d.current_longitude, d.current_latitude];
            points.push(point);
            upsertMarker(d.id, d.current_longitude, d.current_latitude);
          }
        });

        if (points.length) {
          fitToPoints(points);
        } else {
          setMessage('No live driver locations available yet.');
        }
      })
      .catch((e) => {
        setMessage(`Failed to load live driver positions: ${e.message}`);
      });

    return () => {
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
  }, []);

  if (message && !MAPTILER_KEY) {
    return <div className="flex h-full items-center justify-center p-4 text-sm text-slate-500">{message}</div>;
  }

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {message ? (
        <div className="absolute left-3 top-3 rounded bg-white/90 px-3 py-2 text-xs text-slate-600 shadow">
          {message}
        </div>
      ) : null}
    </div>
  );
}
