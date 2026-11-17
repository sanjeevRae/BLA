// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- react-leaflet stub (same pattern as tests/component/live-operations):
// renders markers as buttons and records map props so the real LiveMap
// island can run in jsdom without Leaflet's DOM requirements.
const fakeMap = vi.hoisted(() => ({
  fitBounds: vi.fn(),
  setView: vi.fn(),
  getZoom: () => 7,
}));
const recorded = vi.hoisted(() => ({
  markers: [] as { position: unknown; icon?: unknown }[],
  mapProps: [] as { center: unknown; zoom: unknown }[],
}));

vi.mock("react-leaflet", () => ({
  MapContainer: (props: {
    center: unknown;
    zoom: unknown;
    children?: React.ReactNode;
  }) => {
    recorded.mapProps.push({ center: props.center, zoom: props.zoom });
    return <div data-testid="live-map">{props.children}</div>;
  },
  TileLayer: () => null,
  Marker: (props: {
    position: unknown;
    icon?: unknown;
    eventHandlers?: { click?: () => void };
  }) => {
    recorded.markers.push({ position: props.position, icon: props.icon });
    return (
      <button
        type="button"
        data-testid="map-marker"
        aria-label="Map marker"
        onClick={() => props.eventHandlers?.click?.()}
      />
    );
  },
  Circle: () => null,
  Polyline: () => null,
  useMap: () => fakeMap,
}));

import { cleanup, render, screen, waitFor } from "@testing-library/react";

import {
  LiveOpsPreview,
  summarizePreviewItems,
} from "@/components/live-operations/LiveOpsPreview";
import type {
  LiveOperationItem,
  WarehouseCoordsMap,
} from "@/components/live-operations/types";

/**
 * V3 Step 4 — LiveOpsPreview contracts:
 *  - summarizePreviewItems counts only ACTIVE/PAUSED sessions,
 *    counts distinct drivers, counts DELAYED among active, and
 *    orders stalest never-reported first, then oldest report;
 *  - the preview fetches /api/live-operations once on mount with
 *    the warehouseId display-scope param, renders the counts from
 *    the payload, and shows the honest empty state on an empty
 *    payload.
 */

const NOW_ISO = new Date().toISOString();
const OLD_ISO = new Date(Date.now() - 42 * 60_000).toISOString();
const OLDER_ISO = new Date(Date.now() - 90 * 60_000).toISOString();

const WAREHOUSE_COORDS: WarehouseCoordsMap = {
  "wh-ktm": { latitude: 27.7172, longitude: 85.324, code: "KTM", name: "Kathmandu" },
  "wh-pkr": { latitude: 28.2096, longitude: 83.9856, code: "PKR", name: "Pokhara" },
};

function makeItem(overrides: Partial<LiveOperationItem>): LiveOperationItem {
  return {
    trackingSessionId: "sess-1",
    driverId: "driver-1",
    driverName: "Driver One",
    trackingType: "DELIVERY",
    sessionStatus: "ACTIVE",
    tripId: null,
    tripNumber: null,
    transferId: null,
    deliveryBatchId: "batch-1",
    batchKind: "DELIVERY",
    batchDate: "2026-11-17",
    origin: { warehouseId: "wh-ktm", code: "KTM", name: "Kathmandu" },
    destination: null,
    vehicleRegistration: null,
    packageCount: 4,
    deliveredCount: 1,
    remainingCount: 3,
    location: {
      latitude: 27.7,
      longitude: 85.33,
      accuracyMeters: 18,
      lastRecordedAt: NOW_ISO,
      lastReceivedAt: NOW_ISO,
    },
    freshnessState: "FRESH",
    ...overrides,
  };
}

function locationAt(iso: string) {
  return {
    latitude: 27.7,
    longitude: 85.33,
    accuracyMeters: 18,
    lastRecordedAt: iso,
    lastReceivedAt: iso,
  };
}

// ---------------------------------------------------------------------
// summarizePreviewItems (pure)
// ---------------------------------------------------------------------

