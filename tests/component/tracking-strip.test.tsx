// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { TrackingStrip } from "@/components/tracking/TrackingStrip";
import type {
  OwnTrackingAssignmentSummary,
  OwnTrackingState,
} from "@/server/services/tracking";

/**
 * V3 Step 6 — TrackingStrip: the compact header summarises the
 * SAME /api/tracking/session/current state the panel uses, and
 * the expandable region mounts the REAL LocationTrackingPanel
 * (framed={false}) — hidden with `hidden` only, never unmounted,
 * so the panel's engine lifecycle is untouched. Fetch is stubbed
 * by URL because BOTH the strip and the panel inside it read
 * session/current; geolocation is stubbed as in the panel tests
 * because the mounted panel's effects run.
 */

const CLIENT_CONFIG: OwnTrackingState["clientConfig"] = {
  minPingIntervalSeconds: 30,
  movingIntervalSeconds: { PICKUP: 150, DELIVERY: 150, LINEHAUL: 240 },
  stationaryHeartbeatSeconds: 600,
  movementThresholdMeters: 25,
  freshWithinSeconds: 300,
  delayedWithinSeconds: 900,
};

const BATCH_ASSIGNMENT: OwnTrackingAssignmentSummary = {
  kind: "BATCH",
  tripId: null,
  deliveryBatchId: "batch-1",
  trackingType: "DELIVERY",
  label: "KTM · 2026-11-16",
  originWarehouseCode: "KTM",
  originWarehouseName: "Kathmandu",
  destinationWarehouseCode: null,
  destinationWarehouseName: null,
  status: "OPEN",
  packageCount: 5,
  completedCount: 1,
};

function stateWith(overrides: Partial<OwnTrackingState>): OwnTrackingState {
  return {
    session: null,
    sessionAssignment: null,
    eligibleAssignments: [],
    lastPing: null,
    clientConfig: CLIENT_CONFIG,
    ...overrides,
  };
}

function sessionView(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "sess-1",
    driverId: "driver-1",
    tripId: null,
    deliveryBatchId: "batch-1",
    trackingType: "DELIVERY",
    originWarehouseId: "wh-1",
    destinationWarehouseId: null,
    status,
    startedAt: new Date().toISOString(),
    endedAt: null,
    startReason: "DRIVER",
    endReason: null,
    permissionAcknowledgedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// --- fetch mock -----------------------------------------------------

let currentState: OwnTrackingState;
let fetchCalls: { url: string; method: string }[] = [];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function installFetch() {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    fetchCalls.push({ url, method });
    if (url.endsWith("/api/tracking/session/current")) {
      return jsonResponse(currentState);
    }
    if (url.endsWith("/api/tracking/location")) {
      return jsonResponse({ deduplicated: false, ping: {}, freshnessState: "FRESH" });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
}

function callsTo(path: string) {
  return fetchCalls.filter((c) => c.url.endsWith(path));
}

// --- geolocation mock (same shape as the panel tests) ---------------

interface GeoMock {
  watchSuccess: ((pos: GeolocationPosition) => void) | null;
  watchError: ((err: GeolocationPositionError) => void) | null;
  getCurrentPosition: ReturnType<typeof vi.fn>;
  watchPosition: ReturnType<typeof vi.fn>;
  clearWatch: ReturnType<typeof vi.fn>;
}

let geo: GeoMock;

function position(latitude = 27.7, longitude = 85.3): GeolocationPosition {
  return {
    coords: {
      latitude,
      longitude,
      accuracy: 12,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: Date.now(),
  } as GeolocationPosition;
}

function installGeolocation() {
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  geo = {
    watchSuccess: null,
    watchError: null,
    getCurrentPosition: vi.fn((success: (p: GeolocationPosition) => void) => {
      success(position());
    }),
    watchPosition: vi.fn((success: (p: GeolocationPosition) => void, error: (e: GeolocationPositionError) => void) => {
      geo.watchSuccess = success;
      geo.watchError = error;
      return 7;
    }),
    clearWatch: vi.fn(),
  };
  Object.defineProperty(navigator, "geolocation", { value: geo, configurable: true });
}

beforeEach(() => {
  installFetch();
  installGeolocation();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------

describe("TrackingStrip", () => {
  it("no session + eligible: shows 'Tracking off — tap to start', region hidden until toggled, toggle resyncs", async () => {
    currentState = stateWith({ eligibleAssignments: [BATCH_ASSIGNMENT] });
    render(<TrackingStrip variant="rider" />);

    const toggle = await screen.findByRole("button", {
      name: /Tracking off — tap to start/,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const regionId = toggle.getAttribute("aria-controls");
    expect(regionId).toBeTruthy();
    const region = document.getElementById(regionId as string);
    expect(region).not.toBeNull();
    // Collapsed by default: hidden attribute only — the panel
    // stays mounted inside (its content is in the DOM).
    expect((region as HTMLElement).hasAttribute("hidden")).toBe(true);

    const callsBefore = callsTo("/api/tracking/session/current").length;
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect((region as HTMLElement).hasAttribute("hidden")).toBe(false);
    // The toggle click triggers a resync of session/current.
    await waitFor(() => {
      expect(callsTo("/api/tracking/session/current").length).toBeGreaterThan(callsBefore);
    });
  });

  it("ACTIVE + lastPing FRESH: shows 'Location sharing on' with an 'Updated … ago' freshness line", async () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    currentState = stateWith({
      session: sessionView("ACTIVE") as OwnTrackingState["session"],
      sessionAssignment: BATCH_ASSIGNMENT,
      lastPing: {
        recordedAt: twoMinutesAgo,
        receivedAt: twoMinutesAgo,
        accuracyMeters: 12,
        freshnessState: "FRESH",
      },
    });
    render(<TrackingStrip variant="rider" />);

    const toggle = await screen.findByRole("button", { name: /Location sharing on/ });
    expect(toggle.textContent).toContain("Location sharing on");
    expect(toggle.textContent).toMatch(/Updated .* ago/);
    expect(toggle.textContent).toContain("Updated 2 min ago");
  });

  it("PAUSED: shows 'Tracking paused' on the strip header", async () => {
    currentState = stateWith({
      session: sessionView("PAUSED") as OwnTrackingState["session"],
      sessionAssignment: BATCH_ASSIGNMENT,
    });
    render(<TrackingStrip variant="driver" />);

    const toggle = await screen.findByRole("button", { name: /Tracking paused/ });
    expect(toggle.textContent).toContain("Tracking paused");
  });

  it("mounts the real panel inside the region: its consent text renders for eligible assignments", async () => {
    currentState = stateWith({ eligibleAssignments: [BATCH_ASSIGNMENT] });
    render(<TrackingStrip variant="rider" />);

    // The panel's own consent copy — proof the real panel (not a
    // copy) is mounted inside the strip, even while collapsed.
    expect(
      await screen.findByText(/shares your phone's location while the run is running/),
    ).toBeTruthy();
    // hidden: true — the button sits inside the collapsed (hidden)
    // region; it is mounted in the DOM but out of the a11y tree.
    expect(screen.getByRole("button", { name: "Start tracking", hidden: true })).toBeTruthy();
  });
});
