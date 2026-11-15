# BLA — Testing Strategy

**Tooling (chosen, do not mix):** **Vitest** for unit and integration tests,
**Playwright** for end-to-end browser tests, TypeScript's own `tsc --noEmit`
and ESLint for static gates. Tests live in `tests/unit`, `tests/integration`,
`tests/e2e` per the project structure (Part 25).

**Baseline being replaced:** the old system has exactly **22 DB-free unit
tests** (pure functions only — transitions, routing decisions, role guards,
schemas) and **zero** endpoint, integration or e2e tests. That is not an
acceptable state for a system handling money and custody; this strategy is
the minimum bar for the rebuild.

**Hard rule (Part 26.5):** TypeScript errors are never suppressed to get a
green build — no `any` escapes, no `@ts-ignore`, no broad error suppression.
A test or type error blocks the phase, it is not worked around.

---

## 1. Unit tests (Vitest)

Pure business rules, no database. Every rule in the domain layer gets direct
coverage:

- **Package status transitions** — the full transition table from
  `docs/package-lifecycle.md`: every allowed transition succeeds, every
  disallowed transition is rejected (e.g. `booked → delivered`,
  `in transit → destination inventory` without receiving, dispatch without an
  approved manifest, delivered without proof).
- **Volumetric weight and pricing** — volumetric weight
  `L × W × H / divisor` with the configured divisor; billable weight =
  tariff rule (max of actual vs volumetric); tariff calculation per service
  area/service; declared vs actual weight discrepancies flagged. No price is
  ever read from a frontend constant — tests assert pricing comes from
  `PricingRule` configuration.
- **Inventory calculations** — on-hand per warehouse/zone, in-custody-with-
  driver exclusion (a package assigned to a driver must not count as
  warehouse stock), capacity usage and warning thresholds.
- **Custody transitions** — handover creates matching out/in records;
  count mismatches raise a discrepancy; custody can never point at two
  holders at once.
- **Transfer reconciliation** — expected vs received quantities: exact match
  reconciles; shortage/excess/damage leaves the transfer open with the right
  discrepancy type.
- **COD calculations** — collected vs remitted vs payable; a short remittance
  produces the exact discrepancy amount and blocks settlement of the missing
  part.
- **Vendor settlement calculations** — payable = COD held for vendor −
  shipping charges − authorized deductions, computed from ledger entries,
  never from a stored balance field.
- **Permission decisions** — the authorization service: each permission in
  `docs/role-permission-matrix.md` granted/denied correctly per role,
  including warehouse-scoped variants (`package.read_assigned` vs
  `package.read_all`).
- **Return eligibility** — which stages may be cancelled outright, which must
  go through the return workflow (e.g. after pickup), and which are locked
  (after delivery, history immutable).
- **Delivery attempt limits** — attempt counting, failure-reason handling,
  redelivery/return branching per policy.

## 2. Integration tests (Vitest + test database)

Run against a real PostgreSQL test database (the Supabase schema applied to
a disposable database — never the live production database). These verify
that services, transactions and the data layer behave together:

- **Booking creation** — order + shipment + N packages created atomically,
  unique tracking IDs generated, receipt data correct; a failure mid-way
  leaves no partial order.
- **Package receiving** — receiving scan creates the inventory record,
  custody record and tracking event in one transaction; a duplicate scan
  (same idempotency key) creates none of them twice.
- **Inventory movement** — put-away, internal rack-to-rack movement, picking
  and dispatch preparation update location and custody consistently.
- **Transfer dispatch and receiving** — manifest approval → loading scans →
  dispatch → destination receiving scans → reconciliation, end to end at the
  service level, including a partial-receipt case.
- **Driver assignment** — capability checks (pickup vs delivery vs line-haul),
  availability transitions driven by assignments, workload limits.
- **Delivery confirmation** — OTP verification, COD collection recorded
  against the package and rider, proof-of-delivery stored, package reaches
  `delivered` only with evidence attached.
- **Financial reconciliation** — payment recorded once per idempotency key;
  driver remittance reconciles against collections; vendor settlement
  generated from the ledger matches hand-computed figures; an adjustment
  creates a linked record and leaves the original untouched.