describe("summarizePreviewItems", () => {
  it("returns zeros and no stalest for empty input", () => {
    expect(summarizePreviewItems([])).toEqual({
      activeTrips: 0,
      activeRiders: 0,
      delayedMovements: 0,
      stalest: [],
    });
  });

  it("counts active trips only for LINEHAUL sessions that are ACTIVE or PAUSED", () => {
    const items = [
      makeItem({ trackingSessionId: "a", trackingType: "LINEHAUL", sessionStatus: "ACTIVE" }),
      makeItem({ trackingSessionId: "b", trackingType: "LINEHAUL", sessionStatus: "PAUSED" }),
      makeItem({ trackingSessionId: "c", trackingType: "LINEHAUL", sessionStatus: "ENDED" }),
      makeItem({ trackingSessionId: "d", trackingType: "DELIVERY", sessionStatus: "ACTIVE" }),
      makeItem({ trackingSessionId: "e", trackingType: "PICKUP", sessionStatus: "ACTIVE" }),
    ];
    expect(summarizePreviewItems(items).activeTrips).toBe(2);
  });

  it("counts distinct drivers among ACTIVE/PAUSED items only", () => {
    const items = [
      makeItem({ trackingSessionId: "a", driverId: "driver-1", sessionStatus: "ACTIVE" }),
      makeItem({ trackingSessionId: "b", driverId: "driver-1", sessionStatus: "PAUSED" }),
      makeItem({ trackingSessionId: "c", driverId: "driver-2", sessionStatus: "ACTIVE" }),
      makeItem({ trackingSessionId: "d", driverId: "driver-3", sessionStatus: "ENDED" }),
    ];
    expect(summarizePreviewItems(items).activeRiders).toBe(2);
  });

  it("counts delayed movements only among ACTIVE/PAUSED items", () => {
    const items = [
      makeItem({ trackingSessionId: "a", freshnessState: "DELAYED", sessionStatus: "ACTIVE" }),
      makeItem({ trackingSessionId: "b", freshnessState: "DELAYED", sessionStatus: "PAUSED" }),
      makeItem({ trackingSessionId: "c", freshnessState: "DELAYED", sessionStatus: "ENDED" }),
      makeItem({ trackingSessionId: "d", freshnessState: "FRESH", sessionStatus: "ACTIVE" }),
      makeItem({ trackingSessionId: "e", freshnessState: "STALE", sessionStatus: "ACTIVE" }),
    ];
    expect(summarizePreviewItems(items).delayedMovements).toBe(2);
  });

  it("orders stalest never-reported first, then oldest lastReceivedAt, capped at 3 and active only", () => {
    const neverA = makeItem({
      trackingSessionId: "never-a",
      location: null,
      freshnessState: "OFFLINE",
    });
    const neverB = makeItem({
      trackingSessionId: "never-b",
      location: null,
      freshnessState: "OFFLINE",
    });
    const older = makeItem({
      trackingSessionId: "older",
      location: locationAt(OLDER_ISO),
      freshnessState: "STALE",
    });
    const old = makeItem({
      trackingSessionId: "old",
      location: locationAt(OLD_ISO),
      freshnessState: "STALE",
    });
    const fresh = makeItem({
      trackingSessionId: "fresh",
      location: locationAt(NOW_ISO),
      freshnessState: "FRESH",
    });
    const endedNever = makeItem({
      trackingSessionId: "ended-never",
      sessionStatus: "ENDED",
      location: null,
      freshnessState: "OFFLINE",
    });

    const { stalest } = summarizePreviewItems([
      fresh,
      old,
      neverA,
      older,
      neverB,
      endedNever,
    ]);

    expect(stalest).toHaveLength(3);
    // Never-reported sessions come first (in input-relative order).
    expect(stalest[0].trackingSessionId).toBe("never-a");
    expect(stalest[1].trackingSessionId).toBe("never-b");
    // Then the oldest reported position.
    expect(stalest[2].trackingSessionId).toBe("older");
    expect(stalest.map((item) => item.trackingSessionId)).not.toContain("ended-never");
  });

  it("does not mutate the input array when ordering stalest", () => {
    const items = [
      makeItem({ trackingSessionId: "fresh", location: locationAt(NOW_ISO) }),
      makeItem({ trackingSessionId: "never", location: null }),
    ];
    const before = items.map((item) => item.trackingSessionId);
    summarizePreviewItems(items);
    expect(items.map((item) => item.trackingSessionId)).toEqual(before);
  });
});

