# BLA — Security Review Record

Running record of security-review findings and their dispositions,
phase by phase. Each phase appends its own section; entries name the
audit defect they close (or deliberately defer), the decision taken,
and the evidence (code + tests) behind it.

---

## V2 Phase 2 — Permission reconciliation (audit H-3, M-1, M-7; orphaned-grant review)

**Date:** 2026-11-16 · **Scope:** the Phase 0 audit's permission
findings (`docs/current-implementation-audit.md` §4) and every
catalog grant that had no consuming UI or service surface. Two
grants changed; the rest were reconciled by decision, recorded
below — an orphaned grant is kept only when a named later phase
owns its surface.

### Grants changed in this phase

| Defect | Change | Evidence |
|---|---|---|
| **H-3** — Customer notifications dead by construction: CUSTOMER lacked `notification.read_own`, so every notification service call would 403 and the bell count silently returned 0 | CUSTOMER is granted `notification.read_own` in `src/lib/permissions/catalog.ts`. The customer notifications nav item (gated on that permission in `src/lib/navigation/registry.ts`) now renders | `tests/integration/phase2-permissions.test.ts` (customer reads/lists/marks own notifications end to end; a second customer is denied, audited); `tests/unit/navigation.test.ts` (customer nav now includes `/customer/notifications`) |
| **M-1** — Finance approval bottleneck: `finance.approve_adjustment` was held only by SUPER_ADMIN, so Finance could prepare/create everything but approve nothing, and the Finance adjustments page permanently hid its decision buttons | FINANCE is granted `finance.approve_adjustment` in the catalog. No UI change was needed: `AdjustmentsPage` (`src/components/finance/pages.tsx`) already derives `canDecideAdjustments` from `hasPermission(actor, "finance.approve_adjustment")`, so the decision buttons light up from the grant alone. Four-eyes is unchanged and service-enforced: `approveAdjustment` and `approveRefund` both reject the creator/requester, so a second FINANCE user must decide. Refunds already flowed through `refund.process`, which FINANCE held | `tests/integration/phase2-permissions.test.ts` (finance-created adjustment: self-approve throws the four-eyes error, second finance user applies it with a balanced `ADJ-…` journal; refund: request → self-approve refused → second finance user approves → processed, payment `PARTIALLY_REFUNDED`; WAREHOUSE_STAFF approval attempt still denied) |
| **M-7** — Dead staff create routes: `/staff/transfers/new` and `/staff/deliveries/new` rendered create flows WAREHOUSE_STAFF is not permitted to use (no `transfer.create`, no `delivery.assign`) | Both route directories deleted. The navigation registry never linked the staff variants and the shared components already hide the create links from staff; the warehouse variants (`/warehouse/transfers/new`, `/warehouse/deliveries/new`) remain | `tests/integration/phase2-permissions.test.ts` (route-file existence assertions: staff `new` pages absent, warehouse `new` pages present); `tests/unit/navigation.test.ts` (staff nav still excludes both paths) |

### Orphaned grants — reconciliation decisions (all KEEP)

Each grant below exists in the catalog with no (or only partial)
consuming surface today. None is revoked: each has a named owning
phase, and the service layer already enforces the permission
wherever a surface does exist, so keeping the grant is not an
exposure — removing and re-adding it later would only churn the
catalog and its tests.

| Grant(s) | Holder | Decision | Rationale / consuming surface |
|---|---|---|---|
| `driver.manage`, `driver.assign`, `vehicle.assign` | WAREHOUSE_ADMIN | **KEEP → Phase 6** warehouse fleet pages (audit M-4) | Drivers/Vehicles pages exist only under Admin/Super Admin today. The grants are not wholly dormant: transfer crew assignment already consumes them inline — `assignTransferCrew` (`src/server/services/transfers.ts`) requires both `driver.assign` and `vehicle.assign` — so a Warehouse Admin can crew a transfer today and gains the standalone fleet pages in Phase 6 |
| `booking.create` | WAREHOUSE_ADMIN | **KEEP → Phase 6** warehouse `bookings/new` page (audit M-5) | `/warehouse/bookings` is list + detail only; the create route exists under Admin/Super Admin/Vendor. The booking service already enforces `booking.create`, so the Phase 6 page is a pure UI addition |
| `invoice.read`, `payment.dispute.raise`, `incident.report` | CUSTOMER | **KEEP → Phase 6** customer self-service pages (audit M-3) | No customer billing, dispute, or incident-report page exists yet (`/customer` is packages + tickets + notifications). The grants describe the intended self-service surface; the Phase 6 pages will consume them |
| `profile.update_own` | CUSTOMER | **KEEP — consumed today; profile PAGE → Phase 6** | Consumed today by `/api/me` (`src/app/api/me/route.ts`), whose handler requires `profile.update_own`. Record corrected during this review: the route currently exports a GET handler only — there is no PATCH handler — so the live consumption is the identity read gate, not a profile write. The customer-facing profile page lands in Phase 6 (with audit M-3) |
| `task.create`, `task.assign`, `task.update_own`, `task.verify` | FINANCE, SUPPORT | **KEEP → Phase 6** task UI for those roles (audit M-2) | The task service is complete and already enforces these permissions via the API; six roles have board/detail UI, Finance and Support do not. Phase 6 adds their task pages rather than stripping grants the workflow needs |

