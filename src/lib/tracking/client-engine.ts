/**
 * Phase 4 (V2) — driver-side GPS sending engine.
 *
 * Framework-thin and dependency-injected so the whole behaviour
 * (throttle, dedupe, sequence, latest-wins retry, watchdog) is
 * unit-testable without a browser. The React panel owns the DOM
 * listeners (online/offline, visibility) and calls into the
 * engine; the engine owns the watchPosition lifecycle and every
 * decision about whether a fix becomes a ping.
 *
 * Honesty rules baked in:
 * - a watch error is surfaced immediately — the engine never
 *   reports "active" while fixes have stopped;
 * - sends never happen faster than the server floor, and the
 *   cadence comes from the server-exposed config, never from a
 *   second hardcoded source;
 * - a failed send keeps ONLY the latest position (latest-wins) —
 *   there is no growing offline queue, and unsent state is
 *   visible to the panel at all times.
 */

import type { TrackingClientConfig } from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeoFix {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
  /** Device clock, epoch milliseconds. */
  recordedAt: number;
}

/** GeolocationPositionError-shaped: code 1 permission denied,
 *  2 position unavailable, 3 timeout. Code 0 is used locally for
 *  "geolocation unsupported / insecure context". */
export interface GeoErrorLike {
  code: number;
  message: string;
}

export interface GeolocationLike {
  watchPosition(
    success: (fix: GeoFix) => void,
    error: (error: GeoErrorLike) => void,
    options?: { enableHighAccuracy?: boolean; maximumAge?: number; timeout?: number },
  ): number;
  clearWatch(watchId: number): void;
  getCurrentPosition?(
    success: (fix: GeoFix) => void,
    error: (error: GeoErrorLike) => void,
    options?: { enableHighAccuracy?: boolean; maximumAge?: number; timeout?: number },
  ): void;
}

export interface OutgoingPing {
  trackingSessionId: string;
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedMetersPerSecond: number | null;
  headingDegrees: number | null;
  recordedAt: string;
  sequenceId: number;
}

export type SendOutcome =
  | { ok: true; deduplicated: boolean }
  | { ok: false; status?: number; code?: string };

export interface SequenceStorage {
  read(sessionId: string): number;
  write(sessionId: string, value: number): void;
}

export type EngineEvent =
  | { type: "fix"; fix: GeoFix }
  | { type: "sent"; fix: GeoFix; sequenceId: number; deduplicated: boolean }
  | { type: "send-failed"; fix: GeoFix; status?: number }
  | { type: "geo-error"; error: GeoErrorLike }
  | { type: "session-invalid"; status?: number };

export interface EngineDeps {
  geolocation: GeolocationLike | null;
  sendPing: (ping: OutgoingPing) => Promise<SendOutcome>;
  now?: () => number;
  storage?: SequenceStorage;
  onEvent?: (event: EngineEvent) => void;
}

export interface EngineContext {
  sessionId: string;
  trackingType: "PICKUP" | "DELIVERY" | "LINEHAUL" | string;
  config: TrackingClientConfig;
}

