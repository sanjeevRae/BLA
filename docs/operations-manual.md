# BLA — Operations Manual

Day-to-day running of the BLA logistics platform for Admins, Warehouse
Admins and Finance staff. **Refreshed against the built V2 application
in Phase 8 (2026-11-16): §9 is the built-UI runbook** — role homes,
route names and the who-does-what table are taken from the navigation
registry (`src/lib/navigation/registry.ts`) and the permission catalog
(`src/lib/permissions/catalog.ts`). Sections 1–8 remain the standing
procedures; where §9 names a concrete screen, §9 governs.

**Golden rules (apply all day, every day):**
- A package's location changes only through a recorded movement — never by
  editing a record to "fix" it.
- Money is corrected only through linked adjustments — never by editing a
  payment.
- If the physical world and the system disagree, the physical count wins
  and the difference becomes a discrepancy/incident — never a silent edit.

---

## 1. Starting the day / opening a shift

**Warehouse Admin (each warehouse, e.g. Kathmandu `WH-KTM-01`):**
1. Log in and open your warehouse dashboard. Confirm the overnight figures:
   packages in warehouse, incoming transfers expected today, packages
   awaiting sorting/dispatch, damaged/missing items still open.
2. Check **Exceptions and Incidents** for anything assigned to your
   warehouse that is unresolved — yesterday's shortage is today's first job.
3. Check **Tasks** for overdue items and reassign or escalate before the
   shift starts moving packages.
4. Confirm rider availability for today (available / on leave / suspended)
   and vehicle availability for scheduled line-haul trips.
5. Check the **capacity indicator**: if the warehouse is near its configured
   limit, plan dispatches early (see §5).

**Admin / Operations:**
1. Open the Overview dashboard: pending pickups, in-transit transfers,
   out-for-delivery counts, open exceptions across all warehouses.
2. Review trips scheduled today — any trip without an assigned driver or
   vehicle gets resolved before departure time, not after.
3. Review new vendor registrations awaiting verification.

## 2. Monitoring during the day

- **Overview dashboard** (Admin/Super Admin): packages per state, delivered
  today, failed attempts, COD pending collection and awaiting settlement.
  Figures are live from real records — if a number looks wrong, drill into
  the module; do not "correct" it anywhere.
- **Transfers in transit:** watch expected arrival times. A trip that passes
  its expected arrival without an arrival scan is a delay — contact the
  driver, and if unreachable, open an incident (delayed shipment) so the
  delay is on record.
- **Failed delivery attempts:** a rising count for one rider or one area
  usually means an address-data problem, not a rider problem — Support
  checks the addresses before Finance or Admin questions the rider.
- **Notifications panel:** capacity warnings, transfer discrepancies,
  missing-package alerts, overdue tasks and COD discrepancies arrive here
  and as dashboard badges. Treat a discrepancy notification as a task, not
  as information.

## 3. Handling incidents

All operational problems live in **Exceptions and Incidents** — not in chat
messages or notebooks.

1. **Report** (any staff member): choose the category (missing package,
   damaged package, transfer shortage/excess, wrong warehouse, delivery
   failure, COD discrepancy, vehicle breakdown, …), link the package /
   transfer / trip, describe what physically happened, attach photo evidence
   where relevant.
2. **Acknowledge & assign:** the responsible Warehouse Admin or Admin
   acknowledges, assigns an owner and a severity. A missing package stays an
   open discrepancy in inventory until the investigation concludes — it is
   never written off by removing the record.
3. **Investigate:** notes go on the incident record (who checked what,
   where). For transfer shortages, the manifest, the loading scans and the
   line-haul driver are linked automatically — start there.
4. **Resolve:** resolution requires the outcome (found / confirmed lost /
   compensated / corrected transfer) and, where configured, approval.
   Resolution closes the incident; the record stays readable forever.
5. **Escalate** instead of sitting on it: anything unresolved at end of day
   is escalated to Admin; anything involving money (COD discrepancy,
   payment dispute) is escalated to Finance the same day.

**Breakdown/accident on a trip:** the driver reports it from the trip
dashboard; dispatch is notified automatically. Admin arranges the
replacement driver/vehicle, and the handover between drivers is recorded as
a custody transfer — packages are never "just moved" to another vehicle.