- **Notification creation** — lifecycle events create exactly one in-app
  notification per recipient; retrying the event creates no duplicate.
- **Database transactions** — concurrent updates to the same package
  (optimistic concurrency) produce one success and one conflict, never two
  custody records.

## 3. Security tests

Authorization is tested as behaviour, not assumed. Each test performs the
attack and asserts denial **on the server** (the UI is irrelevant here):

- **Cross-warehouse denial** — a Warehouse Admin / Staff session for
  Kathmandu (`WH-KTM-01`) requests Pokhara (`WH-PKR-01`) inventory,
  packages, staff and transfers — via page URL, Server Action and Route
  Handler — and is denied on all three; the denied attempt is written to the
  audit/security log without leaking Pokhara data in the response.
- **Cross-vendor denial** — Vendor A's session cannot read Vendor B's
  bookings, packages, invoices, COD records or statements, by list or by
  direct ID.
- **Rider scoping** — a rider can read and act only on their own assigned
  pickups/deliveries; another rider's assignment ID returns not-found/denied;
  a rider cannot change a package's warehouse, edit prices or delete
  anything.
- **Customer privacy** — public tracking with a valid tracking ID but wrong
  verification phone is denied; tracking responses contain no internal
  notes, driver personal data, vendor data or financial records.
- **Finance/custody separation** — Finance role cannot perform custody
  operations (receive, dispatch, deliver); warehouse roles cannot create or
  alter payments, settlements or adjustments.
- **Server Action / Route Handler authorization** — every protected action
  and handler is invoked with (a) no session, (b) a session of the wrong
  role, (c) a session with the right role but wrong warehouse/vendor scope;
  only the fully authorized call succeeds. Client-supplied role/permission
  fields in request bodies are ignored (tested by sending forged values).
- **IDOR via modified IDs** — sequential/guessed IDs for packages, orders,
  transfers, payments and users are substituted into URLs and action
  payloads; access is granted only where a real authorization relationship
  exists.
- **Suspended-user session revocation** — suspending a user immediately
  invalidates their existing session (next request denied), including a
  session opened before the suspension; role/permission removal takes effect
  the same way.
- **Authentication hardening** — login rate limiting and failed-login
  monitoring trigger; password reset does not enumerate accounts; session
  cookies are HTTP-only and secure; privileged self-registration is
  impossible (the old system's `POST /auth/signup` super_admin hole must not
  exist in any form); no `REQUIRE_AUTH`-style bypass flag exists in the new
  codebase (asserted by code search in review).
- **Upload security** — proof-of-delivery and document uploads reject
  spoofed file types (content sniffed, not extension-trusted), oversize
  files and unauthenticated uploads; private files are served only via
  short-lived signed URLs to authorized users.

## 4. End-to-end tests (Playwright)

Full journeys in a real browser against the running app, happy path and
failure path:

- **Booking → delivery (happy):** vendor creates booking → pickup rider
  collects → origin warehouse receives and sorts → transfer to destination
  warehouse → reconciled receiving → delivery rider assigned → out for
  delivery → OTP-confirmed delivery with COD collected → finance reconciles
  remittance → vendor settlement issued. Tracking page reflects each public
  step.
- **Booking → delivery (failures along the way):** failed pickup, damaged at
  receiving, failed delivery attempt (recipient unavailable) → redelivery,
  recipient refusal → return-to-sender flow completing at the origin
  warehouse with vendor notified.
- **Role journeys:** each of the ten roles logs in on the single login page
  and lands on its own dashboard; the warehouse admin's dashboard shows only
  their warehouse's numbers.
- **Admin operations:** warehouse creation, staff assignment, driver
  creation/activation, vendor approval, task assignment and completion,
  incident creation → investigation → resolution.
- **Finance journey:** invoice generation, payment recording, COD
  end-of-day reconciliation with a deliberate shortfall, settlement approval.

## 5. Part 23 failure scenarios — named test cases

Each scenario from the specification is a named, automated test (integration
or e2e as appropriate). A scenario is "covered" only when the test passes
against the built system.

