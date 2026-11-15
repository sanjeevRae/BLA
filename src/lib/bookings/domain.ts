/**
 * Phase 3 domain vocabularies (docs/database-schema.md §3–§5, §11;
 * docs/package-lifecycle.md §2–§3). Status values are plain strings in
 * the database, constrained by CHECK constraints; this module is the
 * single TypeScript source the services validate against.
 */

// ---------------------------------------------------------------------------
// Vendors (schema doc §3)
// ---------------------------------------------------------------------------

export const VENDOR_VERIFICATION_STATUSES = [
  "PENDING_VERIFICATION",
  "UNDER_REVIEW",
  "APPROVED",
  "REJECTED",
  "SUSPENDED",
  "INACTIVE",
] as const;
export type VendorVerificationStatus = (typeof VENDOR_VERIFICATION_STATUSES)[number];

/** The verification lifecycle (spec §14.1): pending → under review →
 *  approved / rejected / suspended / inactive. */
export const VENDOR_VERIFICATION_TRANSITIONS: Readonly<
  Record<VendorVerificationStatus, readonly VendorVerificationStatus[]>
> = {
  PENDING_VERIFICATION: ["UNDER_REVIEW", "REJECTED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED"],
  APPROVED: ["SUSPENDED", "INACTIVE"],
  REJECTED: ["UNDER_REVIEW"],
  SUSPENDED: ["APPROVED", "INACTIVE"],
  INACTIVE: ["UNDER_REVIEW"],
};

export const VENDOR_ROLES = ["OWNER", "MANAGER", "BOOKING_STAFF", "ACCOUNTS_STAFF"] as const;
export type VendorRole = (typeof VENDOR_ROLES)[number];

/** Sub-roles allowed to create bookings (matrix §5.4: Accounts Staff
 *  never receive operational write access). */
export const VENDOR_BOOKING_ROLES: readonly string[] = ["OWNER", "MANAGER", "BOOKING_STAFF"];
/** Sub-roles allowed to manage the organisation (addresses, team). */
export const VENDOR_MANAGER_ROLES: readonly string[] = ["OWNER", "MANAGER"];

export const VENDOR_ADDRESS_KINDS = ["PICKUP", "BILLING", "OFFICE"] as const;
export const VENDOR_DOCUMENT_TYPES = [
  "REGISTRATION",
  "PAN_VAT",
  "TAX_CLEARANCE",
  "ID_PROOF",
  "OTHER",
] as const;
export const VENDOR_DOCUMENT_STATUSES = ["PENDING_REVIEW", "APPROVED", "REJECTED"] as const;
export const BILLING_PREFERENCES = ["PREPAID", "CREDIT", "COD_OFFSET"] as const;

// ---------------------------------------------------------------------------
// Customers (schema doc §3)
// ---------------------------------------------------------------------------

export const CUSTOMER_ADDRESS_KINDS = ["PICKUP", "DELIVERY", "HOME"] as const;

// ---------------------------------------------------------------------------
// Orders / shipments (schema doc §4)
// ---------------------------------------------------------------------------

export const ORDER_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "CONFIRMED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;
export const ORDER_APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;
export const ORDER_PAYMENT_STATUSES = [
  "UNPAID",
  "PENDING",
  "PARTIAL",
  "PAID",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "DISPUTED",
] as const;
export const PAYMENT_METHODS = [
  "CASH",
  "BANK_TRANSFER",
  "MOBILE_WALLET",
  "ONLINE_GATEWAY",
  "PREPAID_BALANCE",
  "CREDIT_ACCOUNT",
] as const;
export const PICKUP_METHODS = ["RIDER_PICKUP", "WAREHOUSE_DROPOFF"] as const;

export const SHIPMENT_KINDS = ["FORWARD", "RETURN", "EXCHANGE"] as const;
/** UNROUTED is the held state: the destination district has no serving
 *  warehouse yet, so the booking waits visibly instead of being
 *  silently misrouted (brief Phase 3 routing rule). */
export const ROUTE_KINDS = ["LAST_MILE", "INTER_WAREHOUSE", "UNROUTED"] as const;
export const SHIPMENT_STATUSES = [
  "ACTIVE",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
  "RETURNED",
  "CANCELLED",
] as const;

// ---------------------------------------------------------------------------
// Packages (schema doc §5 — five separate status fields)
// ---------------------------------------------------------------------------

export const PACKAGE_CATEGORIES = [
  "DOCUMENT",
  "PACKAGE",
  "FRAGILE",
  "PERISHABLE",
  "LIQUID",
  "OTHER",
] as const;

export const PACKAGE_CONDITIONS = [
  "GOOD",
  "DAMAGED",
  "SUSPECTED_DAMAGE",
  "PACKAGING_COMPROMISED",
] as const;

export const PACKAGE_PAYMENT_STATUSES = [
  "NOT_APPLICABLE",
  "PENDING",
  "PAID",
  "COD_DUE",
  "COD_COLLECTED",
  "COD_REMITTED",
  "COD_SETTLED",
  "REFUNDED",
] as const;

export const PACKAGE_DELIVERY_STATUSES = [
  "NOT_STARTED",
  "ASSIGNED",
  "OUT_FOR_DELIVERY",
  "ATTEMPTED",
  "DELIVERED",
  "FAILED",
  "REFUSED",
  "RETURN_INITIATED",
  "RETURNED_TO_WAREHOUSE",
  "RETURNED_TO_SENDER",
] as const;

export const PACKAGE_EXCEPTION_STATUSES = [
  "NONE",
  "ON_HOLD",
  "ADDRESS_CLARIFICATION_REQUIRED",
  "DAMAGED",
  "MISSING",
  "MISROUTED",
  "DELAYED",
  "CUSTOMER_UNAVAILABLE",
  "RECIPIENT_REFUSED",
  "DELIVERY_FAILED",
  "PICKUP_FAILED",
  "RETURN_REQUESTED",
  "RETURN_APPROVED",
  "LOST_UNDER_INVESTIGATION",
  "RESOLVED",
] as const;

export const TRACKING_SOURCES = ["WEB", "SCANNER", "MOBILE", "SYSTEM", "OFFLINE_SYNC"] as const;
