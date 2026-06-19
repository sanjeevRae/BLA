import React, { useEffect, useRef } from 'react';
import * as maptilersdk from '@maptiler/sdk';
import '@maptiler/sdk/dist/maptiler-sdk.css';
import { supabase } from '../lib/supabase';

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_API_KEY;

// Live map of every driver. Initial positions come from the `drivers` table;
// live updates stream in via Supabase Realtime on `gps_tracking` inserts.
export default function LiveMap() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markersRef = useRef(new Map()); // driver_id -> maptilersdk.Marker

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    maptilersdk.config.apiKey = MAPTILER_KEY ?? '';

    const map = new maptilersdk.Map({
      container: containerRef.current,
      style: maptilersdk.MapStyle.STREETS.DARK,
      center: [77.6063, 12.9759], // Bengaluru
      zoom: 11,
    });
    mapRef.current = map;

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

    // 1) Seed with last-known driver positions.
    supabase
      .from('drivers')
      .select('id, current_latitude, current_longitude')
      .then(({ data }) => {
        (data ?? []).forEach((d) => {
          if (d.current_latitude != null && d.current_longitude != null) {
            upsertMarker(d.id, d.current_longitude, d.current_latitude);
          }
        });
      });

    // 2) Subscribe to live GPS pings.
    const channel = supabase
      .channel('gps-live')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'gps_tracking' },
        (payload) => {
          const p = payload.new;
          upsertMarker(p.driver_id, p.longitude, p.latitude);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
  }, []);

  return <div ref={containerRef} className="h-full w-full" />;
}
