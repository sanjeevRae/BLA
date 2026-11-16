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

## Standing transitional items

- **SMS notifications are intent-only.** Notification rows on the
  SMS channel record `NOT_SENT_NO_PROVIDER` until an SMS provider
  is connected (same for EMAIL). In-app and tracking-page channels
  are live. The delivery OTP reaches the recipient through the
  phone-verified tracking view in the meantime.
- **Cross-warehouse returns are unimplemented.** A return must be
  received at the warehouse the delivery ran from; the
  `COLLECTION_ASSIGNED` / `COLLECTED` / `IN_TRANSIT` return states
  exist in the vocabulary but no flow moves a return between
  warehouses yet.
- **Top-up remittances are deferred.** When a COD discrepancy is
  accepted at the counted amount, the shortfall stays as the
  rider's driver-cash ledger debt, parked against the
  COD_DISCREPANCY suspense account per vendor. A rider cannot yet
  submit a dedicated top-up remittance to clear it; finance clears
  it through an approved financial adjustment (write-off) or when
  the cash is recovered and adjusted.
- **No GPS-based reporting.** The legacy `gps_tracking` table and
  its cleanup workflow were retired with the old backend. The new
  platform records trip checkpoints (TripStop rows) as operational
  data; no report consumes them and no retention job prunes them
  (see the deployment guide §8 for the retention position).
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
  production. The retention prune and abandoned-session expiry
  services exist but are not yet scheduled (Phase 8 wires the
  schedule); until then they are run operationally.