| # | Test case | Expected behaviour asserted |
|---|---|---|
| 1 | `transfer-missing-packages` | 50 dispatched, 48 received → 48 confirmed, 2 unresolved, discrepancy incident created, transfer cannot fully reconcile, driver + manifest linked, admin notified, history preserved |
| 2 | `misrouted-package-wrong-warehouse` | Misroute recorded, silent inventory reassignment blocked, package held/quarantined, corrective transfer created, admins notified, prior movements intact |
| 3 | `damaged-package-receiving` | Condition + photos captured, receiving employee identified, incident created, hold applied, staff notified, resolution recorded |
| 4 | `customer-unavailable-attempt` | Attempt recorded with reason and timestamp, attempt count increments, customer notified per policy, redelivery or return scheduled by rule |
| 5 | `cod-mismatch-remittance` | Collection Rs. 5,000 preserved, remittance Rs. 4,500 recorded, Rs. 500 discrepancy shown, missing amount blocked from settlement, finance incident created and resolved with a record |
| 6 | `linehaul-driver-breakdown` | Trip incident reported, trip preserved, dispatcher notified, authorized reassignment records driver/vehicle handover and custody reconciliation, ETA updated |
| 7 | `duplicate-scan-idempotency` | Second scan of the same package detected via idempotency key, no duplicate inventory, clear message to the employee, legitimate history preserved |
| 8 | `simultaneous-warehouse-actions` | Two employees dispatch/receive the same package concurrently → one succeeds, one gets a conflict, no duplicate custody records |
| 9 | `vendor-cancel-after-pickup` | Ordinary cancellation rejected once package is in custody; cancellation/return workflow initiated instead, charges calculated, history maintained |
| 10 | `offline-delivery-sync` | Rider's offline actions queue locally as signed events, sync on reconnect, duplicate sync detected and deduplicated, conflicts resolved safely, no fabricated server confirmation |
| 11 | `unauthorized-warehouse-access` | Warehouse A user modifies a request to reach Warehouse B inventory → server rejects, authorization error returned, denied access logged without exposing private data |
| 12 | `duplicate-financial-request` | Same payment confirmation sent twice → exactly one ledger transaction, retry returns the original result |
| 13 | `partial-shipment-delivery` | 3 of 5 packages delivered individually, 2 stay active, shipment shows partially fulfilled, COD/charges calculated per package/contract |
| 14 | `driver-reassignment-custody` | Unavailable rider's packages reassigned only by an authorized user, outgoing and incoming custody both recorded, assignment history fully visible |
| 15 | `return-to-sender-refusal` | Refusal reason recorded, authorized return initiated, return tracking created, every handover recorded, vendor notified, return charges per policy |
| 16 | `warehouse-capacity-reached` | Capacity warning displayed, dispatch blocked/flagged per configured limits, authorized rerouting possible, packages never falsely reported received |
| 17 | `staff-account-disabled-with-custody` | Suspended employee's access and sessions revoked, responsible admin alerted, custody reassignment required and recorded, historical activity preserved |

## 6. The per-phase QA gate (standing directive)

No phase is reported complete — and the next phase does not start — until
**all** of the following pass for that phase's scope:

1. **TypeScript check** — `tsc --noEmit` clean, no suppressions.
2. **Lint** — ESLint clean on changed code.
3. **Unit tests** — the phase's business rules covered per §1, all passing.
4. **Integration tests** — the phase's flows covered per §2, all passing
   against the test database.
5. **Security tests** — the §3 cases relevant to the phase pass (warehouse
   isolation is gated from Phase 2 onward and re-run every later phase).
6. **Production build** — `next build` succeeds.
7. **Independent review** — a reviewer who did not write the code reviews it
   for correctness and security (authorization on every server operation,
   warehouse/vendor scoping inside queries, no secrets in client code, no
   hardcoded data).
8. **Live run-through** — the phase's workflows are exercised manually in
   the running application (browser), including at least one denial case
   (wrong role / wrong warehouse) and the responsive layout at mobile width.

Phase 10 additionally requires: the full §5 scenario suite green, the
complete e2e suite green, and a full regression pass of every earlier phase's
gate items against the production build.
