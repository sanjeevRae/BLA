# Delivery Workflow (Pickup and Final-Mile) — BLA Logistics Platform

**Purpose.** The last mile is where the company meets the customer: pickups
collect packages from senders, deliveries put them in recipients' hands with
proof and, for COD, with money collected. This document covers assignment,
batching, attempts, proof, failures and close-out. Spec reference: Part 11,
Part 4.5; Scenarios 4, 10, 13, 14.

---

## 1. Actors and permissions

| Action | Who | Permission |
|---|---|---|
| Assign pickups / deliveries, build batches | WA (own warehouse), AD/SA | `pickup.assign`, `delivery.assign` |
| Execute pickup (scan, condition, collect) | Assigned DR with pickup capability | `pickup.confirm` |
| Execute delivery (attempts, proof, COD) | Assigned DR with delivery capability | `delivery.attempt.record`, `delivery.confirm` |
| Receive returned packages at warehouse | WA/WS | `package.receive` |
| Reschedule / address correction requests | Recipient (verified), vendor, support | `delivery.reschedule_request` |

A rider sees only their assigned pickups/deliveries and the minimum contact
and address data to perform them (role-permission-matrix.md §4.3).

## 2. Pickup flow

1. A booking in `booked` needs collection (vendor pickup or customer pickup).
   WA/AD assigns a pickup-capable rider → package `pickup_assigned`; rider
   notified in-app.
2. Rider views: sender name/phone, pickup address + landmark + instructions,
   package count and declared details.
3. Rider confirms departure/arrival (`pickup_in_progress`), contacts the
   sender through the app's call action where needed.
4. At handover the rider **scans each package**, verifies declared count,
   description and condition, records actual condition (and weight where
   authorised, `package.inspect` scoped to assigned), and takes pickup
   evidence (photo) where policy requires.
5. Rider confirms collection → packages `picked_up`, custody → rider. Sender
   receives a confirmation notification.
6. Rider returns to the origin warehouse; WA/WS receiving scan moves packages
   to `received_at_origin` and custody to the warehouse. Count mismatch at
   this handover follows the discrepancy flow (inventory-and-custody.md §4).

**Failed pickup:** rider records the attempt with a reason (sender
unavailable, package not ready, wrong address, sender refused). Package →
`exceptionStatus = pickup_failed`; WA/vendor notified; WA reschedules or the
booking is cancelled under the stage rules. A failed pickup is an event with
evidence, never a silent no-show.

## 3. Delivery assignment

WA (destination warehouse) or AD assigns packages to a delivery rider. The
assignment service checks, and refuses with reasons (spec §11.1):

- package is at this warehouse and deliverable (`received_at_destination` /
  `ready_for_delivery`, or local equivalent), not on hold, no blocking
  exception;
- rider has the **delivery capability** and is home-based at (or temporarily
  attached to) this warehouse;
- rider availability state permits a new batch;
- batch limits: package count and total weight within configured limits;
- delivery area matches the batch's area (§4);
- COD exposure: rider's unremitted COD balance is below the configured cap.

Assignment → package `delivery_rider_assigned`. The rider's batch is the unit
of work: packages are scanned out together (§5).

## 4. Delivery batches and areas

Deliveries are grouped into batches by **city → municipality → ward →
service zone / delivery area** (spec §11.2). The dispatcher creates a batch
for an area, adds eligible packages, and assigns it to one rider. Route
optimisation, when used, comes from the mapping provider (MapTiler, with ORS
fallback as in the legacy system) as a *suggested order only* — the workflow
never depends on it, and manual checkpoint discipline carries the day if maps
are unavailable.

## 5. Out-for-delivery and attempts

1. Before leaving, the rider **scans every package** in the batch. Each scan
   moves that package to `out_for_delivery`, custody → rider. A package not
   scanned is not out — it stays in warehouse stock and off the rider's
   liability.
2. At each stop the rider opens the delivery: recipient name/phone, address +
   landmark + instructions, COD amount due (if any), package details.
3. An **attempt** is recorded for every visit that does not complete:

   | Field | Notes |
   |---|---|
   | `packageId`, `riderId`, `attemptNumber` | Number increments per package, across riders and days |
   | `attemptedAt` | Server timestamp (or offline `occurredAt` on sync) |
   | `location` | GPS where available; manual area note otherwise |
   | `result` | `delivered` is not an attempt result — see §6. Failures: §7 table |
   | `failureReason` | From the controlled list in §7 |
   | `contactOutcome` | Called–answered / called–no answer / phone unreachable / not attempted |
   | `evidenceFileIds` | Photo of premises/door where policy requires |
   | `nextAction` | `redeliver` (date), `hold_at_warehouse`, `return_to_sender`, `support_escalation` |

