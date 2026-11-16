# Package Lifecycle and Status Engine — BLA Logistics Platform

**Purpose.** One central lifecycle service owns every package state change. No
screen, API route or script sets a package status directly — operations (receive,
dispatch, deliver…) call `PackageLifecycleService.transition()`, which validates
the move against the transition table, writes the new state, and appends an
immutable tracking event, all in one database transaction. Spec reference: Part 7.

**Why this exists:** the old system had two parallel order paths (classic
`/orders` and Phase-3 `/workflow`), status history written by a Postgres trigger
that recorded `changed_by = NULL` for most (service-role) writes, and a public
status vocabulary of only `received → on_place → went_for_delivery →
out_for_delivery → delivered`. The new engine replaces all of that with one
validated state machine whose every step is attributed.

---

## 1. Concepts

An **Order** is the booking request, a **Shipment** is the consignment, a
**Package** is one physical parcel (spec §6.1). One order → one shipment → N
packages (`ORD-1001` / `SHP-1001` / `PKG-1001…PKG-1005`). The lifecycle below is
per **package**; shipment and order states are derived rollups (e.g. a shipment
with 3 of 5 packages delivered is *partially fulfilled*, spec Scenario 13).

## 2. The five separate state fields

A package never has "a status". It has five independent fields (spec §7.2),
because real events overlap: a package can be *in transit* (operational),
*damaged* (condition), *COD unpaid* (payment) and *under investigation*
(exception) at the same time.

| Field | Values | Owned by |
|---|---|---|
| `operationalStatus` | The 20-state lifecycle in §3 + `draft`, `cancelled` | Lifecycle service |
| `condition` | `good` · `damaged` · `suspected_damage` · `packaging_compromised` | Inspection/pickup/delivery recording |
| `paymentStatus` | `pending` · `partially_paid` · `paid` · `failed` · `refunded` · `partially_refunded` · `disputed` · `reversed` | Finance services only |
| `deliveryStatus` | `not_attempted` · `attempted` · `delivered` · `failed` · `refused` · `returned` | Delivery service |
| `exceptionStatus` | `none` · `pickup_failed` · `on_hold` · `address_clarification` · `missing` · `misrouted` · `delayed` · `lost_under_investigation` · plus an optional link to an open Incident | Exception/incident module |

Exception values are **flags layered on the operational status**, not
replacements for it: setting `exceptionStatus = missing` never rewrites
`operationalStatus`, so when the package is found, operations resume from the
true state. Clearing an exception requires the linked incident to be resolved
(or a WA/AD override with reason, audit-logged).

## 3. Main lifecycle (operational status)

| # | State | Entered when | Custodian after entry |
|---|---|---|---|
| 1 | `booked` | Booking submitted; tracking ID generated | — (not yet physical) |
| 2 | `pickup_assigned` | Pickup rider assigned (`pickup.assign`) | — |
| 3 | `pickup_in_progress` | Rider confirms en route / arrival at sender | — |
| 4 | `picked_up` | Rider scans package at sender and confirms collection | Pickup rider |
| 5 | `received_at_origin` | Receiving scan at origin warehouse | Origin warehouse (Receiving zone) |
| 6 | `inspection_pending` | Package moved from receiving to inspection queue | Origin warehouse |
| 7 | `processing` | Inspection started (weight/condition verification) | Origin warehouse |
| 8 | `sorted` | Inspection passed; sorted to destination lane | Origin warehouse |
| 9 | `ready_for_dispatch` | Placed in Dispatch zone / added to a draft manifest | Origin warehouse |
| 10 | `transfer_assigned` | Added to an approved transfer manifest | Origin warehouse |
| 11 | `dispatched` | Loading scans verified; transfer dispatched | Line-haul driver (trip) |
| 12 | `in_transit` | Trip departs origin | Line-haul driver (trip) |
| 13 | `arrived_at_destination` | Trip arrival recorded at destination | Line-haul driver until handover |
| 14 | `receiving_inspection` | Destination receiving scan done; inspection started | Destination warehouse |
| 15 | `received_at_destination` | Destination receiving reconciled for this package | Destination warehouse |
| 16 | `ready_for_delivery` | Sorted into a delivery area/batch at destination | Destination warehouse |
| 17 | `delivery_rider_assigned` | Assigned to a rider's delivery batch | Destination warehouse |
| 18 | `out_for_delivery` | Rider scans package before departure | Delivery rider |
| 19 | `delivery_attempted` | An attempt is recorded without delivery | Delivery rider (or warehouse on return) |
| 20 | `delivered` | Delivery confirmed with required proof (+ COD captured if COD) | Recipient |

