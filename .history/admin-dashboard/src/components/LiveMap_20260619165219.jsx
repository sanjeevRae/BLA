import React, { useEffect, useRef, useState } from 'react';
import * as maptilersdk from '@maptiler/sdk';
import '@maptiler/sdk/dist/maptiler-sdk.css';
import { api } from '../lib/api';

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_API_KEY;

// Live map of drivers plus the selected order route.
export default function LiveMap({ order }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map());
  const routeLoadedRef = useRef(false);
  const [message, setMessage] = useState('');

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

  function upsertMarker(driverId, lon, lat) {
    const map = mapRef.current;
    if (!map) return;

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

        if (points.length && !routeLoadedRef.current) {
          fitToPoints(points);
        } else if (!points.length) {
          setMessage('No live driver locations found in Supabase yet.');
        }
      })
      .catch((e) => {
        setMessage(`Failed to load live driver positions: ${e.message}`);
      });
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
              'line-color': '#2563eb',
              'line-width': 5,
              'line-opacity': 0.8,
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