4. Package → `delivery_attempted` on a failed attempt; the rider keeps
   custody until warehouse return scan at the end of the run.

Attempt limits are policy (setting, default: 3 attempts). Reaching the limit
forces a `nextAction` decision by WA — redelivery exception, recipient pickup
at warehouse, or return-to-sender — the package cannot loop forever.

## 6. Delivery confirmation and proof

Delivery completes **only** through `delivery.confirm`, which validates
(package-lifecycle.md T7):

- the package is `out_for_delivery` in this rider's custody;
- **proof**, per the shipment's configured policy — at least one of:
  - **OTP** sent to the recipient's phone, entered by the rider (or confirmed
    by the recipient in the tracking flow);
  - **recipient signature** captured on device;
  - **delivery photo** + name of the person who received it (authorised
    recipient name for third-party receipt);
- **COD**: if the shipment is COD, a COD collection record (amount + method)
  in the same transaction — the package cannot be `delivered` with COD
  outstanding unless a WA records an authorised exception (which creates an
  incident and a finance task);
- timestamp + location evidence where available.

On success: package → `delivered`, custody → recipient, recipient and vendor
notified, COD (if any) lands on the rider's cash balance
(cod-reconciliation.md).

**Partial delivery (Scenario 13):** packages are confirmed one by one. Three
of five delivered ⇒ those three are `delivered` with their own proof; two
remain active; the shipment shows *partially fulfilled*; COD and charges are
computed per delivered package per the shipment's contract terms.

## 7. Failed deliveries — reasons and next actions

| Reason | Typical next action |
|---|---|
| Recipient unavailable | Notify recipient (SMS/in-app), schedule redelivery |
| Phone unreachable | Support contacts alternate number; redelivery |
| Wrong / incomplete address | `address_clarification` exception; support correction flow; hold at warehouse |
| Recipient refused | Return-to-sender initiation (return-workflow.md) |
| Business closed | Redelivery next working day |
| Delivery area inaccessible | WA reroutes/reschedules; incident if recurring |
| Payment unavailable (COD) | Recipient asked to arrange payment; redelivery or warehouse hold — package is **not** left without collection unless WA authorises an exception |
| Package damaged in transit | Do not deliver as-is; record condition + photo, return to warehouse, incident raised |

Every failure notifies the recipient (where a channel exists) and is visible
to the vendor on their tracking view at milestone level.

## 8. Close-out (end of run)

1. Rider returns to the warehouse with undelivered packages.
2. WA/WS scans each returned package back in (`delivery_return` movement);
   custody → warehouse; packages return to stock in their delivery area
   location, or to Returns zone if a return was initiated.
3. Count check: scanned-out = delivered + returned + still-with-rider. Any
   gap keeps the missing package in the rider's custody and raises an
   incident — the run cannot be force-closed.
4. COD collected during the run is remitted per cod-reconciliation.md (same
   day by default policy).

## 9. Offline behaviour (Scenario 10)

The rider app queues permitted actions (attempts, proof capture, scans) with
device timestamps and idempotency keys while offline, and syncs on reconnect.
The server validates each queued action against current state: valid ones
apply with their original `occurredAt`; conflicting ones (package reassigned,
already delivered by another path) are stored as observations and flagged for
WA review. The device never displays a server confirmation it did not
receive.

## 10. Failure handling

| Failure | Behaviour |
|---|---|
| Rider tries to confirm delivery for a package not in their batch | Rejected (assigned-only scoping); attempt audit-logged |
| OTP wrong 3 times | Confirmation blocked for that package; recipient can request a new OTP; support notified on repeated failure |
| COD amount entered ≠ COD due | Difference must be explained via the shortfall/exception path; silent under-collection is impossible |
| Recipient disputes delivery ("never received") | Support opens a non-receipt incident; proof record (OTP log/signature/photo + timestamps) is the evidence base; package history is not altered |
| Package damaged discovered at the door | Delivery paused; condition recorded with photo; recipient may refuse; return + incident flow |
| Rider's phone dies mid-run | Work is server-side: a replacement device signs in and sees the same batch; paper fallback scans are entered by WA as assisted scans with reason, attributed to WA with the rider named |
