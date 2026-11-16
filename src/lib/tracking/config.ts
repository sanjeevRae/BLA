/**
 * Phase 3 (V2) GPS tracking configuration — pure functions only.
 *
 * Defaults live here as named constants; an operator may override
 * them through the SystemSetting row keyed by
 * TRACKING_CONFIG_SETTING_KEY ("tracking.config"), whose JSON value
 * is merged over the defaults by resolveTrackingConfig. Loading that
 * row from the database happens in the service layer, never here, so
 * this module stays unit-testable without Prisma.
 */

import type { FreshnessState } from "./domain";

/** SystemSetting key carrying the tracking-config JSON override. */
export const TRACKING_CONFIG_SETTING_KEY = "tracking.config";

export interface TrackingConfig {
  minPingIntervalSeconds: number;
  freshWithinSeconds: number;
  delayedWithinSeconds: number;
  retentionDays: number;
  recentWindowMinutes: number;
  abandonedSessionMinutes: number;
  maxAccuracyMeters: number;
  futureTimestampToleranceSeconds: number;
  preStartToleranceSeconds: number;
}

export const TRACKING_CONFIG_DEFAULTS: TrackingConfig = {
  minPingIntervalSeconds: 30,
  freshWithinSeconds: 300,
  delayedWithinSeconds: 900,
  retentionDays: 30,
  recentWindowMinutes: 30,
  abandonedSessionMinutes: 120,
  maxAccuracyMeters: 10000,
  futureTimestampToleranceSeconds: 300,
  preStartToleranceSeconds: 60,
};

/** Per-field sanity bounds: a stored value outside its range is
 *  treated as malformed and ignored (the default applies), so a
 *  typo'd SystemSetting row can never silently disable a gate —
 *  the same pattern as the idle-timeout bounds in
 *  src/server/services/system-settings.ts. Floors matter as much
 *  as caps (Phase 3 security review): a 1-second ping floor would
 *  invite spam, a 1-day clock tolerance would gut the timestamp
 *  validation, a 1-minute abandonment window would kill live
 *  sessions. Integer fields must be whole numbers;
 *  maxAccuracyMeters may be fractional. */
const FIELD_RULES: Readonly<
  Record<keyof TrackingConfig, { integer: boolean; min: number; max: number }>
> = {
  minPingIntervalSeconds: { integer: true, min: 5, max: 3600 },
  freshWithinSeconds: { integer: true, min: 30, max: 86400 },
  delayedWithinSeconds: { integer: true, min: 60, max: 86400 },
  retentionDays: { integer: true, min: 1, max: 3650 },
  recentWindowMinutes: { integer: true, min: 1, max: 10080 },
  abandonedSessionMinutes: { integer: true, min: 5, max: 10080 },
  maxAccuracyMeters: { integer: false, min: 50, max: 100000 },
  futureTimestampToleranceSeconds: { integer: true, min: 10, max: 3600 },
  preStartToleranceSeconds: { integer: true, min: 5, max: 3600 },
};

function saneValue(
  field: keyof TrackingConfig,
  value: unknown,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  const rule = FIELD_RULES[field];
  if (value < rule.min || value > rule.max) return fallback;
  if (rule.integer && !Number.isInteger(value)) return fallback;
  return value;
}

/**
 * Merge a parsed SystemSetting JSON value over the defaults.
 * `raw` is the already-parsed JSON (an object, or anything else —
 * non-objects, null and malformed fields all fall back per-field).
 */
export function resolveTrackingConfig(raw: unknown): TrackingConfig {
  const source: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const resolved = {} as TrackingConfig;
  for (const field of Object.keys(TRACKING_CONFIG_DEFAULTS) as (keyof TrackingConfig)[]) {
    resolved[field] = saneValue(field, source[field], TRACKING_CONFIG_DEFAULTS[field]);
  }
  return resolved;
}

/**
 * Derive the freshness of a driver's current location. A session
 * that is not ACTIVE (PAUSED / ENDED) — or one that has never
 * reported — is OFFLINE regardless of the last ping's age. Age is
 * measured on the server receive clock (lastReceivedAt), never the
 * device clock; a future receive stamp (clock skew) reads as FRESH.
 */
export function computeFreshness(input: {
  sessionStatus: string;
  lastReceivedAt: Date | null;
  now: Date;
  config: TrackingConfig;
}): FreshnessState {
  if (input.sessionStatus !== "ACTIVE" || input.lastReceivedAt === null) {
    return "OFFLINE";
  }
  const ageSeconds = (input.now.getTime() - input.lastReceivedAt.getTime()) / 1000;
  if (ageSeconds <= input.config.freshWithinSeconds) return "FRESH";
  if (ageSeconds <= input.config.delayedWithinSeconds) return "DELAYED";
  return "STALE";
}
