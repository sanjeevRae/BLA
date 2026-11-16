"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  TrackingEngine,
  sessionStorageSequenceStorage,
  type EngineSnapshot,
  type GeoErrorLike,
  type GeoFix,
  type GeolocationLike,
  type OutgoingPing,
  type SendOutcome,
  type WatchdogState,
} from "@/lib/tracking/client-engine";
import { registerTrackingEngine } from "@/lib/tracking/client-registry";
import { ErrorBox, SectionCard } from "@/components/warehouses/ui";
import type {
  OwnTrackingAssignmentSummary,
  OwnTrackingState,
} from "@/server/services/tracking";

/**
 * Phase 4 (V2) — the driver/rider Location Tracking panel.
 *
 * Mounted in the rider and line-haul driver dashboard layouts so
 * the watch survives in-dashboard navigation (the batch/trip
 * pages are where the work happens). The panel is honest by
 * construction:
 *
 * - tracking starts only from an eligible assignment, only after
 *   the on-screen explanation, and only after the browser grants
 *   permission — a denial never creates a session;
 * - while ACTIVE it shows the last successful update, the GPS
 *   accuracy, the network state, and any unsent position;
 * - a geolocation error or a stall flips it out of the "tracking
 *   on" presentation immediately;
 * - it states plainly that updates pause while the app is in the
 *   background — no background-tracking claims.
 */

const bigPrimaryClass =
  "min-h-[48px] rounded-md bg-brand px-4 py-3 text-[14px] font-semibold text-white disabled:opacity-60";
const bigSubtleClass =
  "min-h-[48px] rounded-md border border-line bg-surface px-4 py-3 text-[14px] font-semibold text-ink disabled:opacity-60";
const bigDangerClass =
  "min-h-[48px] rounded-md border border-line bg-surface px-4 py-3 text-[14px] font-semibold text-red disabled:opacity-60";

// ---------------------------------------------------------------------------
// Browser glue
// ---------------------------------------------------------------------------

function toFix(pos: GeolocationPosition): GeoFix {
  return {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracyMeters: pos.coords.accuracy,
    speedMetersPerSecond: pos.coords.speed ?? null,
    headingDegrees: pos.coords.heading ?? null,
    recordedAt: pos.timestamp,
  };
}

function toGeoError(err: GeolocationPositionError): GeoErrorLike {
  return { code: err.code, message: err.message };
}

function browserGeolocation(): GeolocationLike | null {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) return null;
  return {
    watchPosition: (success, error, options) =>
      navigator.geolocation.watchPosition(
        (pos) => success(toFix(pos)),
        (err) => error(toGeoError(err)),
        options,
      ),
    clearWatch: (id) => navigator.geolocation.clearWatch(id),
    getCurrentPosition: (success, error, options) =>
      navigator.geolocation.getCurrentPosition(
        (pos) => success(toFix(pos)),
        (err) => error(toGeoError(err)),
        options,
      ),
  };
}

function geoSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator !== "undefined" &&
    "geolocation" in navigator
  );
}

async function sendPingRequest(ping: OutgoingPing): Promise<SendOutcome> {
  try {
    const res = await fetch("/api/tracking/location", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ping),
    });
    if (res.ok) {
      const body: unknown = await res.json().catch(() => null);
      const deduplicated =
        body !== null &&
        typeof body === "object" &&
        "deduplicated" in body &&
        (body as { deduplicated: unknown }).deduplicated === true;
      return { ok: true, deduplicated };
    }
    return { ok: false, status: res.status };
  } catch {
    return { ok: false };
  }
}

