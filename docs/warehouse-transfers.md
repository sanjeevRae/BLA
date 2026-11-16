# Warehouse Transfers — BLA Logistics Platform (V2, canonical)

**Status:** Canonical V2 document. This file supersedes
`docs/transfer-workflow.md` (V1 design) as the reference for the built
system. The V1 file is retained for design history only.

**Sources (generated from code, not memory):** status vocabularies are
the constants in `src/lib/transfers/domain.ts`; package transitions are
the allow-list in `src/lib/bookings/lifecycle.ts`; API routes are the
files under `src/app/api/transfers/` and `src/app/api/trips/`.

---

## 1. What a transfer is

A transfer moves packages between two different warehouses under a
manifest, with a named line-haul driver and vehicle. It is complete
only when the destination's physical receiving has been reconciled
against what was dispatched. A package never silently changes
warehouse, and origin = destination is rejected by validation —
moving a parcel between racks/zones inside one warehouse is an
internal inventory movement (see `docs/inventory-and-custody.md`),
not a transfer.

## 2. Actors and permissions

| Step | Who | Permission (from `src/lib/permissions/catalog.ts`) |
|---|---|---|
| Create transfer, select packages | Origin Warehouse Admin; Admin / Super Admin | `transfer.create` |
| Prepare manifest, picking | Origin Warehouse Admin / Staff | `transfer.prepare` |
| Approve (where configured) | Warehouse Admin (own warehouse); Admin / Super Admin | `transfer.approve` |
| Loading scans | Origin Staff / Admin; assigned line-haul driver confirms | `transfer.load` |
| Dispatch | Origin Warehouse Admin | `transfer.dispatch` |
| Trip progress, arrival | Assigned line-haul driver; warehouse oversight | `trip.update_progress` |
| Receiving scans at destination | Destination Warehouse Admin / Staff | `transfer.receive` |
| Reconciliation and closure | Destination Warehouse Admin; Admin / Super Admin | `transfer.reconcile` |

The line-haul driver never selects packages, never edits the manifest
after dispatch, and can never mark packages received at destination.

## 3. Status vocabularies (code constants)

**Transfer — `TRANSFER_STATUSES` in `src/lib/transfers/domain.ts`
(16 values):**
`DRAFT` · `REQUESTED` · `APPROVED` · `REJECTED` · `PREPARING` ·
`READY_FOR_DISPATCH` · `DISPATCHED` · `IN_TRANSIT` · `ARRIVED` ·
`PARTIALLY_RECEIVED` · `RECEIVED` · `RECONCILIATION_PENDING` ·
`RECONCILED` · `CLOSED` · `EXCEPTION` · `CANCELLED`.

A package is committed to a transfer while the transfer is in an
*open* status (`OPEN_TRANSFER_STATUSES`: every status above except
`RECONCILED`, `CLOSED`, `CANCELLED`) — a package may be an item of
only one open transfer at a time. Item/manifest edits are possible
only before dispatch (`DRAFT`, `REQUESTED`, `APPROVED`, `REJECTED`,
`PREPARING`, `READY_FOR_DISPATCH`); cancellation is likewise possible
only before dispatch and before any load scan exists — a loaded
transfer must be physically unloaded first.

**Transfer item — `TRANSFER_ITEM_STATUSES` (8 values):**
`EXPECTED` · `LOADED` · `IN_TRANSIT` · `RECEIVED` · `MISSING` ·
`DAMAGED` · `EXCESS` · `WRONG_PACKAGE`. Only `RECEIVED` and `DAMAGED`
count as physically accounted for at the destination for
reconciliation purposes.

**Transfer scans — `TRANSFER_SCAN_TYPES`:** `LOAD` · `UNLOAD` ·
`RECHECK`.

**Trip — `TRIP_STATUSES` (11 values):** `PLANNED` · `ASSIGNED` ·
`LOADING` · `DISPATCHED` · `IN_TRANSIT` · `DELAYED` · `ARRIVED` ·
`UNLOADING` · `COMPLETED` · `CANCELLED` · `INCIDENT`. A driver or
vehicle with a trip in an active status (`PLANNED` … `INCIDENT`,
i.e. everything except `COMPLETED` / `CANCELLED`) is not assignable
to another trip.

