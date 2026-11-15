# Inter-Warehouse Transfer Workflow — BLA Logistics Platform

**Purpose.** A transfer moves packages between two warehouses under a manifest,
with a named line-haul driver and vehicle, and it is only complete when the
destination's physical receiving has been reconciled against what was
dispatched. A package must never silently change warehouse. Spec reference:
Part 9; scenarios 1, 2, 6.

---

## 1. Actors and permissions

| Step | Who | Permission |
|---|---|---|
| Create transfer, select packages | Origin WA; AD/SA | `transfer.create` |
| Prepare manifest, picking | Origin WA/WS | `transfer.prepare` |
| Approve (where configured) | Destination or origin WA per config; AD/SA | `transfer.approve` |
| Loading scans | Origin WS/WA; assigned LD confirms | `transfer.load` |
| Dispatch | Origin WA | `transfer.dispatch` |
| Trip progress, arrival | Assigned LD; WA/AD oversight | `trip.update_progress` |
| Receiving scans at destination | Destination WA/WS | `transfer.receive` |
| Reconciliation and closure | Destination WA; AD/SA | `transfer.reconcile` |

The line-haul driver never selects packages, never edits the manifest after
dispatch, and can never mark packages received at destination (spec §4.6).

## 2. Transfer record

`transferId` (unique, human-readable) · origin warehouse · destination
warehouse · transfer date · expected arrival · package list (via manifest) ·
assigned line-haul driver · assigned vehicle · dispatch supervisor (the WA who
dispatches) · instructions · status (§4). A `Trip` is created from the transfer
at dispatch; one trip may carry one transfer in the standard flow.

## 3. The workflow — 18 steps

| # | Step | System effect |
|---|---|---|
| 1 | Origin WA creates a **draft** transfer: origin (own warehouse, enforced), destination, date, expected arrival, instructions | Transfer in `draft`; no package state changes |
| 2 | WA/WS **select eligible packages**: only packages whose active inventory record is at the origin, in `ready_for_dispatch` (or `sorted`), not on hold, not already on another open transfer | Ineligible packages are refused at selection with the reason shown (wrong warehouse, on hold, already manifested) |
| 3 | System **validates origin inventory** for the selection (each package physically in stock per its inventory record) | Selection locks the packages to this transfer draft |
| 4 | WA **prepares the manifest** (`TransferManifest`): ordered package list with tracking IDs, weights, piece count | Packages → `transfer_assigned` when the manifest is finalised |
| 5 | **Approval** if configured for this lane (SA setting): WA of the other end or AD approves; rejection returns the transfer to draft with the reason recorded | Status `approved` / back to `draft` |
| 6 | **Assign driver and vehicle**: LD with line-haul role, active and available; vehicle active, insured, capacity ≥ manifest weight/volume | Unavailable/invalid vehicle or driver is refused (driver-workflow.md §4) |
| 7 | Picking: WS move packages Storage → Dispatch zone (`picking` movements) | Inventory locations updated |
| 8 | **Loading scans**: every package is scanned as it is loaded (`TransferScan`, type `load`) | Loaded count builds in real time; unscanned manifest packages block dispatch |
| 9 | **Loaded quantities verified**: loaded count = manifest count; LD confirms the load | Discrepancy at this point is resolved physically before dispatch — the manifest is never edited to match a wrong load |
| 10 | Origin WA **confirms dispatch** | Packages → `dispatched`; custody → LD; origin inventory records close; status `dispatched` |
| 11 | LD **starts the trip** (departure checkpoint) | Packages → `in_transit`; trip `in_transit`; departure time recorded |
| 12 | LD **updates trip progress** (manual checkpoints; delay/breakdown reported as events/incidents) | Expected arrival revised on delay; dispatchers notified |
| 13 | LD **records arrival** at destination | Packages → `arrived_at_destination`; status `arrived`; destination WA/WS notified |
| 14 | Destination WS/WA **scan packages during unloading** (`TransferScan`, type `unload`); each scan is that package's receiving scan | Each scanned package → `receiving_inspection`, destination inventory record created (Receiving zone), custody → destination warehouse |
| 15 | System **compares expected vs received**: manifest list vs unload scans vs condition reports | Differences classified: missing / excess / damaged / wrong package (§5) |
| 16 | Destination WA/WS **report discrepancies** (or confirm clean receipt) | Short/over/damaged receipt → status `partially_received`, incidents auto-created |
| 17 | Destination WA **completes receiving**: all received packages inspected and put away | Received packages → `received_at_destination` |
| 18 | **Reconciliation and closure**: received + accounted-for (damaged-quarantined, excess-held) = manifested, and no open discrepancy incidents → WA reconciles and closes | Status `reconciled` → `closed`. If anything is unaccounted, reconciliation is **refused** and the transfer stays open |

