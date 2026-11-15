# BLA — Entity Relationships

**Status:** design companion to `database-schema.md` · **Date:** 2026-11-15
**Purpose:** the core relationship chains of the new Prisma/PostgreSQL schema, their cardinalities, and the invariants each chain enforces. Field-level detail lives in `database-schema.md`; this document is about how the entities hold together and what the structure makes impossible.

**Notation:** `1 ──< n` = one-to-many, `1 ── 1` = one-to-one, `n ── n` = many-to-many via a named join entity. "Open" rows mean a nullable end timestamp is still `NULL` (`releasedAt`, `endedAt`, `revokedAt`).

---

## 1. The booking chain — Vendor → Order → Shipment → Package → TrackingEvent

```
Vendor 1 ──< n Order            (a vendor books many orders; walk-in orders have vendor = null)
Order  1 ──< n Shipment         (an order may split into several consignments)
Order  1 ──< n OrderItem        (booked lines; composition, cascade-deletable while draft)
Shipment 1 ──< n Package        (one consignment, many physical parcels)
Shipment 1 ── 1 Shipment        (RETURN / EXCHANGE shipments point back via originalShipmentId)
Package  1 ──< n PackageItem    (physical contents of that box)
Package  1 ──< n TrackingEvent  (append-only history)
Package  1 ── 1 PackageLabel    (per print generation; trackingId never changes)
Customer 1 ──< n Order          (as sender; optional — recipients need no account)
```

**Invariants**

- **A package belongs to exactly one shipment and, through it, exactly one order.** `Package.shipmentId` is mandatory; `Package.orderId` is a denormalised copy the service keeps equal to `shipment.orderId`. There is no path for a parcel to exist outside a booking — the legacy split (v1 `packages` with no status vs v2 `shipments` as the parcel) is merged into this single chain.
- **Order, Shipment and Package are three different facts** (spec §6.1): the Order is the commercial request, the Shipment is the transport contract (route, service, frozen price snapshot), the Package is the physical object that gets scanned. Statuses live at the right level: approval on the Order, roll-up on the Shipment, the 20-state lifecycle on the Package.
- **Shipment status is derived, never set.** It is recomputed from its packages on every package transition: all delivered → `DELIVERED`; some delivered → `PARTIALLY_DELIVERED` (Scenario 13 — 3 of 5 boxes delivered leaves 2 active and the shipment honestly partial); all returned → `RETURNED`.
- **A return never rewrites the original chain.** Refusal or vendor request creates a *new* `Shipment(kind = RETURN, originalShipmentId → original)` with its own packages' return journey; the original delivery history, attempts and POD records stay exactly as they happened (spec Part 12).
- **TrackingEvent is the only history.** Every transition in this chain writes an event in the same transaction as the state change; an event records previous status, new status, actor, warehouse, and an optional idempotency key. Events cannot be updated or deleted (append-only trigger), so the timeline a customer sees on the public tracking page and the timeline an auditor sees are the same rows.

---

## 2. The custody chain — Package → InventoryRecord / PackageCustody

```
Package 1 ──< n InventoryRecord     (one row per continuous stay at a warehouse)
Package 1 ──< n InventoryMovement   (append-only movement log)
Package 1 ──< n PackageCustody      (append-only chain; exactly one row is "open")
Warehouse 1 ──< n WarehouseZone 1 ──< n StorageLocation
StorageLocation 1 ──< n InventoryRecord   (where a stay is physically shelved)
HandoverBatch 1 ──< n CustodyHandover n ── 1 Package
CustodyHandover 1 ── 1 PackageCustody     (the custody row a confirmed handover opens)
```

**Invariants**

- **A package has exactly one current custodian.** Enforced physically: a partial unique index allows only one `PackageCustody` row per package with `endedAt IS NULL`. Custody is held by a warehouse (storage), a named user (rider/staff), the recipient (after delivery), or the return team. Any code path that moves a package must close the old custody and open the new one inside one transaction — there is no "in limbo" state and no silent custody change (spec §8.4).
- **Stock and custody are mutually exclusive views of the same fact.** A package physically on a shelf has an *open* `InventoryRecord` at that warehouse and a warehouse custody row. The moment it is handed to a rider, the inventory record is released (`releasedAt` set) and custody passes to the rider — so a package can never simultaneously appear as available warehouse stock *and* be out for delivery (spec §8.1).
- **No receiving scan, no inventory.** An `InventoryRecord` cannot be created without its `receivingEventId` pointing at the TrackingEvent produced by the physical scan (spec §7.3). Changing a status dropdown can never conjure stock into existence.
- **Handovers are counted, and mismatches become incidents.** A `HandoverBatch` declares `expectedCount`; each confirmed package closes one `CustodyHandover` line. If the batch closes with `confirmedCount ≠ expectedCount`, an `Incident(HANDOVER_DISCREPANCY)` is created automatically and the missing packages keep their previous custody — the giver remains accountable until the investigation resolves (spec §8.4: handed over 25, confirmed 23 ⇒ 2 packages are a discrepancy, not a rounding error).
- **Internal moves are movements, not transfers.** Rack-to-rack changes write an `InventoryMovement(INTERNAL_MOVE)` with from/to `StorageLocation` and never touch the Transfer chain (spec §9.5). Parcel movements (`InventoryMovement`) and supplies movements (`StockMovement`) are separate logs for separate kinds of stock (spec §8.2) — the legacy single `inventory` table that conflated them is split.

