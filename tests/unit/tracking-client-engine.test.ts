import { describe, expect, it, vi } from "vitest";

import {
  TrackingEngine,
  decidePingSend,
  haversineMeters,
  watchdogStatus,
  type GeoFix,
  type GeolocationLike,
  type OutgoingPing,
  type SendOutcome,
  type SequenceStorage,
} from "@/lib/tracking/client-engine";
import type { TrackingClientConfig } from "@/lib/tracking/config";

/**
 * Phase 4 (V2) — driver GPS client engine: pure decision logic
 * (throttle / dedupe / heartbeat / watchdog) and the engine's
 * send behaviour with fake geolocation, clock, storage and
 * transport. No DOM, no network.
 */

const CONFIG: TrackingClientConfig = {
  minPingIntervalSeconds: 30,
  movingIntervalSeconds: { PICKUP: 150, DELIVERY: 150, LINEHAUL: 240 },
  stationaryHeartbeatSeconds: 600,
  movementThresholdMeters: 25,
  freshWithinSeconds: 300,
  delayedWithinSeconds: 900,
};

const fix = (overrides: Partial<GeoFix> = {}): GeoFix => ({
  latitude: 27.7,
  longitude: 85.3,
  accuracyMeters: 10,
  speedMetersPerSecond: null,
  headingDegrees: null,
  recordedAt: 0,
  ...overrides,
});

const drain = () => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

describe("haversineMeters", () => {
  it("is zero for the same point and ~111 m for 0.001° of latitude", () => {
    expect(haversineMeters(27.7, 85.3, 27.7, 85.3)).toBe(0);
    const d = haversineMeters(27.7, 85.3, 27.701, 85.3);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(125);
  });
});

describe("decidePingSend", () => {
  const base = {
    movingIntervalMs: 150_000,
    heartbeatMs: 600_000,
    minIntervalMs: 30_000,
    thresholdMeters: 25,
  };
  const lastSent = { latitude: 27.7, longitude: 85.3, at: 1_000_000 };

  it("sends the first fix of a session", () => {
    expect(decidePingSend({ ...base, lastSent: null, fix: fix(), now: 0 })).toEqual({
      send: true,
      reason: "initial",
    });
  });

  it("never sends identical coordinates twice inside the heartbeat", () => {
    const d = decidePingSend({ ...base, lastSent, fix: fix(), now: 1_000_000 + 60_000 });
    expect(d).toEqual({ send: false, reason: "duplicate" });
  });

  it("offers identical coordinates as a heartbeat after the stationary window", () => {
    const d = decidePingSend({ ...base, lastSent, fix: fix(), now: 1_000_000 + 600_000 });
    expect(d).toEqual({ send: true, reason: "heartbeat" });
  });

  it("blocks any send inside the server minimum interval, even for a big move", () => {
    const d = decidePingSend({
      ...base,
      lastSent,
      fix: fix({ latitude: 27.71 }),
      now: 1_000_000 + 10_000,
    });
    expect(d).toEqual({ send: false, reason: "too-soon" });
  });

  it("waits for the moving interval even after moving beyond the threshold", () => {
    const d = decidePingSend({
      ...base,
      lastSent,
      fix: fix({ latitude: 27.701 }),
      now: 1_000_000 + 60_000,
    });
    expect(d).toEqual({ send: false, reason: "waiting-interval" });
  });

  it("sends once moved beyond the threshold AND the moving interval elapsed", () => {
    const d = decidePingSend({
      ...base,
      lastSent,
      fix: fix({ latitude: 27.701 }),
      now: 1_000_000 + 150_000,
    });
    expect(d).toEqual({ send: true, reason: "moved" });
  });

  it("treats sub-threshold movement inside the heartbeat as stationary", () => {
    const d = decidePingSend({
      ...base,
      lastSent,
      fix: fix({ latitude: 27.7001 }),
      now: 1_000_000 + 300_000,
    });
    expect(d).toEqual({ send: false, reason: "stationary" });
  });

  it("sends sub-threshold movement once the heartbeat elapses", () => {
    const d = decidePingSend({
      ...base,
      lastSent,
      fix: fix({ latitude: 27.7001 }),
      now: 1_000_000 + 600_000,
    });
    expect(d).toEqual({ send: true, reason: "heartbeat" });
  });

  it("the server floor beats the identical-coordinate heartbeat (F2 regression)", () => {
    // Legal config combination: heartbeat 600 s < floor 3600 s.
    // The heartbeat must NOT produce a send inside the floor.
    const d = decidePingSend({
      ...base,
      minIntervalMs: 3_600_000,
      lastSent,
      fix: fix(),
      now: 1_000_000 + 600_000,
    });
    expect(d).toEqual({ send: false, reason: "too-soon" });
  });

  it("event sends always go out", () => {
    const d = decidePingSend({
      ...base,
      lastSent,
      fix: fix(),
      now: 1_000_000 + 1_000,
      force: true,
    });
    expect(d).toEqual({ send: true, reason: "event" });
  });
});

