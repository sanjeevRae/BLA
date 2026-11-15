# Warehouse Workflow — BLA Logistics Platform

**Purpose.** Warehouses are the physical backbone of the platform: every package
movement either starts, ends, or passes through one. This document defines how a
warehouse is created, structured internally, capacity-managed, staffed and retired.
Spec reference: Part 5, Part 20 (Warehouse, WarehouseZone, StorageLocation,
WarehouseMembership).

**Live network today (migrates as-is):** `WH-KTM-01` Kathmandu Central Hub ·
`WH-PKR-01` Pokhara Regional Hub · `WH-CHT-01` Chitwan Warehouse (Bharatpur) ·
`WH-LTP-01` Lalitpur Depot.

---

## 1. Actors and permissions

| Action | Who | Permission |
|---|---|---|
| Create / edit master data / deactivate | Super Admin, Admin | `warehouse.create`, `warehouse.update`, `warehouse.deactivate` |
| Edit own warehouse's operational fields (hours, contact, capacity thresholds) | Warehouse Admin (member) | `warehouse.update` (scoped) |
| Manage zones and storage locations | SA, AD, WA (own) | `warehouse.manage_locations` |
| Assign/remove staff and riders | SA, AD; WA for own warehouse | `warehouse.assign_staff` |
| View capacity and inventory | SA, AD (all); WA, WS (own) | `warehouse.capacity.read`, `inventory.read_warehouse` |

Customers, vendors, finance and support never see warehouse internals; finance and
support see directory data only (name, code, city) via `warehouse.read_all`.

## 2. Creating a warehouse

**Step-by-step**

1. SA/AD submits the creation form (all fields in §2.1). The server validates with
   Zod: code format and uniqueness, phone format, province/district consistency,
   capacity > 0, manager must be an existing active user.
2. The warehouse is created in status **Inactive** — it cannot receive packages,
   appear in routing, or be assigned transfers yet.
3. The creator defines at least the mandatory zones (§3) and one storage location.
4. The creator assigns a Warehouse Admin via a `WarehouseMembership`
   (`role_purpose = admin`). A warehouse cannot be activated without one.
5. SA/AD flips status to **Active**. Activation is audit-logged with actor + reason.
6. From activation, the warehouse appears in booking origin/destination selection,
   transfer endpoints, and routing (destination warehouse auto-match by district,
   as the old Phase-3 intake did with city = district).

### 2.1 Required fields

| Field | Rule |
|---|---|
| Name | e.g. "Pokhara Regional Hub" |
| Code | Unique, immutable after creation. Format `WH-<CITY>-<NN>` (e.g. `WH-KTM-01`) |
| Address, City, District, Province, Country | District drives routing and destination auto-match |
| Postal code | Optional (not universal in Nepal) |
| Latitude / Longitude | Optional; used for maps and route estimates when present |
| Contact number, Warehouse email | Operational contact, shown to other warehouses |
| Operating hours | Per-weekday open/close (`WarehouseOperatingHours`); used for expected-arrival and receiving-window logic |
| Warehouse manager | A user; informational — authority comes from membership, not this field |
| Capacity | Package-count capacity (mandatory); optional weight (kg) and per-zone capacities (§4) |
| Type | One of: Main warehouse · Regional warehouse · Local delivery hub · Collection center · Return processing center |
| Operational status | Active · Inactive · Suspended (no new inbound transfers) |

## 3. Zones and storage locations

Every warehouse is divided into functional zones. The six standard zones are
created by template at warehouse setup; WA may add racks/shelves/bins inside them.

| Zone | Purpose |
|---|---|
| Receiving | Inbound packages land here at the receiving scan, before inspection |
| Inspection | Condition/weight verification, damage recording |
| Sorting | Sorted by destination warehouse / delivery area |
| Storage | Rack storage awaiting dispatch or delivery assignment |
| Dispatch | Staged for loading onto transfers or rider runs |
| Damaged | Quarantine for damaged packages under incident investigation |
| Returns | Returned packages awaiting inspection and vendor handover |

**Location codes** are hierarchical and human-readable on labels:

