# Driver Operations — BLA Logistics Platform (V2, canonical)

**Status:** Canonical V2 document. This file supersedes
`docs/driver-workflow.md` (V1 design) as the reference for the built
system. The V1 file is retained for design history only.

**Sources (generated from code, not memory):** vocabularies are the
constants in `src/lib/transfers/domain.ts` (drivers / vehicles /
trips), `src/lib/tracking/domain.ts` (GPS sessions) and
`src/lib/operations/domain.ts` (incidents); assignment blocking is
enforced in `src/server/services/drivers.ts`, `vehicles.ts`,
`transfers.ts` and `deliveries.ts`.

---

## 1. Two driver jobs, one profile model

Drivers move packages in two distinct jobs, modelled as two roles
with capability flags on a single `Driver` profile (1:1 with a
platform `User`):

- **RIDER** — pickup and/or final-mile delivery, capability-flagged.
- **LINEHAUL_DRIVER** — warehouse-to-warehouse transport on trips.

Capabilities — `DRIVER_CAPABILITIES` in
`src/lib/transfers/domain.ts`: `PICKUP` · `DELIVERY` · `LINEHAUL`.
A rider holds `PICKUP`, `DELIVERY`, or both; a line-haul driver
holds `LINEHAUL`. Capabilities are checked **at assignment time** by
the assignment services: the dispatcher UI only offers eligible
drivers, and the server rejects an ineligible assignment even if the
UI is bypassed. A rider cannot confirm a delivery on a trip manifest;
a line-haul driver cannot confirm a doorstep delivery — the actions
do not exist for the wrong role.

## 2. Driver profile (Phase 6 surface)

| Field | Notes |
|---|---|
| User account | 1:1 with a platform user (role RIDER or LINEHAUL_DRIVER) |
| Full name, phone, email (optional), profile photo | Phone is the operational contact |
| Home warehouse | Assignments originate here (warehouse membership) |
| Employment status | `DRIVER_EMPLOYMENT_STATUSES`: `ACTIVE` · `ON_LEAVE` · `SUSPENDED` · `INACTIVE` (set via `driver.manage`) |
| Availability status | `DRIVER_AVAILABILITY_STATUSES`: see §3 |
| Licence number + expiry | An expired licence blocks assignment; the sentinel expiry `1970-01-01` on migrated profiles is visibly expired and blocks assignment until the real date is entered (see `docs/deployment-guide.md`) |
| Verification documents | Private; view restricted to `driver.manage` holders — never exposed to vendors / customers |
| Emergency contact | Optional, restricted like documents |
| Assigned vehicle | Current default vehicle, if any |
| Current trip / workload | Derived from live assignments, not stored flags |

Dashboard routes (navigation registry,
`src/lib/navigation/registry.ts`): Drivers lists/details exist in
the Admin, Super Admin and Warehouse Admin trees (`/admin/drivers`,
`/super-admin/drivers`, `/warehouse/drivers`); riders work from
`/rider`, line-haul drivers from `/transport-driver`. A driver's own
record and performance are read with `driver.read_self` /
`report.read_self`.

## 3. Availability (derived, never login state)

`DRIVER_AVAILABILITY_STATUSES` (9 values): `AVAILABLE` · `ASSIGNED` ·
`ON_PICKUP` · `ON_DELIVERY` · `ON_TRIP` · `OFF_DUTY` · `ON_LEAVE` ·
`SUSPENDED` · `INACTIVE`.

Availability is **derived from real assignments**. The states that
block a new trip assignment even before the active-trip check runs
(`DRIVER_UNAVAILABLE_STATUSES`) are: `ON_TRIP`, `ON_PICKUP`,
`ON_DELIVERY`, `OFF_DUTY`, `ON_LEAVE`, `SUSPENDED`, `INACTIVE`.
Independently, a driver (or vehicle) with a trip in an active trip
status cannot take a second trip — one active trip per driver and
per vehicle.

Assignment blockers enforced server-side include: employment not
active, availability blocking, an existing active trip, and an
expired driving licence. Every refusal names the specific blocker.

## 4. Vehicles

`VEHICLE_TYPES`: `BIKE` · `CAR` · `VAN` · `TRUCK` · `PICKUP`.
`VEHICLE_STATUSES`: `AVAILABLE` · `ASSIGNED` · `ON_TRIP` ·
`MAINTENANCE` · `OFFLINE`. Inspection vocabulary:
`VALID` · `DUE` · `EXPIRED`; maintenance kinds: `SCHEDULED` ·
`REPAIR` · `INSPECTION`.

