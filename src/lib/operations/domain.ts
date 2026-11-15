/**
 * Phase 8 operations vocabulary (docs/database-schema.md §10,
 * docs/exception-management.md, docs/implementation-roadmap.md
 * Phase 8). Every value here is mirrored by a CHECK constraint in
 * the Phase 8 hardening migration — the database and this module
 * are the two halves of the same contract.
 */

// ---------------------------------------------------------------------------
// Incidents (exception-management.md §1–§3, schema doc §10)
// ---------------------------------------------------------------------------

export const INCIDENT_CATEGORIES = [
  "MISSING_PACKAGE",
  "DAMAGED_PACKAGE",
  "WRONG_WAREHOUSE",
  "WRONG_PACKAGE_RECEIVED",
  "TRANSFER_SHORTAGE",
  "TRANSFER_EXCESS",
  "DELIVERY_FAILURE",
  "CUSTOMER_REFUSAL",
  "INCORRECT_ADDRESS",
  "PICKUP_FAILURE",
  "DRIVER_BREAKDOWN",
  "VEHICLE_ACCIDENT",
  "THEFT_SUSPICION",
  "COD_DISCREPANCY",
  "PAYMENT_DISPUTE",
  "DUPLICATE_BOOKING",
  "DUPLICATE_SCAN",
  "WEIGHT_DISCREPANCY",
  "DELAYED_SHIPMENT",
  "CUSTOMER_COMPLAINT",
  "UNAUTHORISED_ACCESS_ATTEMPT",
  "HANDOVER_DISCREPANCY",
] as const;
export type IncidentCategory = (typeof INCIDENT_CATEGORIES)[number];

export const INCIDENT_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

/** Default severity per category (exception-management.md §1). The
 *  reporter or triaging manager can raise it, never silently lower. */
export const INCIDENT_DEFAULT_SEVERITY: Record<IncidentCategory, IncidentSeverity> = {
  MISSING_PACKAGE: "CRITICAL",
  DAMAGED_PACKAGE: "HIGH",
  WRONG_WAREHOUSE: "HIGH",
  WRONG_PACKAGE_RECEIVED: "MEDIUM",
  TRANSFER_SHORTAGE: "HIGH",
  TRANSFER_EXCESS: "MEDIUM",
  DELIVERY_FAILURE: "MEDIUM",
  CUSTOMER_REFUSAL: "LOW",
  INCORRECT_ADDRESS: "MEDIUM",
  PICKUP_FAILURE: "MEDIUM",
  DRIVER_BREAKDOWN: "HIGH",
  VEHICLE_ACCIDENT: "CRITICAL",
  THEFT_SUSPICION: "CRITICAL",
  COD_DISCREPANCY: "HIGH",
  PAYMENT_DISPUTE: "MEDIUM",
  DUPLICATE_BOOKING: "MEDIUM",
  DUPLICATE_SCAN: "LOW",
  WEIGHT_DISCREPANCY: "LOW",
  DELAYED_SHIPMENT: "MEDIUM",
  CUSTOMER_COMPLAINT: "MEDIUM",
  UNAUTHORISED_ACCESS_ATTEMPT: "HIGH",
  HANDOVER_DISCREPANCY: "HIGH",
};