export interface EngineSnapshot {
  watching: boolean;
  lastFix: GeoFix | null;
  lastSentFix: GeoFix | null;
  lastSentAt: number | null;
  hasUnsent: boolean;
  lastError: GeoErrorLike | null;
  startedAt: number | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const EARTH_RADIUS_METERS = 6_371_000;

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export type SendDecisionReason =
  | "initial"
  | "moved"
  | "heartbeat"
  | "event"
  | "duplicate"
  | "too-soon"
  | "waiting-interval"
  | "stationary";

export interface SendDecision {
  send: boolean;
  reason: SendDecisionReason;
}

/**
 * Decide whether `fix` should be reported now.
 *
 * - an event send always goes out (the server deduplicates and
 *   rate-limits authoritatively);
 * - the first fix of a session always goes out;
 * - nothing else goes out inside the server minimum interval —
 *   the floor beats every other rule below;
 * - identical coordinates never go out twice (the server
 *   deduplicates them too) — unless the stationary heartbeat has
 *   elapsed, in which case the fix is offered as a liveness
 *   report (real devices jitter, so it normally lands as a new
 *   fix server-side);
 * - otherwise a fix goes out when the device has moved beyond
 *   the distance threshold AND the moving interval has elapsed,
 *   or when the stationary heartbeat has elapsed.
 */
export function decidePingSend(input: {
  lastSent: { latitude: number; longitude: number; at: number } | null;
  fix: GeoFix;
  now: number;
  movingIntervalMs: number;
  heartbeatMs: number;
  minIntervalMs: number;
  thresholdMeters: number;
  force?: boolean;
}): SendDecision {
  const { lastSent, fix, now } = input;
  if (input.force) return { send: true, reason: "event" };
  if (!lastSent) return { send: true, reason: "initial" };
  const elapsed = now - lastSent.at;
  // The server minimum interval is a hard floor for every
  // non-event send — including the identical-coordinate heartbeat
  // (Phase 4 security review F2: a legal config can set the
  // heartbeat below the floor, and the floor must win).
  if (elapsed < input.minIntervalMs) return { send: false, reason: "too-soon" };
  const identical = fix.latitude === lastSent.latitude && fix.longitude === lastSent.longitude;
  if (identical) {
    if (elapsed >= input.heartbeatMs) return { send: true, reason: "heartbeat" };
    return { send: false, reason: "duplicate" };
  }
  const distance = haversineMeters(lastSent.latitude, lastSent.longitude, fix.latitude, fix.longitude);
  if (distance >= input.thresholdMeters) {
    if (elapsed >= input.movingIntervalMs) return { send: true, reason: "moved" };
    return { send: false, reason: "waiting-interval" };
  }
  if (elapsed >= input.heartbeatMs) return { send: true, reason: "heartbeat" };
  return { send: false, reason: "stationary" };
}

export type WatchdogState =
  | { state: "ok" }
  | { state: "error"; error: GeoErrorLike }
  | { state: "stalled"; cause: "gps" | "network" };

/**
 * Health of a running session. "Stalled" fires when fixes or
 * successful sends stop flowing for more than ~2× the send
 * interval — the panel must show this instead of a stale
 * "tracking active".
 */
export function watchdogStatus(input: {
  now: number;
  startedAt: number | null;
  lastFixAt: number | null;
  lastSentAt: number | null;
  hasUnsent: boolean;
  lastError: GeoErrorLike | null;
  intervalMs: number;
}): WatchdogState {
  if (input.lastError) return { state: "error", error: input.lastError };
  const limit = 2 * input.intervalMs;
  const fixRef = input.lastFixAt ?? input.startedAt;
  if (fixRef !== null && input.now - fixRef > limit) {
    return { state: "stalled", cause: "gps" };
  }
  if (
    input.hasUnsent &&
    input.lastSentAt !== null &&
    input.now - input.lastSentAt > limit
  ) {
    return { state: "stalled", cause: "network" };
  }
  return { state: "ok" };
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

interface PendingSend {
  fix: GeoFix;
  sequenceId: number;
}

export class TrackingEngine {
  private readonly deps: Required<Pick<EngineDeps, "sendPing">> & EngineDeps;
  private readonly now: () => number;
  private context: EngineContext | null = null;
  private watchId: number | null = null;
  private sequence = 0;
  private pending: PendingSend | null = null;
  private flushing = false;
  private lastFix: GeoFix | null = null;
  private lastFixAt: number | null = null;
  private lastSentFix: GeoFix | null = null;
  private lastSentAt: number | null = null;
  private lastError: GeoErrorLike | null = null;
  private startedAt: number | null = null;

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  private emit(event: EngineEvent): void {
    this.deps.onEvent?.(event);
  }

  /** Bind the engine to a session. Restores the sequence counter
   *  so it stays strictly increasing across panel remounts within
   *  the session. */
  attach(context: EngineContext): void {
    if (this.context?.sessionId === context.sessionId) {
      this.context = context;
      return;
    }
    this.stopWatch();
    this.context = context;
    this.sequence = this.deps.storage?.read(context.sessionId) ?? 0;
    this.pending = null;
    this.lastFix = null;
    this.lastFixAt = null;
    this.lastSentFix = null;
    this.lastSentAt = null;
    this.lastError = null;
    this.startedAt = null;
  }

  detach(): void {
    this.stopWatch();
    this.context = null;
    this.pending = null;
  }

  get sessionId(): string | null {
    return this.context?.sessionId ?? null;
  }

  startWatch(): void {
    if (!this.context || this.watchId !== null) return;
    if (!this.deps.geolocation) {
      this.lastError = { code: 0, message: "Geolocation is not available on this device" };
      this.emit({ type: "geo-error", error: this.lastError });
      return;
    }
    if (this.startedAt === null) this.startedAt = this.now();
    this.watchId = this.deps.geolocation.watchPosition(
      (fix) => this.handleFix(fix),
      (error) => {
        this.lastError = error;
        this.emit({ type: "geo-error", error });
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
    );
  }

  stopWatch(): void {
    if (this.watchId !== null && this.deps.geolocation) {
      this.deps.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;
  }

  /** Page Visibility: hidden stops the watch (no background
   *  claims); visible restarts it and immediately offers the
   *  latest known position as a catch-up update. */
  setVisible(visible: boolean): void {
    if (!this.context) return;
    if (!visible) {
      this.stopWatch();
      return;
    }
    this.startWatch();
    if (this.lastFix) {
      this.enqueueSend(this.lastFix);
    } else {
      void this.flushPending();
    }
  }

  /** Network is back: retry the pending (latest) position. */
  handleOnline(): void {
    void this.flushPending();
  }

  /**
   * Event update (trip departure/arrival, pickup confirmation,
   * delivery attempt/completion): report the current position
   * immediately, bypassing the periodic cadence. Prefers a fresh
   * fix when the platform can produce one quickly; falls back to
   * the latest known fix.
   */
  sendImmediate(freshFix?: GeoFix): void {
    if (!this.context) return;
    if (freshFix) {
      this.noteFix(freshFix);
      this.enqueueSend(freshFix);
      return;
    }
    const geo = this.deps.geolocation;
    if (geo?.getCurrentPosition) {
      geo.getCurrentPosition(
        (fix) => {
          this.noteFix(fix);
          this.enqueueSend(fix);
        },
        () => {
          if (this.lastFix) this.enqueueSend(this.lastFix);
        },
        { enableHighAccuracy: true, maximumAge: 10_000, timeout: 10_000 },
      );
      return;
    }
    if (this.lastFix) this.enqueueSend(this.lastFix);
  }

  handleFix(fix: GeoFix): void {
    if (!this.context) return;
    this.noteFix(fix);
    const config = this.context.config;
    const movingIntervalMs =
      (config.movingIntervalSeconds[this.context.trackingType as "PICKUP" | "DELIVERY" | "LINEHAUL"] ??
        config.movingIntervalSeconds.DELIVERY) * 1000;
    const decision = decidePingSend({
      lastSent: this.lastSentFix
        ? { latitude: this.lastSentFix.latitude, longitude: this.lastSentFix.longitude, at: this.lastSentAt ?? 0 }
        : null,
      fix,
      now: this.now(),
      movingIntervalMs,
      heartbeatMs: config.stationaryHeartbeatSeconds * 1000,
      minIntervalMs: config.minPingIntervalSeconds * 1000,
      thresholdMeters: config.movementThresholdMeters,
    });
    if (decision.send) {
      this.enqueueSend(fix);
    } else if (this.pending) {
      // A new fix arrived while an older send is still unsent —
      // retry the pending one (it stays the latest until a newer
      // fix earns its own send).
      void this.flushPending();
    }
  }

  private noteFix(fix: GeoFix): void {
    this.lastFix = fix;
    this.lastFixAt = this.now();
    if (this.lastError) this.lastError = null;
    this.emit({ type: "fix", fix });
  }

  private nextSequence(): number {
    this.sequence += 1;
    if (this.context) this.deps.storage?.write(this.context.sessionId, this.sequence);
    return this.sequence;
  }

  /** Latest-wins: a newer position replaces any unsent older one
   *  (with a fresh sequenceId); re-sending the SAME position
   *  reuses its sequenceId so the server can deduplicate the
   *  replay. */
  private enqueueSend(fix: GeoFix): void {
    if (!this.context) return;
    if (
      this.pending &&
      this.pending.fix.latitude === fix.latitude &&
      this.pending.fix.longitude === fix.longitude &&
      this.pending.fix.recordedAt === fix.recordedAt
    ) {
      void this.flushPending();
      return;
    }
    this.pending = { fix, sequenceId: this.nextSequence() };
    void this.flushPending();
  }

  private async flushPending(): Promise<void> {
    if (this.flushing || !this.pending || !this.context) return;
    this.flushing = true;
    const { fix, sequenceId } = this.pending;
    const sessionId = this.context.sessionId;
    let outcome: SendOutcome;
    try {
      outcome = await this.deps.sendPing({
        trackingSessionId: sessionId,
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracyMeters: fix.accuracyMeters,
        speedMetersPerSecond: fix.speedMetersPerSecond,
        headingDegrees: fix.headingDegrees,
        recordedAt: new Date(fix.recordedAt).toISOString(),
        sequenceId,
      });
    } catch {
      outcome = { ok: false };
    }
    this.flushing = false;
    if (outcome.ok) {
      if (this.pending?.sequenceId === sequenceId) this.pending = null;
      this.lastSentFix = fix;
      this.lastSentAt = this.now();
      this.emit({ type: "sent", fix, sequenceId, deduplicated: outcome.deduplicated });
      if (this.pending) void this.flushPending();
      return;
    }
    if (outcome.status === 409 || outcome.status === 404 || outcome.status === 403) {
      // The session is no longer usable (paused/ended/completed
      // server-side): drop the pending fix and let the panel
      // resync from GET session/current.
      if (this.pending?.sequenceId === sequenceId) this.pending = null;
      this.emit({ type: "session-invalid", status: outcome.status });
      return;
    }
    // 429 (server floor) and network/5xx failures: keep the
    // pending fix; it retries on the next fix, on `online`, and
    // on visibility return.
    this.emit({ type: "send-failed", fix, status: outcome.status });
  }

  getSnapshot(): EngineSnapshot {
    return {
      watching: this.watchId !== null,
      lastFix: this.lastFix,
      lastSentFix: this.lastSentFix,
      lastSentAt: this.lastSentAt,
      hasUnsent: this.pending !== null,
      lastError: this.lastError,
      startedAt: this.startedAt,
    };
  }

  health(at?: number): WatchdogState {
    const config = this.context?.config;
    const intervalMs = config
      ? (config.movingIntervalSeconds[this.context!.trackingType as "PICKUP" | "DELIVERY" | "LINEHAUL"] ??
          config.movingIntervalSeconds.DELIVERY) * 1000
      : 150_000;
    return watchdogStatus({
      now: at ?? this.now(),
      startedAt: this.startedAt,
      lastFixAt: this.lastFixAt,
      lastSentAt: this.lastSentAt,
      hasUnsent: this.pending !== null,
      lastError: this.lastError,
      intervalMs,
    });
  }
}

/** sessionStorage-backed sequence persistence (browser only). */
export function sessionStorageSequenceStorage(): SequenceStorage {
  const key = (sessionId: string) => `bla.tracking.seq.${sessionId}`;
  return {
    read(sessionId) {
      try {
        const raw = window.sessionStorage.getItem(key(sessionId));
        const value = raw ? Number.parseInt(raw, 10) : 0;
        return Number.isFinite(value) && value > 0 ? value : 0;
      } catch {
        return 0;
      }
    },
    write(sessionId, value) {
      try {
        window.sessionStorage.setItem(key(sessionId), String(value));
      } catch {
        // Storage unavailable (private mode): the in-memory
        // counter still keeps the sequence increasing for this
        // page lifetime.
      }
    },
  };
}
