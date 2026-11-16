# Live GPS Tracking — Architecture and Operations

**Phase:** V2 Phase 3 (backend) · **Status:** implemented, local
migrations only (`20261116084000_phase3_gps_tracking`,
`20261116084028_phase3_gps_hardening`) · **Consumers:** Phase 4
(driver/rider tracking UI) and Phase 5 (Live Operations map).

Minimal, honest, free-first location tracking: the system records
the periodic position of a driver/rider's device **only while that
driver has an active assignment and has explicitly started a
tracking session**, associates the position with the active
trip/batch, and shows it to Admin / Super Admin / authorized
Warehouse Admins. GPS never proves delivery and never changes
custody — scans and custody records remain the proof of handover.

---

## 1. The browser limitation (read this first)

Location comes from the **Browser Geolocation API**
(`watchPosition`) in the signed-in web app. This has a hard limit
that no code in this project can remove:

- Geolocation requires HTTPS and an explicit user permission grant.
- Browser GPS is reliable **only while the tracking app is in the
  foreground**. When the screen locks, the browser is closed, the
  tab is suspended, or the OS kills background activity, updates
  stop. There is no guarantee of background tracking, and the UI
  must never claim there is.
- When updates stop, the position goes visibly stale (freshness
  states below) — a stale marker is never presented as live.
- A future native app can post to the same endpoints
  (`POST /api/tracking/location`) without backend changes; the API
  contract is device-agnostic.

Phase 4 surfaces these limits in the driver UI with a visible
warning when updates stop.

## 2. Data model

Three tables in the `app` schema (vocabulary mirrored by CHECK
constraints and `src/lib/tracking/domain.ts`):

- **TrackingSession** — one tracking engagement: `driverId`,
  exactly one of `tripId` (LINEHAUL) / `deliveryBatchId` (PICKUP /
  DELIVERY), `originWarehouseId`, `destinationWarehouseId`
  (line-haul only), `status` (ACTIVE / PAUSED / ENDED),
  `startedAt` / `endedAt`, `startReason` (DRIVER), `endReason`
  (DRIVER / SUPERVISOR / ASSIGNMENT_COMPLETED /
  ASSIGNMENT_CANCELLED / EXPIRED), `permissionAcknowledgedAt`.
  A partial unique index guarantees **at most one ACTIVE session
  per driver**.
- **DriverLocationPing** — one accepted device fix: session +
  driver, `latitude` / `longitude` / `accuracyMeters`,
  optional `speedMetersPerSecond` / `headingDegrees`,
  `recordedAt` (device clock), `receivedAt` (server clock),
  `sequenceId`, `source` (BROWSER). `UNIQUE (trackingSessionId,
  sequenceId)` makes replays idempotent. Coordinates are `Float`
  (machine data, JSON-native; the Decimal coordinates on TripStop
  are for manual checkpoints and are a different thing).
- **DriverCurrentLocation** — one snapshot row per driver (unique
  `driverId`): the latest accepted fix, its recorded/received
  timestamps, `freshnessState`, and the active trip/batch. **The
  live map reads only this table — it never scans ping history.**

Indexes: `TrackingSession(driverId, status)` + the partial unique
index; `DriverLocationPing(trackingSessionId, recordedAt DESC)`,
`(driverId, receivedAt)`; snapshot unique on `driverId`.

## 3. Endpoints

All endpoints resolve the actor from the authenticated session
(Auth.js database session → `getActorContext`) and run the standard
access gate. The driver identity used by every write comes **only**
from that session — a `driverId` in a request body is ignored (and
audit-logged when it disagrees with the actor).