describe("watchdogStatus", () => {
  const base = {
    startedAt: 0,
    lastFixAt: 0,
    lastSentAt: 0,
    hasUnsent: false,
    lastError: null,
    intervalMs: 150_000,
  };

  it("is ok while fixes flow", () => {
    expect(watchdogStatus({ ...base, now: 100_000 })).toEqual({ state: "ok" });
  });

  it("surfaces a geolocation error immediately", () => {
    const error = { code: 1, message: "denied" };
    expect(watchdogStatus({ ...base, now: 1_000, lastError: error })).toEqual({
      state: "error",
      error,
    });
  });

  it("flags a GPS stall after 2× the interval without a fix", () => {
    expect(watchdogStatus({ ...base, now: 300_001 })).toEqual({
      state: "stalled",
      cause: "gps",
    });
  });

  it("flags a network stall when a position stays unsent past 2× the interval", () => {
    expect(
      watchdogStatus({ ...base, now: 300_001, lastFixAt: 300_000, hasUnsent: true }),
    ).toEqual({ state: "stalled", cause: "network" });
  });
});

// ---------------------------------------------------------------------------
// Engine behaviour
// ---------------------------------------------------------------------------

class FakeGeo implements GeolocationLike {
  watchSuccess: ((f: GeoFix) => void) | null = null;
  watchError: ((e: { code: number; message: string }) => void) | null = null;
  currentFix: GeoFix | null = null;
  cleared: number[] = [];
  watchPosition(
    success: (f: GeoFix) => void,
    error: (e: { code: number; message: string }) => void,
  ): number {
    this.watchSuccess = success;
    this.watchError = error;
    return 42;
  }
  clearWatch(id: number): void {
    this.cleared.push(id);
  }
  getCurrentPosition(success: (f: GeoFix) => void): void {
    if (this.currentFix) success(this.currentFix);
  }
  emit(f: GeoFix): void {
    this.watchSuccess?.(f);
  }
  fail(code: number): void {
    this.watchError?.({ code, message: `geo error ${code}` });
  }
}

class MemoryStorage implements SequenceStorage {
  values = new Map<string, number>();
  read(sessionId: string): number {
    return this.values.get(sessionId) ?? 0;
  }
  write(sessionId: string, value: number): void {
    this.values.set(sessionId, value);
  }
}

function makeEngine(options: { send?: (ping: OutgoingPing) => Promise<SendOutcome> } = {}) {
  const geo = new FakeGeo();
  const storage = new MemoryStorage();
  const sent: OutgoingPing[] = [];
  let now = 1_000_000;
  const sendPing =
    options.send ??
    (async (ping: OutgoingPing): Promise<SendOutcome> => {
      sent.push(ping);
      return { ok: true, deduplicated: false };
    });
  const events: string[] = [];
  const engine = new TrackingEngine({
    geolocation: geo,
    sendPing,
    storage,
    now: () => now,
    onEvent: (e) => events.push(e.type),
  });
  engine.attach({ sessionId: "sess-1", trackingType: "DELIVERY", config: CONFIG });
  return {
    engine,
    geo,
    storage,
    sent,
    events,
    setNow: (v: number) => {
      now = v;
    },
    getNow: () => now,
  };
}

