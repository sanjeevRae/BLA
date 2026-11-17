import type { StatusDomain } from "./status-tones";

/**
 * Friendly status labels (docs/ui-design-system.md §4) — a UI-layer
 * dictionary keyed by (domain, value). It changes WORDS ONLY: tone and
 * logic live in status-tones.ts and are untouched. Every value present
 * in the status-tones tables has an explicit entry here (enforced by
 * tests/unit/status-labels.test.ts); unlisted values fall back to a
 * humanised transform — never the raw SCREAMING_SNAKE enum.
 */

/** Acronyms that stay uppercase in labels (DS §4). */
const ACRONYMS: ReadonlySet<string> = new Set(["COD", "NPR", "OTP"]);

/** "LOST_UNDER_INVESTIGATION" -> "Lost under investigation";
 *  "COD_REVIEW_PENDING" -> "COD review pending". */
export function humaniseStatusValue(value: string): string {
  const words = value
    .split("_")
    .filter((word) => word.length > 0)
    .map((word) => (ACRONYMS.has(word) ? word : word.toLowerCase()));
  if (words.length === 0) return value;
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

export const STATUS_LABELS: Readonly<
  Record<StatusDomain, Readonly<Record<string, string>>>
> = {
  operational: {
    DELIVERED: "Delivered",
    CANCELLED: "Cancelled",
    INSPECTION_PENDING: "Inspection pending",
    RECEIVING_INSPECTION: "Receiving inspection",
    DELIVERY_ATTEMPTED: "Delivery attempted",
    PICKUP_IN_PROGRESS: "Pickup in progress",
    PICKED_UP: "Picked up",
    DISPATCHED: "Dispatched",
    IN_TRANSIT: "In transit",
    OUT_FOR_DELIVERY: "Out for delivery",
    // Remaining lifecycle states (status-tones falls back to neutral
    // for these; the labels are still explicit so they never render
    // as raw enums — DS §4 names RECEIVED_AT_DESTINATION explicitly).
    DRAFT: "Draft",
    BOOKED: "Booked",
    PICKUP_ASSIGNED: "Pickup assigned",
    RECEIVED_AT_ORIGIN: "Received at origin",
    PROCESSING: "Processing",
    SORTED: "Sorted",
    READY_FOR_DISPATCH: "Ready for dispatch",
    TRANSFER_ASSIGNED: "Transfer assigned",
    ARRIVED_AT_DESTINATION: "Arrived at destination",
    RECEIVED_AT_DESTINATION: "Received at destination",
    READY_FOR_DELIVERY: "Ready for delivery",
    DELIVERY_ASSIGNED: "Delivery assigned",
  },
  condition: {
    GOOD: "Good",
    DAMAGED: "Damaged",
    SUSPECTED_DAMAGE: "Suspected damage",
    PACKAGING_COMPROMISED: "Packaging compromised",
  },
  payment: {
    PAID: "Paid",
    COD_SETTLED: "COD settled",
    COD_REMITTED: "COD remitted",
    COD_COLLECTED: "COD collected",
    COD_DUE: "COD due",
    PENDING: "Pending",
    REFUNDED: "Refunded",
    NOT_APPLICABLE: "Not applicable",
  },
  delivery: {
    DELIVERED: "Delivered",
    FAILED: "Failed",
    REFUSED: "Refused",
    ATTEMPTED: "Attempted",
    RETURN_INITIATED: "Return initiated",
    ASSIGNED: "Assigned",
    OUT_FOR_DELIVERY: "Out for delivery",
    NOT_STARTED: "Not started",
    RETURNED_TO_WAREHOUSE: "Returned to warehouse",
    RETURNED_TO_SENDER: "Returned to sender",
  },
  exception: {
    NONE: "None",
    RESOLVED: "Resolved",
    MISSING: "Missing",
    LOST_UNDER_INVESTIGATION: "Lost — under investigation",
    DAMAGED: "Damaged",
    DELIVERY_FAILED: "Delivery failed",
    ON_HOLD: "On hold",
    ADDRESS_CLARIFICATION_REQUIRED: "Address clarification required",
    MISROUTED: "Misrouted",
    DELAYED: "Delayed",
    CUSTOMER_UNAVAILABLE: "Customer unavailable",
    RECIPIENT_REFUSED: "Recipient refused",
    PICKUP_FAILED: "Pickup failed",
    RETURN_REQUESTED: "Return requested",
    RETURN_APPROVED: "Return approved",
  },
  generic: {
    APPROVED: "Approved",
    ACTIVE: "Active",
    CONFIRMED: "Confirmed",
    PAID: "Paid",
    COMPLETED: "Completed",
    DELIVERED: "Delivered",
    RECEIVED: "Received",
    RECONCILED: "Reconciled",
    CLOSED: "Closed",
    RESOLVED: "Resolved",
    SETTLED: "Settled",
    VERIFIED: "Verified",
    REJECTED: "Rejected",
    CANCELLED: "Cancelled",
    SUSPENDED: "Suspended",
    INACTIVE: "Inactive",
    FAILED: "Failed",
    EXCEPTION: "Exception",
    CRITICAL: "Critical",
    HIGH: "High",
    PENDING: "Pending",
    PENDING_APPROVAL: "Pending approval",
    PENDING_VERIFICATION: "Pending verification",
    UNDER_REVIEW: "Under review",
    SUBMITTED: "Submitted",
    UNROUTED: "Unrouted",
    PARTIALLY_DELIVERED: "Partially delivered",
    PARTIALLY_RECEIVED: "Partially received",
    RECONCILIATION_PENDING: "Reconciliation pending",
    OPEN: "Open",
    MEDIUM: "Medium",
    ARRIVED: "Arrived",
    RECEIVING: "Receiving",
    PREPARING: "Preparing",
    LOADING: "Loading",
    IN_PROGRESS: "In progress",
    IN_TRANSIT: "In transit",
    DISPATCHED: "Dispatched",
    ASSIGNED: "Assigned",
    DRAFT: "Draft",
    LOW: "Low",
    ARCHIVED: "Archived",
    NOT_STARTED: "Not started",
  },
};

/** Friendly label for a status value in its domain. */
export function statusLabel(domain: StatusDomain, value: string): string {
  return STATUS_LABELS[domain][value] ?? humaniseStatusValue(value);
}
