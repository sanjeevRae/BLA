// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// --- react-leaflet stub: records every marker / circle / polyline /
// tile layer the map island hands to Leaflet, and renders markers as
// clickable buttons so marker selection can be exercised. The map
// object is a stable fake (fitBounds / setView / getZoom).
const fakeMap = vi.hoisted(() => ({
  fitBounds: vi.fn(),
  setView: vi.fn(),
  getZoom: () => 7,
}));
const recorded = vi.hoisted(() => ({
  markers: [] as { position: unknown; icon?: unknown }[],
  circles: [] as { center: unknown; radius: unknown }[],
  polylines: [] as { positions: unknown }[],
  tileUrls: [] as string[],
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
  TileLayer: (props: { url: string }) => {
    recorded.tileUrls.push(props.url);
    return null;
  },
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
  Circle: (props: { center: unknown; radius: unknown }) => {
    recorded.circles.push({ center: props.center, radius: props.radius });
    return null;
  },
  Polyline: (props: { positions: unknown }) => {
    recorded.polylines.push({ positions: props.positions });
    return null;
  },
  useMap: () => fakeMap,
}));

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LiveOperationsBoard } from "@/components/live-operations/LiveOperationsBoard";
import { LiveMap } from "@/components/live-operations/LiveMap";
import { OSM_TILE_URL } from "@/lib/maps/config";
import type {
  LiveOperationDetail,
  LiveOperationItem,
  WarehouseCoordsMap,
} from "@/components/live-operations/types";

/**
 * Phase 5 (V2) — Live Operations board + map contracts:
 *  - freshness badges always sit next to a last-update time, and a
 *    movement with no location renders "Waiting for first location"
 *    and gets NO marker;
 *  - chips filter the fetched list client-side;
 *  - COD is rendered ONLY when codCollectedPaisa is present in the
 *    payload — absent means not mentioned at all;
 *  - polling runs every 50s only while the document is visible and
 *    resumes with an immediate fetch on visibility return;
 *  - a failed fetch keeps the last good rows and offers Retry.
 */

const NOW_ISO = new Date().toISOString();
const OLD_ISO = new Date(Date.now() - 42 * 60_000).toISOString();

const WAREHOUSE_COORDS: WarehouseCoordsMap = {
  "wh-ktm": { latitude: 27.7172, longitude: 85.324, code: "KTM", name: "Kathmandu" },
  "wh-pkr": { latitude: 28.2096, longitude: 83.9856, code: "PKR", name: "Pokhara" },
};