| Endpoint | Actor | Behaviour |
|---|---|---|
| `POST /api/tracking/session/start` | driver (`tracking.manage_own`) | Body names `tripId` **or** `deliveryBatchId` plus `permissionAcknowledged: true`. Server verifies the assignment belongs to this driver and is in an active state, derives origin/destination from the assignment (never from the client), refuses a second concurrent session. |
| `POST /api/tracking/location` | driver (`tracking.manage_own`) | Body: `trackingSessionId`, coordinates, `accuracyMeters`, optional speed/heading, `recordedAt`, `sequenceId`. See §4 for the ingest transaction. |
| `POST /api/tracking/session/stop` | owning driver, or supervisor (`operations.live_view`, scoped) | Driver stop ends with `endReason: DRIVER`. Supervisor stop (Super Admin / Admin globally; Warehouse Admin only for sessions touching their warehouse) ends with `SUPERVISOR` and is always audit-logged (`tracking.session_stopped_supervisor`). |
| `POST /api/tracking/session/pause` | owning driver (`tracking.manage_own`) | ACTIVE → PAUSED. Pings are refused while PAUSED. Owner only — there is no supervisor pause. |
| `POST /api/tracking/session/resume` | owning driver (`tracking.manage_own`) | PAUSED → ACTIVE. Inside the row-lock transaction the assignment's trackable status is re-validated (Phase 4 review F1): a session whose trip/batch went terminal while paused cannot be resurrected. |
| `GET /api/tracking/session/current` | driver (`tracking.manage_own`) | The actor's **own** tracking state for the driver panel: latest session (any status), its assignment summary, eligible assignments (labels + package counts only — no recipient PII), the last accepted fix from the snapshot (timestamps/accuracy/freshness — **not** coordinates), and the client cadence config (§7). Every query is keyed by the actor's own driver id; actors without a driver profile get an empty state. |
| `GET /api/live-operations` | `operations.live_view` | Snapshot-based list of active movements + sessions ended inside the recent window (30 min default). Optional `warehouseId` query filter is a *requested* scope, intersected with authority — it can narrow, never widen. |
| `GET /api/live-operations/[trackingSessionId]` | `operations.live_view` | One movement's detail including the authorized package list — tracking IDs and statuses only, no recipient names, phones, or addresses. |

### Live-operations scope

- SUPER_ADMIN / ADMIN (unscoped): every movement; the optional
  warehouse filter applies on origin or destination.
- WAREHOUSE_ADMIN: only sessions whose origin **or** destination
  warehouse is one of their memberships — this covers trips
  departing/arriving their warehouse and their own riders' batches
  (a batch session's origin is the batch's warehouse).
- Every other role (including WAREHOUSE_STAFF, VENDOR, CUSTOMER):
  denied, and the denial is audit-logged.
- COD: a batch item carries `codCollectedPaisa` **only** when the
  actor holds `finance.read` or `cod.read`; otherwise the field is
  absent from the response entirely.

## 4. The ping ingest transaction

`POST /api/tracking/location` runs one database transaction
(Appendix C binding design):

1. **Lock the TrackingSession row** (`SELECT … FOR UPDATE`) — the
   same lock taken by stop, pause/resume, auto-end, and expiry, so
   a ping can never land after a session ends.
2. Re-verify under the lock: session exists, belongs to the actor,
   status is ACTIVE, and the assignment is still in an active
   state.
3. Validate the fix: coordinate ranges, accuracy present and
   plausible (config `maxAccuracyMeters`, default 10 000 m),
   `recordedAt` not more than ~5 minutes in the future and not
   before the session start (60 s clock-skew tolerance).
4. **Idempotency**: a repeated `(session, sequenceId)` returns the
   stored ping with no writes. Identical coordinates to the last
   accepted ping are deduplicated the same way (stationary
   devices).
5. **Rate limit**: a new position inside the configured minimum
   interval (default 30 s, server receive clock) is refused with
   HTTP 429 (`RATE_LIMITED`).
6. Insert the ping; **conditionally** upsert the snapshot — only
   when the incoming fix is newer than the snapshot's
   (`recordedAt`, tie-broken by `sequenceId`). An out-of-order or
   replayed older fix is stored as history but **never moves the
   marker backwards**.

## 5. Freshness

Computed at read time from the snapshot's `lastReceivedAt` against
server now (defaults in parentheses):

- **FRESH** — last report ≤ 5 min ago (300 s)
- **DELAYED** — 5–15 min (900 s)
- **STALE** — more than 15 min
- **OFFLINE** — session PAUSED/ENDED, or no report yet

Accuracy is stored and returned with every position (metres); the
map (Phase 5) renders it as an accuracy radius. No position is ever
interpolated, smoothed, or projected — the marker is the last
reported fix, and its age is always visible.

## 6. Session lifecycle

- **Start**: only by the assigned driver, only on an eligible
  active assignment (trip in ASSIGNED…INCIDENT, batch OPEN /
  IN_PROGRESS), only with the explicit permission acknowledgement.
- **Auto-end**: when a Trip completes (transfer receiving finish)
  or is cancelled, and when a DeliveryBatch closes or is
  cancelled, the bound session ends inside the same transaction
  (`ASSIGNMENT_COMPLETED` / `ASSIGNMENT_CANCELLED`).