## 4. COD end-of-day reconciliation routine

Cash on delivery is the highest-risk routine in the business. It runs
**every operating day**, per warehouse, before the day is closed.

1. **Riders submit:** each delivery rider's collected COD (per package,
   recorded at delivery time) is totalled by the system as "COD collected".
   The rider physically hands over cash / submits remittance evidence.
2. **Warehouse/Admin counts:** the receiving officer counts the physical
   cash and records the **remittance** amount against the rider for the
   day. The system compares collected vs remitted automatically.
3. **Match → reconcile:** if the amounts match, Finance (or Admin with
   finance permission) marks the day's remittances reconciled. The amounts
   move to "COD awaiting settlement" per vendor.
4. **Mismatch → discrepancy, same day:** if a rider collected Rs. 5,000 and
   remits Rs. 4,500, the original Rs. 5,000 collection record stays as-is,
   the Rs. 4,500 remittance is recorded, and the system shows a **Rs. 500
   discrepancy** and opens a finance incident. The missing Rs. 500 is
   blocked from vendor settlement until the incident is resolved. Nobody
   edits the collection figure to make the day balance.
5. **Vendor settlements:** Finance generates settlements from the ledger
   (COD held for the vendor − shipping charges − authorized deductions).
   Settlements require approval per the permission matrix before payment is
   recorded. A settlement is never calculated from a hand-kept total.
6. **Unreconciled list:** anything left in "COD awaiting remittance" or
   "unreconciled transactions" at day end is reviewed by Finance the next
   morning — it is the first finance task of the day, not the last.

## 5. Capacity warnings

- The warehouse dashboard shows capacity usage against the configured limits
  (package count / zone / weight). Approaching the limit raises a warning
  to the Warehouse Admin and Admin.
- On a warning: prioritize dispatch of ready packages, and notify Admin
  before accepting a large inbound transfer.
- At the **hard limit**, the system blocks further acceptance. Packages are
  rerouted by Admin to another warehouse through a proper transfer — they
  are never marked "received" at a warehouse that does not physically hold
  them.

## 6. Suspending a user (with custody reassignment)

Used for staff who leave, are suspended, or lose a device. Done by Admin /
Super Admin in **Users and Roles**.

1. Open the user, choose **Suspend**, give a reason (required, audit-logged).
   Suspension takes effect immediately: the account cannot log in and any
   existing session is revoked.
2. **Custody check (mandatory):** if the user currently holds packages
   (rider with undelivered parcels, staff member mid-task, driver on a
   trip), the system lists them. Each package/task must be reassigned to a
   named colleague — the reassignment is recorded as a custody handover, so
   the chain of accountability has no gap.
3. The responsible Warehouse Admin is alerted automatically and confirms
   the physical handover of the packages.
4. The suspended user's history (scans, deliveries, tasks, financial
   actions) remains fully visible in audit logs and package histories —
   suspension never erases accountability.
5. Reinstatement (if applicable) is a separate, deliberate action by an
   Admin, also audit-logged.

## 7. End of day

**Warehouse Admin:** confirm all received packages are scanned into storage
locations (no package "in the building but not in the system"), all
dispatched transfers have departure confirmed, undelivered packages from
riders are received back and recorded, and open incidents are updated or
escalated.

**Finance:** complete the COD routine (§4); check the unreconciled list is
empty or carried over with an owner.

**Admin:** glance at tomorrow's scheduled trips and pickups; until automated
backups are configured, take the daily database backup
(`docs/backup-and-recovery.md` §2).

## 8. When something is wrong with the system itself

- Login or dashboard errors affecting everyone: check the deployment status
  (Vercel) and database status (Supabase) dashboards first; if the database
  is implicated, **do not** attempt ad-hoc fixes in the SQL editor on live
  data — raise an incident, and restore only per
  `docs/backup-and-recovery.md`.
- Suspected unauthorized access (logins you don't recognize, audit-log
  denials from a warehouse user probing another warehouse): suspend the
  account (§6), then investigate from the audit log. The log is the record;
  do not delete or edit it.

---

## 9. The built V2 runbook (Phase 8)

### 9.1 Role homes — where each role starts

