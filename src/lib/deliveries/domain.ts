/**
 * Phase 6 delivery vocabulary (docs/database-schema.md §8,
 * docs/delivery-workflow.md, docs/return-workflow.md). Every value
 * here is mirrored by a CHECK constraint in the Phase 6 hardening
 * migration — the database and this module are the two halves of the
 * same contract.
 */

export const DELIVERY_BATCH_KINDS = ["PICKUP", "DELIVERY", "MIXED"] as const;

export const DELIVERY_BATCH_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;

export const DELIVERY_ASSIGNMENT_KINDS = ["PICKUP", "DELIVERY"] as const;

export const DELIVERY_ASSIGNMENT_STATUSES = [
  "PENDING",
  "ACCEPTED",
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "REASSIGNED",
] as const;

/** Assignment statuses in which the package is committed to the
 *  assignment (partial unique index: one active assignment per
 *  package per kind — schema doc §8). */
export const ACTIVE_ASSIGNMENT_STATUSES = [
  "PENDING",
  "ACCEPTED",
  "IN_PROGRESS",
] as const;

/** DeliveryAttempt result vocabulary (schema doc §8). `DELIVERED` is
 *  in the schema CHECK list: the successful visit is recorded as an
 *  attempt row too, so the per-package attempt numbering is one
 *  continuous ledger (delivery-workflow.md §5 numbers attempts per
 *  package across riders and days). */
export const DELIVERY_ATTEMPT_RESULTS = [
  "DELIVERED",
  "RECIPIENT_UNAVAILABLE",
  "PHONE_UNREACHABLE",
  "WRONG_ADDRESS",
  "REFUSED",
  "BUSINESS_CLOSED",
  "AREA_INACCESSIBLE",
  "PAYMENT_UNAVAILABLE",
  "PACKAGE_DAMAGED",
  "PICKUP_FAILED",
  "OTHER",
] as const;

export const DELIVERY_NEXT_ACTIONS = [
  "REDELIVER",
  "ADDRESS_CORRECTION",
  "SUPPORT_ESCALATION",
  "RETURN_TO_SENDER",
  "RETURN_TO_WAREHOUSE",
  "NONE",
] as const;

export const DELIVERY_CONTACT_OUTCOMES = [
  "CALLED_ANSWERED",
  "CALLED_NO_ANSWER",
  "PHONE_UNREACHABLE",
  "NOT_ATTEMPTED",
] as const;

export const POD_METHODS = [
  "OTP",
  "SIGNATURE",
  "PHOTO",
  "AUTHORISED_PERSON",
] as const;

export const COD_COLLECTION_STATUSES = ["MATCHED", "MISMATCH"] as const;

export const COD_METHODS = ["CASH", "MOBILE_WALLET", "BANK_TRANSFER"] as const;

// ---------------------------------------------------------------------------
// Returns (docs/return-workflow.md §2–§3)
// ---------------------------------------------------------------------------

export const RETURN_REASONS = [
  "RECIPIENT_REFUSED",
  "ATTEMPT_LIMIT_REACHED",
  "WRONG_ADDRESS",
  "VENDOR_REQUEST",
  "PACKAGE_DAMAGED",
  "UNDELIVERABLE",
  "CANCELLATION_AFTER_PICKUP",
  "OTHER",
] as const;

export const RETURN_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "REJECTED",
  "COLLECTION_ASSIGNED",
  "COLLECTED",
  "IN_TRANSIT",
  "RECEIVED",
  "INSPECTED",
  "COMPLETED",
  "CANCELLED",
] as const;

/** Return states in which the return is still open: the package is
 *  flagged and cannot be re-dispatched for delivery (return-workflow
 *  rule 2), and no second return may be opened (rule 6). */
export const OPEN_RETURN_STATUSES = [
  "REQUESTED",
  "APPROVED",
  "COLLECTION_ASSIGNED",
  "COLLECTED",
  "IN_TRANSIT",
  "RECEIVED",
  "INSPECTED",
] as const;

export const RETURN_CHARGE_BEARERS = ["VENDOR", "RECIPIENT", "COMPANY"] as const;

// ---------------------------------------------------------------------------
// Policy (docs/delivery-workflow.md §5/§10, security-architecture.md §7).
// These are the doc defaults; a SystemSetting table (schema doc §11)
// does not exist yet, so the defaults live here as named constants.
// ---------------------------------------------------------------------------

/** Failed attempts per package before the return decision is forced
 *  (delivery-workflow.md §5: "Attempt limits are policy (setting,
 *  default: 3 attempts)"). */
export const MAX_DELIVERY_ATTEMPTS = 3;

/** Wrong OTP entries before confirmation is blocked for the package
 *  (delivery-workflow.md §10: "OTP wrong 3 times — confirmation
 *  blocked"). */
export const OTP_MAX_FAILURES = 3;

/** OTP lifetime from generation at pickup. A rider's run is a single
 *  shift; 12 hours covers pickup → last door without re-issue. */
export const OTP_TTL_MS = 12 * 60 * 60 * 1000;

/** Detailed-tracking second factor (security-architecture.md §7):
 *  failed phone verifications per tracking id before the detailed
 *  view locks, and the cooling period the lock is measured over. */
export const TRACKING_DETAIL_MAX_FAILURES = 5;
export const TRACKING_DETAIL_LOCK_MS = 15 * 60 * 1000;

/** Exception states that block delivery assignment (lifecycle rule
 *  T6 — held/missing/lost packages cannot be assigned — plus damaged
 *  parcels, which the delivery workflow §7 forbids delivering as-is,
 *  and packages flagged into the return flow). */
export const ASSIGNMENT_BLOCKING_EXCEPTIONS = [
  "ON_HOLD",
  "MISSING",
  "MISROUTED",
  "LOST_UNDER_INVESTIGATION",
  "DAMAGED",
  "RETURN_REQUESTED",
  "RETURN_APPROVED",
] as const;

/** Failed-attempt result → package exception flag (schema doc §5:
 *  exceptions layer on the operational status, never replace it). */
export const ATTEMPT_EXCEPTION_BY_RESULT: Readonly<Record<string, string>> = {
  RECIPIENT_UNAVAILABLE: "CUSTOMER_UNAVAILABLE",
  REFUSED: "RECIPIENT_REFUSED",
  WRONG_ADDRESS: "ADDRESS_CLARIFICATION_REQUIRED",
  PACKAGE_DAMAGED: "DAMAGED",
};