async function loadCurrentState(): Promise<OwnTrackingState> {
  const res = await fetch("/api/tracking/session/current", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as OwnTrackingState;
}

async function postSessionAction(
  action: "pause" | "resume" | "stop",
  trackingSessionId: string,
): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`/api/tracking/session/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackingSessionId }),
    });
    if (res.ok) return { ok: true };
    const body: unknown = await res.json().catch(() => null);
    const message =
      body !== null &&
      typeof body === "object" &&
      "error" in body &&
      body.error !== null &&
      typeof body.error === "object" &&
      "message" in body.error &&
      typeof (body.error as { message: unknown }).message === "string"
        ? (body.error as { message: string }).message
        : undefined;
    return { ok: false, message };
  } catch {
    return { ok: false, message: "Network error — please try again." };
  }
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

function endReasonCopy(reason: string | null): string {
  switch (reason) {
    case "DRIVER":
      return "You ended tracking.";
    case "SUPERVISOR":
      return "Tracking was ended by a supervisor.";
    case "ASSIGNMENT_COMPLETED":
      return "Tracking ended because the assignment was completed.";
    case "ASSIGNMENT_CANCELLED":
      return "Tracking ended because the assignment was cancelled.";
    case "EXPIRED":
      return "Tracking ended because updates had stopped for too long.";
    default:
      return "Tracking has ended.";
  }
}

function geoErrorCopy(error: GeoErrorLike): string {
  switch (error.code) {
    case 0:
      return "This device or browser cannot provide location, so no position is being received.";
    case 1:
      return "Location permission is off. No position is being received — turn location back on for this site in your browser settings.";
    case 2:
      return "Position unavailable — the device cannot get a GPS fix right now.";
    case 3:
      return "Getting a GPS fix is taking too long (timed out).";
    default:
      return "Location problem: no position is being received.";
  }
}

function agoLabel(atMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min ago`;
}