function makeItem(overrides: Partial<LiveOperationItem>): LiveOperationItem {
  return {
    trackingSessionId: "sess-1",
    driverId: "driver-1",
    driverName: "Delivery Driver",
    trackingType: "DELIVERY",
    sessionStatus: "ACTIVE",
    tripId: null,
    tripNumber: null,
    transferId: null,
    deliveryBatchId: "batch-1",
    batchKind: "DELIVERY",
    batchDate: "2026-11-16",
    origin: { warehouseId: "wh-ktm", code: "KTM", name: "Kathmandu" },
    destination: null,
    vehicleRegistration: null,
    packageCount: 8,
    deliveredCount: 3,
    remainingCount: 5,
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

const deliveryItem = makeItem({});
const linehaulItem = makeItem({
  trackingSessionId: "sess-2",
  driverId: "driver-2",
  driverName: "Linehaul Driver",
  trackingType: "LINEHAUL",
  tripId: "trip-1",
  tripNumber: "TRIP-42",
  transferId: "transfer-1",
  deliveryBatchId: null,
  batchKind: null,
  batchDate: null,
  destination: { warehouseId: "wh-pkr", code: "PKR", name: "Pokhara" },
  vehicleRegistration: "BA 1 KHA 1234",
  packageCount: 20,
  deliveredCount: null,
  remainingCount: null,
  location: {
    latitude: 27.9,
    longitude: 84.9,
    accuracyMeters: 40,
    lastRecordedAt: OLD_ISO,
    lastReceivedAt: OLD_ISO,
  },
  freshnessState: "STALE",
});
const waitingItem = makeItem({
  trackingSessionId: "sess-3",
  driverId: "driver-3",
  driverName: "Waiting Driver",
  trackingType: "PICKUP",
  deliveryBatchId: "batch-2",
  batchKind: "PICKUP",
  packageCount: 4,
  deliveredCount: 0,
  remainingCount: 4,
  location: null,
  freshnessState: "OFFLINE",
});

const ALL_ITEMS = [deliveryItem, linehaulItem, waitingItem];

function detailFor(item: LiveOperationItem, extra: Partial<LiveOperationDetail> = {}): LiveOperationDetail {
  return {
    ...item,
    packages: [
      { packageId: "pkg-1", trackingId: "BLA1001", packageStatus: "OUT_FOR_DELIVERY", assignmentStatus: "IN_PROGRESS" },
      { packageId: "pkg-2", trackingId: "BLA1002", packageStatus: "DELIVERED", assignmentStatus: "COMPLETED" },
    ],
    ...extra,
  };
}

// --- fetch mock -------------------------------------------------------

let listItems: LiveOperationItem[] = ALL_ITEMS;
let details: Record<string, LiveOperationDetail> = {};
let failList = false;
let fetchCalls: string[] = [];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body } as Response;
}