export const INCIDENT_STATUSES = [
  "REPORTED",
  "ACKNOWLEDGED",
  "ASSIGNED",
  "INVESTIGATING",
  "AWAITING_INFORMATION",
  "ESCALATED",
  "RESOLUTION_PROPOSED",
  "RESOLUTION_APPROVED",
  "RESOLVED",
  "CLOSED",
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_OPEN_STATUSES: readonly IncidentStatus[] = [
  "REPORTED",
  "ACKNOWLEDGED",
  "ASSIGNED",
  "INVESTIGATING",
  "AWAITING_INFORMATION",
  "ESCALATED",
  "RESOLUTION_PROPOSED",
  "RESOLUTION_APPROVED",
];

/** Categories whose resolution moves money or writes off a package:
 *  approval is restricted to Admin / Super Admin (matrix footnote
 *  31) and the approver must differ from the proposer. */
export const INCIDENT_MONEY_OR_LOSS_CATEGORIES: readonly IncidentCategory[] = [
  "COD_DISCREPANCY",
  "PAYMENT_DISPUTE",
  "MISSING_PACKAGE",
  "THEFT_SUSPICION",
  "TRANSFER_SHORTAGE",
];

/** Categories the FINANCE function manages (matrix footnote 30). */
export const INCIDENT_FINANCE_CATEGORIES: readonly IncidentCategory[] = [
  "COD_DISCREPANCY",
  "PAYMENT_DISPUTE",
];

/** Customer-facing categories the SUPPORT function manages
 *  (exception-management.md §4). */
export const INCIDENT_CUSTOMER_FACING_CATEGORIES: readonly IncidentCategory[] = [
  "CUSTOMER_COMPLAINT",
  "DELIVERY_FAILURE",
  "INCORRECT_ADDRESS",
  "CUSTOMER_REFUSAL",
  "DAMAGED_PACKAGE",
  "MISSING_PACKAGE",
];

export const INCIDENT_TEAMS = ["WAREHOUSE", "FINANCE", "SUPPORT", "OPERATIONS"] as const;

/** Responsible team derived from the category when the reporter
 *  does not name one (exception-management.md §7 routing). */
export function defaultTeamForCategory(category: IncidentCategory): string {
  if ((INCIDENT_FINANCE_CATEGORIES as readonly string[]).includes(category)) return "FINANCE";
  if ((INCIDENT_CUSTOMER_FACING_CATEGORIES as readonly string[]).includes(category)) return "SUPPORT";
  if (
    category === "HANDOVER_DISCREPANCY" ||
    category === "TRANSFER_SHORTAGE" ||
    category === "TRANSFER_EXCESS" ||
    category === "WRONG_WAREHOUSE" ||
    category === "WRONG_PACKAGE_RECEIVED" ||
    category === "WEIGHT_DISCREPANCY"
  ) {
    return "WAREHOUSE";
  }
  return "OPERATIONS";
}

// ---------------------------------------------------------------------------
// Tasks (schema doc §10, spec Part 15)
// ---------------------------------------------------------------------------

export const TASK_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

export const TASK_STATUSES = [
  "DRAFT",
  "ASSIGNED",
  "ACCEPTED",
  "IN_PROGRESS",
  "BLOCKED",
  "SUBMITTED",
  "UNDER_REVIEW",
  "VERIFIED",
  "CLOSED",
  "REJECTED",
  "CANCELLED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_TERMINAL_STATUSES: readonly TaskStatus[] = ["CLOSED", "CANCELLED"];

/** Statuses in which a task with a past due date reads as overdue. */
export const TASK_OVERDUE_STATUSES: readonly TaskStatus[] = [
  "DRAFT",
  "ASSIGNED",
  "ACCEPTED",
  "IN_PROGRESS",
  "BLOCKED",
  "SUBMITTED",
  "UNDER_REVIEW",
  "REJECTED",
];

// ---------------------------------------------------------------------------
// Support tickets (spec Part 4.10, api-reference §support)
// ---------------------------------------------------------------------------

export const TICKET_CATEGORIES = [
  "NON_RECEIPT",
  "DAMAGE",
  "PAYMENT_DISPUTE",
  "ADDRESS_CORRECTION",
  "REDELIVERY_REQUEST",
  "GENERAL",
] as const;

export const TICKET_STATUSES = [
  "OPEN",
  "IN_PROGRESS",
  "AWAITING_CUSTOMER",
  "ESCALATED",
  "RESOLVED",
  "CLOSED",
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_OPEN_STATUSES: readonly TicketStatus[] = [
  "OPEN",
  "IN_PROGRESS",
  "AWAITING_CUSTOMER",
  "ESCALATED",
];

export const TICKET_MESSAGE_VISIBILITIES = ["PUBLIC", "INTERNAL"] as const;

// ---------------------------------------------------------------------------
// Notifications (schema doc §10, spec Part 17)
// ---------------------------------------------------------------------------

export const NOTIFICATION_CATEGORIES = [
  "DELIVERY_OTP",
  "DELIVERY_ASSIGNED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "INCIDENT_CREATED",
  "INCIDENT_ASSIGNED",
  "INCIDENT_ESCALATED",
  "TASK_ASSIGNED",
  "TICKET_RAISED",
  "TICKET_REPLIED",
  "TICKET_RESOLVED",
  "SETTLEMENT_PAID",
  "RETURN_AUTHORISED",
  "COD_DISCREPANCY",
  "GENERAL",
  // Phase 10 slice 2: the notification-based daily operations summary
  // (scripts/daily-ops-summary.ts) that replaces the retired legacy
  // daily-report cron workflow.
  "DAILY_OPS_SUMMARY",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CHANNELS = ["IN_APP", "TRACKING", "EMAIL", "SMS"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Delivery status vocabulary for one notification row. IN_APP rows
 * are SENT the moment they exist (they ARE the delivery); TRACKING
 * rows are AVAILABLE for the phone-verified recipient to retrieve;
 * EMAIL/SMS rows honestly record NOT_SENT_NO_PROVIDER while no
 * provider keys are configured — an adapter never claims a send
 * that did not happen.
 */
export const NOTIFICATION_DELIVERY_STATUSES = [
  "SENT",
  "AVAILABLE",
  "NOT_SENT_NO_PROVIDER",
  "FAILED",
] as const;
