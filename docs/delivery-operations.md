# Delivery Operations — Pickup and Final-Mile (V2, canonical)

**Status:** Canonical V2 document. This file supersedes
`docs/delivery-workflow.md` (V1 design) as the reference for the
built system. The V1 file is retained for design history only.

**Sources (generated from code, not memory):** vocabularies are the
constants in `src/lib/deliveries/domain.ts`; package transitions are
the allow-list in `src/lib/bookings/lifecycle.ts`; routes are the
files under `src/app/api/deliveries/`, `src/app/api/bookings/` and
`src/app/api/returns/`.

---

## 1. Actors and permissions

| Action | Who | Permission |
|---|---|---|
| Assign pickups / deliveries, build batches | Warehouse Admin (own warehouse), Admin / Super Admin | `pickup.assign`, `delivery.assign` |
| Execute pickup (scan, condition, collect) | Assigned rider with `PICKUP` capability | `pickup.confirm` |
| Execute delivery (attempts, proof, COD) | Assigned rider with `DELIVERY` capability | `delivery.attempt.record`, `delivery.confirm` |
| Receive returned packages at warehouse | Warehouse Admin / Staff | `package.receive` |
| Reschedule / address-correction requests | Recipient (verified), vendor, support | `delivery.reschedule_request` |

A rider sees only their assigned pickups/deliveries and the minimum
contact and address data to perform them.

## 2. Status vocabularies (code constants)

From `src/lib/deliveries/domain.ts`:

- **Batch kinds** (`DELIVERY_BATCH_KINDS`): `PICKUP` · `DELIVERY` ·
  `MIXED`.
- **Batch statuses** (`DELIVERY_BATCH_STATUSES`): `OPEN` ·
  `IN_PROGRESS` · `COMPLETED` · `CANCELLED`.
- **Assignment kinds** (`DELIVERY_ASSIGNMENT_KINDS`): `PICKUP` ·
  `DELIVERY`.
- **Assignment statuses** (`DELIVERY_ASSIGNMENT_STATUSES`):
  `PENDING` · `ACCEPTED` · `IN_PROGRESS` · `COMPLETED` · `FAILED` ·
  `CANCELLED` · `REASSIGNED`. Active (package-committing) statuses
  are `PENDING`, `ACCEPTED`, `IN_PROGRESS` — a partial unique index
  enforces one active assignment per package per kind.
- **Attempt results** (`DELIVERY_ATTEMPT_RESULTS`): `DELIVERED` ·
  `RECIPIENT_UNAVAILABLE` · `PHONE_UNREACHABLE` · `WRONG_ADDRESS` ·
  `REFUSED` · `BUSINESS_CLOSED` · `AREA_INACCESSIBLE` ·
  `PAYMENT_UNAVAILABLE` · `PACKAGE_DAMAGED` · `PICKUP_FAILED` ·
  `OTHER`. The successful visit is recorded as an attempt row too,
  so per-package attempt numbering is one continuous ledger across
  riders and days.
- **Next actions** (`DELIVERY_NEXT_ACTIONS`): `REDELIVER` ·
  `ADDRESS_CORRECTION` · `SUPPORT_ESCALATION` · `RETURN_TO_SENDER` ·
  `RETURN_TO_WAREHOUSE` · `NONE`.
- **Contact outcomes** (`DELIVERY_CONTACT_OUTCOMES`):
  `CALLED_ANSWERED` · `CALLED_NO_ANSWER` · `PHONE_UNREACHABLE` ·
  `NOT_ATTEMPTED`.
- **Proof methods** (`POD_METHODS`): `OTP` · `SIGNATURE` · `PHOTO` ·
  `AUTHORISED_PERSON`.
- **COD** (`COD_COLLECTION_STATUSES`): `MATCHED` · `MISMATCH`;
  methods (`COD_METHODS`): `CASH` · `MOBILE_WALLET` ·
  `BANK_TRANSFER`.
- **Returns** (`RETURN_STATUSES`): `REQUESTED` · `APPROVED` ·
  `REJECTED` · `COLLECTION_ASSIGNED` · `COLLECTED` · `IN_TRANSIT` ·
  `RECEIVED` · `INSPECTED` · `COMPLETED` · `CANCELLED`. Reasons
  (`RETURN_REASONS`): `RECIPIENT_REFUSED` · `ATTEMPT_LIMIT_REACHED` ·
  `WRONG_ADDRESS` · `VENDOR_REQUEST` · `PACKAGE_DAMAGED` ·
  `UNDELIVERABLE` · `CANCELLATION_AFTER_PICKUP` · `OTHER`.

