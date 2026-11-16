/**
 * Phase 3 (V2) GPS tracking vocabulary. Every value here is mirrored
 * by a CHECK constraint in the Phase 3 GPS hardening migration — the
 * database and this module are the two halves of the same contract.
 * Trip / batch status lists below are the tracking-relevant subsets
 * of the Phase 5 trip vocabulary (src/lib/transfers/domain.ts) and
 * the Phase 6 delivery-batch vocabulary
 * (src/lib/deliveries/domain.ts); they are duplicated here so the
 * tracking service validates against its own contract without
 * importing lifecycle modules.
 */

export const TRACKING_TYPES = ["LINEHAUL", "PICKUP", "DELIVERY"] as const;
export type TrackingType = (typeof TRACKING_TYPES)[number];

export const TRACKING_SESSION_STATUSES = ["ACTIVE", "PAUSED", "ENDED"] as const;
export type TrackingSessionStatus = (typeof TRACKING_SESSION_STATUSES)[number];

export const TRACKING_START_REASONS = ["DRIVER"] as const;
export type TrackingStartReason = (typeof TRACKING_START_REASONS)[number];

export const TRACKING_END_REASONS = [
  "DRIVER",
  "SUPERVISOR",
  "ASSIGNMENT_COMPLETED",
  "ASSIGNMENT_CANCELLED",
  "EXPIRED",
] as const;
export type TrackingEndReason = (typeof TRACKING_END_REASONS)[number];

export const PING_SOURCES = ["BROWSER"] as const;
export type PingSource = (typeof PING_SOURCES)[number];

export const FRESHNESS_STATES = ["FRESH", "DELAYED", "STALE", "OFFLINE"] as const;
export type FreshnessState = (typeof FRESHNESS_STATES)[number];

/** Trip statuses in which GPS tracking may run for a line-haul trip:
 *  the trip is assigned to a driver and has not reached a terminal
 *  state (PLANNED has no driver movement to track yet). */
export const ACTIVE_TRIP_STATUSES_FOR_TRACKING = [
  "ASSIGNED",
  "LOADING",
  "DISPATCHED",
  "IN_TRANSIT",
  "DELAYED",
  "ARRIVED",
  "UNLOADING",
  "INCIDENT",
] as const;
export type ActiveTripStatusForTracking = (typeof ACTIVE_TRIP_STATUSES_FOR_TRACKING)[number];

export const TERMINAL_TRIP_STATUSES = ["COMPLETED", "CANCELLED"] as const;
export type TerminalTripStatus = (typeof TERMINAL_TRIP_STATUSES)[number];

/** DeliveryBatch statuses in which GPS tracking may run for a
 *  pickup / delivery run. */
export const ACTIVE_BATCH_STATUSES_FOR_TRACKING = ["OPEN", "IN_PROGRESS"] as const;
export type ActiveBatchStatusForTracking = (typeof ACTIVE_BATCH_STATUSES_FOR_TRACKING)[number];

export const TERMINAL_BATCH_STATUSES = ["COMPLETED", "CANCELLED"] as const;
export type TerminalBatchStatus = (typeof TERMINAL_BATCH_STATUSES)[number];
