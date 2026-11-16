/**
 * Phase 4 (V2) — the live tracking engine registry.
 *
 * The Location Tracking panel (mounted in the rider and
 * line-haul driver dashboard layouts) registers its engine here
 * while a session is ACTIVE. Driver action forms (trip
 * departure/arrival, pickup confirmation, delivery attempt /
 * completion) call `sendTrackingEventUpdate()` after a successful
 * action; when no session is being tracked on this device the
 * call is a no-op. This keeps the wiring surgical: forms never
 * import the panel, and tracking stays strictly opt-in per
 * session.
 */

import type { TrackingEngine } from "./client-engine";

let activeEngine: TrackingEngine | null = null;

export function registerTrackingEngine(engine: TrackingEngine | null): void {
  activeEngine = engine;
}

export function getActiveTrackingEngine(): TrackingEngine | null {
  return activeEngine;
}

/** Fire an immediate location update for the active session, if
 *  any. Never throws — a tracking hiccup must not break the
 *  driver's actual work action. */
export function sendTrackingEventUpdate(): void {
  try {
    activeEngine?.sendImmediate();
  } catch {
    // Intentionally swallowed: the work action already succeeded.
  }
}