// ---------------------------------------------------------------------
// LiveOpsPreview (render, mocked fetch + real LiveMap on stubbed leaflet)
// ---------------------------------------------------------------------

let listItems: LiveOperationItem[] = [];
let fetchCalls: string[] = [];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function installFetch() {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.startsWith("/api/live-operations")) {
      return jsonResponse({
        items: listItems,
        total: listItems.length,
        generatedAt: NOW_ISO,
        latestReceivedAt: NOW_ISO,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

beforeEach(() => {
  recorded.markers = [];
  recorded.mapProps = [];
  fakeMap.fitBounds.mockClear();
  fakeMap.setView.mockClear();
  listItems = [];
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LiveOpsPreview — rendering", () => {
  it("fetches once with the warehouseId param and renders counts from the payload", async () => {
    listItems = [
      makeItem({
        trackingSessionId: "sess-trip",
        driverId: "driver-1",
        driverName: "Trip Driver",
        trackingType: "LINEHAUL",
        sessionStatus: "ACTIVE",
        freshnessState: "DELAYED",
        location: locationAt(OLD_ISO),
        destination: { warehouseId: "wh-pkr", code: "PKR", name: "Pokhara" },
      }),
      makeItem({
        trackingSessionId: "sess-delivery",
        driverId: "driver-1",
        driverName: "Trip Driver",
        trackingType: "DELIVERY",
        sessionStatus: "ACTIVE",
        freshnessState: "FRESH",
        location: locationAt(NOW_ISO),
      }),
      makeItem({
        trackingSessionId: "sess-pickup",
        driverId: "driver-2",
        driverName: "Pickup Driver",
        trackingType: "PICKUP",
        sessionStatus: "PAUSED",
        freshnessState: "DELAYED",
        location: null,
      }),
      makeItem({
        trackingSessionId: "sess-ended",
        driverId: "driver-3",
        driverName: "Ended Driver",
        trackingType: "LINEHAUL",
        sessionStatus: "ENDED",
        freshnessState: "DELAYED",
        location: locationAt(OLDER_ISO),
      }),
    ];

    render(
      <LiveOpsPreview
        basePath="/admin"
        warehouseCoords={WAREHOUSE_COORDS}
        initialWarehouseId="wh-ktm"
      />,
    );

    // Counts come from the payload: 1 active trip, 2 distinct active
    // riders, 2 delayed among active/paused (the ENDED row excluded).
    expect(await screen.findByText("Active trips")).toBeTruthy();
    expect(screen.getByText("Active trips").closest("div")?.textContent).toContain("1");
    expect(screen.getByText("Active riders").closest("div")?.textContent).toContain("2");
    expect(screen.getByText("Delayed movements").closest("div")?.textContent).toContain("2");

    // Exactly one fetch, carrying the display-scope warehouseId.
    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0]).toBe("/api/live-operations?warehouseId=wh-ktm");

    // Stalest list: never-reported pickup driver first, with badge +
    // last-update line and the origin → destination codes.
    expect(screen.getByText("Pickup Driver")).toBeTruthy();
    expect(screen.getByText(/Last update No update yet/)).toBeTruthy();
    expect(screen.getAllByText(/KTM → Local/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/KTM → PKR/)).toBeTruthy();

    // Footer: updated line + View All link to the full page.
    expect(screen.getByText(/^Updated /)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View All Live Operations →" }).getAttribute("href"),
    ).toBe("/admin/live-operations");
  });

  it("shows the empty state on an empty payload", async () => {
    listItems = [];
    render(
      <LiveOpsPreview
        basePath="/admin"
        warehouseCoords={WAREHOUSE_COORDS}
        initialWarehouseId={null}
      />,
    );

    expect(await screen.findByText("No active movements")).toBeTruthy();
    expect(
      screen.getByText(
        "Active transfers, pickups and deliveries appear here while tracking is on.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "View All Live Operations →" }).getAttribute("href"),
    ).toBe("/admin/live-operations");
    // No warehouseId param when no initial scope is set.
    await waitFor(() => expect(fetchCalls).toHaveLength(1));
    expect(fetchCalls[0]).toBe("/api/live-operations");
  });
});
