> **Canonical V2 doc:** `docs/driver-operations.md` supersedes this V1 workflow for the built system. This file is retained for design history only.

# Driver, Vehicle and Trip Workflow — BLA Logistics Platform

**Purpose.** Drivers move packages in two distinct jobs: riders do pickup and
final-mile delivery; line-haul drivers move manifested loads between
warehouses. This document defines driver profiles, capabilities, availability,
vehicles, and the trip lifecycle. Spec reference: Part 10; delivery-side detail
in delivery-workflow.md.

**Legacy note:** today all 4 live drivers carry `users.role = driver` and the
split lives in `drivers.driver_type` (`micro`/`big`). The rebuild makes this
explicit: role **DR** (Delivery Rider) with capability flags, and role **LD**
(Line-haul Driver). The unused `micro_driver`/`big_driver` enum values are
retired.

---

## 1. Driver profile

| Field | Notes |
|---|---|
| Driver ID | Unique, human-readable |
| User account | 1:1 with a platform user (role DR or LD) |
| Full name, phone, email (optional), profile photo | Phone is the operational contact |
| Home warehouse | Via `WarehouseMembership` (`driver_home`) — assignments originate here |
| Category | DR or LD (the role); DR capabilities below |
| Employment status | `active` · `suspended` · `inactive` (set by `driver.manage`) |
| License number + expiry | Expiry in the past ⇒ not assignable; 30-day warning to AD |
| Verification documents | Private storage; view restricted to AD/SA (`driver.manage`) — never exposed to vendors/customers |
| Emergency contact | Optional, restricted like documents |
| Assigned vehicle | Current default vehicle, if any |
| Current trip / workload | Derived from live assignments, not stored flags |

## 2. Categories and capabilities

| Category | Can be assigned | Cannot |
|---|---|---|
| DR — pickup capability | Vendor/counter pickups | — |
| DR — delivery capability | Final-mile delivery batches | — |
| DR — combined (both flags) | Both | — |
| LD — line-haul | Inter-warehouse trips with manifests | Final-mile deliveries, pickups |

Capabilities are checked **at assignment time** by the assignment services
(spec §10.2): the dispatcher UI only offers eligible drivers, and the server
rejects an ineligible assignment even if the UI is bypassed. A rider cannot
confirm a delivery on a trip manifest; an LD cannot confirm a doorstep
delivery — the actions do not exist for the wrong role.

## 3. Availability

Driver availability is **derived from real assignments**, never from login
state (spec §10.3):

| State | Meaning | Assignable? |
|---|---|---|
| `available` | Active, no current run | Yes |
| `assigned` | Has work queued today, not yet started | Yes (within workload limits) |
| `on_pickup` | Executing a pickup run | Additional pickups in the same area only |
| `on_delivery` | Out for delivery with a batch | No new batch until return/close-out |
| `on_trip` | Line-haul trip in progress | No |
| `off_duty` | Shift ended / not rostered | No |
| `on_leave` | Recorded leave | No |
| `suspended` | Employment suspended | No — and sessions revoked, custody reassignment triggered (Scenario 17) |
| `inactive` | Left the company | No |

Workload limits (max packages per batch, max batch weight) are settings
(`settings.manage`); assignment services enforce them and explain refusals.

## 4. Vehicles

`Vehicle` record: vehicle ID · registration number (unique) · type (bike, van,
truck…) · capacity (pieces) · weight limit (kg) · assigned driver (default) ·
insurance status + expiry · registration expiry · inspection/roadworthiness
status + date · maintenance schedule · availability
(`available` / `on_trip` / `maintenance` / `inactive`).

Assignment rules (`vehicle.assign`):
- A vehicle with expired insurance, expired registration, failed inspection,
  or `maintenance`/`inactive` status **cannot be assigned** — the refusal
  names the exact blocker.
- Vehicle capacity and weight limit are checked against the manifest at
  transfer dispatch.
- A vehicle on an open trip cannot be assigned to a second trip.

## 5. Trip lifecycle (line-haul)

A `Trip` is created from a transfer at dispatch (transfer-workflow.md §3,
steps 10–13) and carries: trip ID · origin · destination · driver · vehicle ·
manifest · planned departure · actual departure · expected arrival · actual
arrival · status · incident history.

