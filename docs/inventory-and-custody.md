# Inventory and Custody — BLA Logistics Platform

**Purpose.** At any second, the system must answer three questions about every
package: *where is it physically, what state is it in, and who is accountable
for it right now?* This document defines the inventory model (what a warehouse
holds), the custody model (who is responsible), and how the two stay in
agreement. Spec reference: Part 8.

---

## 1. Two inventories that never mix

### 1.1 Parcel inventory
Customer property in our care. One `InventoryRecord` per package per warehouse
stay:

| Field | Notes |
|---|---|
| `packageId` | The physical parcel (unique while active — see invariant I1) |
| `warehouseId` | Holding warehouse |
| `storageLocationId` | Current zone/rack/shelf (warehouse-workflow.md §3) |
| `condition` | From inspection: `good`, `damaged`, … (package-lifecycle.md §2) |
| `operationalStatus` | Mirrors the package lifecycle state while in this warehouse |
| `receivingEventId` | The tracking event that brought it in — inventory cannot exist without one |
| `custodyId` | Current custody record (§3) |
| `lastMovementId` | Most recent inventory movement (§2) |
| `receivedAt` / `closedAt` | `closedAt` set when the package leaves (dispatch, delivery handout, return); the record is kept, never deleted |

### 1.2 Supplies inventory
Company consumables — boxes, packaging tape, bags, labels, protective material.
Tracked as `StockItem` + `StockMovement`: quantity on hand per warehouse,
minimum level with low-stock warning, purchase/receipt records, issue records
(e.g. labels consumed by the label printer run), and stock adjustments with
reason. Supplies have **no tracking IDs, no custody, no customer linkage**, and
never appear in parcel queries or counts (spec §8.2).

Permissions: `supplies.manage` (WA/WS own warehouse, AD/SA all).

## 2. Inventory movements

Every physical relocation of a parcel inside or out of a warehouse is an
`InventoryMovement` with actor, timestamp, source location, destination
location, and reason. Movement types (spec §8.3):

| Type | From → To | Created by |
|---|---|---|
| `receiving` | (external custodian) → Receiving zone | Receiving scan (WA/WS, or rider drop-off confirmation) |
| `put_away` | Receiving/Inspection → Storage location | WS/WA after inspection |
| `internal_move` | Location → location, same warehouse | WS/WA (`inventory.move_internal`) |
| `picking` | Storage → Dispatch zone | WS/WA preparing a manifest or delivery batch |
| `dispatch` | Dispatch zone → line-haul driver (transfer) | Loading + dispatch confirmation |
| `delivery_handout` | Storage/Dispatch → delivery rider | Rider departure scan |
| `delivery_return` | Delivery rider → warehouse location | Rider returns undelivered package; WA/WS accepts |
| `transfer_arrival` | Line-haul driver → destination Receiving zone | Destination receiving scan |
| `return_receiving` | (return flow) → Returns zone | WA/WS (return-workflow.md) |
| `damage_quarantine` | Any location → Damaged zone | Whoever records damage; WA confirms |
| `inventory_correction` | Location → corrected location | WA only, with reason, linked incident (`inventory.correct`) |

Movements are append-only. A wrong movement is fixed by a corrective movement,
never by editing the original.

## 3. Custody model

`PackageCustody` is the single source of truth for accountability. Exactly one
custody record is *active* for a package at any time. A custodian is one of:

- a **warehouse** (with a storage location — the package is on a shelf),
- a **warehouse staff member** (during active handling, e.g. mid-inspection),
- the **pickup rider**, the **line-haul driver**, or the **delivery rider**,
- the **recipient** (terminal — delivery confirmed),
- the **return processing team** (a warehouse role custodian at the returns zone),
- the **vendor/sender** (terminal for completed returns).

### 3.1 Handover protocol
Every change of custodian is a `CustodyHandover`:

| Field | Notes |
|---|---|
| `packageId` (or a batch of package IDs on one handover) | Bulk handovers list each package |
| `fromCustodian` / `toCustodian` | Person or warehouse+location |
| `offeredAt` / `confirmedAt` | Two-phase: the giver records the offer, the receiver confirms by scan |
| `confirmedBy` | The receiving actor, resolved from their DB user record |
| `evidenceFileIds` | Handover photo/signature where policy requires |
| `discrepancyNote` | Receiver can flag count/condition mismatch at confirmation |

A handover is not complete — and custody does not move — until the receiver
confirms. A package scanned out by a rider but never confirmed back at the
warehouse is still the rider's responsibility, and the rider dashboard and WA
dashboard both show it as outstanding.

### 3.2 Where inventory and custody meet
- Package in warehouse inventory ⇒ custodian is that warehouse (or a staff
  member of it, mid-handling).
- Package with a rider/driver ⇒ **no active inventory record** at any
  warehouse. It appears on dashboards as "with rider X", never as available
  stock (spec §8.1, invariant I2).
- Package delivered ⇒ custody = recipient; inventory record closed at handout.

## 4. Discrepancy handling — the 25 vs 23 rule

When a receiver confirms **fewer** packages than the handover/manifest claims
(spec §8.4 worked example: driver hands over 25, warehouse confirms 23):