Assignment rules (`vehicle.assign`): a vehicle with expired
insurance, expired registration, failed/expired inspection, or a
`MAINTENANCE` / `OFFLINE` status **cannot be assigned** — the refusal
names the exact blocker. Capacity and weight limit are checked
against the manifest at transfer dispatch. A vehicle on an open trip
cannot be assigned to a second trip.

## 5. Trips (line-haul) and runs (riders)

A `Trip` is created from a transfer at dispatch (see
`docs/warehouse-transfers.md`). `TRIP_STATUSES` (11 values):
`PLANNED` · `ASSIGNED` · `LOADING` · `DISPATCHED` · `IN_TRANSIT` ·
`DELAYED` · `ARRIVED` · `UNLOADING` · `COMPLETED` · `CANCELLED` ·
`INCIDENT`.

**Checkpoints are manual and reliable — GPS is an enhancement,
never a dependency:** departure confirmed → optional en-route
checkpoints → arrival confirmed → unloading complete (destination
scans) → trip completed when the transfer reconciles or is
partially received with incidents open (the trip ends; the
*transfer* stays open).

Riders have runs, not trips: a pickup or delivery batch
(`docs/delivery-operations.md`) with the same checkpoint discipline
(start, per-package scans, close-out at warehouse return).

## 6. GPS tracking (Phases 3–4)

Full design: `docs/live-gps-tracking.md`; privacy/retention:
`docs/gps-privacy-and-retention.md`. The operational facts every
driver and dispatcher must know:

- Tracking is **driver-started only**, per assignment, after an
  explicit on-screen permission acknowledgement
  (`permissionAcknowledgedAt` is recorded). Nobody can start a
  session for a driver.
- Session vocabulary — `TRACKING_TYPES`: `LINEHAUL` · `PICKUP` ·
  `DELIVERY`; `TRACKING_SESSION_STATUSES`: `ACTIVE` · `PAUSED` ·
  `ENDED`; start reason is always `DRIVER`; end reasons
  (`TRACKING_END_REASONS`): `DRIVER` · `SUPERVISOR` ·
  `ASSIGNMENT_COMPLETED` · `ASSIGNMENT_CANCELLED` · `REASSIGNED` ·
  `EXPIRED`. At most one ACTIVE session per driver.
- Location comes from the browser Geolocation API
  (`watchPosition`). **Foreground-only limitation (explicit):
  browser GPS is reliable only while the tracking app is in the
  foreground. When the screen locks, the browser is closed, the tab
  is suspended, or the OS kills background activity, updates stop.
  There is no background tracking, and the UI never claims there
  is.** A stale position is shown as stale (freshness `FRESH` /
  `DELAYED` / `STALE` / `OFFLINE`), never as live.
- The driver panel (`LocationTrackingPanel`, mounted on both driver
  dashboards) offers Start / Pause / Resume / End. Pings are refused
  while `PAUSED`. Supervisors (with `operations.live_view`, scoped)
  can **end** a session — audited — but cannot pause, start, or
  silently restart one.
- Sessions auto-end inside the assignment transaction when a trip
  completes / is cancelled or a batch closes / is cancelled
  (`ASSIGNMENT_COMPLETED` / `ASSIGNMENT_CANCELLED`), and end with
  `REASSIGNED` when the driver is replaced (§8).
- Cadence is server-configured (`src/lib/tracking/config.ts`):
  rider moving ≈ 150 s, line-haul moving ≈ 240 s, stationary
  heartbeat 600 s, server ping floor 30 s. Detailed pings are
  retained **30 days** by default; maintenance is hourly session
  expiry + daily ping prune (see `docs/live-gps-tracking.md`).

Driver endpoints (Route Handlers, all `tracking.manage_own` unless
noted): `POST /api/tracking/session/start`,
`POST /api/tracking/location`, `POST /api/tracking/session/pause`,
`POST /api/tracking/session/resume`,
`POST /api/tracking/session/stop`,
`GET /api/tracking/session/current`. The driver identity on every
write comes only from the authenticated session.

## 7. Incident reporting (Phase 7 driver surface)

Drivers report problems from the work itself; incidents are the
system of record (`src/lib/operations/domain.ts`,
`src/server/services/incidents.ts`, `POST /api/incidents` with
`incident.report`; trip incidents also via `trip.report_incident`).

