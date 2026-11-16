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
| `GET /api/live-operations` | `operations.live_view` | Snapshot-based list of active movements + sessions ended inside the recent window (30 min default). Optional `warehouseId` query filter is a *requested* scope, intersected with authority — it can narrow, never widen. |
| `GET /api/live-operations/[trackingSessionId]` | `operations.live_view` | One movement's detail including the authorized package list — tracking IDs and statuses only, no recipient names, phones, or addresses. |

Service-only (Phase 4 will add routes): `pauseTrackingSession` /
`resumeTrackingSession` — owner-driver only; pings are refused
while PAUSED.

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

Spec reporting cadence (Phase 4 client behaviour): riders ~2–3
min moving, line-haul ~3–5 min, ~10 min stationary, plus immediate
event pings — the 30 s server floor sits safely below all of them.

## 8. Cost

Zero paid services: browser Geolocation + the existing Postgres +
polling. OpenStreetMap tiles are a Phase 5 (map UI) concern and
follow the OSM tile policy; the backend adds no external calls.