Statuses: `planned` · `assigned` · `loading` · `dispatched` · `in_transit` ·
`delayed` · `arrived` · `unloading` · `completed` · `cancelled` · `incident`
(overlay while an incident is open; the underlying movement status is kept).

**Checkpoints** (manual, reliable — GPS is an enhancement, never a dependency,
spec §10.5): departure confirmed → optional en-route checkpoints (LD taps at
major stops; the old system already wrote checkpoint events) → arrival
confirmed → unloading complete (destination scans) → trip completed when the
transfer reconciles or is `partially_received` with incidents open (the trip
ends; the *transfer* stays open).

Riders have runs, not trips: a pickup run or delivery batch with the same
checkpoint discipline (start, per-package scans, close-out at warehouse
return).

## 6. Breakdowns, delays, reassignment

**Breakdown / accident (Scenario 6):**
1. LD reports a trip incident (category `vehicle_breakdown` / `accident`)
   with location note and photo if safe to take. Trip → `incident` overlay;
   packages stay in LD custody, `in_transit`.
2. AD and both WAs are notified immediately.
3. Authorised dispatcher (AD or origin/destination WA) chooses: wait for
   repair (revised ETA), or **reassign**: a replacement driver and/or vehicle
   is assigned; the load changes hands through a recorded custody handover —
   package-by-package scan at the roadside handover where feasible, or a
   count-verified bulk handover with both drivers confirming.
4. Expected arrival is revised; the incident keeps the full timeline.

**Rider unavailable mid-run (Scenario 14):** packages in the rider's custody
are reassigned only through a warehouse return + re-handout, or a direct
rider-to-rider handover with scans. Both custody legs are recorded; assignment
history shows both riders. A dispatcher can never silently move a package
from one rider's list to another's.

**New assignment eligibility:** an LD becomes assignable when their trip is
`completed`/`cancelled`, or when a dispatcher reassigns them off it (recorded).
A rider becomes assignable for a new batch after close-out of the current one
(all packages delivered, attempted-and-returned, or handed over).

## 7. Actors and permissions

| Action | Who | Permission |
|---|---|---|
| Create/edit driver profiles, verify documents, activate/suspend | SA/AD; WA limited to own-warehouse riders' availability | `driver.manage` |
| Assign work (batches, trips) | SA/AD; WA (own warehouse) | `driver.assign`, `delivery.assign`, `transfer.*` |
| Manage vehicles | SA/AD | `vehicle.manage` |
| Assign vehicle to trip | SA/AD; WA (own transfers) | `vehicle.assign` |
| Update own trip progress, report incident | Assigned LD/DR | `trip.update_progress`, `trip.report_incident` |
| View own record, performance, COD position | DR/LD | `driver.read_self`, `report.read_self` |

Drivers see **only** their assigned work and the minimum sender/recipient
information needed to execute it (spec §4.5/§4.6 restrictions). Driver personal
documents are never visible to vendors, customers, or other drivers.

## 8. Rules and invariants

1. One active trip per driver and per vehicle.
2. Custody is continuous across every reassignment — handovers, never edits.
3. Expired license/insurance/registration blocks assignment automatically;
   warnings start 30 days before expiry.
4. Suspension revokes sessions immediately and surfaces the driver's custody
   list for reassignment before the account closes (Scenario 17).
5. Trip and run history is permanent, including cancelled and incident trips.
6. GPS pings (where the app sends them) are supporting evidence only; no
   workflow step depends on GPS availability. (The legacy `cleanup_gps_tracking`
   7-day hard-delete is replaced by the platform retention policy; GPS is not
   part of the package's permanent history.)

## 9. Failure handling

| Failure | Behaviour |
|---|---|
| Assignment of suspended/on-trip/expired-license driver attempted | Refused with the specific reason; attempt audit-logged |
| Vehicle double-assignment attempted | Refused; names the open trip holding the vehicle |
| LD tries to mark destination receipt | Action does not exist for LD; arrival + handover only (receiving is destination staff) |
| Trip arrival recorded but destination never scans | Trip sits in `arrived/unloading`; packages remain in LD custody on every dashboard; WA at destination is reminded; AD sees it in exceptions after a threshold |
| Driver loses connectivity mid-trip | Checkpoints queue offline with timestamps and sync on reconnect; no server confirmation is ever fabricated on-device (Scenario 10) |
| Incident reported on a completed trip | Rejected — incidents attach to open trips/transfers; historical issues go through exception-management as standalone incidents linked to the trip |
