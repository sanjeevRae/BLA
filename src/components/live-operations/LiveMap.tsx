"use client";

import { useEffect, useRef } from "react";
import L from "leaflet";
import { Circle, MapContainer, Marker, Polyline, TileLayer, useMap } from "react-leaflet";

import "leaflet/dist/leaflet.css";
import "./live-map.css";

import { DEFAULT_MAP_ZOOM, NEPAL_CENTRE, OSM_ATTRIBUTION, OSM_TILE_URL } from "@/lib/maps/config";
import type {
  LiveOperationItem,
  WarehouseCoords,
  WarehouseCoordsMap,
} from "@/components/live-operations/types";

/**
 * Live Operations map island (V2 Phase 5) — loaded by the board via
 * next/dynamic with ssr:false (Leaflet needs the DOM).
 *
 * No-remount contract: the MapContainer is rendered ONCE with
 * constant centre/zoom props and is never keyed by data. Polling
 * updates re-render the keyed Marker children and a MapController
 * effect syncs the view imperatively — the map instance, its zoom
 * and the user's pan survive every refresh.
 *
 * Honesty rules: a movement with location=null gets NO marker (the
 * list says "Waiting for first location"); freshness drives pin
 * colour/opacity so a stale fix never looks live; the only line
 * ever drawn is the dashed straight-line connector to the selected
 * movement's destination warehouse, labelled in the detail panel
 * as "Straight-line connection — not a road route". No road
 * routes, no ETAs, no interpolated positions.
 */

const TYPE_LETTER: Record<LiveOperationItem["trackingType"], string> = {
  LINEHAUL: "L",
  PICKUP: "P",
  DELIVERY: "D",
};