function installFetch() {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    fetchCalls.push(url);
    const detailMatch = url.match(/\/api\/live-operations\/([^?]+)$/);
    if (detailMatch) {
      const detail = details[detailMatch[1]];
      if (!detail) return jsonResponse({ error: "not found" }, false, 404);
      return jsonResponse(detail);
    }
    if (url.startsWith("/api/live-operations")) {
      if (failList) return jsonResponse({ error: "boom" }, false, 500);
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

function listCalls() {
  return fetchCalls.filter(
    (url) => url === "/api/live-operations" || url.startsWith("/api/live-operations?"),
  );
}

const BOARD_PERMISSIONS = [
  "operations.live_view",
  "transfer.read_warehouse",
  "delivery.assign",
  "delivery.read_assigned",
  "package.receive",
];

function renderBoard(basePath = "/warehouse") {
  return render(
    <LiveOperationsBoard
      basePath={basePath}
      permissions={BOARD_PERMISSIONS}
      warehouseOptions={[
        { id: "wh-ktm", code: "KTM", name: "Kathmandu" },
        { id: "wh-pkr", code: "PKR", name: "Pokhara" },
      ]}
      warehouseCoords={WAREHOUSE_COORDS}
      initialWarehouseId={null}
    />,
  );
}

beforeEach(() => {
  recorded.markers = [];
  recorded.circles = [];
  recorded.polylines = [];
  recorded.tileUrls = [];
  recorded.mapProps = [];
  fakeMap.fitBounds.mockClear();
  fakeMap.setView.mockClear();
  listItems = ALL_ITEMS;
  details = {};
  failList = false;
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------

describe("LiveOperationsBoard — list rendering", () => {
  it("renders rows with freshness badges, activity and last-update times", async () => {
    renderBoard();
    expect(await screen.findByText("Delivery Driver")).toBeTruthy();
    expect(screen.getByText("Linehaul Driver")).toBeTruthy();
    expect(screen.getByText("Fresh")).toBeTruthy();
    // "Stale" appears twice: the freshness badge AND the filter chip.
    expect(screen.getAllByText("Stale").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText(/Delivering — 3 of 8 delivered/)).toBeTruthy();
    expect(screen.getByText(/In transit/)).toBeTruthy();
    expect(screen.getByText(/TRIP-42/)).toBeTruthy();
    expect(screen.getByText(/Last update just now/)).toBeTruthy();
  });

  it("renders a waiting-for-location row and passes NO marker for it to the map", async () => {
    renderBoard();
    expect(await screen.findByText("Waiting Driver")).toBeTruthy();
    expect(screen.getByText("Waiting for first location")).toBeTruthy();
    await screen.findByTestId("live-map");
    await waitFor(() => expect(recorded.markers.length).toBeGreaterThan(0));
    const positions = recorded.markers.map((m) => JSON.stringify(m.position));
    // Only the two located movements may have markers.
    expect(new Set(positions)).toEqual(
      new Set([JSON.stringify([27.7, 85.33]), JSON.stringify([27.9, 84.9])]),
    );
    expect(recorded.tileUrls).toContain(OSM_TILE_URL);
  });

  it("shows the empty state when there are no movements", async () => {
    listItems = [];
    renderBoard();
    expect(await screen.findByText("No active movements")).toBeTruthy();
  });

  it("shows an all-stale notice when every movement is stale or offline", async () => {
    listItems = [linehaulItem, waitingItem];
    renderBoard();
    expect(await screen.findByText(/No live positions right now/)).toBeTruthy();
  });
});

describe("LiveOperationsBoard — filter chips", () => {
  it("filters rows client-side by type and freshness", async () => {
    renderBoard();
    expect(await screen.findByText("Delivery Driver")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Deliveries" }));
    expect(screen.getByText("Delivery Driver")).toBeTruthy();
    expect(screen.queryByText("Linehaul Driver")).toBeNull();
    expect(screen.queryByText("Waiting Driver")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Stale" }));
    expect(screen.getByText("Linehaul Driver")).toBeTruthy();
    expect(screen.getByText("Waiting Driver")).toBeTruthy();
    expect(screen.queryByText("Delivery Driver")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Warehouse transfers" }));
    expect(screen.getByText("Linehaul Driver")).toBeTruthy();
    expect(screen.queryByText("Waiting Driver")).toBeNull();

    // Chips are client-side: still exactly one list fetch.
    expect(listCalls()).toHaveLength(1);
  });
});

describe("LiveOperationsBoard — detail drawer", () => {
  it("clicking a row fetches the detail and opens the panel; absent COD renders no COD text", async () => {
    details = { "sess-1": detailFor(deliveryItem) };
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: /Delivery Driver/ }));
    expect(await screen.findByText("Packages (2)")).toBeTruthy();
    expect(fetchCalls.some((url) => url === "/api/live-operations/sess-1")).toBe(true);
    // Package tracking ids link to public tracking.
    const link = screen.getByRole("link", { name: "BLA1001" });
    expect(link.getAttribute("href")).toBe("/track/BLA1001");
    // COD field ABSENT from the payload → nothing about COD anywhere.
    expect(screen.queryByText(/COD/)).toBeNull();
    expect(screen.queryByText(/NPR/)).toBeNull();
    // Warehouse dashboard + delivery permission → View batch action.
    expect(screen.getByRole("link", { name: "View batch" }).getAttribute("href")).toBe(
      "/warehouse/deliveries/batch-1",
    );
  });

  it("renders COD formatted from paisa when the field is present", async () => {
    details = { "sess-1": detailFor(deliveryItem, { codCollectedPaisa: "123450" }) };
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: /Delivery Driver/ }));
    expect(await screen.findByText("COD collected")).toBeTruthy();
    expect(screen.getByText("NPR 1,234.50")).toBeTruthy();
  });

  it("shows trip + manifest actions for a line-haul movement on the warehouse dashboard", async () => {
    details = { "sess-2": detailFor(linehaulItem) };
    renderBoard();
    fireEvent.click(await screen.findByRole("button", { name: /Linehaul Driver/ }));
    expect(await screen.findByText("Packages (2)")).toBeTruthy();
    expect(screen.getByRole("link", { name: "View trip" }).getAttribute("href")).toBe(
      "/warehouse/transfers/transfer-1",
    );
    expect(screen.getByRole("link", { name: "View manifest" }).getAttribute("href")).toBe(
      "/warehouse/transfers/transfer-1/manifest",
    );
    // No driver-detail route exists anywhere — the action is omitted.
    expect(screen.queryByRole("link", { name: /driver/i })).toBeNull();
  });

  it("hides trip/batch actions on the admin dashboard (no transfers tree there)", async () => {
    details = { "sess-1": detailFor(deliveryItem) };
    renderBoard("/admin");
    fireEvent.click(await screen.findByRole("button", { name: /Delivery Driver/ }));
    expect(await screen.findByText("Packages (2)")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "View batch" })).toBeNull();
    expect(screen.queryByRole("link", { name: "View trip" })).toBeNull();
  });

  it("clicking a map marker selects the same movement and loads its detail", async () => {
    details = { "sess-1": detailFor(deliveryItem), "sess-2": detailFor(linehaulItem) };
    renderBoard();
    await screen.findByText("Delivery Driver");
    const markers = await screen.findAllByTestId("map-marker");
    expect(markers.length).toBeGreaterThan(0);
    fireEvent.click(markers[0]);
    await waitFor(() =>
      expect(fetchCalls.some((url) => url.startsWith("/api/live-operations/sess-"))).toBe(true),
    );
  });
});

