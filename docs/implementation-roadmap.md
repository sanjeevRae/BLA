# BLA — Implementation Roadmap (Next.js Rebuild)

**Date:** 2026-11-15
**Basis:** `docs/project-audit.md` (Phase 0 inspection) and the master
specification, Part 27 (implementation phases) and Part 30 (working rules).
**Target architecture (spec Part 3):** one Next.js application (App Router,
TypeScript) in a modular-monolith structure; the existing Supabase **PostgreSQL**
database; **Prisma** as the single ORM (chosen per spec Part 3.1 — not mixed
with Drizzle); **Auth.js** authentication with secure HTTP-only session cookies;
RBAC + resource-based permissions checked on **every** protected server
operation; Zod validation; central service modules (spec Part 22) so business
rules live in exactly one place; the existing frontend design system and
components preserved and migrated (spec Part 2.3). Currency **NPR**, display
timezone **Asia/Kathmandu**, timestamps stored in UTC.

---

## Standing QA gate (applies to every phase)

No phase is called complete until **all** of the following pass for that
phase's scope (spec Part 26.5 and Part 30, rules 23–25):

1. **TypeScript check** — `tsc --noEmit` clean; no `any` / `@ts-ignore` /
   broad suppression used to force a pass.
2. **Lint** — clean.
3. **Production build** — `next build` succeeds.
4. **Tests** — the phase's unit tests (business rules: transitions, pricing,
   custody, COD/settlement math, permission decisions), integration tests
   (database transactions and workflows) and security tests (cross-warehouse,
   cross-vendor, cross-role denial) are written and passing.
5. **Independent security review** — a reviewer other than the implementer
   checks: authorization on every Server Action and Route Handler touched;
   warehouse/vendor/driver scoping applied **inside the database query**,
   never by trusting a client-supplied ID; input validation; no secrets in
   browser code; sensitive actions audited.
6. **Live workflow run-through** — the phase's real user workflows are
   exercised in the running application (browser), for every affected role,
   including the failure paths — not just happy paths.

After each phase, a progress report is produced in the format required by spec
Part 30: what was implemented, files reused / created / removed, database
changes, APIs and services added, security checks completed, tests performed,
build results, known issues, remaining tasks.

---

## Migration strategy (applies across all phases)

The audit (Risk R1) established that **the live database is not reproducible
from the repo's SQL files** — 3 tables and ~31 columns exist only live. The
migration therefore proceeds from the live database, never from `db/*.sql`:

1. **Backup first.** Before the new schema touches the live database, take a
   full `pg_dump` (schema + data) of the live Supabase project and store it
   outside the database. This is the rollback point for the entire migration.
   (Pre-rebuild code state is already preserved under the git tag
   `pre-rebuild-checkpoint`.)
2. **Inspect the live-only structures in `pg_catalog`** (RLS state, indexes,
   constraints on `warehouse_memberships`, `inventory_movements`,
   `warehouse_transfer_items` — unverifiable via REST during the audit).
3. **New Prisma schema alongside the old tables.** The new schema (spec
   Part 20 entities) is created in the same database next to the existing
   tables — nothing is dropped or altered in place. Old and new models coexist
   while modules are migrated one phase at a time.
4. **Reconcile auth identities** (audit Risk R5): verify every live
   `public.users` row has a matching `auth.users` entry before the Auth.js
   cut-over, starting with the two real-shaped accounts.
5. **Migrate master data only.** Transactional data in the live database is
   demo/test data (audit §4.4) and is **not** migrated. Carried over, after
   owner confirmation: the 4 warehouses (Kathmandu, Pokhara, Chitwan,
   Lalitpur), 9 user accounts, 4 drivers, 4 vehicles, 5 warehouse memberships,
   1 customer, and admin settings/help content. The demo vendor, demo parcels
   and `dev-bypass` event history are discarded or re-seeded as development
   fixtures. The 7 app-created `inventory` intake rows are confirmed with the
   owner before disposal. One open question rides along: whether any *other*
   database holds real order history (this one has none).
6. **Apply the never-applied Phase 3c** (`warehouses.district`) as part of the
   master-data migration — district-based routing depends on it.
7. **Old backend removed only in Phase 10.** The FastAPI backend is the current
   (only) enforcement point for warehouse isolation and vendor scoping
   (audit Risk R2). It stays running until the new Next.js server layer
   enforces membership-based scoping on every query and that enforcement has
   passed the security tests — then, and only then, is the old backend
   retired and the old tables dropped (after a final backup).

