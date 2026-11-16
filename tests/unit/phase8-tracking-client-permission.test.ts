import { describe, expect, it } from "vitest";

import {
  TrackingEngine,
  type GeoFix,
  type GeolocationLike,
  type OutgoingPing,
  type SendOutcome,
  type SequenceStorage,
} from "@/lib/tracking/client-engine";
import type { TrackingClientConfig } from "@/lib/tracking/config";

/**
 * Phase 8 (V2) — GPS permission denied MID-TRIP.
 *
 * tests/unit/tracking-client-engine.test.ts already covers a watch
 * error at start (code 1 before any fix) and a TRANSIENT error
 * (code 2, POSITION_UNAVAILABLE) mid-session with recovery. The
 * case missing there — and the one this file adds — is a
 * PERMISSION_DENIED (code 1) arriving after fixes have already
 * flowed: the driver revokes location permission (or the browser
 * withdraws it) in the middle of a trip.
 *
 * Expected engine behaviour, asserted here:
 *  - the error surfaces immediately in the snapshot and health()
 *    reports "error" — the panel can never keep claiming tracking
 *    is healthy;
 *  - the engine fabricates nothing: no further ping is sent while
 *    no new fix arrives;
 *  - the watch is NOT torn down by the engine itself (consistent
 *    with the transient-error design: the error callback never
 *    calls clearWatch; the panel/watchdog own the reaction);
 *  - already-sent state is untouched (last sent fix stands).
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

class FakeGeo implements GeolocationLike {
  watchSuccess: ((f: GeoFix) => void) | null = null;
  watchError: ((e: { code: number; message: string }) => void) | null = null;
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
    success(fix());
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

describe("TrackingEngine — permission denied mid-trip (Phase 8)", () => {
  it("surfaces code 1 immediately after fixes flowed, sends nothing further, and keeps the last sent fix", async () => {
    const geo = new FakeGeo();
    const sent: OutgoingPing[] = [];
    const events: string[] = [];
    let now = 1_000_000;
    const engine = new TrackingEngine({
      geolocation: geo,
      sendPing: async (ping): Promise<SendOutcome> => {
        sent.push(ping);
        return { ok: true, deduplicated: false };
      },
      storage: new MemoryStorage(),
      now: () => now,
      onEvent: (e) => events.push(e.type),
    });
    engine.attach({ sessionId: "sess-p8", trackingType: "DELIVERY", config: CONFIG });
    engine.startWatch();

    // Trip under way: two fixes flow and are sent.
    geo.emit(fix({ recordedAt: 1_000_000 }));
    await drain();
    now = 1_200_000;
    geo.emit(fix({ latitude: 27.702, recordedAt: 1_200_000 }));
    await drain();
    expect(sent).toHaveLength(2);
    expect(engine.health().state).toBe("ok");
    expect(engine.getSnapshot().lastError).toBeNull();

    // Mid-trip: the driver revokes location permission.
    geo.fail(1);
    await drain();

    const snapshot = engine.getSnapshot();
    expect(snapshot.lastError?.code).toBe(1);
    expect(engine.health()).toEqual({
      state: "error",
      error: { code: 1, message: "geo error 1" },
    });
    expect(events).toContain("geo-error");
    // The engine does not tear the watch down itself and does not
    // fabricate sends: the sent log and last-sent fix are exactly
    // what they were before the denial.
    expect(geo.cleared).toHaveLength(0);
    expect(sent).toHaveLength(2);
    expect(snapshot.lastSentFix?.latitude).toBe(27.702);
    expect(snapshot.hasUnsent).toBe(false);
    // Time passing without a fix must not produce a send either.
    now = 1_900_000;
    await drain();
    expect(sent).toHaveLength(2);
    engine.detach();
  });
});