function assignmentLine(a: OwnTrackingAssignmentSummary): string {
  const route =
    a.destinationWarehouseCode !== null
      ? `${a.originWarehouseCode} → ${a.destinationWarehouseCode}`
      : a.originWarehouseCode;
  const counts =
    a.completedCount !== null
      ? `${a.packageCount} package(s) · ${a.completedCount} done`
      : `${a.packageCount} package(s)`;
  return `${a.label} · ${route} · ${counts}`;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export function LocationTrackingPanel({ variant }: { variant: "rider" | "driver" }) {
  const [data, setData] = useState<OwnTrackingState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [engineUi, setEngineUi] = useState<{
    snap: EngineSnapshot | null;
    health: WatchdogState;
  }>({ snap: null, health: { state: "ok" } });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [online, setOnline] = useState(() =>
    typeof navigator !== "undefined" ? navigator.onLine : true,
  );
  const [docVisible, setDocVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState === "visible",
  );
  const [startingKey, setStartingKey] = useState<string | null>(null);
  const [permDenied, setPermDenied] = useState(false);
  const [startUnavailable, setStartUnavailable] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [endedDismissed, setEndedDismissed] = useState(false);
  const [supported] = useState<boolean>(() => geoSupported());

  const engineRef = useRef<TrackingEngine | null>(null);
  const firstFixRef = useRef<GeoFix | null>(null);
  const dataRef = useRef<OwnTrackingState | null>(null);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  /** Copy the engine's live state into React state. Called only
   *  from async/event contexts (engine callbacks, timers, fetch
   *  completions) — never synchronously from an effect body. */
  const syncEngineUi = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) {
      setEngineUi({ snap: null, health: { state: "ok" } });
      return;
    }
    setEngineUi({ snap: engine.getSnapshot(), health: engine.health() });
  }, []);

  const fetchCurrent = useCallback(async () => {
    try {
      const body = await loadCurrentState();
      setData(body);
      setLoadError(null);
    } catch {
      setLoadError("Could not load your tracking state. Check your connection and retry.");
    }
  }, []);

  // Initial load + periodic resync (detects supervisor stops and
  // assignment-completion auto-ends while a session is live).
  useEffect(() => {
    let cancelled = false;
    loadCurrentState()
      .then((body) => {
        if (!cancelled) {
          setData(body);
          setLoadError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError("Could not load your tracking state. Check your connection and retry.");
        }
      });
    const id = window.setInterval(() => {
      const session = dataRef.current?.session;
      if (session && (session.status === "ACTIVE" || session.status === "PAUSED")) {
        void fetchCurrent();
      }
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [fetchCurrent]);

  // 5-second tick: relative times, the watchdog, engine UI sync.
  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now());
      syncEngineUi();
    }, 5_000);
    return () => window.clearInterval(id);
  }, [syncEngineUi]);

  // Network + visibility wiring.
  useEffect(() => {
    const onOnline = () => {
      setOnline(true);
      engineRef.current?.handleOnline();
      syncEngineUi();
    };
    const onOffline = () => setOnline(false);
    const onVisibility = () => {
      const visible = document.visibilityState === "visible";
      setDocVisible(visible);
      engineRef.current?.setVisible(visible);
      syncEngineUi();
      if (visible) void fetchCurrent();
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [fetchCurrent, syncEngineUi]);

  // Engine lifecycle, driven by the server-confirmed session
  // state. No setState here: the engine reports through its
  // onEvent callback and the 5-second tick syncs the UI copy.
  const session = data?.session ?? null;
  const sessionId = session?.id ?? null;
  const sessionStatus = session?.status ?? null;
  useEffect(() => {
    const engine = engineRef.current;
    if (!sessionId || !data) {
      engine?.detach();
      registerTrackingEngine(null);
      return;
    }
    if (sessionStatus === "ACTIVE") {
      let eng = engine;
      if (!eng) {
        eng = new TrackingEngine({
          geolocation: browserGeolocation(),
          sendPing: sendPingRequest,
          storage: sessionStorageSequenceStorage(),
          onEvent: (event) => {
            if (event.type === "session-invalid") {
              void fetchCurrent();
            }
            syncEngineUi();
          },
        });
        engineRef.current = eng;
      }
      eng.attach({
        sessionId,
        trackingType: session?.trackingType ?? "DELIVERY",
        config: data.clientConfig,
      });
      registerTrackingEngine(eng);
      if (document.visibilityState === "visible") eng.startWatch();
      if (firstFixRef.current) {
        eng.sendImmediate(firstFixRef.current);
        firstFixRef.current = null;
      }
      return;
    }
    if (sessionStatus === "PAUSED") {
      engine?.stopWatch();
      registerTrackingEngine(null);
      return;
    }
    // ENDED
    engine?.detach();
    registerTrackingEngine(null);
  }, [sessionId, sessionStatus, session?.trackingType, data, fetchCurrent, syncEngineUi]);

  // Unmount: stop everything.
  useEffect(() => {
    return () => {
      engineRef.current?.detach();
      registerTrackingEngine(null);
    };
  }, []);

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  async function handleStart(assignment: OwnTrackingAssignmentSummary) {
    setActionError(null);
    setPermDenied(false);
    setStartUnavailable(false);
    if (!geoSupported()) {
      setStartUnavailable(true);
      return;
    }
    const key = assignment.tripId ?? assignment.deliveryBatchId ?? "";
    setStartingKey(key);
    // 1) Ask the browser FIRST. Only a grant may create a session.
    let fix: GeoFix;
    try {
      fix = await new Promise<GeoFix>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve(toFix(pos)),
          (err) => reject(err),
          { enableHighAccuracy: true, timeout: 20_000, maximumAge: 0 },
        );
      });
    } catch (err) {
      setStartingKey(null);
      const code = (err as GeolocationPositionError)?.code;
      if (code === 1) setPermDenied(true);
      else setStartUnavailable(true);
      return;
    }
    // 2) Permission granted — start the session with the
    //    acknowledgement recorded server-side.
    try {
      const res = await fetch("/api/tracking/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(assignment.tripId
            ? { tripId: assignment.tripId }
            : { deliveryBatchId: assignment.deliveryBatchId }),
          permissionAcknowledged: true,
        }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const message =
          body !== null &&
          typeof body === "object" &&
          "error" in body &&
          body.error !== null &&
          typeof body.error === "object" &&
          "message" in body.error &&
          typeof (body.error as { message: unknown }).message === "string"
            ? (body.error as { message: string }).message
            : "Could not start tracking.";
        setActionError(message);
        setStartingKey(null);
        void fetchCurrent();
        return;
      }
    } catch {
      setActionError("Network error — tracking was not started. Please try again.");
      setStartingKey(null);
      return;
    }
    firstFixRef.current = fix;
    setStartingKey(null);
    setEndedDismissed(false);
    void fetchCurrent();
  }

  async function handleSessionAction(action: "pause" | "resume" | "stop") {
    if (!sessionId) return;
    setActionError(null);
    setBusyAction(action);
    const result = await postSessionAction(action, sessionId);
    setBusyAction(null);
    if (!result.ok) {
      setActionError(result.message ?? "That action did not go through. Please try again.");
    }
    void fetchCurrent();
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  const noun = variant === "driver" ? "trip" : "run";
  const now = nowMs;
  const engineSnap = engineUi.snap;
  const health: WatchdogState =
    sessionStatus === "ACTIVE" ? engineUi.health : { state: "ok" };

  return (
    <SectionCard title="Location tracking">
      <div className="flex flex-col gap-3">
        {data === null && loadError === null ? (
          <p className="text-[13px] text-slate2">Loading your tracking state…</p>
        ) : null}

        {loadError !== null ? (
          <div className="flex flex-col gap-2">
            <ErrorBox message={loadError} />
            <div>
              <button type="button" className={bigSubtleClass} onClick={() => void fetchCurrent()}>
                Retry
              </button>
            </div>
          </div>
        ) : null}

        {actionError !== null ? <ErrorBox message={actionError} /> : null}

        {/* ------------------------- ACTIVE ------------------------- */}
        {data !== null && sessionStatus === "ACTIVE" ? (
          <>
            {health.state === "error" ? (
              <div className="rounded-md border border-red/30 bg-redbg px-3 py-2">
                <p className="text-[13px] font-semibold text-red">Location problem</p>
                <p className="text-[13px] text-ink">{geoErrorCopy(health.error)}</p>
              </div>
            ) : health.state === "stalled" ? (
              <div className="rounded-md border border-line bg-amberbg px-3 py-2">
                <p className="text-[13px] font-semibold text-amber">Updates have stalled</p>
                <p className="text-[13px] text-ink">
                  {health.cause === "network"
                    ? "Positions are not reaching the server. Check your connection — the latest position will be sent when it returns."
                    : "No GPS fix has been received for a while. Keep this app on screen and move to an open area if you can."}
                </p>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-[13px] font-semibold text-green">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-green" />
                Tracking on
              </p>
            )}

            {data.sessionAssignment ? (
              <p className="text-[13px] text-slate2">{assignmentLine(data.sessionAssignment)}</p>
            ) : null}

            <div className="grid gap-1 text-[13px] text-ink">
              <p>
                Last update:{" "}
                {engineSnap?.lastSentAt
                  ? `${agoLabel(engineSnap.lastSentAt, now)} · accuracy ±${Math.round(engineSnap.lastSentFix?.accuracyMeters ?? 0)} m`
                  : data.lastPing
                    ? `${agoLabel(new Date(data.lastPing.receivedAt).getTime(), now)} · accuracy ±${Math.round(data.lastPing.accuracyMeters)} m`
                    : "no update sent yet"}
              </p>
              <p>
                Network:{" "}
                {online ? "online" : "offline — updates will resume when the connection returns"}
              </p>
              {engineSnap?.hasUnsent ? (
                <p className="text-amber">
                  Latest position not sent yet — it will retry automatically.
                </p>
              ) : null}
              {!docVisible ? (
                <p className="text-amber">App is in the background — updates are paused.</p>
              ) : null}
            </div>

            <p className="text-[12px] text-slate2">
              Updates are sent only while this app is open on your screen. If you lock your
              phone or switch apps, updates pause and your position shows as delayed — that
              is expected.
            </p>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={bigSubtleClass}
                disabled={busyAction !== null}
                onClick={() => void handleSessionAction("pause")}
              >
                {busyAction === "pause" ? "Pausing…" : "Pause"}
              </button>
              <button
                type="button"
                className={bigDangerClass}
                disabled={busyAction !== null}
                onClick={() => void handleSessionAction("stop")}
              >
                {busyAction === "stop" ? "Ending…" : "End tracking"}
              </button>
            </div>
          </>
        ) : null}

        {/* ------------------------- PAUSED ------------------------- */}
        {data !== null && sessionStatus === "PAUSED" ? (
          <>
            <p className="flex items-center gap-2 text-[13px] font-semibold text-amber">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber" />
              Tracking paused
            </p>
            {data.sessionAssignment ? (
              <p className="text-[13px] text-slate2">{assignmentLine(data.sessionAssignment)}</p>
            ) : null}
            <p className="text-[13px] text-ink">
              While paused, no location is sent. Resume when you are moving again.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={bigPrimaryClass}
                disabled={busyAction !== null}
                onClick={() => void handleSessionAction("resume")}
              >
                {busyAction === "resume" ? "Resuming…" : "Resume"}
              </button>
              <button
                type="button"
                className={bigDangerClass}
                disabled={busyAction !== null}
                onClick={() => void handleSessionAction("stop")}
              >
                {busyAction === "stop" ? "Ending…" : "End tracking"}
              </button>
            </div>
          </>
        ) : null}

        {/* ------------------ ELIGIBLE / NOT STARTED ------------------ */}
        {data !== null &&
        sessionStatus !== "ACTIVE" &&
        sessionStatus !== "PAUSED" &&
        data.eligibleAssignments.length > 0 ? (
          <>
            <p className="text-[13px] text-ink">
              When you start, this app shares your phone&apos;s location while the {noun} is
              running. Your admins and the warehouse admins for this {noun} can see your
              current position so they can coordinate the work. Tracking stops by itself
              when the {noun} finishes, and you can pause or end it at any time. Nothing is
              collected before you start or after it ends.
            </p>
            {permDenied ? (
              <div className="rounded-md border border-red/30 bg-redbg px-3 py-2">
                <p className="text-[13px] font-semibold text-red">Location permission is off</p>
                <p className="text-[13px] text-ink">
                  Tracking was not started. To turn it on: tap the lock or settings icon in
                  your browser&apos;s address bar, choose Location → Allow, then tap Start
                  again.
                </p>
              </div>
            ) : null}
            {startUnavailable ? (
              <div className="rounded-md border border-red/30 bg-redbg px-3 py-2">
                <p className="text-[13px] font-semibold text-red">GPS unavailable</p>
                <p className="text-[13px] text-ink">
                  This device or browser cannot provide a location right now, so tracking
                  cannot start. Check that location services are on, then try again.
                </p>
              </div>
            ) : null}
            {!supported ? (
              <p className="text-[13px] text-amber">
                This browser cannot share location (GPS unavailable), so tracking cannot be
                started here.
              </p>
            ) : null}
            <div className="flex flex-col gap-3">
              {data.eligibleAssignments.map((a) => {
                const key = a.tripId ?? a.deliveryBatchId ?? "";
                return (
                  <div
                    key={key}
                    className="flex flex-col gap-2 rounded-md border border-line bg-page px-3 py-3"
                  >
                    <p className="text-[13px] font-semibold text-ink">{assignmentLine(a)}</p>
                    <div>
                      <button
                        type="button"
                        className={bigPrimaryClass}
                        disabled={startingKey !== null || !supported}
                        onClick={() => void handleStart(a)}
                      >
                        {startingKey === key ? "Starting…" : "Start tracking"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}

        {/* ------------------------- ENDED ------------------------- */}
        {data !== null &&
        sessionStatus === "ENDED" &&
        data.eligibleAssignments.length === 0 &&
        !endedDismissed ? (
          <>
            <p className="flex items-center gap-2 text-[13px] font-semibold text-slate2">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-faint" />
              Tracking ended
            </p>
            <p className="text-[13px] text-ink">{endReasonCopy(session?.endReason ?? null)}</p>
            <div>
              <button type="button" className={bigSubtleClass} onClick={() => setEndedDismissed(true)}>
                Dismiss
              </button>
            </div>
          </>
        ) : null}

        {/* --------------------- NO ASSIGNMENT --------------------- */}
        {data !== null &&
        (sessionStatus === null || (sessionStatus === "ENDED" && endedDismissed)) &&
        data.eligibleAssignments.length === 0 ? (
          <p className="text-[13px] text-slate2">
            No active {noun} right now. Tracking starts here when a {noun} is assigned to
            you — it never starts on its own.
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}
