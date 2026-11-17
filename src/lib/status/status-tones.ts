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

/**
 * The five status colours (docs/ui-design-system.md §2.4/§4) — the ONLY
 * status hexes in the product. V3 changed the values behind the tones;
 * the tone assignment of every domain value below is unchanged from V2.
 */
export const TONE_HEX: Record<StatusTone, { text: string; bg: string }> = {
  success: { text: "#18794E", bg: "#E3F4E8" },
  warning: { text: "#99610A", bg: "#FFF0D6" },
  danger: { text: "#B42318", bg: "#FDE8E7" },
  info: { text: "#285EA8", bg: "#E7EFFB" },
  neutral: { text: "#53635D", bg: "#EDF1EE" },
};

export const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-successbg text-success",
  warning: "bg-warningbg text-warning",
  danger: "bg-dangerbg text-danger",
  info: "bg-infobg text-info",
  neutral: "bg-neutralbg text-neutral",
};

/** Tone text colour alone (compact badge density, dots, inline labels). */
export const TONE_TEXT_CLASSES: Record<StatusTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
  neutral: "text-neutral",
};

/** Tone → icon name (DS §2.4). Rendered by the ToneIcon component in
 * `src/components/ui/ToneIcon.tsx` (same Lucide-style stroke set). */
export type ToneIconName =
  | "check-circle"
  | "clock"
  | "alert-octagon"
  | "info"
  | "minus-circle";

export const TONE_ICONS: Record<StatusTone, ToneIconName> = {
  success: "check-circle",
  warning: "clock",
  danger: "alert-octagon",
  info: "info",
  neutral: "minus-circle",
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

/** Exported so the friendly-label dictionary (labels.ts) and its tests
 * can iterate every classified value programmatically. */
export const DOMAIN_TONES: Readonly<Record<StatusDomain, Readonly<Record<string, StatusTone>>>> = {
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