### Deliberately NOT granted in this phase

- **`settlement.approve` for FINANCE — open policy item.** M-1's
  scope was adjustments and refunds, and both now run four-eyes
  inside Finance. Settlement approval stays with ADMIN /
  SUPER_ADMIN. Whether Finance should also approve settlements
  (with four-eyes against the preparer) is a policy decision for
  Meena, not a defect fix; it stays open until he decides.

### Deferred by decision — four-eyes approval for privileged-role invitations (Appendix C candidate)

- **Deferred to Phase 6** (Phase 8 backstop). The independent
  reviews suggested a second approver before a SUPER_ADMIN / ADMIN
  invitation becomes usable. Implementing it cleanly needs a new
  `PENDING_APPROVAL` invitation state, approver fields, and — most
  importantly — an approval surface: no admin users/invitations UI
  exists yet (audit H-4; the only invitation surface is the
  warehouse MembersPanel). Adding the state without the surface
  would strand privileged invitations unapprovable and break the
  onboarding path already used in production (the first Super
  Admin's invitation was created and accepted through this exact
  flow on 2026-11-16). Phase 6 builds the Super Admin users UI,
  which is the natural home for an approval queue.
- **Mitigations already in force meanwhile:** only a Super Admin
  can invite another Super Admin; only `user.manage` holders
  (Super Admin / Admin) can invite company roles at all, and
  scoped inviters are confined to Warehouse Staff in their own
  warehouse (P2-1); tokens are SHA-256-hashed, single-use
  (atomic claim, P2-5), and expire in 7 days; acceptance refuses
  established accounts (P2-2); SUPER_ADMIN and ADMIN must enrol
  TOTP MFA before dashboard access (Phase 10 gate); every invite
  and acceptance is audit-logged; and Phase 2 adds a per-IP
  failure budget (20 / 10 min) on the redemption endpoint, which
  refuses with the same generic message as an invalid token.

### Confirm-or-scope decision (audit L-1)

- **Vehicles stay globally readable in Phase 2.** Fleet vehicles
  are company-level assets: the `Vehicle` model carries no
  warehouse ownership (only a nullable `homeWarehouseId` hint), so
  there is no ownership scope to enforce. `listVehicles`
  (`src/server/services/vehicles.ts`) therefore remains global for
  actors holding `vehicle.manage`, `vehicle.assign`, or
  `transfer.create`. Recorded as confirmed for Phase 2 and noted
  for re-review in Phase 8, alongside the other isolation audits.

### Independent security review (Phase 2)

An independent reviewer (no part in building Phase 2) attacked the
Phase 2 diff with live proof-of-concept tests against the test
database (`tests/integration/phase2-security-review.test.ts`, kept
as a regression suite). Verdict: **no High or Medium findings.**
Held under live attack: the journal-balance trigger (including
concurrent split-transaction composition attempts and leg UPDATEs),
four-eyes under the new FINANCE grant (including concurrent
approvals — exactly one applies, the journal posts exactly once),
customer notification isolation (including the userId-NULL
DELIVERY_OTP tracking rows — never listed, never markable),
the L-2 movement-touch scope fix (including no regression for
unscoped SUPPORT readers), staff-route removal (direct service
calls denied), fingerprint canonicalisation, and invitation race
accounting (exactly one success + one failure row for simultaneous
accepts).

Four Low findings, all dispositioned in-phase:

- **F-1 (fixed)** — a client-supplied `paidAt` was excluded from
  the payment fingerprint although it is stored and becomes the
  journal's `occurredAt`: two payments differing only in date
  collapsed under one idempotency key. `paidAt` is now part of the
  fingerprint whenever the client supplies it; faithful retries
  (which reproduce the omission or the value) still replay.