Terminal/side states: `draft` (booking not yet submitted), `cancelled` (only
under the cancellation rules of §5), and the return path states, which live in
return-workflow.md (`return_requested → … → returned_to_sender`) and re-enter
this machine as custody states, never as an edit of history.

**Local deliveries** (origin warehouse = destination service warehouse) skip
states 10–15: `ready_for_dispatch → ready_for_delivery`. The transition table
encodes this as an explicit allowed shortcut for same-warehouse shipments, not
as staff skipping steps.

## 4. Transition validation rules

The transition table is code + data: an explicit allow-list of
`(fromState, toState, triggeringOperation, requiredPermission)`. Anything not
listed is rejected with a conflict error. Non-negotiable rules (spec §7.3):

| # | Rule | Enforcement |
|---|---|---|
| T1 | `→ picked_up` requires an active pickup assignment for that rider, **or** a counter drop-off receiving record created by WA/WS | No assignment + no drop-off record → transition rejected |
| T2 | `→ received_at_origin` / `received_at_destination` requires a **receiving scan event** in the same transaction | Status cannot be set from a form; the scan *is* the transition |
| T3 | `→ dispatched` requires the package to be on an **approved** transfer manifest with loading scans complete for it | Draft/unapproved manifest → rejected |
| T4 | `→ in_transit` requires the trip's departure confirmation | Cannot precede `dispatched`; timestamps monotonic |
| T5 | `→ received_at_destination` requires destination receiving reconciliation for that package (transfer-workflow.md) | A package the destination never scanned cannot enter its inventory |
| T6 | `→ delivery_rider_assigned` / `out_for_delivery` requires `operationalStatus` ∈ {`received_at_destination`, `ready_for_delivery`, `received_at_origin` (local)} and `exceptionStatus` ∉ {`on_hold`, `missing`, `lost_under_investigation`} | Held/missing packages cannot be assigned |
| T7 | `→ delivered` requires delivery proof per shipment policy (OTP verified, or signature, or photo + named recipient) **and**, for COD, a COD collection record in the same transaction | Proof-less delivery is impossible through any endpoint |
| T8 | A returned package re-enters via the return workflow as a **new custody chain linked to the original shipment** | It can never be silently re-labelled a new booking; history stays joined |
| T9 | `→ cancelled` only from `draft`, `booked`, `pickup_assigned` (before physical custody). After `picked_up`, cancellation becomes a return workflow (Scenario 9) | In-custody "cancel" requests are rejected with the return path offered |
| T10 | No transition may move a package backwards except the defined exception/return paths, and every such path creates an incident or return record | Prevents history laundering |
| T11 | Every transition carries an **idempotency key** (client-generated per scan/action). Replaying the same key returns the original result without a second event (Scenario 7: duplicate scan) | Duplicate scans show the operator "already recorded at HH:MM by you" and change nothing |
| T12 | Concurrent transitions on one package are serialised by a row lock + optimistic version check inside the transaction (Scenario 8) | The loser receives a conflict response naming the winning state; no duplicate custody rows |

## 5. Booking-stage edit and cancellation rules

- **Before pickup** (`draft`, `booked`, `pickup_assigned`): authorised users
  (AD, WA-origin, vendor owner of the booking) may correct sender/recipient/
  address fields. Every correction is a versioned edit with actor + reason in
  the audit log.
- **After pickup**: sender/recipient identity is frozen. Address changes become
  a controlled correction request (support or vendor raises, AD/WA applies);
  after `dispatched`, an address change additionally requires an exception
  record and possible re-routing approval.
- **After delivery**: shipment history is immutable, full stop.
- **Cancellation record** (when T9 permits): who requested, who approved,
  reason, shipment stage at cancellation, applicable charges, and whether a
  pickup/return is required. Cancellation never deletes the booking.

## 6. Tracking events (append-only)

Every transition — and every significant non-transition event (scan, note,
evidence upload, exception raised/cleared) — appends one `TrackingEvent`:

