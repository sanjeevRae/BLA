# Financial Workflow — BLA Logistics Platform

**Purpose.** Every rupee the platform touches must be traceable to an original
transaction, and no financial record is ever rewritten. This document defines
the money concepts, the ledger, invoices and payments, and the adjustment and
refund mechanics. COD detail lives in cod-reconciliation.md. Spec reference:
Part 13; Scenario 12. **Currency: NPR throughout. Timestamps stored in UTC,
displayed in Asia/Kathmandu.**

---

## 1. The ten money concepts — always separate

These are different kinds of money and are stored, totalled and reported
separately. Mixing them is the classic logistics-accounting failure this
design exists to prevent (spec §13.1).

| # | Concept | Nature |
|---|---|---|
| 1 | Shipping revenue | Company's earned income from delivery charges |
| 2 | Shipping charges paid | Charges already settled by the payer |
| 3 | Shipping charges outstanding | Charges invoiced/accrued, not yet paid |
| 4 | COD collected from recipient | Cash/wallet taken at the door — **held for the vendor** |
| 5 | COD held by driver | Collected, not yet remitted (a liability of the rider) |
| 6 | COD remitted to company | Received from rider, verified by finance |
| 7 | COD payable to vendor | Company's liability to the vendor after reconciliation |
| 8 | Vendor settlement | A payout event settling payable + charges per contract |
| 9 | Refund | Money returned to a payer |
| 10 | Financial adjustment | A correcting entry linked to an original transaction |

**Rule F0:** COD collected for a vendor is a **liability**, not revenue. It
becomes relevant to revenue only through the shipping charges the vendor owes,
which are settled per contract — never by quietly netting COD into income.

## 2. Payment methods and statuses

**Methods** (configurable list, `settings.manage`): cash · bank transfer ·
mobile wallet · online payment gateway · prepaid account balance · approved
credit account. **No raw card details are ever stored** — gateway payments
keep only the gateway's reference.

**Payment status** (on invoices/payments, independent of delivery status):
`pending` · `partially_paid` · `paid` · `failed` · `refunded` ·
`partially_refunded` · `disputed` · `reversed`.

The legacy system conflated these onto the order row (`payment_status`
unpaid/pending/paid/refunded, set by a workflow endpoint independently of any
money movement). In the rebuild, an order's displayed payment status is a
**rollup of its invoices and payments**, and it changes only when a finance
service records an actual payment event.

## 3. Invoices, payments, allocations

1. **Invoice** (`invoice.create`, FN): issued to a vendor (periodic statement
   billing) or against a shipment (prepaid/counter). Lines reference the
   underlying charges (shipment charges, return charges, adjustments). An
   issued invoice is immutable; corrections are credit-note adjustments.
2. **Payment** (`finance.record_payment`, FN): records money actually
   received — amount, method, payer, reference (bank txn id, wallet txn id,
   gateway reference, or cash receipt number), time, recorded-by.
3. **PaymentAllocation**: links a payment to one or more invoices/charges.
   A payment can be partially allocated; unallocated remainder is payer
   credit, visible on their statement. Balances are always the sum of
   allocations — never a hand-edited number on a profile.
4. **Idempotency (Scenario 12):** every payment-creation request carries an
   idempotency key (gateway reference for online payments; a client-generated
   key + reference for manual entry). A duplicate submission returns the
   original payment record. A payment **cannot be counted twice** — enforced
   by a unique constraint on the key, not by UI care.

## 4. The ledger

`LedgerTransaction` is the immutable spine. Every money movement writes one:

| Field | Notes |
|---|---|
| `transactionId` / `reference` | Unique human-readable reference |
| `account` | The financial account affected (company cash, vendor payable, rider COD, revenue, …) |
| `amount` + `currency` (NPR) | Signed by direction convention of the account |
| `type` | `charge`, `payment`, `cod_collection`, `cod_remittance`, `settlement`, `refund`, `adjustment`, `reversal` |
| `relatedOrderId` / `relatedPackageId` | Operational link where applicable |
| `paymentMethod` | Where money moved |
| `occurredAt` / `recordedAt` | Event time vs entry time |
| `actorId` | Who recorded it (DB-resolved) |
| `approvedBy` | For adjustments and settlements above threshold |
| `reversesTransactionId` / `adjustsTransactionId` | Link for corrections |
| `idempotencyKey` | Unique |

**Ledger rules:**
- **Append-only.** No update, no delete — for any role, including Super
  Admin. A mistake is corrected by a new `adjustment` or `reversal` entry
  that references the original (spec §13.5, §4.9).
- **Balanced operations in DB transactions.** Operations that move money
  between accounts (settlement, remittance verification, refund) write all
  their ledger entries in one database transaction — all or nothing.
- **Balances are derived.** Vendor payable, rider cash, outstanding charges:
  computed from the ledger (with cached rollups only where they are provably
  rebuilt from the ledger). Nobody edits a balance field.

## 5. Adjustments and approvals

1. FN creates an adjustment: target transaction, amount, reason (mandatory),
   evidence. Status `pending_approval`.
2. A **different** user with `finance.approve_adjustment` (SA; AD below a
   configured threshold) approves or rejects. Self-approval is impossible —
   enforced by a check that approver ≠ creator.
3. On approval the adjustment posts to the ledger and the affected statements
   regenerate. On rejection nothing posts; the request and reason remain in
   history.
4. Sensitive adjustments (write-offs of COD shortages, charge waivers above
   threshold) additionally require the linked incident to be resolved or
   referenced.

## 6. Refunds

`refund.process` (FN): references the original payment, the reason (e.g.
return completed, duplicate payment, service failure), amount ≤ original
un-refunded remainder, method (same channel where possible). Posts ledger
entries, moves the payment toward `refunded`/`partially_refunded`, and is
visible on the payer's statement. A refund never edits the original payment.

## 7. Pricing inputs (no hardcoded prices)

Shipping charges come from `PricingRule` + `ShippingService` configuration
(`pricing.manage`): billable weight = max(actual, volumetric), volumetric =
L×W×H / configured divisor (package weight data per spec §6.3). Charges are
computed at booking/intake and frozen onto the shipment; later tariff changes
never retroactively change an existing shipment's charge. Frontend components
contain no prices (spec §6.3).

## 8. Actors and permissions

Per role-permission-matrix.md §3.7: FN records and prepares; SA approves
adjustments and high-value settlements; AD has read-level operational finance
only; WA sees COD expectations for own warehouse only; vendors see their own
invoices, statements and settlements (`invoice.read`, `settlement.read`,
scoped V); operational roles have no finance write permissions, and finance
has no custody/package permissions.

## 9. Failure handling

| Failure | Behaviour |
|---|---|
| Duplicate payment submission (double click, gateway retry) | Idempotency key returns the original payment; exactly one ledger entry exists (Scenario 12) |
| Payment recorded against the wrong invoice | Fixed by re-allocation via adjustment entries; original allocation preserved |
| Gateway webhook arrives twice / out of order | Processed idempotently by gateway reference; status transitions validated (a `paid` payment cannot regress to `pending`) |
| Amount mismatch vs invoice | Partial allocation; remainder stays outstanding and ages on reports; no silent rounding |
| Adjustment attempted by its own creator | Approval action refused (approver ≠ creator check) |
| Attempt to delete/edit a ledger row | No such operation exists in any service or route; DB role for the app has no DELETE grant on ledger tables as defence-in-depth |
| Disputed payment (vendor/customer raises) | `payment.dispute.raise` opens a support/finance case; the payment is flagged `disputed`; funds are not re-moved until the case resolves via adjustment |