- **F-2 (fixed)** — pre-fingerprint payments (`requestFingerprint`
  NULL) accepted any replay payload. The expected fingerprint is
  now derived from the stored row (amount, method, transactionRef
  and allocations are all persisted) and compared; `paidAt` is
  excluded on both sides for legacy rows only, because a legacy
  row cannot distinguish a client-supplied value from the server
  default.
- **F-3 (accepted, gated)** — the invitation limiter's per-IP
  budget can be burned for a victim IP only where clients can set
  `x-forwarded-for` themselves. The documented deployment
  (Vercel, or a proxy that overwrites the header per
  `docs/deployment-guide.md` §3) is not exposed; that proxy
  requirement is a hard go-live gate for any self-hosted topology.
  A per-(token, IP) composite budget is the recorded future
  hardening if a non-overwriting topology is ever adopted.
- **F-4 (fixed)** — expired invitation tokens returned a distinct
  "has expired" message, an oracle distinguishing token states.
  Expired tokens now refuse with the same generic message as every
  other refusal class; the EXPIRED status flip and attempt
  recording are unchanged.

Two by-design observations were recorded without action: the
creator of an adjustment can self-REJECT it (rejection moves no
money and is the safe direction), and a warehouse actor who
legitimately handled a package sees its full movement history
including legs at other warehouses (continuity for handlers; the
pre-existing scope branch behaves the same way).

## V2 Phase 3 — GPS tracking backend (2026-11-16)

### Permission-catalog changes (grant reconciliation)

Phase 3 adds exactly two permissions; no existing grant was
changed.

| Code | Grants added |
| --- | --- |
| `tracking.manage_own` | RIDER, LINEHAUL_DRIVER |
| `operations.live_view` | SUPER_ADMIN, ADMIN, WAREHOUSE_ADMIN |

No role can post a location for another driver (identity comes
only from the authenticated session) and no role can read another
driver's raw ping history — the live-operations read is
snapshot-only and warehouse-scoped. COD figures appear in
live-operations payloads only when the actor independently holds
`finance.read` or `cod.read`.

### Independent review