Every sign-in lands on the primary role's home (`ROLE_LANDING_PATH`
in the permission catalog; dashboard trees in the navigation
registry). There is one login for all roles.

| Role | Home | First screens of the day (registry labels) |
|---|---|---|
| Super Admin | `/super-admin` | Overview · Tasks · Notifications · Live Operations · Incidents · Users & Roles · Settings · Audit Logs |
| Admin | `/admin` | Overview · Tasks · Notifications · Bookings · Live Operations · Incidents · Support tickets · Settlements · Reports |
| Warehouse Admin | `/warehouse` | Overview · Receive & scan · Arrivals · Inventory · Transfers (+ New transfer) · Deliveries (+ New delivery batch) · Handovers · Returns · Live Operations · Drivers · Vehicles · Reports |
| Warehouse Staff | `/staff` | Overview · Receive & scan · Arrivals · Inventory · Transfers · Deliveries · Handovers · Supplies · Returns · Incidents |
| Rider | `/rider` (home **is** the batch list) | Batch detail (`/rider/batches/[id]`) · COD (`/rider/cod`) · Tasks · My performance · Notifications |
| Line-haul Driver | `/transport-driver` | Home (assigned trips) · Tasks · My performance · Notifications |
| Vendor | `/vendor` | Home · Bookings (+ New booking; bulk at `/vendor/bookings/bulk`) · Billing · Reports · Profile |
| Customer | `/customer` | My packages · My invoices (`/customer/billing`) · Support tickets · My incidents · Notifications · Profile |
| Finance | `/finance` | Overview · Invoices · Ledger · COD remittances · Settlements · Adjustments & refunds · Reports · Tasks |
| Support | `/support` | Home · Support tickets · Incidents · Tasks · Notifications |

Public tracking (no login) lives at `/track`; it shows milestones
only — never driver positions or internal detail.

### 9.2 Starting the day, per role

- **Warehouse Admin / Staff:** open Overview, then work the queues
  in order: **Incidents** (yesterday's shortage is today's first
  job) → **Arrivals** (transfers expected today) → **Receive &
  scan** backlog → **Inventory** exceptions → **Transfers /
  Deliveries** to prepare. Confirm rider/vehicle availability
  (Drivers / Vehicles) and the capacity indicator before accepting
  a large inbound transfer (§5).
- **Admin / Super Admin:** Overview first (pending pickups,
  in-transit transfers, out-for-delivery, open exceptions), then
  **Live Operations** (§9.4) for anything already moving, then
  vendor verifications and the invitation approval queue — 
  privileged invitations wait in `PENDING_APPROVAL` until a
  *second* approver decides them (four-eyes; the inviter cannot
  approve their own).
- **Rider / Line-haul Driver:** home shows today's batches/trips.
  Start the tracking session from the tracking panel when the run
  starts (it is driver-started only, foreground-only — §9.4), and
  work scans/attempts from the batch/trip detail, not from chat
  or paper.
- **Finance:** yesterday's unreconciled COD list is the first task
  (§9.5), then Settlements and Adjustments & refunds queues.
- **Support:** Support tickets and Incidents queues; address
  corrections and redelivery requests are raised from the ticket —
  Support never touches custody or money directly.
- **Vendor / Customer:** self-service only (own bookings, billing,
  tickets, incidents). Anything outside their scope is a Support
  ticket, not a phone workaround.

### 9.3 Exception handling (built flow)

1. **Report** in **Incidents** (any role with `incident.report`;
  drivers also report from the trip/batch — breakdown, accident,
  delay). Link the package/transfer/trip, describe what physically
  happened, attach evidence. Auto-created incidents (transfer
  shortage/excess, handover discrepancy, COD discrepancy) arrive
  pre-linked — start from those links.
2. **Triage:** the responsible team (WAREHOUSE / FINANCE / SUPPORT /
  OPERATIONS, derived from the category) acknowledges and assigns.
  Statuses run `REPORTED → ACKNOWLEDGED → ASSIGNED → INVESTIGATING
  → AWAITING_INFORMATION / ESCALATED → RESOLUTION_PROPOSED →
  RESOLUTION_APPROVED → RESOLVED → CLOSED`.