**External dependency (only one):** the **Supabase connection string** (direct
PostgreSQL connection) is needed at exactly one point — when the new Prisma
schema is first applied to the live database (end of Phase 1) and for the
`pg_dump` backup. All design, coding and local testing before that point
proceed without it (development runs against a local PostgreSQL with the same
schema). If the connection string cannot be provided, the fallback is: Muse
generates the migration SQL and the owner pastes it into the Supabase SQL
Editor — no password is shared.

---

## Phase 0 — Project audit ✅ (complete 2026-11-15)

**Scope.** Full repository inspection per spec Part 2.2: frontend inventory,
backend inventory, database inventory (repo SQL **and** live database),
dependency report, risks, migration plan.

**Deliverables.**
- `docs/project-audit.md` — the Phase 0 deliverable (this roadmap's basis).
- `docs/implementation-roadmap.md` — this document.
- Git checkpoint tag `pre-rebuild-checkpoint` pushed.
- The remaining design documents required by spec Part 28 (business
  requirements, system architecture, database schema, entity relationships,
  role-permission matrix, workflow documents, security architecture, testing
  strategy) are produced from the audit findings before Phase 1 coding begins.

**Key findings carried forward.** Four deployables, not one app; two parallel
auth systems (one client-asserted and insecure); two parallel data-model
generations; ~81 backend endpoints mapped with a 45-row responsibilities list;
critical security remnants (§3.4 of the audit); live DB ≠ repo SQL; real data
is master data only.

**Acceptance.** Audit documents written and grounded in the live system; no
production data modified. ✅

**Dependencies.** None.

---

## Phase 1 — Next.js foundation

**Scope.** The application skeleton and the security foundation everything
else stands on: Next.js App Router + TypeScript project; Prisma + PostgreSQL
configuration; Auth.js authentication; user management; roles and permissions;
audit-log foundation; the existing frontend's design system and shell migrated
in (tokens, sidebar/topbar layout, page-header pattern).

**Key deliverables.**
- Next.js app (App Router, TypeScript, strict) with the modular structure of
  spec Part 25 (`src/app`, `src/modules`, `src/lib`, `src/server`,
  `prisma/`).
- Prisma schema v1: User, Role, Permission, RolePermission, UserRole, Session,
  WarehouseMembership, UserInvitation, AuditLog, SystemSetting (spec Part 20),
  with soft-delete/archival and RESTRICT/SET NULL on history-bearing FKs
  (audit Risk R3) and lifecycle states as text + CHECK, not rigid enums
  (Risk R7).
- **One login page for all roles** (the owner's explicit requirement): Auth.js
  credentials flow, passwords hashed by the library (bcrypt/argon2), secure
  HTTP-only session cookies, session expiration and revocation, login rate
  limiting and failed-login monitoring, account deactivation/suspension with
  session revocation (spec Part 21.1). **No self-registration of privileged
  roles** — users are created by admins or by invitation (this closes audit
  §3.4 #1 and #2: no dev-bypass, no open super_admin signup, in any mode).
- Authorization service: permission checks (spec Part 21.2 permission names)
  enforced in a central authorization-aware data-access layer; deny by
  default; role and permissions always loaded from the database server-side,
  never trusted from the client.
- Role-based landing: each role lands on its own dashboard route (spec
  Part 24.2); wrong-portal users get a helpful denial, replacing the old
  `/auth/me` gate concept.
- Migrated shell: existing sidebar/topbar/design tokens, with the TSX auth
  pages' divergent styling unified onto the console token system and the
  Tailwind content-glob bug fixed.
- Seed (development only): the spec's roles/permissions matrix and demo users;
  production super-admin created by invitation/first-run, never seeded with a
  known password.

**Acceptance criteria (spec Phase 1).** Users can securely log in from the
single login page and see **only** authorized dashboard routes; direct URL or
API access to another role's area is denied server-side; suspended users
cannot reuse sessions; sensitive actions (user create/role change/suspend)
appear in the audit log.

**Dependencies.** Phase 0. The Supabase connection string is required at the
end of this phase to apply the schema to the live database (see Migration
strategy) — development and all QA-gate testing before that run locally.

**QA gate.** Full gate; security tests must include: unauthenticated Server
Action / Route Handler invocation denied; privilege-escalation attempts
(self-assigned role, modified IDs) denied and logged; session revocation on
suspension verified live.

---

## Phase 2 — Warehouses and memberships

**Scope.** Warehouse management and the warehouse-scoping model the whole
system depends on.

**Key deliverables.**
- Warehouse CRUD with the spec Part 5.1 field set (unique code, address,
  city/district/province, coordinates, contact, email, operating hours,
  manager, capacity, type, operational status); deactivation/archival instead
  of deletion.
- Warehouse zones and storage locations (`WH-KTM / ZONE-A / RACK-03 /
  SHELF-02` location codes, spec Part 5.3); capacity configuration and
  near-limit warnings (Part 5.4).
- WarehouseMembership as the canonical scoping model — adopting the live
  database's existing `warehouse_memberships` design (user × warehouse ×
  role/purpose with assign/revoke audit) into the Prisma schema.
- Warehouse-scoped data access: every warehouse-scoped query resolves the
  user's memberships server-side and applies the scope **inside the query**
  (spec Part 20.2); a browser-supplied warehouse ID is never proof of
  permission. PostgreSQL RLS reviewed as a defence-in-depth layer where
  appropriate, not as a substitute for application authorization.
- Warehouse Admin dashboard (spec Part 4.3): packages in warehouse, incoming/
  outgoing transfers, awaiting sorting/dispatch, riders, staff, today's
  received/dispatched, damaged/missing, tasks, discrepancies — all computed
  from real records.
- Master-data migration executed here (per Migration strategy): warehouses
  (with the Phase 3c `district` values), memberships, users, drivers,
  vehicles, the one customer.

**Acceptance criteria (spec Phase 2).** **Warehouse A users cannot access
Warehouse B data** — proven by automated security tests and a live attempt
with modified requests (spec Scenario 11), with the denied access logged.
Warehouse Admin cannot create warehouses, see company-wide finance, or change
another warehouse's custody.

**Dependencies.** Phase 1 (auth, permissions, memberships table).

**QA gate.** Full gate; the cross-warehouse denial test is a hard blocker for
every later phase.

---

## Phase 3 — Vendors, customers and booking

**Scope.** The commercial front door: vendor accounts, customer records, and
booking creation that generates real, trackable packages.

**Key deliverables.**
- Vendor registration + verification lifecycle (pending → under review →
  approved / rejected / suspended / inactive, spec Part 14.1), business
  profile, pickup addresses, verification documents (private storage,
  spec Part 21.4); multiple vendor users with Vendor Owner / Manager /
  Booking Staff / Accounts Staff roles, all scoped to the vendor organization.
- Customer records with duplicate-aware creation (validated phone as the
  matching key, controlled duplicate resolution); recipients can track without
  an account.
- Booking creation (spec Part 6.2): sender, recipient, package and delivery
  sections; draft + submit; one **Order** → one **Shipment** → N **Packages**
  (Part 6.1), unifying the old split `packages`/`shipments` concept into one
  canonical package record; unique tracking IDs enforced by database
  constraint + retry (not probe loops); labels and QR/barcodes generated.
- Declared vs actual vs volumetric vs billable weight stored separately;
  volumetric divisor and pricing rules **configurable** (PricingRule /
  ShippingService / ServiceArea tables), never hardcoded in components
  (Part 6.3).
- Booking edit/cancellation rules by stage (Part 6.4), with cancellation
  recording requester, approver, reason, stage and charges. Vendor-cancel-
  after-pickup routes into the return workflow (Scenario 9), never a plain
  cancel.
- Vendor portal rebuilt inside the Next.js app (preserving the old portal's
  behaviour: submission into the admin approval queue; own orders / parcels /
  settlements views) — including fixing the shipped submit-button bug by
  rebuilding the form properly. Vendor approval queue preserved in the admin
  console.

**Acceptance criteria (spec Phase 3).** A vendor can create a real booking and
the system generates trackable package records; a vendor cannot see or touch
another vendor's records (tested); booking totals and billable weight are
computed by the central pricing service and match unit tests.

**Dependencies.** Phase 2 (warehouses for origin/destination; memberships for
scoping).

**QA gate.** Full gate; integration tests cover booking → package generation
end-to-end, including multi-package orders and partial data validation
failures.

---

## Phase 4 — Warehouse operations

**Scope.** The physical heart of the system: receiving, inspection, sorting,
storage, internal movement, parcel inventory and custody — all scan/event
driven, never status-edited by hand.

**Key deliverables.**
- Package lifecycle service (spec Part 7): the central state machine with an
  explicit transition table; separate fields for operational status, package
  condition, payment status, delivery status and exception status (Part 7.2);
  every transition validated (Part 7.3) and recorded as an append-only
  TrackingEvent with actor, role, warehouse, location, related
  transfer/trip, notes, evidence and **idempotency key** (Part 7.4) —
  replacing the four fragmented free-text trails.
- Receiving workflow: scan → verify ID/weight/condition → record damage →
  assign storage location → put-away. A package enters inventory **only**
  through a receiving scan (Part 1.3).
- Inventory: parcel inventory (per warehouse, with storage location, custody,
  last movement) kept strictly separate from supplies inventory (StockItem /
  StockMovement — adopting the live-only `inventory_movements` design);
  internal movements recorded with actor, source, destination, reason
  (Part 8.3). A package with a driver must not simultaneously appear as
  warehouse stock.
- Custody management: every handover records from/to party or location,
  package IDs, time, confirmation and evidence; count mismatches
  automatically raise a discrepancy (Part 8.4).
- Duplicate-scan protection (Scenario 7): idempotency keys + unique
  constraints; the second scan returns a clear message, not a duplicate
  record. Concurrency control (transactions + optimistic locking) so two
  staff cannot double-receive or double-dispatch the same package
  (Scenario 8).
- Warehouse Staff dashboard and task views (Part 4.4); capacity warnings wired
  to receiving (Scenario 16: warn/flag at configured limits, never falsely
  mark received).

**Acceptance criteria (spec Phase 4).** Every physically received parcel has a
valid warehouse receiving event; inventory always reflects actual custody;
duplicate and concurrent-action tests pass (Scenarios 7, 8).

**Dependencies.** Phase 3 (packages exist to receive).

**QA gate.** Full gate; integration tests run the receive → put-away → move →
pick flows against the database with transaction assertions.

---

## Phase 5 — Transfers and transportation

**Scope.** Inter-warehouse movement with manifests and physical reconciliation,
plus the vehicle/trip layer it rides on.

**Key deliverables.**
- Transfer entity redesigned as **header + items + manifest + scans**
  (replacing the old per-shipment transfer rows): origin/destination,
  expected arrival, selected packages validated against origin inventory,
  driver + vehicle assignment, dispatch approval where configured
  (spec Part 9.1–9.2). Full status set (Part 9.3): draft → requested →
  approved → preparing → ready → dispatched → in transit → arrived →
  partially received → received → reconciliation pending → reconciled →
  closed (+ exception / cancelled).
- Loading scans with loaded-quantity verification; dispatch confirmation;
  destination receiving by scan with expected-vs-received comparison;
  **missing / excess / damaged / wrong packages reported as discrepancies**
  and opened as incidents — a transfer cannot be reconciled or closed until
  received quantities are reconciled (Part 1.3, Part 9.4). The live
  `trip_manifests` load/receipt columns are the design seed for this.
- Misroute handling (Scenario 2): wrong-warehouse arrival is recorded,
  the package is held/quarantined, a corrective transfer is created, history
  is preserved — never a silent inventory reassignment.
- Vehicles module (Part 10.4): registration, type, capacity/weight limit,
  assigned driver, insurance/registration/inspection status and expiry,
  maintenance records, availability — unavailable or invalid vehicles cannot
  be assigned. Trips (Part 10.5) with planned vs actual times, manual
  checkpoint fallback (no GPS dependency), incident reporting; driver
  breakdown flow (Scenario 6) with authorized reassignment and custody
  handover between drivers/vehicles.
- Line-haul Driver dashboard (Part 4.6): assigned trips, manifest, loading
  scans, departure/arrival, handover evidence, trip history. Drivers cannot
  edit manifests after dispatch or mark missing packages received.
- Internal rack-to-rack movement stays an inventory movement (Part 9.5),
  never an inter-warehouse transfer.

**Acceptance criteria (spec Phase 5).** A package cannot silently move
between warehouses; the Scenario 1 test (dispatch 50, receive 48) passes end
to end: 48 confirmed, 2 unresolved, discrepancy incident created, transfer
blocked from reconciliation, admin notified, history preserved.

**Dependencies.** Phase 4 (inventory/custody/scans).

**QA gate.** Full gate; reconciliation math and discrepancy flows covered by
integration tests; manifest amendment attempts by drivers verified denied.

---

## Phase 6 — Riders and delivery

**Scope.** Pickup and last-mile delivery: assignments, batches, attempts,
proof, failures and the return flow they feed.

**Key deliverables.**
- Driver profiles completed (Part 10.1–10.3): home warehouse, capability set
  (pickup / delivery / combined — replacing the single `driver_type` text),
  license + expiry, verification documents (access-controlled), availability
  derived from actual assignments, not login state.
- Delivery assignment with eligibility checks (availability, capability,
  count, weight, area, workload, shift — Part 11.1); delivery batches grouped
  by city/municipality/ward/zone (Part 11.2); route geometry from
  MapTiler/ORS retained from the old routing service, without making delivery
  depend on GPS availability.
- Rider dashboard (Part 4.5) rebuilt in the Next.js app, preserving the old
  driver-app behaviour: today's pickups/deliveries, custody list, COD to
  collect / collected / pending remittance, returns, daily history. Pickup
  flow (arrive → scan → verify → evidence → collect) and delivery flow
  (scan → out-for-delivery → attempt → proof → confirm).
- **DeliveryAttempt as a real entity** (Part 11.3): attempt number, time,
  location, result, failure reason, contact outcome, evidence, next action —
  replacing the old `failed_attempts` counter. Customer-unavailable flow
  (Scenario 4) with redelivery/return branching.
- Proof of delivery (Part 11.4): configurable OTP / signature / photo /
  authorized-recipient name with timestamp; **a package cannot be marked
  delivered without the required proof or an authorized exception**
  (Part 1.3). POD uploads move to validated, access-controlled storage
  (Part 21.4) instead of public Cloudinary URLs.
- Partial delivery (Scenario 13): packages delivered individually; shipment
  shows partially fulfilled; COD/payments calculated per the contract.
- Rider reassignment (Scenario 14) and suspended-staff custody handover
  (Scenario 17): authorized reassignment with outgoing + incoming custody
  records; suspension revokes sessions and flags held packages for
  reassignment.
- Returns and reverse logistics (Part 12): refusal / unreachable / wrong
  address / vendor request / damage / undeliverable → return requested →
  approved → collected → in transit → received → inspected → completed, with
  charges and vendor notification; original delivery history untouched.
  Return-to-sender (Scenario 15) covered end to end.
- Offline delivery (Scenario 10): permitted rider actions queue locally as
  signed events and sync idempotently when connectivity returns; duplicates
  on sync are detected, conflicts resolved safely, no fabricated server
  confirmations.
- Public customer tracking rebuilt (Part 4.8): tracking ID **plus a
  verification factor** (closing the old full-PII-with-no-verification
  exposure), public status only — no internal notes, driver personal details
  or financial data; `?order=` deep link and live progress preserved;
  customer notifications on lifecycle events (Part 17).

**Acceptance criteria (spec Phase 6).** A package can be tracked from pickup
to final delivery with evidence at every handover; delivered-without-proof is
impossible outside an authorized, audited exception; rider sees only assigned
work (security-tested).

**Dependencies.** Phase 5 (destination-warehouse receiving feeds delivery
eligibility); Phase 4 custody.

**QA gate.** Full gate; e2e tests run booking → pickup → transfer → delivery
and the failed-delivery → redelivery and → return journeys (spec Part 26.4).

---

## Phase 7 — Finance

**Scope.** Money, done properly: invoices, payments, COD, remittances,
settlements, refunds — on an immutable ledger, in NPR.

**Key deliverables.**
- Financial model (spec Part 13): FinancialAccount, LedgerTransaction,
  Invoice, Payment, PaymentAllocation, CODCollection, DriverRemittance,
  VendorSettlement, Refund, FinancialAdjustment. Every transaction carries a
  **unique reference** and an **idempotency key**; balances are derived from
  the ledger, never overwritten on a profile. Adjustments and reversals are
  new linked records — original events are never rewritten (Part 4.9).
- The ten financial concepts kept strictly separate (Part 13.1): shipping
  revenue, charges paid/outstanding, COD collected, COD held by driver, COD
  remitted, COD payable to vendor, vendor settlement, refund, adjustment.
  **COD is a liability until settled, never company revenue.**
- COD workflow (Part 13.4) end to end: declared at booking → collected by
  rider → remittance submitted with evidence → finance verifies → ledger
  updated → vendor payable calculated → settlement approved → payment
  recorded → vendor statement. **COD mismatch (Scenario 5)** — collect
  Rs. 5,000 / remit Rs. 4,500 — preserves both records, shows the Rs. 500
  discrepancy, blocks settlement of the missing amount and opens a finance
  incident.
- Payments: configurable methods (cash, bank transfer, mobile wallet, online
  gateway, prepaid balance, credit account — Part 13.2; the India-era `upi`
  method and INR defaults are removed); payment status kept separate from
  delivery status (Part 13.3). Stripe integration rebuilt on the ledger with
  **NPR** as the currency, the dependency properly declared, webhook
  fulfilment idempotent (Scenario 12: a duplicated payment confirmation
  creates exactly one transaction).
- Finance role and dashboard (Part 4.9): revenue, paid/unpaid charges, COD
  collected/pending/awaiting remittance, vendor payable, settlement due,
  refunds, disputes, driver cash balances, unreconciled transactions.
  Finance staff cannot change physical custody (security-tested).
- Vendor statements and settlement history in the vendor portal (real data
  only); invoices generated from ledger records.

**Acceptance criteria (spec Phase 7).** Every collected amount can be traced
from its original transaction through remittance to settlement; duplicate
financial requests do not duplicate transactions (tested); settlement and COD
calculations match unit tests to the paisa.

**Dependencies.** Phase 6 (COD originates at delivery); Phase 3 (charges
originate at booking).

**QA gate.** Full gate; financial integration tests run inside database
transactions with rollback assertions; finance/custody cross-permission
denials are explicit security tests.

---

## Phase 8 — Tasks, incidents and support

**Scope.** Operational accountability for everything that goes wrong or needs
doing: work tasks, exceptions/incidents, customer support, notifications.

**Key deliverables.**
- Task management (spec Part 15): tasks for any role with related
  package/shipment/transfer/issue links, priority, due date, attachments,
  comments; full workflow (draft → assigned → accepted → in progress →
  blocked → submitted → under review → verified → closed / rejected /
  cancelled) with reassignment reasons and overdue visibility. Tasks never
  substitute for package status updates.
- Incidents (Part 16): all required categories (missing, damaged, wrong
  warehouse, wrong package, transfer shortage/excess, delivery failure,
  refusal, wrong address, pickup failure, breakdown, accident, theft
  suspicion, COD discrepancy, payment dispute, duplicate booking/scan,
  weight discrepancy, delay, complaint, unauthorized access attempt) with
  severity, evidence, investigation notes, resolution and approval; workflow
  reported → acknowledged → assigned → investigating → awaiting information →
  escalated → resolution proposed → resolution approved → resolved → closed.
  A missing package remains an unresolved discrepancy until an authorized
  investigation concludes — it is never deleted from inventory. The
  discrepancy incidents auto-created by Phases 4, 5 and 7 land here.
- Support (Part 4.10): complaint tickets, package search with authorized
  tracking view, address-correction and redelivery requests, escalation to
  investigation tasks, case notes, verified closure. Support cannot change
  payments or custody directly.
- Notifications (Part 17): **in-app notifications first**, per-user with
  preferences, linked to real events and deduplicated on retry; role-specific
  categories for admin, warehouse admin, drivers, vendors and customers.
  EmailJS (email) and Textlocal (SMS) adapters retained behind the
  notification service so parcel flows — which notify nobody today — notify
  consistently. The admin feed tables are replaced by per-user notifications;
  sidebar Notifications becomes functional (it is a dead button today).

**Acceptance criteria (spec Phase 8).** Operational problems have accountable
owners and complete resolution histories; every auto-raised discrepancy from
earlier phases is visible, assignable and closable only through the incident
workflow.

**Dependencies.** Phases 4–7 (incident sources); Phase 1 (audit, users).

**QA gate.** Full gate; live run-through raises each incident type and walks
it to closure.

---

## Phase 9 — Reporting and analytics

**Scope.** Management and operational reporting computed from the real
operational records — **no fake dashboard numbers** (spec Part 1.3): every
figure traceable to its underlying records.

**Key deliverables.**
- Admin reports (Part 18.1): bookings, packages, delivered, failed, return
  rate, average delivery time, delays, warehouse / transfer / driver / vendor
  performance, revenue, outstanding charges, COD collection and
  reconciliation, vendor settlements, incident frequency.
- Warehouse reports (Part 18.2): daily receiving/dispatch, current inventory,
  capacity, aging inventory, transfers in/out, discrepancies, damaged,
  staff performance.
- Driver reports (Part 18.3): assigned/completed/failed, pickup completion,
  average delivery time, COD collected vs remitted, returns, trip history.
- Vendor reports/statements (Part 18.4): booking history, delivery success
  rate, charges, COD collections and payable, settlement history, returns.
- The Super Admin / Admin overview dashboards completed (spec Part 4.1–4.2):
  the full operational and financial picture with filters by date range,
  warehouse, status, vendor, service type, payment status, driver and area —
  replacing the old analytics service (which computed live in Python from
  full-table reads) with indexed, paginated queries over the new schema.
  Consistent definitions and Asia/Kathmandu date boundaries everywhere;
  authorized export where permitted.

**Acceptance criteria (spec Phase 9).** Reports agree with the underlying
operational records — verified by reconciling report totals against ledger
and package records on the migrated dataset; dashboard numbers match the
reports they summarize.

**Dependencies.** Phases 3–8 (all data sources live).

**QA gate.** Full gate; reconciliation checks are automated (report totals vs
source-record queries) and re-run on the production dataset before sign-off.

---

## Phase 10 — Production readiness

**Scope.** Hardening, cut-over and retirement of the old system (spec
Part 10 / Phase 10 and Part 2.4–2.5).

**Key deliverables.**
- **Old backend removed.** The FastAPI application, its Render service and
  its Python dependency set are retired; the two GitHub-Actions cron jobs are
  re-pointed or replaced (daily report via the new notification service; GPS
  retention re-implemented in the new job system — spec Part 3.1 durable job
  queue where needed). No two competing backends remain. Leftover one-off
  scripts (`_sec_patch.py`, `_gen_payments.py`) are removed. Old tables are
  dropped only after a final full backup and a verification pass that every
  preserved frontend behaviour runs on the new server layer.
- Security hardening pass (spec Part 21): rate limits on all sensitive
  endpoints, security headers, CSRF posture reviewed, file-upload validation
  (type/size/safe names, private storage, short-lived signed URLs), secrets
  audit (no server secrets in browser code; the anon key is the only
  client-side key), MFA available/required for privileged users per policy.
- Backup and recovery: scheduled `pg_dump` backups with a documented,
  **tested** restore procedure (docs/backup-and-recovery.md); Supabase
  free-tier limits (500 MB) monitored, GPS retention enforced.
- Observability: structured server-side logs, error handling with a standard
  error envelope, health checks, monitoring of failed jobs and 5xx rates.
- Performance: pagination on all list endpoints (no unbounded browser loads),
  indexes verified against the report/query patterns of Phase 9.
- Documentation completed (spec Part 28 — all 24 documents in `docs/`,
  including deployment guide and operations manual) and the deployment
  performed per that guide.

**Acceptance criteria (spec Phase 10 + Part 29).** The application is deployed
and operable without development-only behaviour: no dev-bypass anywhere, no
`REQUIRE_AUTH`-style global off switch, production build green, full test
suites green, restore-from-backup demonstrated, and the final acceptance
checklist (Part 29 — organization, warehouse, packages, transfers, drivers,
vendors/customers, finance, safety/security, quality) verified item by item
against the running system.

**Dependencies.** All previous phases; the QA gate applied to the whole
system, not just Phase 10 scope.

---

## Phase dependency summary

```
Phase 0 (audit) ✅
  └─ Phase 1 (foundation: Next.js + Prisma + Auth.js + permissions + audit)
       └─ Phase 2 (warehouses + memberships + master-data migration)
            └─ Phase 3 (vendors, customers, booking)
                 └─ Phase 4 (warehouse operations: lifecycle, inventory, custody)
                      ├─ Phase 5 (transfers, vehicles, trips)
                      │    └─ Phase 6 (riders, delivery, returns, public tracking)
                      │         └─ Phase 7 (finance: ledger, COD, settlements)
                      └─ Phase 8 (tasks, incidents, support, notifications)
                           └─ Phase 9 (reporting & analytics)
                                └─ Phase 10 (production readiness; old backend removed)
```

Phases are sequential by dependency; a phase does not start until the previous
phase has passed the standing QA gate. Completed features are always reported
separately from incomplete ones, with changed files recorded per phase
(spec Part 30).