**Package operational states on this leg** (from
`src/lib/bookings/lifecycle.ts`): `READY_FOR_DISPATCH` →
(`add_to_transfer`, `transfer.prepare`) → `TRANSFER_ASSIGNED` →
(`dispatch_transfer`, `transfer.dispatch`) → `DISPATCHED` →
(`trip_departed`, `trip.update_progress`) → `IN_TRANSIT` →
(`trip_arrived`, `trip.update_progress`) → `ARRIVED_AT_DESTINATION`
→ (`destination_receiving_scan`, `transfer.receive`) →
`RECEIVING_INSPECTION` → (`destination_receiving_complete`,
`transfer.receive`) → `RECEIVED_AT_DESTINATION`. Before dispatch, a
manifested package can be released back with
`TRANSFER_ASSIGNED → READY_FOR_DISPATCH` (`remove_from_transfer`).
There is no edge out of `DISPATCHED` and beyond back to origin stock.

## 4. The workflow

1. Origin Warehouse Admin creates a **draft** transfer: origin (own
   warehouse, enforced), destination, date, expected arrival,
   instructions. No package state changes.
2. Staff **select eligible packages**: only packages whose active
   inventory record is at the origin, in `READY_FOR_DISPATCH` (the
   lifecycle entry state), not on hold, not already on another open
   transfer. Ineligible packages are refused at selection with the
   reason shown.
3. The manifest (`TransferManifest`) is prepared: ordered package
   list with tracking IDs, weights, piece count. Manifesting moves
   each package to `TRANSFER_ASSIGNED`.
4. **Approval** if configured for the lane; rejection returns the
   transfer toward draft handling with the reason recorded.
5. **Assign driver and vehicle**: a line-haul-capable driver who is
   active and available, and a vehicle that is available with valid
   insurance / registration / inspection and capacity for the
   manifest. Invalid assignments are refused with the blocker named
   (see `docs/driver-operations.md`).
6. Picking moves packages Storage → Dispatch zone (inventory
   movements).
7. **Loading scans**: every package is scanned as it is loaded
   (`TransferScan`, type `LOAD`). Loaded count builds in real time;
   unscanned manifest packages block dispatch. A discrepancy here is
   resolved physically — the manifest is never edited to match a
   wrong load.
8. Origin Warehouse Admin **confirms dispatch**: packages →
   `DISPATCHED`, custody → line-haul driver, origin inventory
   records close. A `Trip` is created from the transfer at dispatch;
   one trip carries one transfer in the standard flow.
9. The driver **departs** (packages → `IN_TRANSIT`), updates trip
   progress (manual checkpoints; delay / breakdown reported as
   events / incidents), and **records arrival** (packages →
   `ARRIVED_AT_DESTINATION`; destination staff notified).
10. Destination staff **scan packages during unloading** (type
    `UNLOAD`); each scan is that package's receiving scan: package →
    `RECEIVING_INSPECTION`, destination inventory record created
    (Receiving zone), custody → destination warehouse.
11. The system **compares expected vs received** (manifest vs unload
    scans vs condition reports) and classifies differences: missing /
    excess / damaged / wrong package (§5).
12. Destination staff **complete receiving**: received packages →
    `RECEIVED_AT_DESTINATION`. A short / over / damaged receipt
    leaves the transfer `PARTIALLY_RECEIVED` with incidents linked.
13. **Reconciliation and closure**: received + accounted-for
    (damaged-quarantined, excess-resolved) must equal manifested,
    with no open discrepancy incidents, before the transfer can move
    `RECONCILED` → `CLOSED`. If anything is unaccounted,
    reconciliation is **refused** and the transfer stays open.

## 5. Discrepancy handling

| Case | Handling |
|---|---|
| **Missing package** (manifested, not scanned at destination) | Package stays `IN_TRANSIT` in the driver's custody; a `TRANSFER_SHORTAGE` incident (default severity HIGH, `src/lib/operations/domain.ts`) is created naming the tracking IDs, driver, vehicle and both warehouses; the transfer cannot reconcile. |
| **Excess package** (scanned, not on manifest) | Received as an unmanifested arrival into Receiving-zone quarantine; `TRANSFER_EXCESS` incident; it joins stock only after Warehouse Admin resolution links it to its true shipment. |
| **Damaged package** | Receiving scan + condition `DAMAGED` + evidence; custody moves but the package is routed to the Damaged zone; `DAMAGED_PACKAGE` incident. Damage is accounted-for, not a shortage, so the transfer can reconcile with the incident linked. |
| **Wrong package / wrong warehouse** | Arrival observation recorded, package exception `MISROUTED`, quarantined; a corrective transfer returns it to the network. It never enters this warehouse's dispatchable inventory. |
| **Duplicate scan** | Idempotent: the second scan returns "already scanned"; counts unchanged. |
| **Vehicle breakdown en route** | Driver reports an incident; a dispatcher may reassign driver / vehicle with a recorded custody handover of the load; expected arrival is updated. See §7 for the tracking-session consequence. |
| **Delayed arrival** | Driver updates progress with a reason; destination and Admin see the revised ETA; delay can raise a `DELAYED_SHIPMENT` incident. |