1. The 23 confirmed packages complete their handover normally — operations are
   not blocked by the shortage.
2. The 2 unconfirmed packages **stay in the driver's custody** in the system.
   The driver cannot be marked "handed over" for them, and the trip/transfer
   cannot fully close.
3. An incident (`transfer_shortage`, severity high) is **auto-created**,
   linked to the transfer, trip, driver, both warehouses and the exact missing
   tracking IDs.
4. AD + both WAs are notified in-app immediately.
5. Resolution paths: packages found and scanned (handover completes, incident
   updated), or investigation concludes (loss process in
   exception-management.md). Nobody can edit the manifest count or the
   confirmation count to make the numbers agree.

The same mechanism covers excess (receiver has a package not on the manifest:
it is received as an *unmanifested arrival* observation, quarantined, incident
`transfer_excess`) and condition mismatch (received but damaged: custody moves,
condition + incident recorded — custody and condition are separate facts).

## 5. Actors and permissions

| Action | Who | Permission |
|---|---|---|
| View inventory | SA/AD all; WA/WS own warehouse | `inventory.read_all` / `inventory.read_warehouse` |
| Internal moves, put-away, picking | WA/WS (own) | `inventory.move_internal` |
| Corrections | WA (own), AD/SA | `inventory.correct` + reason + incident |
| Handover offer/confirm | WA/WS, assigned DR/LD | `custody.handover` (scoped) |
| Custody history read | SA/AD; WA scoped; vendor milestone-level only | `custody.read` |

Finance and support have **no** inventory or custody permissions: finance must
never change physical custody (spec §4.9), support raises requests that
operators execute.

## 6. Rules and invariants

- **I1 — One active inventory record per package.** Enforced by a partial
  unique index; a second receiving insert for an already-stocked package is
  the duplicate-scan path (idempotent return, not a new record).
- **I2 — Inventory XOR field custody.** A package has either an active
  warehouse inventory record or an active person custodian, never both, never
  neither (after first receipt).
- **I3 — No inventory without a receiving event.** The receiving scan creates
  the tracking event, the lifecycle transition and the inventory record in one
  transaction.
- **I4 — Custody changes only via confirmed handover.** No admin screen edits
  a package's custodian field directly.
- **I5 — Counts are derived.** Warehouse stock counts, rider custody counts
  and capacity figures are computed from live records, never stored counters.
- **I6 — History is permanent.** Closed inventory records, movements and
  handovers are retained and queryable for the life of the package record.

## 7. Failure handling

| Failure | Behaviour |
|---|---|
| Duplicate receiving scan | Idempotency key returns the original receiving result; operator sees "already received at HH:MM"; no duplicate stock (Scenario 7) |
| Receiver confirms fewer than offered | §4 flow: partial handover completes, remainder stays with giver, incident auto-created |
| Receiver scans a package not offered to them | Treated as unmanifested arrival: quarantined in Receiving, incident raised, package does **not** enter sellable/dispatchable stock until WA resolves |
| Staff member suspended while holding custody | Custody list for that user is surfaced to WA/AD; every item must be handed over to a named receiver before the account fully closes (Scenario 17) |
| Package found in a location that contradicts its record | WS records an `inventory_correction` movement from the recorded location to the found location with reason; repeated corrections at one warehouse surface in warehouse reports |
| Handover offered but never confirmed (e.g. driver left) | After a configured timeout the handover shows as *unconfirmed* on both dashboards; WA can escalate to an incident; custody remains with the giver until a human resolves it — the system never auto-confirms |

---

## 8. V2 final state (Phase 8 addendum)

- **Custody on reassignment (Phase 7).** Reassignment never edits a
  custodian field (invariant I4 applies unchanged); it *moves*
  custody through recorded paths, and the tracking layer follows:
  - *Delivery batch reassignment:* the old assignments close as
    `REASSIGNED`, new assignments chain to them, packages change
    hands only via warehouse return + re-handout or a scanned
    rider-to-rider handover, and any live tracking session bound
    to the old batch ends in the same transaction with
    `endReason = REASSIGNED`.
  - *Trip driver replacement:* the load changes hands through a
    recorded custody handover (package-by-package scan where
    feasible, or count-verified bulk handover with both drivers
    confirming); the outgoing driver's session on the trip ends
    `REASSIGNED` in the same transaction.
  In both cases the custody chain has no gap: the outgoing holder
  remains accountable until the recorded handover confirms.
- **Returns cross-warehouse (Phase 7).** A return held in inventory
  at the receiving warehouse whose return warehouse is elsewhere
  leaves that inventory through the normal transfer path
  (manifested return package — `docs/warehouse-transfers.md` §7):
  inventory closes at dispatch with release reason `RETURN` /
  transfer movement, and a new stay opens at the return warehouse
  on receiving completion. The two stays are separate
  `InventoryRecord`s, as I1/I3 require — the package is never in
  two warehouses' stock at once, and never in none while in the
  network.
- **Evidence binding is delivery-side.** Phase 7's POD
  hash-binding affects proof records, not inventory or custody;
  it is recorded here only to prevent it being looked for in this
  layer. See `docs/delivery-operations.md` §6.