Policy constants in the same module: `MAX_DELIVERY_ATTEMPTS = 3`,
`OTP_MAX_FAILURES = 3`, OTP lifetime 12 hours from generation at
pickup. Assignment is blocked for packages whose exception is
`ON_HOLD`, `MISSING`, `MISROUTED`, `LOST_UNDER_INVESTIGATION`,
`DAMAGED`, `RETURN_REQUESTED` or `RETURN_APPROVED`
(`ASSIGNMENT_BLOCKING_EXCEPTIONS`).

**Package operational states on these legs** (from
`src/lib/bookings/lifecycle.ts`): pickup — `BOOKED` →
(`assign_pickup`) → `PICKUP_ASSIGNED` → (`pickup_started`) →
`PICKUP_IN_PROGRESS` → (`confirm_pickup`) → `PICKED_UP` →
(`receive_at_origin`) → `RECEIVED_AT_ORIGIN`. A counter drop-off
skips the pickup leg: `BOOKED → RECEIVED_AT_ORIGIN` by receiving
scan. Delivery — `READY_FOR_DELIVERY` → (`assign_delivery`) →
`DELIVERY_ASSIGNED` → (`out_for_delivery`) → `OUT_FOR_DELIVERY` →
(`record_delivery_attempt`) → `DELIVERY_ATTEMPTED` →
(`reattempt_delivery`) → `OUT_FOR_DELIVERY`, or
(`confirm_delivery`) → `DELIVERED` from either `OUT_FOR_DELIVERY`
or `DELIVERY_ATTEMPTED`. Before the rider takes custody, a cancelled
or superseded assignment releases the parcel:
`DELIVERY_ASSIGNED → READY_FOR_DELIVERY`
(`release_delivery_assignment`). At end of run, the warehouse
return scan returns undelivered parcels:
`OUT_FOR_DELIVERY / DELIVERY_ATTEMPTED → READY_FOR_DELIVERY`
(`delivery_return_scan`, `package.receive`).

## 3. Pickup leg (Phase 7 completion)

The pickup leg is a first-class batch/assignment flow, symmetric
with delivery — not an informal collection:

1. A booking in `BOOKED` needs collection (vendor pickup or customer
   pickup). A `PICKUP`-kind batch (or the pickup side of a `MIXED`
   batch) is built at the origin warehouse and assigned to a
   pickup-capable rider (`pickup.assign`) → package
   `PICKUP_ASSIGNED`; rider notified in-app.
2. The rider views: sender name/phone, pickup address + landmark +
   instructions, package count and declared details.
3. The rider starts the pickup (`PICKUP_IN_PROGRESS`) and records a
   **pickup attempt** where the collection does not complete
   (`POST /api/deliveries/assignments/[id]/pickup-attempt`; attempt
   result `PICKUP_FAILED` covers sender unavailable, package not
   ready, wrong address, sender refused). A failed pickup is an
   event with evidence, never a silent no-show: the package is
   flagged, Warehouse Admin / vendor are notified, and the booking
   is rescheduled or cancelled under the stage rules.
4. At handover the rider **scans each package**, verifies declared
   count, description and condition, records actual condition (and
   weight where authorised, `package.inspect` scoped to assigned),
   and takes pickup evidence where policy requires.
5. The rider confirms collection (`pickup.confirm`) → packages
   `PICKED_UP`, custody → rider. Sender receives a confirmation
   notification. Delivery OTPs are generated at pickup (hashed at
   rest, 12-hour lifetime).
6. The rider returns to the origin warehouse; the receiving scan
   moves packages to `RECEIVED_AT_ORIGIN` and custody to the
   warehouse. A count mismatch at this handover follows the
   discrepancy flow (`docs/inventory-and-custody.md`).

**Guard (Phase 7, F1):** the `PICKUP` branch refuses packages with
an active delivery assignment — a package already committed to a
delivery run cannot simultaneously be picked up.

Pickup/delivery GPS: a rider with an open/in-progress batch may run
a tracking session of type `PICKUP` / `DELIVERY`
(`docs/driver-operations.md` §6). Foreground-only browser GPS;
manual scans remain the proof.

## 4. Delivery assignment and batches

Warehouse Admin (destination warehouse) or Admin assigns packages
to a delivery rider. The assignment service checks, and refuses with
reasons:

- package is at this warehouse and deliverable
  (`READY_FOR_DELIVERY`, reached from `RECEIVED_AT_DESTINATION` or
  the local shortcut), not on hold, no blocking exception (§2);
- rider has the `DELIVERY` capability and is home-based at (or
  temporarily attached to) this warehouse;
- rider availability permits a new batch;
- batch limits: package count and total weight within configured
  limits;
- delivery area matches the batch's area;
- COD exposure: the rider's unremitted COD balance is below the
  configured cap; an expired rider licence also blocks assignment.