- **Expiry**: `expireAbandonedTrackingSessions()` ends ACTIVE /
  PAUSED sessions whose assignment is terminal or whose last
  activity is older than the abandonment window (default 120 min),
  with `endReason: EXPIRED` and a system audit row. Phase 8 wires
  this to a schedule; until then it is invoked operationally.
- **Stop race**: because stop and ping take the same row lock,
  whichever commits first wins — a ping that arrives after the stop
  commits fails the ACTIVE check; there is no validate-then-close
  window.

## 7. Configuration

One typed module (`src/lib/tracking/config.ts`); every value can
be overridden by a `SystemSetting` row with key `tracking.config`
(JSON object merged over defaults; invalid values are ignored).

| Key | Default | Meaning |
|---|---|---|
| `minPingIntervalSeconds` | 30 | server-side floor between accepted pings per session |
| `freshWithinSeconds` | 300 | FRESH bound |
| `delayedWithinSeconds` | 900 | DELAYED bound |
| `retentionDays` | 30 | detailed ping retention (see gps-privacy-and-retention.md) |
| `recentWindowMinutes` | 30 | how long ENDED sessions stay on the live list |
| `abandonedSessionMinutes` | 120 | no-activity window for session expiry |
| `maxAccuracyMeters` | 10000 | fixes with worse claimed accuracy are rejected |
| `futureTimestampToleranceSeconds` | 300 | device clock lead tolerated |
| `preStartToleranceSeconds` | 60 | device clock lag tolerated before session start |
| `riderMovingIntervalSeconds` | 150 | client cadence: pickup/delivery moving interval (Phase 4) |
| `linehaulMovingIntervalSeconds` | 240 | client cadence: line-haul moving interval (Phase 4) |
| `stationaryHeartbeatSeconds` | 600 | client cadence: stationary liveness interval (Phase 4) |
| `movementThresholdMeters` | 25 | client cadence: minimum movement that counts as "moved" (Phase 4) |

The four client-cadence values are projected to the driver panel
via `GET /api/tracking/session/current` (`toTrackingClientConfig`)
— the server config is the single source of truth and the client
never hardcodes a second copy. Each is range-checked like the
rest (moving 30–3600 s, heartbeat 60–3600 s, threshold 5–1000 m);
out-of-range overrides fall back to defaults. The 30 s server
floor sits safely below every cadence, and the client enforces
the floor itself for every non-event send (§8).

## 8. The driver interface (Phase 4)

One shared component — `src/components/tracking/LocationTrackingPanel.tsx`
— mounted at the top of **both** driver dashboards (rider and
line-haul/transport-driver layouts, above the page content so it
is visible without digging and survives in-dashboard navigation).
Labels are role-aware (batch/run vs trip). All controls are
≥ 48 px touch targets. The panel polls `GET
/api/tracking/session/current` every 30 s while a session is
ACTIVE/PAUSED and on visibility return, so a supervisor stop or
an assignment auto-end is reflected without a reload.

### Panel state model

- **No eligible assignment** — explains tracking starts when a
  trip/batch begins; no controls are offered and nothing is
  collected.
- **Eligible, not started** — assignment summary plus the consent
  explanation *before any browser prompt* (location is shared
  only while the assignment runs, visible to admins and the
  assignment's warehouse admins, stops automatically when the
  assignment completes — per `gps-privacy-and-retention.md`).
- **Permission flow** — Start first requests a browser fix via
  `getCurrentPosition`; **only on grant** does the panel call
  `session/start` with `permissionAcknowledged: true`, and the
  granted fix becomes the session's first ping. On denial the
  session is **not** started and the panel shows how to
  re-enable permission in the browser. Geolocation unsupported
  or a non-secure context shows GPS unavailable and disables
  Start.
- **ACTIVE** — "Tracking on", assignment, last successful update
  (live relative time), last fix accuracy (± m), network state
  (online/offline), an unsent-position warning when a send is
  outstanding, and Pause / End controls. The panel states
  plainly that updates pause while the app is in the background
  — there is no background tracking.