3. **Money/loss rule:** incidents involving money or package
  write-off (COD discrepancy, payment dispute, missing package,
  theft suspicion, transfer shortage) need an approver different
  from the proposer; the record, not a chat thread, is the
  resolution.
4. **End of day:** anything unresolved is escalated, not carried
  silently (§3). A missing package stays an open discrepancy in
  inventory until the investigation concludes.

### 9.4 Live Operations monitoring

- Who watches: Super Admin / Admin (all movements) and Warehouse
  Admin (movements whose origin **or** destination is their
  warehouse) — **Live Operations** in the registry, gated on
  `operations.live_view`. Warehouse Staff, drivers, vendors and
  customers have no live map.
- The board polls every ~50 s while visible and shows, per
  movement: driver, type (transfer / pickup / delivery), route,
  package count, last update and a freshness badge (Fresh /
  Delayed / Stale / Offline — always read it *with* the
  last-update time). A movement with no fix yet says "Waiting for
  first location" and has no marker.
- **Foreground-only discipline:** a Stale/Offline marker usually
  means the driver's app is backgrounded, the screen is locked, or
  the phone lost signal — it does **not** mean the driver stopped
  working. Call the driver; do not conclude anything from GPS
  alone. GPS never proves delivery and never changes custody.
- A supervisor may **End** a stuck tracking session from the
  detail view (audited, `endReason = SUPERVISOR`). Supervisors
  cannot start or pause a driver's session.
- Straight-line connector on the detail map is labelled
  "not a road route" — there are no ETAs. Plan from trip/batch
  checkpoints and expected-arrival times, not from the line.

### 9.5 COD close of day (built screens)

The §4 routine, on the built UI:

1. **Rider side:** collections are recorded per package at delivery
   confirmation (amount + method; a difference is a `MISMATCH` with
   a required explanation — never edited later). The rider checks
   their position in **COD** (`/rider/cod`) and submits the day's
   remittance.
2. **Finance side:** verify remittances in **COD remittances**
   (`/finance/remittances`): counted amount vs collected. Match →
   verified; the cash moves toward vendor settlement. Shortfall →
   resolve the remittance as a discrepancy the same day: the
   collection record stays as-is, a finance incident opens, and
   the shortfall is blocked from settlement until resolved.
3. **Adjustments** (write-offs / corrections) go through
   **Adjustments & refunds** (`/finance/adjustments`) as linked
   adjustments created by one Finance user and approved by a
   *different* user — money is never corrected by editing a
   payment (§4, golden rules).
4. **Settlements** are generated from the ledger in
   **Settlements** (`/finance/settlements`), approved, then paid.
   Note the open decision: there is currently **no monetary
   approval threshold** on settlements (known limitation F12c) —
   until Meena sets one, the prepare/approve/pay separation
   between Finance and Admin is the control.
5. Close the day only when the unreconciled list is empty or every
   remainder has a named owner for the morning.

### 9.6 Who does what (built permissions, summary)

| Job | Does it | Never |
|---|---|---|
| Receive / inspect / sort / put away | Warehouse Staff, Warehouse Admin (own warehouse) | Finance, Support, vendors |
| Create / dispatch / reconcile transfers | Warehouse Admin (origin creates/dispatches; destination receives/reconciles) | Line-haul driver (no receiving action exists for drivers) |
| Assign pickups / deliveries / trips | Warehouse Admin (own), Admin | Riders self-assigning |
| Start / pause / resume GPS tracking | The assigned driver only | Supervisors (end-only, audited) |
| Confirm delivery + collect COD | Assigned rider | Anyone else on that assignment |
| Verify COD, prepare/pay settlements, record payments | Finance | Warehouse roles (Warehouse Admin sees own-warehouse COD via `cod.read` only) |
| Approve settlements | Admin / Super Admin | Finance (prepares and pays; does not approve) |
| Approve financial adjustments | A different user than the creator (Finance or Super Admin) | The creator (self-approval refused) |
| Invite users (privileged roles) | Inviter + a second approver (four-eyes) | Self-approval |
| Manage settings / roles | Super Admin (Settings; Users & Roles) | Admin (no `settings.manage`) |
| Tickets / customer follow-up | Support | Support touching custody or money |