Deliveries are grouped into batches by **city → municipality →
ward → service zone / delivery area**. The dispatcher creates a
batch for an area, adds eligible packages, and assigns it to one
rider. Route order, where shown, is a suggestion only — the
workflow never depends on a routing provider.

**Bulk booking note (bookings-side, Phase 7):** vendors can create
1–50 bookings in one submission via `POST /api/bookings/bulk`
(page: `/vendor/bookings/bulk`), created all-or-nothing inside a
single transaction by the BookingService. Bulk-created bookings
enter the same pickup/delivery flow as single bookings — there is
no separate bulk delivery path.

## 5. Out-for-delivery and attempts

1. Before leaving, the rider **scans every package** in the batch.
   Each scan moves that package to `OUT_FOR_DELIVERY`, custody →
   rider. A package not scanned is not out — it stays in warehouse
   stock and off the rider's liability.
2. At each stop the rider opens the delivery: recipient name/phone,
   address + landmark + instructions, COD amount due (if any),
   package details.
3. An **attempt** is recorded for every visit
   (`POST /api/deliveries/assignments/[id]/attempt`): package,
   rider, attempt number (increments per package, across riders
   and days), server timestamp, result (§2), contact outcome,
   evidence where policy requires, and next action.
4. Package → `DELIVERY_ATTEMPTED` on a failed attempt; the rider
   keeps custody until the warehouse return scan at end of run.

Attempt limits are policy (default **3 attempts**). Reaching the
limit forces a next-action decision by the Warehouse Admin —
redelivery exception, recipient pickup at warehouse, or
return-to-sender — the package cannot loop forever. Failed-attempt
results map to package exceptions (e.g. `REFUSED` →
`RECIPIENT_REFUSED`, `WRONG_ADDRESS` →
`ADDRESS_CLARIFICATION_REQUIRED`, `PACKAGE_DAMAGED` → `DAMAGED`).

## 6. Delivery confirmation, proof, and evidence hash-binding

Delivery completes **only** through `delivery.confirm`
(`POST /api/deliveries/assignments/[id]/deliver`), which validates:

- the package is `OUT_FOR_DELIVERY` (or `DELIVERY_ATTEMPTED`) in
  this rider's custody;
- **proof**, per the shipment's configured policy — at least one
  POD method (§2): OTP sent to the recipient's phone and entered by
  the rider (wrong entries lock confirmation after 3 failures; a
  new code can be issued via
  `POST /api/deliveries/assignments/[id]/regenerate-otp`), recipient
  signature, delivery photo, or authorised-person receipt with the
  receiver's name;
- **COD**: if the shipment is COD, a COD collection record (amount
  + method, `MATCHED` / `MISMATCH` with a required explanation) in
  the same transaction — the package cannot be `DELIVERED` with COD
  outstanding unless a Warehouse Admin records an authorised
  exception (which creates an incident and a finance task).

**Evidence hash-binding (Phase 7, M-10).** POD photo/signature
evidence is still a reference string (no object-storage provider /
`FileAsset` model yet — see `docs/known-limitations.md`). At
delivery confirmation the server stores the SHA-256 hash of each
reference on the ProofOfDelivery (`photoEvidenceHash` /
`signatureEvidenceHash`) and binds the hash to the package in
`DeliveryEvidenceBinding` **inside the delivery transaction**. The
hash is globally unique across kinds: the same reference can never
prove two different packages' deliveries (reuse throws and the
whole delivery rolls back), and one string used as a photo for one
package and a signature for another still conflicts.

On success: package → `DELIVERED`, custody → recipient, recipient
and vendor notified, COD (if any) lands on the rider's cash balance
(`docs/cod-reconciliation.md`).

**Partial delivery:** packages are confirmed one by one. Three of
five delivered ⇒ those three are `DELIVERED` with their own proof;
two remain active; the shipment shows partially delivered; COD and
charges are computed per delivered package.

## 7. Failed deliveries — reasons and next actions

| Reason (attempt result) | Typical next action |
|---|---|
| `RECIPIENT_UNAVAILABLE` | Notify recipient, schedule redelivery |
| `PHONE_UNREACHABLE` | Support contacts alternate number; redelivery |
| `WRONG_ADDRESS` | `ADDRESS_CLARIFICATION_REQUIRED` exception; support correction flow; hold at warehouse |
| `REFUSED` | Return-to-sender initiation (`docs/return-workflow.md`) |
| `BUSINESS_CLOSED` | Redelivery next working day |
| `AREA_INACCESSIBLE` | Warehouse Admin reroutes/reschedules; incident if recurring |
| `PAYMENT_UNAVAILABLE` | Recipient asked to arrange payment; redelivery or warehouse hold — package is **not** left without collection unless a Warehouse Admin authorises an exception |
| `PACKAGE_DAMAGED` | Do not deliver as-is; record condition + photo, return to warehouse, incident raised |
| `PICKUP_FAILED` (pickup leg) | Reschedule pickup or cancel under stage rules |

