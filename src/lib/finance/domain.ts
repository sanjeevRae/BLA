/**
 * Phase 7 finance vocabularies (docs/financial-workflow.md,
 * docs/cod-reconciliation.md, docs/database-schema.md §9).
 *
 * Money is integer paisa in BigInt everywhere — no floats in any
 * money path. COD is a liability until settled, never revenue
 * (rule F0). The ledger is append-only: corrections are new linked
 * entries, never edits.
 */

// ---------------------------------------------------------------------------
// Accounts (database-schema §9, FinancialAccount)
// ---------------------------------------------------------------------------

export const ACCOUNT_KINDS = ["ASSET", "LIABILITY", "REVENUE", "EXPENSE"] as const;
export const ACCOUNT_OWNER_TYPES = ["COMPANY", "VENDOR", "DRIVER"] as const;

/** Company-level chart of accounts, seeded as reference data. Per-vendor
 *  VENDOR_PAYABLE and per-driver DRIVER_CASH accounts are created lazily
 *  by the finance services (find-or-create inside the posting
 *  transaction) with codes suffixed by the owner id. */
export const COMPANY_ACCOUNTS = [
  { code: "CASH_ON_HAND", name: "Cash on hand", kind: "ASSET" },
  { code: "BANK", name: "Bank accounts", kind: "ASSET" },
  { code: "ACCOUNTS_RECEIVABLE", name: "Accounts receivable (counter/customer charges)", kind: "ASSET" },
  { code: "COD_CLEARING", name: "COD clearing — verified cash held for vendors", kind: "ASSET" },
  { code: "DRIVER_CASH", name: "Driver cash template (per-driver accounts)", kind: "ASSET" },
  { code: "VENDOR_PAYABLE", name: "Vendor payable template (per-vendor accounts)", kind: "LIABILITY" },
  { code: "COD_DISCREPANCY", name: "COD discrepancy suspense", kind: "LIABILITY" },
  { code: "SHIPPING_REVENUE", name: "Shipping revenue", kind: "REVENUE" },
  { code: "DEDUCTIONS_INCOME", name: "Settlement deductions income", kind: "REVENUE" },
] as const;

export const vendorPayableAccountCode = (vendorId: string) => `VENDOR_PAYABLE:${vendorId}`;
export const driverCashAccountCode = (driverId: string) => `DRIVER_CASH:${driverId}`;

/** Debit-normal kinds: balance = Σ DEBIT − Σ CREDIT. The others are
 *  credit-normal: balance = Σ CREDIT − Σ DEBIT. */
export const DEBIT_NORMAL_KINDS: readonly string[] = ["ASSET", "EXPENSE"];

// ---------------------------------------------------------------------------
// Ledger (database-schema §9, LedgerTransaction)
// ---------------------------------------------------------------------------

export const LEDGER_DIRECTIONS = ["DEBIT", "CREDIT"] as const;

export const LEDGER_TYPES = [
  "SHIPPING_CHARGE",
  "PAYMENT_RECEIVED",
  "COD_COLLECTED",
  "COD_REMITTED",
  "COD_SETTLED",
  "REFUND",
  "ADJUSTMENT",
  "REVERSAL",
  "DRIVER_PAYOUT",
] as const;

// ---------------------------------------------------------------------------
// Invoices & payments (financial-workflow §2–§3)
// ---------------------------------------------------------------------------

export const INVOICE_STATUSES = [
  "DRAFT",
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "CANCELLED",
  "REFUNDED",
] as const;

/** Stored statuses the finance service recomputes from allocations;
 *  OVERDUE is derived at read time from dueAt, never stored. */
export const INVOICE_RECOMPUTABLE_STATUSES: readonly string[] = [
  "ISSUED",
  "PARTIALLY_PAID",
  "PAID",
];

export const INVOICE_LINE_KINDS = [
  "SHIPPING_CHARGE",
  "RETURN_CHARGE",
  "ADJUSTMENT",
] as const;

export const PAYMENT_METHODS = [
  "CASH",
  "BANK_TRANSFER",
  "MOBILE_WALLET",
  "ONLINE_GATEWAY",
  "PREPAID_BALANCE",
  "CREDIT_ACCOUNT",
] as const;

export const PAYMENT_STATUSES = [
  "PENDING",
  "PAID",
  "FAILED",
  "REFUNDED",
  "PARTIALLY_REFUNDED",
  "DISPUTED",
  "REVERSED",
] as const;

export const PAYER_TYPES = ["CUSTOMER", "VENDOR", "COMPANY"] as const;

/** Ledger cash account a payment method settles into. */
export function cashAccountForMethod(method: string): "CASH_ON_HAND" | "BANK" {
  return method === "CASH" ? "CASH_ON_HAND" : "BANK";
}

// ---------------------------------------------------------------------------
// COD remittances (cod-reconciliation §1 steps 7–9, §3)
// ---------------------------------------------------------------------------

export const REMITTANCE_STATUSES = [
  "SUBMITTED",
  "UNDER_VERIFICATION",
  "VERIFIED",
  "DISCREPANCY",
  "CLOSED",
] as const;

export const REMITTANCE_RESOLUTIONS = ["ACCEPTED_COUNTED", "REJECTED"] as const;

/** Collection methods a rider may hand over by (the DeliveryCodCollection
 *  method vocabulary). */
export const REMITTANCE_METHODS = ["CASH", "MOBILE_WALLET", "BANK_TRANSFER"] as const;

// ---------------------------------------------------------------------------
// Vendor settlements (cod-reconciliation §4)
// ---------------------------------------------------------------------------

export const SETTLEMENT_STATUSES = [
  "PENDING",
  "RECONCILED",
  "APPROVED",
  "SETTLED",
  "DISPUTED",
  "CANCELLED",
] as const;

export const SETTLEMENT_LINE_KINDS = [
  "COD_CREDIT",
  "SHIPPING_CHARGE",
  "DEDUCTION",
  "ADJUSTMENT",
] as const;

// ---------------------------------------------------------------------------
// Refunds & adjustments (financial-workflow §5–§6)
// ---------------------------------------------------------------------------

export const REFUND_STATUSES = ["REQUESTED", "APPROVED", "PROCESSED", "REJECTED"] as const;

export const ADJUSTMENT_STATUSES = ["REQUESTED", "APPROVED", "REJECTED", "APPLIED"] as const;

export const ADJUSTMENT_TARGET_TYPES = [
  "PAYMENT",
  "INVOICE",
  "COD_COLLECTION",
  "SETTLEMENT",
  "LEDGER",
] as const;

/** Targets the Phase 7 apply path implements concretely. Other targets
 *  are rejected at creation with a clear error rather than silently
 *  accepted (the remaining targets land with the Phase 8 incident
 *  workflows that own their resolution paths). */
export const ADJUSTMENT_APPLIABLE_TARGETS: readonly string[] = ["INVOICE", "COD_COLLECTION"];
