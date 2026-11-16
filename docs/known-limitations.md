# BLA — Known Limitations & Accepted Dispositions

The deliberate, reviewed trade-offs of the rebuilt platform. Every
entry here was raised by a phase security review (or stands as a
transitional state) and was **accepted with reasoning** rather than
fixed — the Phase 10 slice-2 disposition pass (2026-11-16). Nothing
in this file is an unknown defect: each item names the control that
bounds it and the trigger that should reopen it.

## Accepted review dispositions

### P3-8 — Read authorization is scope-link based
Object reads (booking, package, invoice, …) authorize by **scope
link**: a vendor reads its own organisation's records, a customer
reads records where they are sender/recipient, a warehouse member
reads records touching their warehouses, and `*.read_all` holders
read globally. There is no second per-object permission check on
the scoped paths. This is the documented two-layer model
(security-architecture.md §3.3–§3.4): role permissions gate the
modules (route level), scope links gate the rows, links are
resolved server-side from the database on every request — never
from client input — and every denied read is audit-logged.
*Reopen if:* a role is introduced that holds warehouse membership
without an operational need to read that warehouse's bookings.

### P3-9 (rest) — Multi-vendor users resolve their oldest link
An account linked to several vendor organisations resolves the
**oldest active** VendorUser link as its actor vendor. The actor
model carries a single `vendorId` (security-architecture.md §3.3);
a vendor switcher is a product feature (UI + session semantics),
not a patch. All other links remain intact in the data and are
honoured the moment the oldest link is deactivated.
*Reopen if:* a real multi-vendor user appears — build the switcher
then, with the actor model change it deserves.

### P4-9 — Warehouse-bound handovers can be confirmed by the giver
A handover addressed to a warehouse (custodian = the warehouse as
an organisation) can be confirmed by any member of the receiving
warehouse — including the person who handed it over, if they are
also a member there. Per inventory-and-custody.md §3.1, the
receiver of an organisation-to-organisation handover is the
warehouse itself ("the receiver confirms by scan"; `confirmedBy`
records the confirming actor). Person-level separation of duties
is enforced where the model defines a person receiver
(rider/vendor handovers require the named receiver). Both the
initiator and the confirmer are audit-recorded, and the
short-count → DISPUTED flow is the control for abuse.
*Reopen if:* a fraud case or an auditor requires person-level
separation for warehouse custody too.

### P5-9 — Observation TrackingEvents carry previousStatus == newStatus
Transfer receiving writes three `EXCEPTION_RAISED` TrackingEvents
directly (wrong-warehouse arrival, excess arrival, missing at
finish) with `previousStatus == newStatus`. These are
**observations, not transitions**: the package lifecycle service
remains the only writer of `operationalStatus`, and an observation
truthfully records the state the package was in when it was seen.
The status-history invariant ("every status CHANGE has an event")
is unaffected — no change occurs on these rows.
*Reopen if:* a consumer of the tracking feed starts interpreting
every event as a state change; the fix then is an explicit
`observation` flag, not a lifecycle change.

