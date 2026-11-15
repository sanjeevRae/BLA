# COD Reconciliation — BLA Logistics Platform

**Purpose.** Cash on delivery is the highest-risk money in the business: it is
collected in cash, at doors, by riders, for money that belongs to vendors.
This document defines the COD chain from booking declaration to vendor
settlement, so that every collected rupee is traceable from the recipient's
hand to the vendor's statement. Spec reference: §13.4; Scenario 5.

**Legacy note:** in the old system COD capture was a hidden side effect of
driver-task status updates, and settlements simply summed `cod_collections`.
There was no remittance verification step and no discrepancy state. The chain
below replaces that with explicit, separately recorded events.

---

## 1. The COD workflow — 13 steps

| # | Step | Record created |
|---|---|---|
| 1 | **Booking declares the COD amount** (vendor or counter booking; zero for prepaid) | `codAmount` on the shipment, frozen at booking; changes before pickup follow booking-edit rules, after pickup are impossible |
| 2 | **Amount confirmed per policy** at intake: warehouse verifies the declared COD against the shipment documents | Confirmation on the intake record |
| 3 | **Rider receives the delivery assignment** showing COD due per package | Assignment view (rider sees only own COD) |
| 4 | **Rider collects COD at the door** as part of delivery confirmation | — (same transaction as step 5) |
| 5 | **Rider records amount + method** (cash / wallet / transfer) | `CODCollection`: package, shipment, rider, amount, method, collectedAt — written **in the same DB transaction** as the `delivered` transition (a delivery cannot complete with COD silently skipped) |
| 6 | **Collection is linked** to package, shipment, rider and vendor | Ledger entry `cod_collection` (vendor-payable side) + rider cash balance increases |
| 7 | **Rider submits remittance**: hands cash to the warehouse/finance point or transfers, declaring the total submitted | `DriverRemittance` in state `submitted`, listing the collections it covers |
| 8 | **Finance verifies the remittance** against the declared total (`cod.verify`) | Remittance → `verified` or `discrepancy` (§3) |
| 9 | **COD ledger is updated**: rider cash balance decreases by the verified amount; company COD holding increases | Ledger entries `cod_remittance` |
| 10 | **Vendor payable is calculated** per vendor: verified COD held, minus shipping charges and return charges per contract, for the settlement period | Payable computation, reproducible from the ledger at any time |
| 11 | **Vendor settlement is approved** (`settlement.approve`; SA above threshold) | `VendorSettlement` approved |
| 12 | **Payment is recorded** (`settlement.pay`) with method + reference | Ledger entries close the payable for the settled items |
| 13 | **Vendor receives a statement**: per-package COD, charges, adjustments, net paid | Statement generated from ledger data only |

## 2. Driver cash balances

- Each rider has a **cash position**: `collected − remitted(verified) =
  outstanding`. It is derived from `CODCollection` and `DriverRemittance`
  records, never a typed-in number.
- The rider's dashboard shows: COD to collect today, collected today,
  outstanding balance, remittances pending verification.
- **Exposure cap:** a rider whose outstanding balance exceeds the configured
  cap cannot be assigned new COD deliveries (delivery-workflow.md §3) until
  they remit. WA sees the block reason; the rider sees their own balance —
  nobody is surprised.
- Remittance is expected same-day by default policy (configurable). Overdue
  remittances surface on the WA and FN dashboards and notify the rider.

## 3. The mismatch scenario — collected Rs. 5,000, remitted Rs. 4,500

Spec Scenario 5, step by step:

1. The original collection record stands: **Rs. 5,000**, linked to its
   package and rider. It is never edited.
2. The remittance is recorded as submitted: **Rs. 4,500**.
3. At verification, finance records `verified amount = 4,500`. The system
   computes the **Rs. 500 discrepancy** automatically and shows it on the
   remittance, the rider's balance (Rs. 500 remains outstanding), and the
   finance dashboard.
4. A **finance incident** (`cod_discrepancy`) is auto-created, assigned to
   FN, linked to rider, remittance and collection.