- **PAUSED** — clear paused state ("no location is sent while
  paused") with Resume / End.
- **Signal problems** — a `watchPosition` error flips the panel
  to a red "Location problem" state *immediately*; it never
  keeps showing "Tracking on" through a signal failure. The
  watch itself is not torn down (POSITION_UNAVAILABLE / TIMEOUT
  are routinely transient; the next good fix recovers the panel),
  and a watchdog flags "no update for X" when fixes or sends
  stall beyond ~2× the send interval (amber banner, GPS vs
  network copy distinguished).
- **ENDED** — shows "Tracking ended" plus the reason (you ended
  it / a supervisor ended it / the assignment completed / was
  cancelled / the session expired). The notice takes precedence
  over the eligible list — including when the driver stopped
  mid-assignment and could start again — until dismissed;
  dismissal is remembered per session in `sessionStorage` so a
  reload does not nag.

### The sending engine

`src/lib/tracking/client-engine.ts` — framework-thin,
dependency-injected, unit-tested. The panel owns DOM listeners;
the engine owns the watch lifecycle and every send decision.

- **Watch lifecycle** — `watchPosition` runs only while the
  session is ACTIVE and the page is visible. Hidden → watch
  stopped; visible again → watch restarted and the latest known
  position offered as a catch-up update.
- **Cadence decision** (`decidePingSend`, pure) — an event send
  always goes out; the first fix always goes out; **nothing else
  goes out inside the server minimum interval** (the floor beats
  every other rule, including the heartbeat — Phase 4 review
  F2); identical coordinates are never sent twice unless the
  stationary heartbeat has elapsed; otherwise a fix goes out
  when the device moved beyond the distance threshold AND the
  moving interval elapsed, or the heartbeat elapsed. Intervals
  come from the server-exposed config (§7): rider/delivery
  150 s, line-haul 240 s, heartbeat 600 s, threshold 25 m.
- **Decision tick** — platforms deliver fixes sparsely (a
  stationary phone may produce none for minutes), so while
  watching, a 15 s tick re-evaluates the latest fix against the
  cadence rules: a held send matures on schedule without waiting
  for the next fix. The tick never touches fix-arrival
  timestamps, so the watchdog's freshness stays honest.
- **Identical-coordinate interaction** — the client offers the
  stationary heartbeat, but the server deduplicates a
  bit-identical fix against the snapshot without refreshing
  freshness (§4.4). On real devices GPS jitter normally makes
  the heartbeat a genuinely new fix; a perfectly stationary
  device may therefore read DELAYED/STALE on the admin side
  despite heartbeats being offered. That is the honest outcome
  — freshness is never faked.
- **Failure handling** — a failed send keeps **only the latest**
  pending position (latest-wins, no growing queue) and retries
  on the next fix, on the decision tick, on `online`, and on
  visibility return; the panel shows the unsent state. A
  409/404/403 outcome drops the pending fix and makes the panel
  resync from `session/current` (the session ended or paused
  server-side).
- **Sequence** — `sequenceId` is strictly increasing per
  session, persisted in `sessionStorage`
  (`bla.tracking.seq.<sessionId>`) so it survives panel
  remounts; re-sending the same fix reuses its sequence so the
  server can deduplicate the replay. The counter is removed
  when the session ends (Phase 4 review O1).
- **Event updates** — `sendImmediate()` (fresh fix preferred)
  is exposed through a module registry
  (`src/lib/tracking/client-registry.ts`) and called **only on
  success** from the existing driver flows: trip departure and
  arrival (`src/components/transfers/forms.tsx`), pickup
  confirmation, delivery attempt recorded, and delivery
  completed (`src/components/deliveries/forms.tsx`). It is a
  no-op when no session is live and can never throw into a
  success path.

Verified end-to-end on the production build (headless Chrome,
CDP geolocation override + permission grant): eligible batch →
consent → grant → ACTIVE → first ping + snapshot FRESH → a
Warehouse Admin's `live-operations` shows the movement → moved
fix sent at the (test-shortened) cadence → pause (no pings
land) → resume (pings flow) → stop → panel ended, session
ENDED/DRIVER. Real-device behaviour (background/screen-lock,
iOS Safari, Android Chrome) is a Phase 8 verification item.

## 9. Cost

Zero paid services: browser Geolocation + the existing Postgres +
polling. OpenStreetMap tiles are a Phase 5 (map UI) concern and
follow the OSM tile policy; the backend adds no external calls.

## 10. The Live Operations map (Phase 5)

Pages: `/admin/live-operations`, `/super-admin/live-operations`,
`/warehouse/live-operations` — thin wrappers over one shared board
(`src/components/live-operations/`), registered in the Phase 1
navigation registry under Operations and gated on
`operations.live_view`. Warehouse Staff, riders, drivers, vendors
and customers have no page and no nav item; the API denies them
regardless (§3). The map itself is a client-only island
(`LiveMap.tsx`, loaded with `next/dynamic`, `ssr: false` — Leaflet
needs the DOM) inside the client board.

**Data behaviour.** The board polls `GET /api/live-operations`
every 50 s (inside the spec's 45–60 s band) **only while the
document is visible** — the Page Visibility API pauses polling in
a hidden tab and returning to the tab refetches immediately. A
manual Refresh button does the same on demand. The header shows
when the board last refreshed, the server's latest received
location time across the returned movements (`latestReceivedAt`),
and the board's server generation time (`generatedAt`). Poll
results replace list/marker state in place: the page never
reloads and the Leaflet instance is never remounted (one
`MapContainer` with constant props; markers are keyed children;
the view only re-fits when the *set* of located movements
changes, so polling never yanks a user's pan). A failed fetch
keeps the last good data on screen, flags it as possibly stale,
and offers Retry.

**Search is server-side.** The search box and the warehouse
selector are query parameters of the list endpoint, composed
inside the service with the actor's scope — search narrows, it
never widens (Phase 5 integration tests prove a Warehouse Admin
searching a foreign warehouse's package tracking ID gets an
empty board). Search matches driver name, trip number, transfer
number, batch id prefix, and package tracking IDs (a tracking-ID
search resolves to the movement carrying that package). The
filter chips (All / Warehouse transfers / Pickups / Deliveries /
Active / Delayed / Stale) filter the fetched list client-side;
Active = FRESH or DELAYED, Stale = STALE or OFFLINE.

**The map.** OpenStreetMap standard tiles; the tile URL and
attribution live in exactly one place (`src/lib/maps/config.ts`)
so the provider can be swapped without touching components.
Markers are `divIcon` pins (no Leaflet default icon assets):
shape/letter by movement type (line-haul / pickup / delivery),
colour and opacity by freshness — a stale or offline pin is
visually muted and never looks live. A movement with no accepted
fix yet has **no marker**; its list row says "Waiting for first
location". The selected movement additionally shows its origin
and destination warehouse markers (only where the warehouse's
primary address carries coordinates — none are invented) and an
accuracy circle of the fix's `accuracyMeters`. Controls: zoom,
Fit active drivers, My warehouse (when a warehouse filter is
set), Show all authorized. There are **no road routes and no
ETAs**. The single line ever drawn is a dashed, muted
straight-line connector from the selected driver's position to
the destination warehouse, labelled in the detail panel
"Straight-line connection — not a road route".

**Side list + detail.** Each row: driver, movement type, trip /
batch reference, origin → destination, package count, current
activity, last update in relative time, and a freshness badge
(Fresh green, Delayed amber, Stale red, Offline gray) — freshness
is always paired with its last-update time (§5). Selecting a row
or a marker selects the movement in both and opens the detail
panel (`GET /api/live-operations/[id]`): driver, vehicle
(line-haul), trip/batch, route, package count, delivered /
remaining for batches, COD collected **only when the payload
carries it** (the server includes `codCollectedPaisa` only for
`finance.read` / `cod.read` actors — the panel renders nothing
about COD otherwise), last GPS update with accuracy in metres,
freshness, and the authorized package list (tracking IDs +
statuses only, linking to the public milestone page). Action
links appear only where the route exists in that dashboard and
the actor holds the permission: View trip / View manifest /
View batch exist only in the warehouse dashboard (the admin
trees have no transfers/deliveries routes). No "View driver"
action exists — there is no driver-detail route in any
dashboard, and a list page is not a driver view.

**OpenStreetMap tile-policy obligations** (this deployment is a
low-volume pilot on the public tile service):
- Tiles load from the standard HTTPS endpoint with the
  attribution "© OpenStreetMap contributors" visible on the map
  at all times.
- No bulk downloading, prefetching, or offline caching of tiles;
  the browser's normal HTTP cache honours OSM's caching headers.
- The tile provider is one config constant: if usage grows
  beyond a low-volume pilot, production must move to self-hosted
  tiles or a contracted provider — that evaluation is a Phase 8
  deployment item, not a silent scale-up of the public service.

**Cost.** Still zero paid services: Leaflet + react-leaflet
(MIT/BSD open source), OSM public tiles under the policy above,
browser Geolocation, and the existing Postgres behind a polling
endpoint.