### F12c — No monetary approval threshold on settlements
A SUPER_ADMIN can prepare, approve and pay a vendor settlement
end-to-end. The four-eyes rule that *is* specified
(financial-workflow.md §5 — approver ≠ creator, enforced for
adjustments and refunds) does not extend to settlements in the
requirements, and the threshold the document references ("SA
approves … high-value settlements") is **nowhere given a value**.
Inventing a money threshold would be making policy, so none is
implemented. The permission matrix already separates the duties
for everyone else: FINANCE prepares and pays but cannot approve;
ADMIN approves but can neither prepare nor pay; only the
break-glass SUPER_ADMIN holds all three, and every step is
audit-logged with actor identity.
*Reopen when:* Meena sets a threshold value — it then lands as a
SystemSetting key plus one check in `approveSettlement`.

### M-10 — POD evidence stays reference strings, hash-bound to one package
Proof-of-delivery photo/signature evidence (`ProofOfDelivery.photoFileId`
/ `signatureFileId`) remains a plain reference string by design:
no object-storage provider is wired into the platform, and there
is no `FileAsset` model yet — choosing a provider is a deployment
and cost decision for Meena, not an engineering default. What
Phase 7 adds is integrity on top of the references: at delivery
confirmation the server stores the SHA-256 hash of each reference
on the POD (`photoEvidenceHash` / `signatureEvidenceHash`) and
binds the hash to the package in `DeliveryEvidenceBinding` inside
the delivery transaction, so the same reference can never prove
two different packages' deliveries — reuse throws and the whole
delivery rolls back. (The hash is globally unique across kinds:
one string used as a photo for one package and a signature for
another still conflicts.) `DeliveryAttempt.evidenceFileId` has no
writer anywhere in the codebase, so there is no attempt evidence
to bind yet; when a writer lands, it binds through the same table
with its own kind.
*Reopen when:* an object-storage provider is chosen — `FileAsset`
then lands, evidence references become FileAsset links, and the
existing bindings migrate to it.

## Standing transitional items

- **SMS notifications are intent-only.** Notification rows on the
  SMS channel record `NOT_SENT_NO_PROVIDER` until an SMS provider
  is connected (same for EMAIL). In-app and tracking-page channels
  are live. The delivery OTP reaches the recipient through the
  phone-verified tracking view in the meantime.
- **Cross-warehouse returns travel on normal transfers (Phase 7).**
  A return's `destinationWarehouseId` is the origin warehouse of
  the package's shipment — the return warehouse, where inspection
  and vendor handover happen — while `warehouseId` records the
  warehouse that first received the return back from the last
  mile. When the two differ, the RECEIVED return joins a normal
  transfer as a manifested package flagged as a return (linked via
  `transferId`): it may be manifested only toward its return
  warehouse, moves to `IN_TRANSIT` at dispatch, and returns to
  `RECEIVED` when transfer receiving completes at the destination
  (first-receipt stamps are preserved; the arrival is a tracking
  event). Inspection and completion then run at the destination
  warehouse. The `COLLECTION_ASSIGNED` / `COLLECTED` return states
  remain vocabulary-only — no collection leg is implemented.
- **Top-up remittances are deferred.** When a COD discrepancy is
  accepted at the counted amount, the shortfall stays as the
  rider's driver-cash ledger debt, parked against the
  COD_DISCREPANCY suspense account per vendor. A rider cannot yet
  submit a dedicated top-up remittance to clear it; finance clears
  it through an approved financial adjustment (write-off) or when
  the cash is recovered and adjusted.
- **No GPS-based reporting.** The legacy `gps_tracking` table and
  its cleanup workflow were retired with the old backend. V2 adds
  live GPS *visibility* (TrackingSession / DriverLocationPing /
  DriverCurrentLocation + the Live Operations board — see
  `docs/live-gps-tracking.md`), but no management *report* consumes
  location history, and TripStop checkpoints remain operational
  data retained with their trips (see the deployment guide §8).
- **Customer/counter invoice *generation* is out of scope.**
  Invoices are generated for vendor orders from snapshotted
  booking charges; ad-hoc counter invoices for walk-in customers
  are not generated by the platform.
- **Migrated driver licence expiries are sentinel values.** The
  live master-data migration creates driver profiles with expiry
  1970-01-01 because the legacy system stored no expiry. The
  drivers are blocked from assignment until the real dates are
  entered (see the migration runbook, deployment guide §4).
- **GPS legal review is a production gate (V2 Phase 3).** The
  live-tracking backend collects driver location only during
  active assignments, but the Nepal Privacy Act 2075 review
  described in docs/gps-privacy-and-retention.md §6 (driver
  notice/acknowledgement text, 30-day ping retention, access
  expectations) must be completed before GPS is enabled in
  production. The retention prune (daily) and abandoned-session
  expiry (hourly) services are scheduled as of Phase 8 via
  `scripts/tracking-maintenance.ts` (see
  docs/live-gps-tracking.md §11); the schedule must be verified
  running in the production environment at go-live.

## Pre-production real-device GPS checklist — NOT yet verified (Phase 8)

Everything in this section is **unverified**. The GPS backend, the
driver panel, and the Live Operations board were verified on the
production build with headless Chrome (CDP geolocation override +
permission grant) — see `docs/live-gps-tracking.md` §8. **No item
below has been checked on a real device, and no coverage is implied
for any of them.** Each item must be performed on physical hardware
and its result recorded before GPS is relied on in production:

- [ ] **Android Chrome — background behaviour:** start a session,
  background the app / switch apps, and confirm updates stop and
  freshness degrades honestly (no apparently-live stale marker);
  return to the foreground and confirm the watch restarts and a
  catch-up fix is sent.
- [ ] **Android Chrome — screen-lock behaviour:** lock the screen
  mid-session for several cadence intervals; confirm the same
  stop/degrade/resume behaviour as backgrounding, and that the
  panel's "no update for X" watchdog fires.
- [ ] **iOS Safari — `watchPosition` behaviour:** confirm fixes are
  delivered at a usable cadence while the page is visible, how
  delivery behaves across tab suspension and screen lock, and that
  the panel recovers without a reload.
- [ ] **iOS Safari — permission UX:** first-run permission prompt
  wording/timing from the panel's Start flow; denial path (session
  must NOT start; re-enable instructions shown must match current
  Safari UI).
- [ ] **Real fix cadence and jitter:** on a moving vehicle, compare
  actual ping intervals against the configured cadences (rider
  150 s / line-haul 240 s / heartbeat 600 s, 25 m movement
  threshold), and observe GPS jitter at standstill — in particular
  whether stationary heartbeats register as new fixes or are
  deduplicated as bit-identical (the honest DELAYED/STALE outcome
  described in `docs/live-gps-tracking.md` §8).
- [ ] **Per-browser permission re-enable flows:** deny permission,
  then follow each browser's real steps to re-enable it (Android
  Chrome site settings; iOS Safari / iOS Settings location
  services) and confirm the panel's instructions match and the
  flow ends in a working session.
- [ ] **Panel pixel checks at 390 / 768 / 1440 px:** driver
  tracking panel and Live Operations board rendered at phone
  (390 px), tablet (768 px) and desktop (1440 px) widths — touch
  targets, freshness badges paired with last-update times, paused /
  signal-problem states, and the map/list selection sync all
  visually inspected. (Build-level layout was verified from
  rendered structure; these are the on-device pixel checks.)
- [ ] **OSM tile rendering on a real network:** Live Operations map
  tiles load over a real mobile/office connection (not the build
  sandbox), attribution is visible, pan/zoom stay responsive at
  pilot data volumes, and tile failure degrades to the list view
  without breaking the board.

Until this checklist is complete, GPS in production is a pilot
aid: manual checkpoints and scans remain the operational record,
exactly as `docs/driver-operations.md` states.