5. The missing Rs. 500 is **excluded from vendor payable** for settlement —
   the vendor is not paid money the company does not hold, and the shortfall
   is not silently absorbed either: it sits as a named, owned discrepancy.
6. Resolution paths, all recorded on the incident: rider remits the balance
   later (remittance #2 covers it; incident closes), rider explains an
   authorised exception (e.g. recipient paid partially with WA-approved
   exception at the door — cross-checked against the delivery record), or
   escalation to AD/SA for recovery/write-off. A write-off posts as a
   **financial adjustment** with SA approval (financial-workflow.md §5) —
   the original records still show 5,000 / 4,500 forever.

Over-remittance (rider submits more than collected) follows the mirror path:
excess is recorded, held as unallocated rider credit, and resolved by finance
— never pocketed into a settlement.

## 4. Vendor payable and settlement

- Payable per vendor per period = Σ verified COD collections for that
  vendor's delivered packages − Σ shipping charges − Σ return charges ±
  approved adjustments. Every term is a ledger query; the settlement screen
  shows the full breakdown per package before approval.
- A settlement covers an explicit list of collections/charges. Items in
  discrepancy (unverified remittance, disputed payment) are **excluded and
  listed as pending**, not netted quietly.
- Approval: FN prepares (`settlement.prepare`), AD approves below the
  configured NPR threshold, SA above it (`settlement.approve`). Payment
  recording is FN (`settlement.pay`) with method + external reference.
- After payment, the vendor's statement shows exactly which packages' COD
  and which charges composed the payout.

## 5. Actors and permissions

| Action | Who | Permission |
|---|---|---|
| Collect + record COD | Assigned delivery rider | `cod.collect` |
| Submit remittance | Rider (own) | `cod.remit` |
| Verify remittance | Finance, SA | `cod.verify` |
| View COD position | FN/SA all; AD operational totals; WA own-warehouse expectations; rider own; vendor own (collected/settled view) | `cod.read` (scoped) |
| Prepare/approve/pay settlement | FN / AD≤threshold, SA / FN | `settlement.prepare` / `settlement.approve` / `settlement.pay` |

Warehouse staff handle physical cash hand-in only as the receiving point of a
remittance; the verification and ledger steps are finance's — WA cannot mark
a remittance verified.

## 6. Rules and invariants

1. No `delivered` COD package without a `CODCollection` in the same
   transaction (or a WA-authorised exception that creates an incident).
2. Collections are immutable; corrections are new records (adjustments,
   additional remittances), never edits.
3. A collection can be covered by exactly one *verified* remittance;
   remittance coverage is by explicit collection list, not by lump-sum
   matching, so partial coverage is always explainable.
4. Vendor payable is computed only from **verified** remittances.
5. Rider cash, company COD holding and vendor payable reconcile to the
   ledger at all times; the finance dashboard shows the three-way check and
   flags any drift as an incident (drift should be impossible — if it
   appears, it is a bug, and it is treated as one).

## 7. Failure handling

| Failure | Behaviour |
|---|---|
| Rider records COD amount different from the amount due | The difference must be routed through the door-step exception (recipient paid less / refused COD) with WA approval; otherwise delivery confirmation is blocked |
| Remittance submitted twice (double tap / retry) | Idempotency key on submission; the second returns the original remittance |
| Finance verifies less than submitted (counting error suspected) | Verified amount is what's counted; the gap opens the §3 discrepancy path with both figures preserved |
| Rider leaves / is suspended with an outstanding balance | Balance surfaces on AD/FN dashboards; settlement of the rider's final pay is a manual HR process, but the platform keeps the exact outstanding figure and collection list as the record (Scenario 17 interplay) |
| Vendor disputes a settlement figure | Dispute opens a case; the statement's per-package breakdown is the shared evidence; any correction posts as an adjustment in the next settlement, never by editing the paid one |
| COD package delivered while system offline | Collection is captured in the offline delivery record and syncs with it; until sync, the rider's balance shows "pending sync" amounts separately from confirmed balance |