**Absolute rule:** the destination is never forced to accept a
quantity it did not physically receive. A partially received transfer
remains open for investigation until every manifested package is
received, accounted for, or written through the loss investigation
process by Admin / Super Admin — never by editing counts.

## 6. API surface (Route Handlers)

Generated from `src/app/api/**/route.ts`:

- `GET /api/transfers` · `POST /api/transfers`
- `GET /api/transfers/[id]`
- `POST /api/transfers/[id]/load`
- `POST /api/transfers/[id]/dispatch`
- `POST /api/transfers/[id]/receive`
- `POST /api/transfers/[id]/finish-receiving`
- `POST /api/transfers/[id]/complete-receiving`
- `POST /api/transfers/[id]/reconcile`
- `POST /api/trips/[id]/depart` · `POST /api/trips/[id]/arrive`

Dashboard routes (navigation registry, `src/lib/navigation/registry.ts`):
Warehouse Admin / Staff — Transfers (`/warehouse/transfers`,
`/staff/transfers`), New transfer (`/warehouse/transfers/new`,
Warehouse Admin only), Arrivals (`/warehouse/arrivals`,
`/staff/arrivals`), transfer detail and manifest pages under each
tree.

## 7. V2 changes (Phases 3–7)

- **GPS tracking linkage (Phase 3).** A dispatched trip can carry a
  driver-started `TrackingSession` (`trackingType = LINEHAUL`). GPS
  is supporting evidence only; no transfer step depends on it. See
  `docs/live-gps-tracking.md`.
- **Driver replacement — `REASSIGNED` (Phase 7).** When a trip's
  driver is replaced (`src/server/services/trips.ts`), the outgoing
  driver's live tracking session on that trip ends in the same
  transaction with `endReason = REASSIGNED`
  (`TRACKING_END_REASONS` in `src/lib/tracking/domain.ts`). Custody
  of the load moves only through the recorded handover; the
  replacement driver starts their own session if they track.
- **Cross-warehouse returns ride normal transfers (Phase 7).** A
  return received at one warehouse whose return warehouse
  (`ReturnRequest.destinationWarehouseId` — the origin warehouse of
  the package's shipment) is a different warehouse joins a normal
  transfer as a manifested package flagged as a return (linked via
  `ReturnRequest.transferId`). It may be manifested **only toward
  its return warehouse** (the transfer picker offers cross-warehouse
  return packages toward their return warehouse). The package is
  first readied with the lifecycle edge `READY_FOR_DELIVERY →
  READY_FOR_DISPATCH` (`return_ready_for_dispatch`,
  `transfer.prepare`), then follows the ordinary manifest path
  (`TRANSFER_ASSIGNED` …). At dispatch the return status moves
  `RECEIVED → IN_TRANSIT`; when transfer receiving completes at the
  destination it returns to `RECEIVED` (first-receipt stamps are
  preserved; the arrival is a tracking event). Inspection and
  completion then run at the return warehouse. Full return flow:
  `docs/return-workflow.md`; lifecycle note:
  `docs/package-lifecycle.md`.

## 8. Rules and invariants

1. A package can be on at most one open transfer at a time.
2. Dispatch requires: approval (where configured) + driver +
   vehicle + loading scans complete for every manifested package.
3. Custody is continuous: origin warehouse → line-haul driver (at
   dispatch) → destination warehouse (per package, at its unload
   scan). There is no moment a package is "nobody's".
4. Expected arrival is set at creation and revised only through trip
   progress events, each revision timestamped and attributed.
5. Cancellation after any package is loaded is impossible; the load
   must be physically reversed (unload scans back into origin stock)
   and recorded.
6. Transfer, manifest and scan records are permanent; amendments
   append, they do not rewrite.