function pinIcon(item: LiveOperationItem, selected: boolean): L.DivIcon {
  const typeClass = `bla-pin-${item.trackingType.toLowerCase()}`;
  const freshnessClass = `bla-pin-${item.freshnessState.toLowerCase()}`;
  return L.divIcon({
    className: "bla-pin-wrap",
    html: `<span class="bla-pin ${typeClass} ${freshnessClass}${selected ? " bla-pin-selected" : ""}"><span class="bla-pin-letter">${TYPE_LETTER[item.trackingType]}</span></span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function warehouseIcon(coords: WarehouseCoords): L.DivIcon {
  return L.divIcon({
    className: "bla-wh-wrap",
    html: `<span class="bla-wh">${coords.code}</span>`,
    iconSize: [38, 22],
    iconAnchor: [19, 11],
  });
}

function fitToPoints(map: L.Map, points: [number, number][]) {
  if (points.length === 0) return;
  if (points.length === 1) {
    map.setView(points[0], Math.max(map.getZoom(), 11));
    return;
  }
  map.fitBounds(L.latLngBounds(points.map(([lat, lng]) => L.latLng(lat, lng))), {
    padding: [40, 40],
  });
}

/** Registers the map instance for the control buttons and fits the
 *  view to the active drivers whenever the SET of located movements
 *  changes (initial load, a driver appears/disappears) — not on
 *  every position update, so a user's pan is not yanked away by
 *  polling. */
function MapController({
  items,
  mapRef,
}: {
  items: LiveOperationItem[];
  mapRef: React.MutableRefObject<L.Map | null>;
}) {
  const map = useMap();
  useEffect(() => {
    mapRef.current = map;
  }, [map, mapRef]);

  const locatedSignature = items
    .filter((item) => item.location !== null)
    .map((item) => item.trackingSessionId)
    .sort()
    .join(",");
  const prevSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!locatedSignature || locatedSignature === prevSignatureRef.current) return;
    prevSignatureRef.current = locatedSignature;
    const points = items
      .filter((item) => item.location !== null)
      .map(
        (item) =>
          [item.location!.latitude, item.location!.longitude] as [number, number],
      );
    fitToPoints(map, points);
    // items identity changes each poll; the signature is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locatedSignature, map]);

  return null;
}

export interface LiveMapProps {
  items: LiveOperationItem[];
  selectedId: string | null;
  onSelect: (trackingSessionId: string) => void;
  warehouseCoords: WarehouseCoordsMap;
  /** The board's current warehouse filter ("" / null = all). */
  selectedWarehouseId: string | null;
  onShowAllAuthorized: () => void;
}

export function LiveMap({
  items,
  selectedId,
  onSelect,
  warehouseCoords,
  selectedWarehouseId,
  onShowAllAuthorized,
}: LiveMapProps) {
  const mapRef = useRef<L.Map | null>(null);
  const selected = items.find((item) => item.trackingSessionId === selectedId) ?? null;
  const located = items.filter((item) => item.location !== null);

  const selectedOriginCoords = selected ? warehouseCoords[selected.origin.warehouseId] : undefined;
  const selectedDestinationCoords = selected?.destination
    ? warehouseCoords[selected.destination.warehouseId]
    : undefined;
  const myWarehouseCoords = selectedWarehouseId ? warehouseCoords[selectedWarehouseId] : undefined;

  function handleFitDrivers() {
    const map = mapRef.current;
    if (!map) return;
    fitToPoints(
      map,
      located.map(
        (item) => [item.location!.latitude, item.location!.longitude] as [number, number],
      ),
    );
  }

  function handleMyWarehouse() {
    const map = mapRef.current;
    if (!map) return;
    if (myWarehouseCoords) {
      map.setView([myWarehouseCoords.latitude, myWarehouseCoords.longitude], 12);
      return;
    }
    // Coordinates unknown for that warehouse: fall back to fitting
    // its movements (the board's list is already warehouse-filtered).
    handleFitDrivers();
  }

  function handleShowAll() {
    onShowAllAuthorized();
    handleFitDrivers();
  }

  const controlButtonClass =
    "rounded-md border border-line bg-surface px-3 py-2 text-[12px] font-semibold text-ink disabled:opacity-60";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className={controlButtonClass} onClick={handleFitDrivers}>
          Fit active drivers
        </button>
        {selectedWarehouseId ? (
          <button type="button" className={controlButtonClass} onClick={handleMyWarehouse}>
            My warehouse
          </button>
        ) : null}
        <button type="button" className={controlButtonClass} onClick={handleShowAll}>
          Show all authorized
        </button>
      </div>
      <div className="h-[420px] w-full overflow-hidden rounded-lg border border-line">
        <MapContainer
          center={[NEPAL_CENTRE[0], NEPAL_CENTRE[1]]}
          zoom={DEFAULT_MAP_ZOOM}
          style={{ height: "100%", width: "100%" }}
        >
          <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} />
          <MapController items={items} mapRef={mapRef} />
          {located.map((item) => (
            <Marker
              key={item.trackingSessionId}
              position={[item.location!.latitude, item.location!.longitude]}
              icon={pinIcon(item, item.trackingSessionId === selectedId)}
              eventHandlers={{ click: () => onSelect(item.trackingSessionId) }}
            />
          ))}
          {selected?.location && selectedOriginCoords ? (
            <Marker
              position={[selectedOriginCoords.latitude, selectedOriginCoords.longitude]}
              icon={warehouseIcon(selectedOriginCoords)}
            />
          ) : null}
          {selected?.location && selectedDestinationCoords ? (
            <Marker
              position={[
                selectedDestinationCoords.latitude,
                selectedDestinationCoords.longitude,
              ]}
              icon={warehouseIcon(selectedDestinationCoords)}
            />
          ) : null}
          {selected?.location ? (
            <Circle
              center={[selected.location.latitude, selected.location.longitude]}
              radius={selected.location.accuracyMeters}
              pathOptions={{ className: "bla-accuracy" }}
            />
          ) : null}
          {selected?.location && selectedDestinationCoords ? (
            <Polyline
              positions={[
                [selected.location.latitude, selected.location.longitude],
                [selectedDestinationCoords.latitude, selectedDestinationCoords.longitude],
              ]}
              pathOptions={{ className: "bla-connector" }}
            />
          ) : null}
        </MapContainer>
      </div>
      <p className="text-[12px] text-slate2">
        Pins show each driver&apos;s last reported position — the age of every position is
        shown in the list, and a faded pin is not a live position.
      </p>
    </div>
  );
}

export default LiveMap;
