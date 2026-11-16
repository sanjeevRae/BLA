// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { LocationTrackingPanel } from "@/components/tracking/LocationTrackingPanel";
import type {
  OwnTrackingAssignmentSummary,
  OwnTrackingState,
} from "@/server/services/tracking";

/**
 * Phase 4 (V2) — Location Tracking panel states, with mocked
 * fetch + geolocation. The critical honesty contracts:
 *  - a permission denial NEVER calls session/start;
 *  - an unsupported browser cannot start;
 *  - a watch error replaces the "Tracking on" presentation
 *    immediately;
 *  - paused / ended states render with their controls / reason.
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
let fetchCalls: { url: string; method: string; body: unknown }[] = [];

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function installFetch() {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body) as unknown) : undefined;
    fetchCalls.push({ url, method, body });
    if (url.endsWith("/api/tracking/session/current")) {
      return jsonResponse(currentState);
    }
    if (url.endsWith("/api/tracking/session/start")) {
      currentState = stateWith({
        session: sessionView("ACTIVE") as OwnTrackingState["session"],
        sessionAssignment: BATCH_ASSIGNMENT,
      });
      return jsonResponse(sessionView("ACTIVE"), true, 201);
    }
    if (url.endsWith("/api/tracking/session/pause")) {
      currentState = stateWith({
        session: sessionView("PAUSED") as OwnTrackingState["session"],
        sessionAssignment: BATCH_ASSIGNMENT,
      });
      return jsonResponse(sessionView("PAUSED"));
    }
    if (url.endsWith("/api/tracking/session/resume")) {
      currentState = stateWith({
        session: sessionView("ACTIVE") as OwnTrackingState["session"],
        sessionAssignment: BATCH_ASSIGNMENT,
      });
      return jsonResponse(sessionView("ACTIVE"));
    }
    if (url.endsWith("/api/tracking/session/stop")) {
      currentState = stateWith({
        session: sessionView("ENDED", {
          endedAt: new Date().toISOString(),
          endReason: "DRIVER",
        }) as OwnTrackingState["session"],
      });
      return jsonResponse(sessionView("ENDED"));
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

// --- geolocation mock ------------------------------------------------

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

function installGeolocation(mode: "grant" | "deny" | "unavailable" = "grant") {
  // jsdom leaves isSecureContext undefined; real browsers always
  // define it (and localhost/HTTPS are secure contexts).
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  geo = {
    watchSuccess: null,
    watchError: null,
    getCurrentPosition: vi.fn((success: (p: GeolocationPosition) => void, error: (e: GeolocationPositionError) => void) => {
      if (mode === "grant") success(position());
      else error({ code: mode === "deny" ? 1 : 2, message: "mock" } as GeolocationPositionError);
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

function removeGeolocation() {
  // The property must be ABSENT (as in a browser without the API);
  // defining it as undefined would still satisfy `"geolocation" in
  // navigator`.
  delete (navigator as { geolocation?: unknown }).geolocation;
}

beforeEach(() => {
  installFetch();
  installGeolocation("grant");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------

describe("LocationTrackingPanel", () => {
  it("shows the no-assignment state and offers no controls", async () => {
    currentState = stateWith({});
    render(<LocationTrackingPanel variant="rider" />);
    expect(await screen.findByText(/No active run right now/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Start tracking/ })).toBeNull();
  });

  it("shows the consent explanation and the eligible assignment before any prompt", async () => {
    currentState = stateWith({ eligibleAssignments: [BATCH_ASSIGNMENT] });
    render(<LocationTrackingPanel variant="rider" />);
    expect(await screen.findByText(/shares your phone's location while the run is running/)).toBeTruthy();
    expect(screen.getByText(/KTM · 2026-11-16/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start tracking" })).toBeTruthy();
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
  });

  it("starts only after a permission grant, then shows Tracking on", async () => {
    currentState = stateWith({ eligibleAssignments: [BATCH_ASSIGNMENT] });
    render(<LocationTrackingPanel variant="rider" />);
    fireEvent.click(await screen.findByRole("button", { name: "Start tracking" }));
    await waitFor(() => {
      expect(callsTo("/api/tracking/session/start")).toHaveLength(1);
    });
    const startBody = callsTo("/api/tracking/session/start")[0].body as Record<string, unknown>;
    expect(startBody.deliveryBatchId).toBe("batch-1");
    expect(startBody.permissionAcknowledged).toBe(true);
    expect(await screen.findByText("Tracking on")).toBeTruthy();
    // The watch is running and the granted fix went out as a ping.
    expect(geo.watchPosition).toHaveBeenCalled();
    await waitFor(() => {
      expect(callsTo("/api/tracking/location").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("never starts a session when permission is denied", async () => {
    installGeolocation("deny");
    currentState = stateWith({ eligibleAssignments: [BATCH_ASSIGNMENT] });
    render(<LocationTrackingPanel variant="rider" />);
    fireEvent.click(await screen.findByRole("button", { name: "Start tracking" }));
    expect(await screen.findByText("Location permission is off")).toBeTruthy();
    expect(screen.getByText(/Tracking was not started/)).toBeTruthy();
    expect(callsTo("/api/tracking/session/start")).toHaveLength(0);
  });

  it("cannot start when the browser has no geolocation", async () => {
    removeGeolocation();
    currentState = stateWith({ eligibleAssignments: [BATCH_ASSIGNMENT] });
    render(<LocationTrackingPanel variant="rider" />);
    const button = (await screen.findByRole("button", {
      name: "Start tracking",
    })) as HTMLButtonElement;
    expect(await screen.findByText(/cannot share location \(GPS unavailable\)/)).toBeTruthy();
    expect(button.disabled).toBe(true);
  });

  it("flips to the error state immediately when the watch errors", async () => {
    currentState = stateWith({
      session: sessionView("ACTIVE") as OwnTrackingState["session"],
      sessionAssignment: BATCH_ASSIGNMENT,
    });
    render(<LocationTrackingPanel variant="rider" />);
    expect(await screen.findByText("Tracking on")).toBeTruthy();
    await waitFor(() => expect(geo.watchError).not.toBeNull());
    act(() => {
      geo.watchError?.({ code: 2, message: "unavailable" } as GeolocationPositionError);
    });
    expect(await screen.findByText("Location problem")).toBeTruthy();
    expect(screen.queryByText("Tracking on")).toBeNull();
  });

  it("renders the paused state and resumes through the route", async () => {
    currentState = stateWith({
      session: sessionView("PAUSED") as OwnTrackingState["session"],
      sessionAssignment: BATCH_ASSIGNMENT,
    });
    render(<LocationTrackingPanel variant="rider" />);
    expect(await screen.findByText("Tracking paused")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => {
      expect(callsTo("/api/tracking/session/resume")).toHaveLength(1);
    });
    expect(await screen.findByText("Tracking on")).toBeTruthy();
  });

  it("pauses through the route from the active state", async () => {
    currentState = stateWith({
      session: sessionView("ACTIVE") as OwnTrackingState["session"],
      sessionAssignment: BATCH_ASSIGNMENT,
    });
    render(<LocationTrackingPanel variant="rider" />);
    expect(await screen.findByText("Tracking on")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(callsTo("/api/tracking/session/pause")).toHaveLength(1);
    });
    expect(await screen.findByText("Tracking paused")).toBeTruthy();
  });

  it("shows the ended state with the completion reason", async () => {
    currentState = stateWith({
      session: sessionView("ENDED", {
        endedAt: new Date().toISOString(),
        endReason: "ASSIGNMENT_COMPLETED",
      }) as OwnTrackingState["session"],
    });
    render(<LocationTrackingPanel variant="driver" />);
    expect(await screen.findByText("Tracking ended")).toBeTruthy();
    expect(screen.getByText(/assignment was completed/)).toBeTruthy();
  });

  it("states the foreground-only limitation while active", async () => {
    currentState = stateWith({
      session: sessionView("ACTIVE") as OwnTrackingState["session"],
      sessionAssignment: BATCH_ASSIGNMENT,
    });
    render(<LocationTrackingPanel variant="driver" />);
    expect(await screen.findByText(/only while this app is open on your screen/)).toBeTruthy();
  });
});