Incident categories (22 values) include the driver-relevant:
`DRIVER_BREAKDOWN` (default HIGH), `VEHICLE_ACCIDENT` (CRITICAL),
`DELAYED_SHIPMENT` (MEDIUM), `DAMAGED_PACKAGE` (HIGH),
`DELIVERY_FAILURE` (MEDIUM), `PICKUP_FAILURE` (MEDIUM),
`MISSING_PACKAGE` (CRITICAL), `THEFT_SUSPICION` (CRITICAL).
Incident statuses (10 values): `REPORTED` · `ACKNOWLEDGED` ·
`ASSIGNED` · `INVESTIGATING` · `AWAITING_INFORMATION` · `ESCALATED` ·
`RESOLUTION_PROPOSED` · `RESOLUTION_APPROVED` · `RESOLVED` ·
`CLOSED`. Severities: `LOW` · `MEDIUM` · `HIGH` · `CRITICAL` — a
reporter or triaging manager can raise the default severity, never
silently lower it.

**Breakdown / accident:** the driver reports the incident with a
location note and photo if safe; packages stay in the driver's
custody, `IN_TRANSIT`; Admin and both warehouse admins are notified.
A dispatcher then waits for repair (revised ETA) or reassigns (§8).

## 8. Reassignment and custody

- **Trip driver replacement (Phase 7):** a replacement driver and/or
  vehicle is assigned by an authorised dispatcher; the load changes
  hands through a **recorded custody handover** — package-by-package
  scan at the handover where feasible, or a count-verified bulk
  handover with both drivers confirming. The outgoing driver's live
  tracking session on the trip ends in the same transaction with
  `endReason = REASSIGNED`. Expected arrival is revised; the
  incident keeps the full timeline.
- **Delivery batch reassignment (Phase 7):** see
  `docs/delivery-operations.md` — the old assignment closes as
  `REASSIGNED`, custody moves only through the recorded path, and
  any live tracking session on the old batch ends `REASSIGNED`.
- **Rider unavailable mid-run:** packages in the rider's custody are
  reassigned only through a warehouse return + re-handout, or a
  direct rider-to-rider handover with scans. Both custody legs are
  recorded; a dispatcher can never silently move a package from one
  rider's list to another's.
- **Suspension:** revokes sessions immediately and surfaces the
  driver's custody list for reassignment before the account closes.

## 9. Actors and permissions

| Action | Who | Permission |
|---|---|---|
| Create/edit driver profiles, verify documents, activate/suspend | Super Admin / Admin; Warehouse Admin limited to own-warehouse riders | `driver.manage` |
| Assign work (batches, trips) | Super Admin / Admin; Warehouse Admin (own warehouse) | `driver.assign`, `delivery.assign`, `transfer.*` |
| Manage vehicles | Super Admin / Admin | `vehicle.manage` |
| Assign vehicle to trip | Super Admin / Admin; Warehouse Admin (own transfers) | `vehicle.assign` |
| Manage own GPS session | Assigned rider / line-haul driver | `tracking.manage_own` |
| View live operations | Super Admin / Admin; Warehouse Admin (scoped) | `operations.live_view` |
| Update own trip progress, report incident | Assigned driver / rider | `trip.update_progress`, `trip.report_incident`, `incident.report` |
| View own record, performance, COD position | Rider / line-haul driver | `driver.read_self`, `report.read_self`, `cod.read` (own) |

Drivers see **only** their assigned work and the minimum
sender/recipient information needed to execute it. Driver personal
documents are never visible to vendors, customers, or other drivers.

## 10. Rules, invariants, failure handling

1. One active trip per driver and per vehicle; one ACTIVE tracking
   session per driver.
2. Custody is continuous across every reassignment — handovers,
   never edits.
3. Expired licence / insurance / registration blocks assignment
   automatically; warnings start before expiry.
4. Trip and run history is permanent, including cancelled and
   incident trips.
5. GPS never proves delivery and never changes custody — scans and
   custody records remain the proof of handover.

| Failure | Behaviour |
|---|---|
| Assignment of suspended / on-trip / expired-licence driver attempted | Refused with the specific reason; attempt audit-logged |
| Vehicle double-assignment attempted | Refused; names the open trip holding the vehicle |
| Line-haul driver tries to mark destination receipt | Action does not exist for the driver; arrival + handover only (receiving is destination staff work) |
| Trip arrival recorded but destination never scans | Trip sits in `ARRIVED` / `UNLOADING`; packages remain in driver custody on every dashboard; destination Warehouse Admin is reminded |
| Driver loses connectivity / app backgrounded | GPS updates stop (foreground-only, §6) and freshness degrades visibly; manual checkpoints remain the reliable progress mechanism — no server confirmation is ever fabricated on-device |
| Incident reported on a completed trip | Rejected — incidents attach to open trips/transfers; historical issues go through exception management as standalone incidents linked to the trip |