| Field | Notes |
|---|---|
| `id` | Unique event ID |
| `packageId` | The physical parcel |
| `eventType` | e.g. `received_scan`, `status_transition`, `handover`, `attempt`, `exception_raised` |
| `previousStatus` / `newStatus` | For transitions; null pair for pure events |
| `occurredAt` (event time) | When it physically happened (device time for offline capture) |
| `recordedAt` | When the server stored it; `occurredAt ≠ recordedAt` exposes offline sync |
| `actorId` / `actorRole` | Always resolved from the DB user record — never `dev-bypass`, never NULL for staff writes (the old trigger's NULL-actor flaw is designed out: the service writes the event, not a trigger) |
| `warehouseId` | Where applicable |
| `location` | Storage location code or free-text/GPS label for field events |
| `assignmentId` / `transferId` / `tripId` | Related operational records where applicable |
| `notes` | Operator note |
| `evidenceFileIds` | Photos/documents (private storage, signed URLs) |
| `source` | `web`, `rider_app`, `scan`, `system`, `offline_sync` |
| `idempotencyKey` | Unique; enforces T11 |

Events are **append-only**: no update or delete endpoint exists, for any role
including Super Admin. Corrections happen by appending a compensating event
that references the original. The public tracking projection is a filtered
view of this stream (milestone events only, no actor names beyond role labels,
no internal notes).

## 7. Actors and permissions (summary)

Receiving/inspection/sorting: WA/WS of the holding warehouse (`package.receive`,
`package.inspect`, `package.sort`). Dispatch: WA (`transfer.dispatch`) with WS
loading scans. Pickup/delivery transitions: the assigned rider only
(`pickup.confirm`, `delivery.confirm`). Holds: WA/AD set, WA/AD release; support
may *request*. Finance touches `paymentStatus` only, through finance services —
a finance user cannot cause an operational transition, and an operator cannot
cause a payment transition (role-permission-matrix.md §4.5).

## 8. Failure handling

| Failure | Behaviour |
|---|---|
| Disallowed transition attempted | 409-style conflict: response names current state and the operations that *are* allowed; attempt audit-logged |
| Duplicate scan / replayed action | Original result returned via idempotency key; operator sees a clear "already recorded" message; no duplicate event or inventory row |
| Two staff act on one package simultaneously | Transaction lock + version check; second action fails as conflict (Scenario 8) |
| Scan of unknown tracking ID | Rejected, no record created; repeated unknown scans from one account are audit-flagged (possible label fraud) |
| Package scanned at the wrong warehouse | Scan accepted as an *arrival observation* only: package goes to `exceptionStatus = misrouted`, is quarantined, and does **not** enter that warehouse's inventory (Scenario 2) |
| Proof missing at delivery confirmation | Transition rejected listing exactly which proof element is missing; attempt may still be recorded as failed |
| Offline rider action syncs late | Accepted with original `occurredAt` if the transition is still valid against current state; if state has moved on (e.g. package reassigned), the event is stored as a conflicting observation and an incident is raised for dispatcher review — never silently applied, never fabricated as confirmed (Scenario 10) |

---

## 9. V2 final state (Phase 8 addendum)

The transition allow-list in code (`src/lib/bookings/lifecycle.ts`,
`OPERATIONAL_STATUSES`: 22 values — the 20-state chain plus `DRAFT`
and `CANCELLED`) is the authority; the prose table in §3 uses the
V1 naming for two states (`delivery_rider_assigned` in §3 is
`DELIVERY_ASSIGNED` in code). Phase 7 added / confirmed these edges:

- **Cross-warehouse return travel (Phase 7).** A return received
  back into the delivery warehouse (`READY_FOR_DELIVERY` after the
  scan-back) that must travel to its return warehouse is readied
  with the new edge `READY_FOR_DELIVERY → READY_FOR_DISPATCH`
  (`return_ready_for_dispatch`, permission `transfer.prepare`),
  then joins a normal transfer as a manifested return package
  (`TRANSFER_ASSIGNED` … — see `docs/warehouse-transfers.md` §7).
  The return record, not the package lifecycle, tracks the return's
  own `RECEIVED → IN_TRANSIT → RECEIVED` movement; first-receipt
  stamps are preserved.
- **Evidence binding is delivery-side, not a lifecycle change.**
  Phase 7's POD hash-binding (`DeliveryEvidenceBinding`) runs
  inside the existing `confirm_delivery` transition's transaction
  — it adds integrity to rule T7's proof requirement and changes
  no state edge. See `docs/delivery-operations.md` §6.
- **Pre-pickup / pre-custody release edges** (already in the built
  table): `DELIVERY_ASSIGNED → READY_FOR_DELIVERY`
  (`release_delivery_assignment`) and the warehouse return scan
  `OUT_FOR_DELIVERY / DELIVERY_ATTEMPTED → READY_FOR_DELIVERY`
  (`delivery_return_scan`) — both are defined T10 release paths
  that exist only before/around custody, never backwards edits of
  delivered history.
