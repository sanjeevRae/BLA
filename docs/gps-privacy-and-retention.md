# GPS Privacy and Retention Policy

**Phase:** V2 Phase 3 · **Applies to:** TrackingSession,
DriverLocationPing, DriverCurrentLocation (see
`docs/live-gps-tracking.md` for the technical design).

This document is the company's working policy for driver/rider
location data. It describes what the system actually does today;
where the law requires more than the system currently enforces,
that is called out explicitly.

---

## 1. What is collected, and when

Location is collected **only during an active work assignment**:

- A tracking session can start only when the driver/rider has an
  eligible active assignment (a line-haul trip in progress, or an
  open/in-progress pickup/delivery batch) and only when the driver
  personally starts it after an explicit on-screen acknowledgement
  (`permissionAcknowledgedAt` is recorded on every session).
- Tracking never starts at app open, never before an assignment
  exists, and never continues after work: the session ends when
  the driver stops it, when a supervisor stops it, automatically
  when the assignment completes or is cancelled, or by the
  abandonment sweep when reporting has clearly stopped.
- Each stored fix is a single point: latitude, longitude, accuracy
  (metres), optional speed/heading, the device timestamp and the
  server receive timestamp. Nothing else is collected — no
  contacts, no messages, no data from other apps, no location
  outside a session.

## 2. Why it is collected

Operational visibility only: dispatchers and warehouse managers
can see where an active trip or delivery run currently is, how
fresh that information is, and which packages are associated with
the movement. Location data is **not** proof of delivery, does not
change package custody, and must not be used as the sole basis for
disciplinary conclusions — browser GPS has metre-level error,
gaps when the app is not in the foreground, and device-clock
uncertainty, all of which the system records rather than hides
(accuracy and freshness travel with every position).

## 3. Who can see what

| Audience | Access |
|---|---|
| Super Admin / Admin | All active movements, positions, freshness, associated packages (tracking IDs + statuses). |
| Warehouse Admin | Only movements whose origin or destination is their own warehouse, and their own riders' batches. |
| Warehouse Staff | No live map. Only the movement information their duties already give them through trips/batches. |
| Drivers / Riders | Their own tracking state and their own assignment only. A driver can never read another driver's location through any endpoint. |
| Vendors | Nothing. No internal map, no driver positions. |
| Customers / public tracking | Delivery milestones only. **Never** driver coordinates, exact or approximate. |
| Finance / Support | No location access (neither role holds `operations.live_view`). COD totals appear on the live view only for actors who already hold a finance/COD read permission. |

Enforcement is server-side on every request (permission +
warehouse scope composed into the queries); the endpoints return
no raw ping history to anyone — the live view reads the current
snapshot only. Supervisor session stops are always audit-logged,
as are denied access attempts and any attempt to submit a location
under a foreign driver identity.

## 4. Retention

- **Detailed pings (`DriverLocationPing`): 30 days** by default
  (configurable, `retentionDays` in the `tracking.config`
  SystemSetting). `pruneExpiredLocationPings()` deletes ping rows
  whose server receive time is older than the window. Phase 8
  wires the prune to a schedule; until then it is run
  operationally. The prune never touches sessions, snapshots,
  custody records, tracking events, or financial records.
- **Sessions (`TrackingSession`)**: kept as operational records
  (who was tracked, for which assignment, when, and why the
  session ended) under the same retention discipline as trips and
  batches.
- **Snapshots (`DriverCurrentLocation`)**: one row per driver,
  continuously overwritten; holds only the latest fix.
- Custody, delivery, transfer, and financial history follow the
  company's existing record retention and are **not** shortened by
  this policy.

## 5. Employee-facing commitments

- No tracking outside active assignments; no tracking of personal
  devices outside the work session the driver started.
- The driver always knows tracking is on: the Phase 4 interface
  shows the tracking state, the last successful update, and the
  GPS accuracy, with Start / Pause / Resume / End controls in the
  driver's hands. A supervisor can end a session (audited) but
  cannot start one for a driver or restart one silently.
- Location data is never sold, never shared with third parties,
  and never sent to external AI or analytics services.

## 6. Legal review (pre-production)

Nepal's **Privacy Act 2075 (2018)** governs personal data
collection by bodies in Nepal, including employee data. Before
this feature is enabled in production, the company must complete
a legal/operational review covering at least: the lawful basis and
notice given to drivers (the in-app acknowledgement text), the
30-day detailed-ping retention against operational and incident
needs, access logging expectations, and the process for a driver
to see or challenge their own location records. **This item is
open and is a production gate** — it is recorded here and in
`docs/known-limitations.md` so it cannot be silently forgotten.