---

## 3. The transfer chain — Transfer → Manifest → Trip

```
Warehouse 1 ──< n Transfer (as origin)        Warehouse 1 ──< n Transfer (as destination)
Transfer 1 ──< n TransferItem n ── 1 Package  (the packages on this transfer)
TransferItem 1 ──< n TransferScan             (append-only load/unload scans, idempotent)
Transfer 1 ── 1 TransferManifest              (the frozen, sealed loading document)
Transfer 1 ── 1 Trip                          (one trip executes one transfer)
Trip 1 ──< n TripStop                         (checkpoints, in sequence)
Driver (LINEHAUL capability) 1 ──< n Trip     Vehicle 1 ──< n Trip
TransferItem n ── 0..1 Incident               (every missing/damaged/excess outcome links its case)
```

**Invariants**

- **A transfer cannot be dispatched without a sealed manifest, an assigned line-haul driver and an available vehicle.** The service checks all three (plus driver `LINEHAUL` capability and unexpired vehicle insurance/registration) before `READY_FOR_DISPATCH → DISPATCHED`; the manifest's `packageCount` is the count of its items at seal time and cannot drift afterwards — post-dispatch changes require an authorised amendment recorded as TrackingEvent + AuditLog.
- **A package can be on only one open transfer at a time** (partial unique index over `TransferItem` for non-closed transfers), and only packages with an open `InventoryRecord` at the *origin* warehouse are eligible for selection — you cannot manifest what you do not physically hold.
- **Loading and receiving are scan-driven, and scans are idempotent.** Each `TransferScan` carries a unique idempotency key: scanning the same package twice (Scenario 7) returns the original scan instead of double-loading it. Item status moves only via scans (`EXPECTED → LOADED → IN_TRANSIT → RECEIVED / MISSING / DAMAGED / EXCESS`).
- **A transfer cannot close until received quantities reconcile.** `RECONCILED` requires every item to be `RECEIVED`, or to carry a non-clean status *with* a linked `Incident` whose resolution has been approved (spec §9.4). A partially received transfer sits in `PARTIALLY_RECEIVED / RECONCILIATION_PENDING` indefinitely — the destination warehouse is never forced to accept manifest quantities it did not physically receive, and the shortage stays visible on both warehouses' dashboards.
- **Arrival does not equal inventory.** Destination receiving scans close items and open destination `InventoryRecord`s + custody; a package that arrives but is not scanned exists only as an in-transit item — which is precisely what makes a shortage detectable instead of silently absorbed.
- **Trips are subordinate to transfers.** A `Trip` exists to execute one `Transfer`; trip incidents (breakdown, delay — Scenario 6) update the trip and notify dispatch, and an authorised driver/vehicle reassignment is recorded as new assignment data plus TrackingEvents, with package custody reconciled at the physical handover — packages are never "moved" to a new driver by editing a row.

---

## 4. The delivery chain — DeliveryAssignment → DeliveryAttempt → ProofOfDelivery

```
Driver 1 ──< n DeliveryBatch 1 ──< n DeliveryAssignment
Package 1 ──< n DeliveryAssignment        (history of assignments, incl. reassignments)
DeliveryAssignment 1 ── 1 DeliveryAssignment  (reassignedFromId chain, Scenario 14)
DeliveryAssignment 1 ──< n DeliveryAttempt    (append-only, numbered per assignment)
Package 1 ── 0..1 ProofOfDelivery (current)   ProofOfDelivery 1 ── 1 ProofOfDelivery (supersededById chain)
DeliveryAssignment 1 ── 0..1 CODCollection    (when the package is COD)
```

**Invariants**

