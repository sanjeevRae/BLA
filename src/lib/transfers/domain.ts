/**
 * Phase 5 transfers & transport vocabulary (docs/database-schema.md §7,
 * docs/transfer-workflow.md §4, docs/driver-workflow.md). Statuses are
 * stored as strings and enforced by CHECK constraints in the Phase 5
 * hardening migration; these constants are the single code-side source.
 */

// -- Transfers ---------------------------------------------------------------

export const TRANSFER_STATUSES = [
  "DRAFT",
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "PREPARING",
  "READY_FOR_DISPATCH",
  "DISPATCHED",
  "IN_TRANSIT",
  "ARRIVED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "RECONCILIATION_PENDING",
  "RECONCILED",
  "CLOSED",
  "EXCEPTION",
  "CANCELLED",
] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/**
 * Statuses in which a package is committed to a transfer: from
 * selection until the transfer reconciles, closes or is cancelled.
 * A package may be an item of only one open transfer (workflow §7
 * rule 1) — mirrored by the DB trigger in the hardening migration.
 */
export const OPEN_TRANSFER_STATUSES: readonly string[] = [
  "DRAFT",
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "PREPARING",
  "READY_FOR_DISPATCH",
  "DISPATCHED",
  "IN_TRANSIT",
  "ARRIVED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "RECONCILIATION_PENDING",
  "EXCEPTION",
];

/** Item selection / manifest edits are possible only before dispatch. */
export const TRANSFER_EDITABLE_STATUSES: readonly string[] = [
  "DRAFT",
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "PREPARING",
  "READY_FOR_DISPATCH",
];

/** Cancellation is possible only before dispatch and before any load
 *  scan exists (workflow §7 rule 5: a loaded transfer must be
 *  physically unloaded first). */
export const TRANSFER_CANCELLABLE_STATUSES: readonly string[] = [
  "DRAFT",
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "PREPARING",
  "READY_FOR_DISPATCH",
];

export const TRANSFER_ITEM_STATUSES = [
  "EXPECTED",
  "LOADED",
  "IN_TRANSIT",
  "RECEIVED",
  "MISSING",
  "DAMAGED",
  "EXCESS",
  "WRONG_PACKAGE",
] as const;
export type TransferItemStatus = (typeof TRANSFER_ITEM_STATUSES)[number];

/** Item states in which the package is physically accounted for at the
 *  destination — reconciliation may proceed past them. */
export const ACCOUNTED_ITEM_STATUSES: readonly string[] = ["RECEIVED", "DAMAGED"];

export const TRANSFER_SCAN_TYPES = ["LOAD", "UNLOAD", "RECHECK"] as const;
export type TransferScanType = (typeof TRANSFER_SCAN_TYPES)[number];

// -- Trips -------------------------------------------------------------------

export const TRIP_STATUSES = [
  "PLANNED",
  "ASSIGNED",
  "LOADING",
  "DISPATCHED",
  "IN_TRANSIT",
  "DELAYED",
  "ARRIVED",
  "UNLOADING",
  "COMPLETED",
  "CANCELLED",
  "INCIDENT",
] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

/** A driver or vehicle with a trip in one of these states is not
 *  assignable to another trip (driver-workflow.md §8 rule 1). */
export const ACTIVE_TRIP_STATUSES: readonly string[] = [
  "PLANNED",
  "ASSIGNED",
  "LOADING",
  "DISPATCHED",
  "IN_TRANSIT",
  "DELAYED",
  "ARRIVED",
  "UNLOADING",
  "INCIDENT",
];

// -- Drivers -----------------------------------------------------------------

export const DRIVER_EMPLOYMENT_STATUSES = [
  "ACTIVE",
  "ON_LEAVE",
  "SUSPENDED",
  "INACTIVE",
] as const;

export const DRIVER_AVAILABILITY_STATUSES = [
  "AVAILABLE",
  "ASSIGNED",
  "ON_PICKUP",
  "ON_DELIVERY",
  "ON_TRIP",
  "OFF_DUTY",
  "ON_LEAVE",
  "SUSPENDED",
  "INACTIVE",
] as const;

/** Availability states that block a new trip assignment even before
 *  the active-trip check runs (derived from real work, §10.3). */
export const DRIVER_UNAVAILABLE_STATUSES: readonly string[] = [
  "ON_TRIP",
  "ON_PICKUP",
  "ON_DELIVERY",
  "OFF_DUTY",
  "ON_LEAVE",
  "SUSPENDED",
  "INACTIVE",
];

export const DRIVER_CAPABILITIES = ["PICKUP", "DELIVERY", "LINEHAUL"] as const;

// -- Vehicles ----------------------------------------------------------------

export const VEHICLE_TYPES = ["BIKE", "CAR", "VAN", "TRUCK", "PICKUP"] as const;

export const VEHICLE_STATUSES = [
  "AVAILABLE",
  "ASSIGNED",
  "ON_TRIP",
  "MAINTENANCE",
  "OFFLINE",
] as const;

export const VEHICLE_INSPECTION_STATUSES = ["VALID", "DUE", "EXPIRED"] as const;

export const VEHICLE_MAINTENANCE_KINDS = ["SCHEDULED", "REPAIR", "INSPECTION"] as const;