## 4. Transfer statuses

`draft` · `requested` (submitted for approval) · `approved` · `rejected`
(returns to draft with reason) · `preparing` · `ready_for_dispatch` ·
`dispatched` · `in_transit` · `arrived` · `partially_received` · `received` ·
`reconciliation_pending` · `reconciled` · `closed` · `exception` (an open
incident blocks progress) · `cancelled` (only from draft/requested, before any
loading; packages released back to origin stock).

## 5. Discrepancy handling

| Case | Handling |
|---|---|
| **Missing package** (manifested, not scanned at destination) | Package stays `in_transit` in the LD's custody; incident `transfer_shortage` (high) auto-created naming the tracking IDs, driver, vehicle, both warehouses; AD + both WAs notified; transfer cannot reconcile (Scenario 1: 50 dispatched, 48 received → 48 complete normally, 2 remain unresolved, transfer stays open) |
| **Excess package** (scanned, not on manifest) | Received as unmanifested arrival into Receiving-zone quarantine; incident `transfer_excess`; WA investigates (usually a loading error at origin or a misroute); it joins stock only after WA resolution links it to its true shipment |
| **Damaged package** | Receiving scan + condition `damaged` + photo evidence; package received (custody moves) but routed to Damaged zone; incident `damaged_package`; transfer can reconcile with the damage incident linked — damage is accounted-for, not a shortage |
| **Wrong package / wrong warehouse** | A package whose destination warehouse is not this one: arrival observation recorded, `exceptionStatus = misrouted`, quarantined; corrective transfer created back into the network; the package never enters this warehouse's dispatchable inventory (Scenario 2) |
| **Duplicate scan** | Idempotency: second scan returns "already scanned"; counts unchanged |
| **Incorrect manifest** (wrong package listed, never loaded) | Found at loading verification (step 9) before dispatch, or at receiving; manifest amendment after dispatch requires AD approval and is recorded as an amendment with reason — the original manifest is preserved |
| **Vehicle breakdown en route** | LD reports incident; dispatcher may reassign driver/vehicle with a recorded custody handover of the load; expected arrival updated (driver-workflow.md §6) |
| **Delayed arrival** | LD updates progress with reason; destination WA and AD see revised ETA; delay beyond threshold auto-raises a `delayed_shipment` incident |

**Absolute rule (spec §9.4):** the destination is never forced to accept a
quantity it did not physically receive. A partially received transfer remains
open for investigation until every manifested package is received, accounted
for as damaged/excess-resolved, or written through the loss investigation
process by AD/SA — never by editing counts.

## 6. Internal movements are NOT transfers

Moving a parcel between racks, shelves or zones **inside one warehouse** is an
internal inventory movement (inventory-and-custody.md §2): no transfer record,
no manifest, no driver. Creating a transfer with origin = destination is
rejected by validation.

## 7. Rules and invariants

1. A package can be on at most one open transfer at a time (enforced at
   selection, step 2).
2. Dispatch requires: approved (where configured) + driver + vehicle +
   loading scans complete for every manifested package.
3. Custody chain is continuous: origin warehouse → LD (at dispatch) →
   destination warehouse (per package, at its unload scan). There is no moment
   a package is "nobody's".
4. Expected arrival is set at creation and revised only through trip progress
   events, each revision timestamped and attributed.
5. Cancellation after any package is loaded is impossible; the load must be
   physically reversed (unload scans back into origin stock) and recorded.
6. Transfer, manifest and scan records are permanent; amendments append, they
   do not rewrite.

## 8. Failure handling

| Failure | Behaviour |
|---|---|
| Package selected that is on hold / in another transfer / not in stock | Refused at selection with the specific reason; selection of other packages unaffected |
| Driver/vehicle becomes unavailable after assignment, before dispatch | Dispatch blocked; WA reassigns (recorded); manifest unchanged |
| Destination at hard capacity on arrival | Receiving scans refused per warehouse capacity rules; packages remain in LD custody; AD notified to reroute or authorise override (warehouse-workflow.md §4) |
| LD attempts to confirm receipt at destination | No such action exists for LD; the UI offers arrival + handover only. Receiving is destination staff work |
| Network loss during loading/unloading scans | Scans queue on-device with idempotency keys and sync in order; counts shown as "pending sync" until confirmed — dispatch/reconciliation act only on server-confirmed scans |
| Reconciliation attempted with open shortage | Refused; response lists unaccounted tracking IDs and linked incident IDs |