- **One active assignment per package per kind.** A partial unique index prevents two riders from simultaneously holding the same package for delivery; reassignment closes the old assignment (`REASSIGNED`), creates a new one chained via `reassignedFromId`, and moves custody through a `HandoverBatch` — the full assignment history stays visible (Scenario 14).
- **Attempts are facts, not counters.** Every visit writes a `DeliveryAttempt` with result, reason, contact outcome and next action (the legacy design stored only `failed_attempts Int` — who, when, why and what-next were unrecoverable). Attempt numbers are unique per assignment.
- **No proof, no "delivered".** `Package.operationalStatus` may enter `DELIVERED` only when a non-superseded `ProofOfDelivery` exists for the package (OTP verified, signature, photo, or authorised-recipient record) **or** when an approved `Approval(kind = DELIVERY_WITHOUT_PROOF)` is linked from the delivery event (spec §7.3). The lifecycle service enforces this; there is no status-editing endpoint that bypasses it.
- **Delivery and COD are one atomic act.** When a COD package is delivered, the `CODCollection` is created in the same transaction as the POD and the `DELIVERED` transition, for exactly the package's `codAmountPaisa` (`@@unique([packageId])` on CODCollection makes a second collection a database error). A failed attempt creates no collection and leaves the COD due.
- **Failed delivery always has a next step.** An attempt's `nextAction` (redeliver, address correction, support escalation, return initiation) drives the follow-up work queues; `RETURN_TO_SENDER` spawns the return Shipment of chain §1 rather than mutating the original.

---

## 5. The money chain — Order → Invoice → Payment → LedgerTransaction

```
Order 1 ──< n Invoice 1 ──< n PaymentAllocation n ── 1 Payment
Payment 1 ──< n Refund                       (refunds reverse; they never edit the payment)
FinancialAccount 1 ──< n LedgerTransaction   (append-only, immutable)
LedgerTransaction 1 ── 0..1 LedgerTransaction (reversalOfId — an entry is reversed at most once)
LedgerTransaction n ── 0..1 Payment / CODCollection / VendorSettlement / Order / Package
FinancialAdjustment 1 ── 0..1 LedgerTransaction (applying an adjustment creates its entry)
```

**Invariants**

- **The ledger is the truth; everything else is a cache.** Account balances are computed by summing `LedgerTransaction`s. `Order.paymentStatus`, `Package.paymentStatus` and `Invoice.status` are derived roll-ups recomputed by the finance service from payments, allocations and ledger rows — they are never written by hand, which eliminates the legacy three-sources-of-truth duplication (payments table + order columns + shipment columns, audit §5).
- **Ledger entries are immutable.** No update, no delete (append-only trigger). An error is corrected by a `REVERSAL` entry of opposite direction linked via `reversalOfId`, or by a `FinancialAdjustment` that posts its own entry after approval. The original entry — including the mistake — remains visible forever (spec §13.5, §4.9).
- **A payment cannot be counted twice.** `Payment.idempotencyKey` is unique and gateway `transactionRef` is unique where present: a duplicated confirmation request (Scenario 12) returns the existing payment instead of posting a second one.
- **Allocations cannot over-settle.** Σ `PaymentAllocation` for a payment ≤ the payment amount; Σ allocations against an invoice drive its status (`ISSUED → PARTIALLY_PAID → PAID`) and can never exceed `totalPaisa` (service-enforced inside the posting transaction).
- **Shipping revenue and COD never mix.** Shipping charges post to `SHIPPING_REVENUE`; COD posts to `COD_CLEARING`/`VENDOR_PAYABLE` liability accounts. A rupee collected for a vendor is money the company *owes*, and no report can present it as income (spec §13.1).

---

## 6. The COD chain — CODCollection → DriverRemittance → VendorSettlement

```
Package (COD) 1 ── 1 CODCollection
Driver 1 ──< n DriverRemittance 1 ──< n CODCollection   (collections join a remittance when handed in)
VendorSettlement 1 ──< n VendorSettlementLine n ── 0..1 CODCollection
VendorSettlementLine n ── 0..1 Invoice                    (shipping charges settled by deduction)
CODCollection 1 ── 1 LedgerTransaction (collection)  DriverRemittance ──> LedgerTransaction (verification)
Incident (COD_DISCREPANCY) n ── 0..1 DriverRemittance / CODCollection
```

**Invariants**