Every failure notifies the recipient (where a channel exists) and
is visible to the vendor on their tracking view at milestone level.
Drivers can also raise a general incident (`incident.report`,
`POST /api/incidents`) from the run — see
`docs/driver-operations.md` §7.

## 8. Reassignment (Phase 7) and close-out

**Batch reassignment** (`POST /api/deliveries/batches/[id]/reassign`):
when a rider cannot finish a run, the dispatcher reassigns the
batch's remaining work to a replacement rider. The old assignments
close as `REASSIGNED` (never edited into the new rider's history),
new assignments chain to them, custody moves only through the
recorded path (warehouse return + re-handout, or a scanned
rider-to-rider handover), and any live tracking session bound to
the old batch ends in the same transaction with
`endReason = REASSIGNED`. A batch whose every active assignment is
already terminal refuses reassignment.

**Close-out (end of run):**

1. Rider returns to the warehouse with undelivered packages.
2. Warehouse staff scan each returned package back in
   (`POST /api/deliveries/scan-back`; `delivery_return_scan`) —
   custody → warehouse; packages return to stock in their delivery
   area location, or to the Returns zone if a return was initiated.
   The batch is then closed
   (`POST /api/deliveries/batches/[id]/close`); closing a batch
   auto-ends any bound tracking session
   (`ASSIGNMENT_COMPLETED` / `ASSIGNMENT_CANCELLED`).
3. Count check: scanned-out = delivered + returned + still-with-
   rider. Any gap keeps the missing package in the rider's custody
   and raises an incident — the run cannot be force-closed.
4. COD collected during the run is remitted per
   `docs/cod-reconciliation.md` (same day by default policy);
   rider COD view: `/rider/cod`.

## 9. Returns handoff

Undeliverable / refused packages enter the return flow
(`docs/return-workflow.md`, `GET/POST /api/returns`,
`POST /api/returns/[id]/approve|inspect|complete|reject`). V2
Phase 7: when the return warehouse differs from the warehouse that
first received the return back from the last mile, the `RECEIVED`
return travels on a normal transfer (see
`docs/warehouse-transfers.md` §7) and inspection/completion run at
the return warehouse.

## 10. API surface (Route Handlers)

Generated from `src/app/api/**/route.ts`:

- Batches: `GET/POST /api/deliveries/batches`,
  `GET /api/deliveries/batches/[id]`,
  `POST /api/deliveries/batches/[id]/assignments`,
  `POST /api/deliveries/batches/[id]/pickup`,
  `POST /api/deliveries/batches/[id]/collect`,
  `POST /api/deliveries/batches/[id]/reassign`,
  `POST /api/deliveries/batches/[id]/close`
- Assignments: `POST /api/deliveries/assignments/[id]/pickup-attempt`,
  `POST /api/deliveries/assignments/[id]/attempt`,
  `POST /api/deliveries/assignments/[id]/deliver`,
  `POST /api/deliveries/assignments/[id]/regenerate-otp`
- Scan-back: `POST /api/deliveries/scan-back`
- Bookings (bulk): `POST /api/bookings/bulk`
- Returns: `GET/POST /api/returns`,
  `POST /api/returns/[id]/approve|inspect|complete|reject`
- Incidents: `GET/POST /api/incidents`, `GET /api/incidents/[id]`

Dashboard routes (navigation registry): rider home **is** the batch
list (`/rider`, detail `/rider/batches/[id]`); Warehouse Admin /
Staff deliveries (`/warehouse/deliveries`, `/staff/deliveries`,
new batch `/warehouse/deliveries/new`); returns
(`/warehouse/returns`, `/staff/returns`).

## 11. Failure handling

| Failure | Behaviour |
|---|---|
| Rider tries to confirm delivery for a package not in their batch | Rejected (assigned-only scoping); attempt audit-logged |
| OTP wrong 3 times | Confirmation blocked for that package; recipient can request a new OTP; support notified on repeated failure |
| COD amount entered ≠ COD due | Recorded as `MISMATCH` with a required explanation; silent under-collection is impossible |
| Evidence reference reused for a second package | Hash-binding conflict; the whole delivery transaction rolls back (§6) |
| Recipient disputes delivery ("never received") | Support opens a non-receipt incident; the proof record (OTP log / signature / photo + timestamps + evidence binding) is the evidence base; package history is not altered |
| Package damaged discovered at the door | Delivery paused; condition recorded with photo; recipient may refuse; return + incident flow |
| Rider's phone dies mid-run | Work is server-side: a replacement device signs in and sees the same batch. Browser GPS is foreground-only, so tracking resumes only when the panel is open again — it is never back-filled as if continuous |