describe("TrackingEngine", () => {
  it("sends the first fix with sequence 1 and persists the counter", async () => {
    const { engine, geo, sent, storage } = makeEngine();
    engine.startWatch();
    geo.emit(fix({ recordedAt: 1_000_000 }));
    await drain();
    expect(sent).toHaveLength(1);
    expect(sent[0].sequenceId).toBe(1);
    expect(sent[0].trackingSessionId).toBe("sess-1");
    expect(storage.read("sess-1")).toBe(1);
  });

  it("throttles: a moved fix inside the moving interval is not sent", async () => {
    const { engine, geo, sent, setNow } = makeEngine();
    engine.startWatch();
    geo.emit(fix({ recordedAt: 1_000_000 }));
    await drain();
    setNow(1_060_000);
    geo.emit(fix({ latitude: 27.701, recordedAt: 1_060_000 }));
    await drain();
    expect(sent).toHaveLength(1);
  });

  it("sends a moved fix after the moving interval with the next sequence", async () => {
    const { engine, geo, sent, setNow } = makeEngine();
    engine.startWatch();
    geo.emit(fix({ recordedAt: 1_000_000 }));
    await drain();
    setNow(1_150_000);
    geo.emit(fix({ latitude: 27.701, recordedAt: 1_150_000 }));
    await drain();
    expect(sent).toHaveLength(2);
    expect(sent[1].sequenceId).toBe(2);
    expect(sent[1].latitude).toBe(27.701);
  });

  it("dedupes identical coordinates", async () => {
    const { engine, geo, sent, setNow } = makeEngine();
    engine.startWatch();
    geo.emit(fix({ recordedAt: 1_000_000 }));
    await drain();
    setNow(1_300_000);
    geo.emit(fix({ recordedAt: 1_300_000 }));
    await drain();
    expect(sent).toHaveLength(1);
  });

  it("restores the sequence across a remount within the session", async () => {
    const { engine, geo, sent, storage } = makeEngine();
    engine.startWatch();
    geo.emit(fix({ recordedAt: 1_000_000 }));
    await drain();
    expect(sent[0].sequenceId).toBe(1);

    const sent2: OutgoingPing[] = [];
    const engine2 = new TrackingEngine({
      geolocation: geo,
      sendPing: async (ping) => {
        sent2.push(ping);
        return { ok: true, deduplicated: false };
      },
      storage,
      now: () => 2_000_000,
    });
    engine2.attach({ sessionId: "sess-1", trackingType: "DELIVERY", config: CONFIG });
    engine2.startWatch();
    geo.emit(fix({ latitude: 27.702, recordedAt: 2_000_000 }));
    await drain();
    expect(sent2).toHaveLength(1);
    expect(sent2[0].sequenceId).toBe(2);
  });

  it("keeps only the latest position after a failed send (latest-wins)", async () => {
    let failing = true;
    const attempts: OutgoingPing[] = [];
    const { engine, geo, setNow } = makeEngine({
      send: async (ping) => {
        attempts.push(ping);
        return failing ? { ok: false } : { ok: true, deduplicated: false };
      },
    });
    engine.startWatch();
    geo.emit(fix({ recordedAt: 1_000_000 }));
    await drain();
    expect(engine.getSnapshot().hasUnsent).toBe(true);

    // A newer fix earns its own send and replaces the pending one.
    setNow(1_200_000);
    geo.emit(fix({ latitude: 27.701, recordedAt: 1_200_000 }));
    await drain();
    expect(attempts).toHaveLength(2);
    expect(attempts[1].latitude).toBe(27.701);
    expect(attempts[1].sequenceId).toBe(2);

    // When the network returns, the retry carries the LATEST fix.
    failing = false;
    engine.handleOnline();
    await drain();
    expect(attempts).toHaveLength(3);
    expect(attempts[2].latitude).toBe(27.701);
    expect(engine.getSnapshot().hasUnsent).toBe(false);
  });

  it("stops the watch when hidden and restarts + catches up when visible", async () => {
    const { engine, geo, sent } = makeEngine();
    engine.startWatch();
    geo.emit(fix({ recordedAt: 1_000_000 }));
    await drain();
    engine.setVisible(false);
    expect(geo.cleared).toContain(42);
    engine.setVisible(true);
    await drain();
    // Catch-up re-offers the latest fix as an event send.
    expect(sent.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a watch error immediately in the snapshot and health", async () => {
    const { engine, geo } = makeEngine();
    engine.startWatch();
    geo.fail(1);
    await drain();
    expect(engine.getSnapshot().lastError?.code).toBe(1);
    expect(engine.health().state).toBe("error");
  });

  it("drops the pending fix and signals session-invalid on a 409", async () => {
    const { engine, geo, events } = makeEngine({
      send: async () => ({ ok: false, status: 409 }),
    });
    engine.startWatch();
    geo.emit(fix({ recordedAt: 1_000_000 }));
    await drain();
    expect(engine.getSnapshot().hasUnsent).toBe(false);
    expect(events).toContain("session-invalid");
  });

  it("sendImmediate bypasses the cadence with a fresh fix", async () => {
    const { engine, geo, sent } = makeEngine();
    engine.startWatch();
    geo.emit(fix({ recordedAt: 1_000_000 }));
    await drain();
    expect(sent).toHaveLength(1);
    engine.sendImmediate(fix({ latitude: 27.7005, recordedAt: 1_005_000 }));
    await drain();
    expect(sent).toHaveLength(2);
    expect(sent[1].latitude).toBe(27.7005);
  });

  it("does nothing before attach", async () => {
    const geo = new FakeGeo();
    const sendPing = vi.fn(async (): Promise<SendOutcome> => ({ ok: true, deduplicated: false }));
    const engine = new TrackingEngine({ geolocation: geo, sendPing });
    engine.sendImmediate(fix());
    engine.handleFix(fix());
    await drain();
    expect(sendPing).not.toHaveBeenCalled();
  });
});