- **The collected figure is frozen at the door.** `CODCollection.amountPaisa` records what the rider collected from the recipient and is never edited. What the rider later hands over is a *different number on a different row* (`DriverRemittance.declaredAmountPaisa`, then Finance's `countedAmountPaisa`). Scenario 5 — collected Rs 5,000, remitted Rs 4,500 — is therefore representable exactly: collection 500,000 paisa, counted remittance 450,000 paisa, `discrepancyPaisa = −50,000`, all three facts preserved.
- **A discrepancy blocks settlement of the short amount.** Verification with `discrepancyPaisa ≠ 0` opens an `Incident(COD_DISCREPANCY)`; the affected collections stay out of `VERIFIED` status and cannot be picked up by a settlement until the incident resolves (spec §13.4).
- **A collection is settled at most once.** `VendorSettlementLine.codCollectionId` is unique where set: the same collected rupee cannot appear in two settlements. Settlement lines also carry the shipping-charge deductions (via Invoice links), so `netPayable = Σ COD credits − Σ charges − Σ deductions` is fully traceable line by line — the legacy `settlements` table's untraceable lump sums (audit §1.5) are not repeated.
- **Only verified money settles.** A settlement may only include `CODCollection`s in `VERIFIED` status belonging to remittances that Finance has verified; approval requires the `settlement.approve` permission and posts the closing ledger entries (`COD_SETTLED`) in the same transaction.

---

## 7. The access chain — User → Role / Membership / Vendor

```
User n ── n Role                    (via UserRole; grants via RolePermission n ── n Permission)
User 1 ──< n WarehouseMembership n ── 1 Warehouse   (role held at that warehouse; revokedAt closes)
User 1 ── 0..1 Driver               (operational profile; capabilities via DriverCapability)
User n ── n Vendor                  (via VendorUser, with an intra-vendor role)
User 1 ── 0..1 Customer             (optional account link; recipients need none)
User 1 ──< n Session                (revocable; suspension kills sessions)
```

**Invariants**

- **Authorisation is resolved server-side from these tables on every request** — the caller's roles, permissions and active warehouse memberships are loaded from the database; role or warehouse claims in the request are ignored (spec §20.2, §21.3). This replaces the legacy arrangement where the backend's service-role key bypassed RLS and a flag (`REQUIRE_AUTH`) could disable the gate entirely (audit R2, R9).
- **Warehouse isolation is structural.** Warehouse-scoped tables carry `warehouseId`; queries filter by the caller's non-revoked memberships. A Warehouse Admin of Kathmandu has no membership row for Pokhara, so no query they can issue returns Pokhara stock — isolation does not depend on the UI hiding anything (spec §4.3).
- **Revocation is immediate and remembered.** Removing a `UserRole` or setting `WarehouseMembership.revokedAt` takes effect on the next request and is written to `AuditLog`; suspending a `User` revokes their `Session`s, and if they hold custody of packages, the suspension workflow forces custody reassignment first (Scenario 17).

---

## 8. Satellite relations — Tasks, Incidents, Notifications, Audit

```
Task n ── 0..1 Package / Shipment / Transfer / Incident     Task 1 ──< n TaskComment
Incident n ── 0..1 Package / Order / Transfer / Trip / CODCollection / DriverRemittance
Incident 1 ──< n IncidentEvidence n ── 1 FileAsset
User 1 ──< n Notification        (dedupeKey unique — event retries never double-notify)
User 1 ──< n AuditLog            (append-only; also records denied/anonymous attempts with actor = null)
FileAsset n ── attached to ──> ProofOfDelivery, Driver documents, Incident evidence, Labels, Settlements
```

**Invariants**

- **Problems are entities, not status overwrites.** A missing package is an open `Incident` linked to the package — the package's inventory/custody rows stay in place as an unresolved discrepancy until an *approved* incident resolution closes it (spec §16.3). Nothing operational is ever "fixed" by deleting its record.
- **Every sensitive action leaves an AuditLog row in the same transaction** as the action itself (role grants, suspensions, settings changes, financial approvals, authorisation denials), with actor, role snapshot, scope warehouse and redacted before/after diffs.
- **Notifications are consequences, not decoration.** Each notification links to the entity and event that caused it and carries a `dedupeKey`, so a retried event cannot spam the recipient (spec Part 17) — replacing the legacy global admin feed that was linked to nothing.

---

## 9. Cross-cutting invariants (the spec's closing principles, as schema properties)

| Principle | Where the schema enforces it |
|---|---|
| Every package has a known location | Open `InventoryRecord` *or* open custody with a rider/trip — exactly one of the two, always (partial unique indexes on both). |
| Every package has a known status | Five separate status fields on `Package` (operational / condition / payment / delivery / exception), changed only through the lifecycle service with a transition table. |
| Every package has an accountable custodian | Exactly one open `PackageCustody` row per package, at all times. |
| Every package has a complete history | Append-only `TrackingEvent` written in the same transaction as every change; no update/delete path exists. |
| Every transfer is physically reconciled | `Transfer` cannot reach `CLOSED` until every item is received or incident-resolved (§3). |
| Every delivery has a recorded outcome | `DELIVERED` requires `ProofOfDelivery` or an approved exception; every failure is a `DeliveryAttempt` with a next action (§4). |
| Every payment is financially traceable | Immutable `LedgerTransaction`s with unique references and idempotency keys; balances derived, never overwritten (§5, §6). |
| Every user has only the permissions their job needs | Data-driven Role/Permission tables + warehouse memberships, checked server-side on every operation (§7). |
| History and financial records are never deleted | `Restrict` FKs on all history-bearing relations, status-based archival instead of deletes, append-only triggers on event/ledger/audit tables. |
