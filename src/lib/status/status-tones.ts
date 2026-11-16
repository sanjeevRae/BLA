/**
 * Unified status → tone mapping (audit M-11/L-4). Pure TypeScript —
 * no React — so the mapping is testable in isolation and shared by
 * every badge in the app. The five package status domains
 * (operational / condition / payment / delivery / exception) each
 * have their own vocabulary; `generic` covers everything else
 * (orders, vendors, transfers, incidents, …). Unknown values in any
 * domain fall back to "neutral".
 */

export type StatusDomain =
  | "operational"
  | "condition"
  | "payment"
  | "delivery"
  | "exception"
  | "generic";

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

export const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-greenbg text-greendeep",
  warning: "bg-amberbg text-amberdeep",
  danger: "bg-redbg text-reddeep",
  info: "bg-accentbg text-brand",
  neutral: "bg-cream text-slate2",
};

/** "OUT_FOR_DELIVERY" -> "OUT FOR DELIVERY". */
export function statusLabel(status: string): string {
  return status.replaceAll("_", " ");
}

const OPERATIONAL_TONES: Readonly<Record<string, StatusTone>> = {
  DELIVERED: "success",
  CANCELLED: "danger",
  INSPECTION_PENDING: "warning",
  RECEIVING_INSPECTION: "warning",
  DELIVERY_ATTEMPTED: "warning",
  PICKUP_IN_PROGRESS: "info",
  PICKED_UP: "info",
  DISPATCHED: "info",
  IN_TRANSIT: "info",
  OUT_FOR_DELIVERY: "info",
};

const CONDITION_TONES: Readonly<Record<string, StatusTone>> = {
  GOOD: "success",
  DAMAGED: "danger",
  SUSPECTED_DAMAGE: "warning",
  PACKAGING_COMPROMISED: "warning",
};

const PAYMENT_TONES: Readonly<Record<string, StatusTone>> = {
  PAID: "success",
  COD_SETTLED: "success",
  COD_REMITTED: "success",
  COD_COLLECTED: "info",
  COD_DUE: "warning",
  PENDING: "warning",
  REFUNDED: "neutral",
  NOT_APPLICABLE: "neutral",
};

const DELIVERY_TONES: Readonly<Record<string, StatusTone>> = {
  DELIVERED: "success",
  FAILED: "danger",
  REFUSED: "danger",
  ATTEMPTED: "warning",
  RETURN_INITIATED: "warning",
  ASSIGNED: "info",
  OUT_FOR_DELIVERY: "info",
  NOT_STARTED: "neutral",
  RETURNED_TO_WAREHOUSE: "neutral",
  RETURNED_TO_SENDER: "neutral",
};

const EXCEPTION_TONES: Readonly<Record<string, StatusTone>> = {
  NONE: "neutral",
  RESOLVED: "success",
  MISSING: "danger",
  LOST_UNDER_INVESTIGATION: "danger",
  DAMAGED: "danger",
  DELIVERY_FAILED: "danger",
  ON_HOLD: "warning",
  ADDRESS_CLARIFICATION_REQUIRED: "warning",
  MISROUTED: "warning",
  DELAYED: "warning",
  CUSTOMER_UNAVAILABLE: "warning",
  RECIPIENT_REFUSED: "warning",
  PICKUP_FAILED: "warning",
  RETURN_REQUESTED: "warning",
  RETURN_APPROVED: "warning",
};

const GENERIC_TONES: Readonly<Record<string, StatusTone>> = {
  APPROVED: "success",
  ACTIVE: "success",
  CONFIRMED: "success",
  PAID: "success",
  COMPLETED: "success",
  DELIVERED: "success",
  RECEIVED: "success",
  RECONCILED: "success",
  CLOSED: "success",
  RESOLVED: "success",
  SETTLED: "success",
  VERIFIED: "success",
  REJECTED: "danger",
  CANCELLED: "danger",
  SUSPENDED: "danger",
  INACTIVE: "danger",
  FAILED: "danger",
  EXCEPTION: "danger",
  CRITICAL: "danger",
  HIGH: "danger",
  PENDING: "warning",
  PENDING_APPROVAL: "warning",
  PENDING_VERIFICATION: "warning",
  UNDER_REVIEW: "warning",
  SUBMITTED: "warning",
  UNROUTED: "warning",
  PARTIALLY_DELIVERED: "warning",
  PARTIALLY_RECEIVED: "warning",
  RECONCILIATION_PENDING: "warning",
  OPEN: "warning",
  MEDIUM: "warning",
  ARRIVED: "warning",
  RECEIVING: "warning",
  PREPARING: "warning",
  LOADING: "warning",
  IN_PROGRESS: "info",
  IN_TRANSIT: "info",
  DISPATCHED: "info",
  ASSIGNED: "info",
  DRAFT: "neutral",
  LOW: "neutral",
  ARCHIVED: "neutral",
  NOT_STARTED: "neutral",
};

const DOMAIN_TONES: Readonly<Record<StatusDomain, Readonly<Record<string, StatusTone>>>> = {
  operational: OPERATIONAL_TONES,
  condition: CONDITION_TONES,
  payment: PAYMENT_TONES,
  delivery: DELIVERY_TONES,
  exception: EXCEPTION_TONES,
  generic: GENERIC_TONES,
};

export function statusTone(domain: StatusDomain, status: string): StatusTone {
  return DOMAIN_TONES[domain][status] ?? "neutral";
}