A reviewer who built nothing attacked the GPS surface with 46
proof-of-concept tests (`tests/integration/phase3-security-review.test.ts`):
identity substitution (body-smuggled driverId/userId/source,
cross-driver ping/stop/pause/resume), session races (concurrent
starts, ping-vs-stop, double stop, concurrent resumes), replay
(duplicate sequence with a different payload, replay after end,
cross-session snapshot tie-breaks), scope escapes on both GET
endpoints (home-warehouse vs session-warehouse confusion,
`warehouseId` widening attempts, superseded-session snapshot
leakage), COD gating on list AND detail (including a FINANCE actor
with COD permissions but no `live_view`), supervisor-stop scope
and auditing, validation abuse (NaN/Infinity, int32 overflow,
tolerance edges, an assignment forced terminal behind the
session's back), and the expire/prune sweeps under hostile config
overrides.

**Verdict: no High or Medium findings.** Every headline claim held:
actor-only identity, FOR UPDATE row-lock serialisation of
ping/stop, one ACTIVE session per driver (DB partial index),
snapshot never rewinds within a session, warehouse scope that
cannot be widened by request parameters, COD field absence, and
the in-transaction assignment re-check.

Four Low findings, all fixed in the same phase:

- **F-1 (fixed)** — `resumeTrackingSession` leaked a raw Prisma
  P2002 instead of a 409 when the one-active-session partial index
  fired on the UPDATE path (its metadata does not name the index
  the way the INSERT path does). The DB invariant always held; the
  resume transaction now translates any unique violation to
  `ConflictError`, matching the start path.
- **F-2 (fixed)** — the snapshot tie-break compared per-session
  sequenceIds across sessions: a new session's first fix at the
  same `recordedAt` as the ended session's last fix, with a lower
  (restarted) sequenceId, did not move the snapshot, leaving the
  live board dark for an actively reporting driver. A fix from a
  different (current) session now wins on equal `recordedAt`;
  sequence comparison applies only within the same session.
- **F-3 (fixed)** — `sequenceId` beyond the int4 column range
  escaped as a raw database error. The ping schema now bounds
  `sequenceId` to the int32 range, so it is a clean 400.
- **F-4 (fixed)** — the `tracking.identity_mismatch` audit row was
  written before the permission and ownership checks, letting any
  authenticated low-privilege account mint append-only AuditLog
  rows for nonexistent sessions. The audit now happens only after
  both checks pass.

One judgment call was actioned with the findings: the tracking
config resolver had caps but no floors, so a single SystemSetting
write could set a 1-second ping floor or a 24-hour device-clock
tolerance. Floors (and a tighter tolerance cap) are now enforced
per field in `src/lib/tracking/config.ts`; out-of-range overrides
fall back to defaults as before. `retentionDays: 1` remains an
allowed operator choice (prune still never touches sessions,
snapshots or custody history).

One Info observation, no action: a missing session id returns 404
while a foreign one returns 403 on the ping and detail paths — an
existence oracle consistent with the rest of the codebase, over
unguessable UUID ids.

## V2 Phase 4 — Driver GPS interface (2026-11-16)

Scope: the three new routes (`POST /api/tracking/session/pause`,
`POST /api/tracking/session/resume`, `GET
/api/tracking/session/current`), the driver panel's data flow,
the client cadence config, and the delivery/transfer event
wiring.

### Independent review — PASS WITH FINDINGS (no High/Medium)

Verified clean, with adversarial PoCs: ownership discipline on
pause/resume/current (foreign drivers, ADMIN, WAREHOUSE_ADMIN,
permission-stripped driver actors all denied with no state
change); `session/current` scoping (every query keyed by the
actor's driver id; exact key whitelist — no recipient/phone/
address/COD/coordinate fields, not even the actor's own
coordinates in `lastPing`); the permission-grant flow (denial
never calls `session/start`); cadence config bounds (no
SystemSetting value can soften a server gate); event wiring
(success-path only, cannot throw into a completed action); no
GPS data anywhere except the tracking endpoints; no
console/localStorage leaks.

Findings, all fixed in this phase:

- **F1 (Low)** — `resumeTrackingSession` did not re-validate the
  assignment's trackable status: a session paused while its
  batch/trip went terminal via a path that skipped the auto-end
  hook could be resurrected into a zombie ACTIVE session (pings
  were still refused by the ingest gate, but the zombie blocked
  a legitimate start). Fixed: resume re-checks trip/batch status
  inside the row-lock transaction; regression tests in the
  Phase 4 integration suite and the reviewer's PoC suite.
- **F2 (Low)** — `decidePingSend` evaluated the
  identical-coordinate heartbeat before the server-floor check,
  so a legal config (heartbeat below the floor) contradicted the
  documented "nothing inside the minimum interval" invariant
  (server gates were never weakened — the ingest floor held).
  Fixed: the floor check now precedes the heartbeat branch;
  unit regression added.
- **O1 (Informational)** — the sessionStorage sequence key
  embeds the session id and persisted after the session ended.
  The counter must persist while a session is live (sequence
  monotonicity across remounts); the panel now removes it when
  the session reaches ENDED.

The reviewer's 9-test PoC suite is committed as
`tests/integration/phase4-security-review.test.ts` (9/9 after
fixes). Separately, the production run-through produced two
client fixes (decision tick for sparse-fix platforms;
ended-notice precedence) — see `docs/live-gps-tracking.md` §8.

## V2 Phase 5 — Live Operations map (independent review, 2026-11-16)

Scope: the new map pages/board and the server-side search added
to `listLiveOperations`. The builder-independent reviewer ran 27
adversarial PoCs (`tests/integration/phase5-security-review.test.ts`)
against the claims that matter for a location board. Verdict: no
High or Medium findings; claims on scope, composition, PII, COD
gating, registry denial, cookie preselect, and freshness honesty
all hold, with two Low findings fixed in-phase and their PoCs
flipped to regressions (suite 27/27 after fixes):

- **P5-S1 (Low)** — search `%` / `_` acted as unescaped Postgres
  LIKE wildcards (Prisma `contains`/`startsWith` pass them
  through): a match-all *within* the actor's already-authorized
  scope and window — never a scope widening, since search is one
  AND-ed condition beside the scope/window conditions, verified
  by foreign-warehouse probes. Fixed: the service escapes LIKE
  metacharacters so search terms match literally.
- **P5-S3 (Low)** — `warehouseIcon` interpolated the warehouse
  code raw into a Leaflet `divIcon` `html:` string (an innerHTML
  sink). Not reachable today (creation enforces
  `WH-[A-Z]{3}-\d{2}` and codes are immutable), but the DB column
  carries no CHECK, so the sink is now escaped at the source as
  defence in depth. Driver names never reach any `html:` string
  (pin icons interpolate only enum classes + a constant letter).
- **P5-S2 (Informational)** — a premise worth recording:
  WAREHOUSE_ADMIN holds `cod.read` by catalog design, so WA
  actors legitimately receive `codCollectedPaisa`. The gate
  itself was verified with synthetic actors: holding neither
  `finance.read` nor `cod.read` means the key is *absent* (not
  null) from list and detail payloads, including under search.

Also verified: WA detail access to a foreign session is refused
and audit-logged; an ENDED session outside the recent window
stays hidden even when its package ID is searched exactly;
payloads carry no recipient names/phones/addresses in keys or
values (fixture packages carried distinctive PII); the seven
roles without `operations.live_view` get no registry item on any
dashboard and are denied by the service on both read paths.

## V2 Phase 6 — Per-role dashboards, identity surfaces, four-eyes invitations (independent review, 2026-11-16)

Scope: every role home (spec §7), the Super Admin Users & Roles /
Settings / Audit Logs surfaces, the privileged-invitation
four-eyes flow, and the Warehouse Admin fleet + booking-create
surfaces. The builder-independent reviewer ran 32 adversarial
PoCs (`tests/integration/phase6-security-review.test.ts`, kept as
a regression suite) against dashboard metric scoping, privilege
escalation through the identity surfaces, Settings writes, the
four-eyes flow, and vendor/customer isolation. Verdict: **no High
findings; 5 Medium and 4 Low, all fixed in-phase, PoC suite 32/32
after fixes.** Verified holding throughout: Users & Roles
projections leak no secrets (a planted marker secret never
appears), last-active-Super-Admin protection, settings writes
gated/validated/audited, the four-eyes race resolves to exactly
one winner with one audit row, the audit viewer resists all
widening attempts, and warehouse/vendor/customer/rider isolation
on the new homes.

- **F1 (Medium)** — `getWarehouseHomeSummary` had no permission
  gate; `isUnscoped()` resolves to `warehouse.read_all`, held by
  FINANCE/SUPPORT, leaking any warehouse's operational data to
  them. Fixed: operations gate (`inventory.read_all` or
  `inventory.read_warehouse`, audited denial) before any read.
- **F2 (Medium)** — `createBooking`'s dropoff scope check was
  conditioned on a non-empty membership list, so a
  WAREHOUSE_ADMIN-role holder with NO membership (reachable via
  the new role-assignment surface) was treated as unscoped and
  could drop off anywhere. Fixed together with F3.
- **F3 (Medium)** — a RIDER_PICKUP booking's derived origin
  (from the vendor pickup address) had no scope check, letting a
  Warehouse Admin inject bookings into another warehouse via any
  approved vendor. Fixed: one chokepoint in `createBookingOnce`
  after origin resolution on all paths — non-vendor actors
  without `booking.read_all` must hold the origin warehouse in
  membership; denial audited; the pre-existing dropoff check is
  kept.
- **F4 (Medium)** — Phase 6's `listIncidents` customer branch
  (`order.customerId`) was wider than the canonical
  `incidentVisibleTo` rule, exposing staff-filed incidents on the
  sender's own orders that the detail read refuses. Fixed: order
  branch removed; package-recipient + reporter branches only.
- **F5 (Medium, pre-existing)** — `reactivateUser` lacked
  `suspendUser`'s Super Admin guard, so an ADMIN could
  reactivate a suspended SUPER_ADMIN. Fixed: guard mirrored
  exactly.
- **F6 (Low)** — `getAdminHome` had no top-level gate; a
  Warehouse Admin caller received the global active-driver count
  (its own gate is only `driver.assign`, counted globally).
  Fixed: `report.read_all` + `booking.read_all` required up
  front with audited denials (FINANCE passes that gate but is
  still refused overall by the daily report's finance scope
  rule).
- **F7 (Low, pre-existing service gap surfaced by the M-4 UI)**
  — `assignVehicleDriver` had no warehouse scope, so a Warehouse
  Admin could assign drivers to vehicles homed at other
  warehouses. Fixed: for actors without `vehicle.manage`, both
  the vehicle's and the driver's home warehouse must be in the
  actor's memberships; denials audited.
- **F8 (Low)** — `validateTrackingConfigPatch` used
  `key in FIELD_RULES`, accepting Object.prototype keys
  (`toString`, `constructor`) as known fields and storing junk
  in the tracking config row. Fixed: `Object.hasOwn`.
- **F9 (Low)** — the four-eyes approve/reject loader never
  checked `expiresAt`; an invitation that expired while
  PENDING_APPROVAL could still be approved (redemption was
  already refused — the safety-critical half held). Fixed:
  expired rows flip to EXPIRED and the action is refused and
  audited.

Also recorded: the Phase 6 finance/support suite's capped
stalest-first queue assertions were made deterministic over the
shared test DB (the suite cleans up its own fixtures in
`beforeAll` and backdates queue-bound plants) — a test-design
fix, no service behaviour changed. Live run-through on the
production build: all 10 role homes render with real scoped
data, and one privileged invitation completed the full
four-eyes flow end to end (invite → redemption refused before
approval → second-user approval → redemption → new Admin signs
in through MFA enrolment to a working dashboard).

## V2 Phase 7 — Operational workflows completion (independent review, 2026-11-16)

Scope: the new Phase 7 surfaces — driver incident links, vendor
bulk booking, batch/trip reassignments, cross-warehouse returns,
POD evidence binding, the driver-detail profile, and the vendor
pickup leg. The reviewer was builder-independent and wrote live
proof-of-concept tests (`tests/integration/phase7-security-review.test.ts`,
37 PoCs) against every surface, asserting both the refusal and
unchanged state on each denial.

Verdict: **PASS WITH FINDINGS** — 36/37 PoCs passed on first run;
one Low finding, fixed in-phase; the suite now passes 37/37.

- **F1 (Low, defense in depth)** — the PICKUP branch of
  `addBatchPackages` checked for an active PICKUP assignment but
  not for an active DELIVERY assignment (the DELIVERY branch
  checks both). Through current flows the violating state is not
  reachable (a package with an active delivery assignment is
  never in a pickup-eligible status), but a future flow could
  have double-committed a parcel. Fixed: the PICKUP branch now
  refuses when the package carries an open delivery assignment,
  mirroring the DELIVERY branch.

Surfaces verified holding (probe counts in the PoC suite):
driver incident scope (foreign trip/assignment/package links
refused with no rows written; follow-up task assignee validation;
warehouse derived from the incident, never from input); bulk
booking (cross-vendor rows, schema-invalid rows and
in-transaction failures all roll back the whole bulk — zero
partial writes; 51-row and 0-row bulks refused); reassignment
races (reassign ∥ deliver and double-reassign each produce
exactly one winner and exactly one open custody record; the old
rider's tracking session ends with REASSIGNED while other
batches' sessions are untouched; a COD-pending old batch stays
open and reconcilable; trip driver replacement refuses all
pre-departure statuses and races safely against arrival);
returns custody (wrong-destination / non-RECEIVED / same-warehouse
manifesting refused; a mixed add rolls back entirely; inspect and
complete enforce the package's physical warehouse; the
deterioration incident fires exactly once); evidence binding
(same reference on a second package refused with the delivery
fully rolled back; cross-kind reuse refused; trim normalisation
holds; concurrent deliveries racing one reference produce exactly
one binding); driver detail (out-of-scope reads denied and
audit-logged; the `gps` key is absent for actors without
`operations.live_view`); pickup leg (cross-warehouse adds
refused; drop-off parcels refused; only the PICKUP_FAILED
exception auto-clears on re-assignment; collection generates no
OTP material; shortages stay PENDING).

Also in Phase 7: the continuous chain test
(`tests/integration/phase7-chain.test.ts`, 14 tests) executes the
full logistics scenario end to end with custody / inventory /
ledger assertions at every step, and the live run-through of the
same chain on the production build exposed — and this phase
fixed — a reachability defect the service tests could not see:
`listEligiblePackages` (the transfer picker's query) never
offered cross-warehouse return packages, so a return could not
be manifested from the UI. The picker now includes RECEIVED
returns whose return destination matches the transfer
destination; `addTransferItems` remains the authoritative gate
(regression test in `phase7-returns-cross-warehouse.test.ts`).

---

## V2 Phase 8 — open-item disposition: L-1 (vehicle read scope)

**Disposition: ACCEPTED — vehicle reads remain global for fleet
permission holders. No code change.** This closes the Phase 2
confirm-or-scope item with the re-review it asked for.

Why scoping vehicle *reads* by warehouse is not enforceable without
breaking legitimate work:

- The `Vehicle` model carries **no warehouse ownership** — only a
  nullable `homeWarehouseId` hint. There is no ownership relation to
  scope by; the hint is not custody (a vehicle is physically wherever
  its current trip is).
- Vehicles move between warehouses by design. A Warehouse Admin
  receiving an inbound transfer legitimately needs the inbound
  vehicle — homed at the *origin* warehouse — for crew assignment
  and arrival handling. Home-warehouse read scoping would hide
  exactly the vehicles a WA is about to receive.
- A vehicle record is operational fleet data (registration, type,
  capacity, status, home-warehouse hint): no personal data, no
  customer data, no financial data. The exposure from a fleet
  permission holder seeing the whole fleet list is minimal.

Compensating controls (all verified in code at Phase 8):

- Reads are permission-gated: `listVehicles`/`getVehicle` require
  `vehicle.manage`, `vehicle.assign`, or `transfer.create`. Roles
  without a fleet function (Rider, Line-haul, Vendor, Customer,
  Finance, Support, Warehouse Staff) cannot read vehicles at all.
- The one vehicle **write** a scoped actor holds —
  `assignVehicleDriver` (`vehicle.assign`, Warehouse Admin) — is
  membership-scoped since the Phase 6 F7 fix: for actors without
  `vehicle.manage`, both the vehicle's and the driver's home
  warehouse must be in the actor's memberships, with denials
  audit-logged.
- All other vehicle writes (`createVehicle`, `updateVehicle`,
  `setVehicleStatus`, `recordVehicleMaintenance`) require
  `vehicle.manage`, held only by the global roles (Admin, Super
  Admin).
- Transfer crew assignment consumes `driver.assign` +
  `vehicle.assign` inside the transfer's own warehouse scope checks
  (`assignTransferCrew`), so assignment power never exceeds the
  transfer's scope.

Re-open this only if vehicles gain a true ownership/custody model or
vehicle records start carrying sensitive data.

## V2 Phase 8 — open-item disposition: PICKUP batch permission gate

**Disposition: FIXED.** The Phase 7 minor is closed.
`createDeliveryBatch` (`src/server/services/deliveries.ts`) now
resolves the batch kind from the parsed input first, then requires
the kind-appropriate permission via `requirePermAudited`:
`pickup.assign` for PICKUP batches, `delivery.assign` for DELIVERY
batches (MIXED follows the delivery gate, matching the existing
split in `addBatchPackages`). The catalog already carried
`pickup.assign` (held today by exactly the roles that also hold
`delivery.assign`, so no existing flow changes); a future
pickup-only role can now be created without also granting delivery
assignment. Evidence:
`tests/integration/phase8-pickup-batch-permission.test.ts` —
single-permission actors prove pickup-only creates PICKUP but is
refused DELIVERY (and the no-kind default) with no batch row
written, delivery-only the mirror image, and the full
WAREHOUSE_ADMIN role unaffected. Scope was creation only: mutations
of an existing batch keep their existing gates, since the batch's
kind — and therefore the authority under which it was created — is
fixed at creation.

## V2 Phase 8 — malformed-JSON sweep

The Phase 8 API-validation work found that routes parsing bodies
with a bare `await request.json()` throw a raw `SyntaxError` on a
malformed body (500 in production) instead of answering 400 from
schema validation. The three V2 routes (bookings, bookings/bulk,
incidents) were fixed by that work; Phase 8 then swept the remaining
eight files of the same class — operations/handovers,
operations/handovers/[id]/confirm, operations/receive, tasks,
support/tickets and its request-redelivery /
request-address-correction sub-routes, and the public
track/[trackingId]/complaint route — to the repo-standard
`request.json().catch(() => ({}))` form used by the other routes.
No route in `src/app/api` now parses a body without the catch.
Behaviour for valid bodies is unchanged; malformed bodies now reach
service validation and answer 400.

## V2 Phase 8 — FINAL independent security review (2026-11-16)

Scope: the whole V2 surface at HEAD `b44919a` — the GPS stack,
Live Operations, the admin surfaces (Users & Roles / Settings /
Audit Logs), the four-eyes invitation flow, every Phase 7 surface,
the Phase 8 additions, and a V1 High-class IDOR sweep over the new
`[id]` routes. The reviewer built none of V2. Method: live
proof-of-concept attacks as a vitest suite against the local test
database (`tests/integration/phase8-final-review.test.ts`, 31
tests), each asserting the refusal AND unchanged state on denial.
The coordinator's full-suite run at the same HEAD stood at 873/873
before this suite; this suite adds 31 more.

**Verdict: PASS — no findings at any severity.** Every attack was
repelled on first run. The one initial failure was a test-fixture
defect (a free-text return `reason` violating the column's CHECK
constraint), not a product defect; corrected to the enum value and
the suite passes 31/31.

### Attacks attempted, per area

- **1 · GPS stack (6 tests)** — ping for another driver with the
  body `driverId` spoofed to the session owner (refused, audited,
  zero pings written; identity comes from the session only); ping
  after session end; ping after the batch went terminal behind the
  session's back (in-transaction re-check refuses); session start
  for a batch and for a trip the driver does not hold; pause /
  resume / stop of another driver's session (session survives
  ACTIVE); supervisor stop scope — Warehouse Admins of both an
  unrelated warehouse and the driver's non-session warehouse are
  refused, the session warehouse's WA stops it as SUPERVISOR.
- **2 · Live Operations (4 tests)** — a WA cannot widen scope via
  the `warehouseId` filter, via search (including an exact foreign
  tracking-id search), or at all in the plain list; the six roles
  without `operations.live_view` (rider, vendor, customer,
  warehouse staff, finance, support) are refused on BOTH list and
  detail; the COD field is *absent* (not null) for a live-view
  holder stripped of `cod.read`/`finance.read`, and present for a
  COD-holding WA as control; detail payloads contain the package
  tracking id but none of the planted recipient name / phone /
  address.
- **3 · Admin surfaces (5 tests)** — Users & Roles escalation
  boundary verified as the service actually enforces it:
  `setUserRoles` requires `role.manage` (Super Admin only in the
  catalog), so ADMIN and Warehouse Admin actors are refused for
  every grant including SUPER_ADMIN, a Super Admin cannot edit
  their own roles, and a Super Admin granting SUPER_ADMIN succeeds
  (the documented boundary — no lesser actor can); membership
  edits outside scope (WA assigning into another warehouse, or
  appointing a Warehouse Admin in their own) refused with zero
  rows written, staff assignment in own warehouse works; Settings
  writes by ADMIN / WA / FINANCE refused and nothing stored;
  `tracking.config` patches below floors (`minPingIntervalSeconds: 1`,
  `futureTimestampToleranceSeconds: 5`) and above caps
  (`retentionDays: 99999`), and idle-timeout values 0 / 169, are
  rejected whole with the stored row byte-identical; the Audit
  Logs viewer stays warehouse-scoped under `warehouseId`,
  entity-type and `actorSearch` filter combinations, while the
  global reader sees both planted rows.
- **4 · Four-eyes invitations (4 tests)** — self-approval refused
  and audit-logged (`invitation_self_approval`); approval by
  non-privileged actors (WA, FINANCE) refused; redemption before
  approval refused with the generic message and the row stays
  PENDING_APPROVAL; a second Super Admin's approval makes the
  token redeemable exactly once; a REJECTED invitation can never
  be redeemed; an invitation that expired while PENDING_APPROVAL
  cannot be approved (flips to EXPIRED) and cannot be redeemed.
- **5 · Phase 7 surfaces (9 tests)** — driver incident scope (a
  rider cannot link another driver's assignment or package, and
  cannot read the other's incident in detail or list); bulk
  booking (a cross-vendor row refuses the whole bulk with zero
  orders; an in-transaction failure on row 2 rolls back row 1);
  batch reassignment custody (exactly one open custody record,
  held by the new rider; the old rider is refused on the moved
  assignment); trip driver replacement en route (custody and trip
  move, the old driver's session ends REASSIGNED and their pings
  then fail) and its pre-departure refusal; returns inspect /
  complete keyed to the package's physical warehouse (WA of the
  return's origin warehouse refused on both, WA of the physical
  warehouse inspects); POD evidence reuse regression (the same
  reference bound to a second package — cross-kind included — is
  refused inside the transaction, exactly one binding survives);
  driver profile (out-of-scope read denied and audited; the `gps`
  key is absent for an actor without `operations.live_view` and
  present with it).
- **6 · Phase 8 additions (3 tests)** — `createDeliveryBatch`
  kind gate (pickup-only actor refused a DELIVERY batch,
  delivery-only refused a PICKUP batch, no batch rows written on
  refusal, pickup-only PICKUP creation works); tracking
  maintenance functions (`runTrackingMaintenance`,
  `expireAbandonedTrackingSessions`, `pruneExpiredLocationPings`)
  are exposed by NO route under `src/app/api` (whole-tree grep
  asserted in the suite; the only caller is the CLI script);
  malformed JSON at the handler level answers 400, not 500, on
  three swept routes (tasks, operations/handovers,
  operations/receive).
- **7 · IDOR sweep on the new `[id]` routes** — folded into the
  areas above: Live Operations detail with a foreign session id
  (refused + audited, no data returned), driver-profile detail
  with a foreign driver id (denied + audited), and incident
  detail with another driver's incident id (refused, absent from
  list). No `[id]` substitution returned another scope's data.

### Findings

None. No High, Medium, Low or Informational findings were raised
by this review; no production code was changed by the reviewer.

### Regression coverage

`tests/integration/phase8-final-review.test.ts` (31 tests) is
committed as the permanent regression suite for this review. It
complements, and does not duplicate, the per-phase reviewer suites
it re-attacks from a fresh angle: `phase3-security-review.test.ts`
(GPS races/replay/config abuse), `phase5-security-review.test.ts`
(live-operations search composition), `phase6-security-review.test.ts`
(admin surfaces and four-eyes races), `phase7-security-review.test.ts`
(Phase 7 surfaces, 37 PoCs) and `phase8-api-validation.test.ts`
(handler-level validation on the V2 routes).