describe("LiveOperationsBoard — polling and failure handling", () => {
  it("polls every 50s only while visible, and refetches immediately on visibility return", async () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    renderBoard();
    await act(async () => {});
    expect(listCalls()).toHaveLength(1);
    expect(screen.getByText("Delivery Driver")).toBeTruthy();

    // 50s while visible → one more fetch.
    await act(async () => {
      vi.advanceTimersByTime(50_000);
    });
    expect(listCalls()).toHaveLength(2);

    // Hidden: the interval fires but must not fetch.
    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(150_000);
    });
    expect(listCalls()).toHaveLength(2);

    // Visible again → immediate fetch without waiting for the interval.
    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(listCalls()).toHaveLength(3);
  });

  it("keeps the last good rows and shows a Retry banner when a refresh fails", async () => {
    renderBoard();
    expect(await screen.findByText("Delivery Driver")).toBeTruthy();

    failList = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/may be stale/)).toBeTruthy();
    // Previous rows are still on screen.
    expect(screen.getByText("Delivery Driver")).toBeTruthy();
    expect(screen.getByText("Linehaul Driver")).toBeTruthy();

    failList = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("Delivery Driver")).toBeTruthy();
  });
});

describe("LiveMap", () => {
  it("defaults to the Nepal centre, draws warehouse markers, accuracy circle and the straight-line connector only for the selected movement", async () => {
    render(
      <LiveMap
        items={[deliveryItem, linehaulItem, waitingItem]}
        selectedId="sess-2"
        onSelect={() => undefined}
        warehouseCoords={WAREHOUSE_COORDS}
        selectedWarehouseId={null}
        onShowAllAuthorized={() => undefined}
      />,
    );
    await screen.findByTestId("live-map");
    expect(recorded.mapProps[0].center).toEqual([28.3949, 84.124]);
    expect(recorded.mapProps[0].zoom).toBe(7);
    const positions = recorded.markers.map((m) => JSON.stringify(m.position));
    // 2 driver markers + origin/destination warehouse markers for the
    // selected line-haul movement; the waiting movement has none.
    expect(positions).toContain(JSON.stringify([27.7172, 85.324]));
    expect(positions).toContain(JSON.stringify([28.2096, 83.9856]));
    expect(recorded.markers).toHaveLength(4);
    // Accuracy circle for the selected driver, radius = accuracyMeters.
    expect(recorded.circles).toEqual([{ center: [27.9, 84.9], radius: 40 }]);
    // Dashed straight-line connector: current position → destination.
    expect(recorded.polylines).toEqual([
      { positions: [[27.9, 84.9], [28.2096, 83.9856]] },
    ]);
  });
});