```
WH-KTM / ZONE-A / RACK-03 / SHELF-02
  │        │         │          └─ shelf/bin within the rack
  │        │         └─ rack within the zone
  │        └─ storage zone (mapped to one of the functional zones above)
  └─ warehouse code
```

Rules:
- A `StorageLocation` belongs to exactly one zone in exactly one warehouse; its
  full code is unique platform-wide.
- A package's inventory record always points at a current `StorageLocation`
  (or at a custodian — see inventory-and-custody.md). "Somewhere in the building"
  is not a state the system accepts.
- Deactivating a location with packages in it is blocked until they are moved;
  the move is recorded as internal movements, never as an edit.

## 4. Capacity management

- Capacity is tracked as **current package count vs configured count capacity**,
  and, where configured, total stored weight and per-zone counts.
- Thresholds: **warning at 85%**, **critical at 95%** (configurable per warehouse
  by SA under `settings.manage` defaults).
- At warning: WA dashboard banner + in-app notification to WA and AD.
- At critical: notification escalates; new transfer creation **to** this warehouse
  shows a blocking warning to the origin WA/AD (spec Scenario 16).
- **Hard limit (100%):** the system refuses new receiving scans and transfer
  dispatches into the warehouse unless an AD/SA records an authorised override
  with a reason. It never silently over-admits, and it never marks a package
  received that was not physically scanned (spec §5.4).
- Rerouting: AD/WA at origin may redirect a *not-yet-dispatched* transfer to an
  alternate warehouse; packages already in transit are handled by incident +
  corrective transfer, never by editing their destination.

## 5. Staffing a warehouse

1. Users are created/invited centrally (`user.manage` / `user.invite`).
2. SA/AD (or WA for own warehouse, WS/DR only) creates a `WarehouseMembership`:
   user, warehouse, role purpose (`admin`, `staff`, `rider_home`, `driver_home`),
   effective from now.
3. Membership removal sets `revoked_at` (the row is kept — assignment history is
   audit data). Removal is effective on the user's next request and blocks new
   writes under that warehouse immediately.
4. A WA whose membership is removed while packages/tasks are assigned to them
   triggers a reassignment prompt for AD/the remaining WA: open tasks and custody
   responsibilities must be handed over explicitly (see exception-management.md,
   suspended staff scenario).

## 6. Deactivation — never deletion

- A warehouse with any historical records **cannot be deleted**; there is no
  delete operation in the UI or API.
- Deactivation requires: no packages currently in inventory (all dispatched,
  delivered, returned or transferred out), no open transfers in either direction,
  no active trips ending there. The system lists blockers instead of failing
  silently.
- Deactivated warehouses keep all history queryable, disappear from booking/
  routing selection, and can be reactivated by SA/AD (audit-logged).
- The same rule applies to zones and storage locations: deactivate, never delete,
  once they have held a package.

## 7. Rules and invariants

1. One database, one inventory truth: warehouses are scopes on shared tables,
   never separate databases or schemas (spec §1.3).
2. Warehouse code is unique and immutable; renaming a warehouse changes the name,
   never the code printed on existing labels.
3. Every warehouse-scoped read/write passes membership scoping
   (role-permission-matrix.md §4.1). There is no cross-warehouse "staff" access.
4. District is operational data, not decoration: booking routing and destination
   auto-match key off it, so district changes by WA are not permitted (AD/SA only,
   audit-logged, because they change routing behaviour).
5. Capacity counts derive from live inventory records, never from a stored
   counter that can drift.

## 8. Failure handling

| Failure | Behaviour |
|---|---|
| Duplicate code on create | Rejected with the conflicting warehouse named; nothing created |
| Activation without a Warehouse Admin | Blocked with a specific message; warehouse stays Inactive |
| Receiving scan at hard capacity | Scan rejected, package stays with its current custodian, WA + AD notified, incident auto-created (capacity) |
| Deactivation with inventory/transfers open | Blocked; response lists the exact blockers and counts |
| Membership removed for the only WA | AD/SA warned at removal time; warehouse flagged "no active admin" on the AD dashboard until reassigned |
| Location deactivated while occupied | Blocked until internal movements empty it |
