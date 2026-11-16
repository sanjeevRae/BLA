# BLA — Current Implementation Audit (V2 Phase 0)

**Date:** 2026-11-16 · **Repo state audited:** `main` @ `84f3f00` (V1 rebuild complete + postinstall fix)
**Scope:** Full audit of the V1 platform against the V2.0 master specification §2 — every module, every role, the database schema, GPS state, external services, and a measured build/test baseline. **No application code, migrations, or live data were changed in this phase.** Live database access was read-only (Supabase Management API `SELECT`/`information_schema` only).
**Method:** Four independent module auditors (operations modules; business modules; GPS/schema/services; tests + UI shell) + coordinator verification, repo inventory, and a full local gate run.

---

## 1. Baseline measurements (actually run, 2026-11-16)

| Check | Result |
|---|---|
| Typecheck (`npm run typecheck`, `tsc --noEmit`) | **Clean** — 0 errors |
| Lint (`npm run lint`) | **0 errors**, 2 warnings (pre-existing unused vars in `tests/integration/phase8-security-review.test.ts:65`, `tests/integration/phase10-security-review.test.ts:49`) |
| Production build (`npm run build`) | **Succeeded** — full route table for all 10 role groups + public tracking + API routes |
| Test suite (`npm test`, Vitest, 29 files) | See honest sequence below |

**Test sequence (reported in full, per standing rule):**

1. First run: 23 of 29 files failed with "Can't reach database server at localhost:5432". Root cause was **environment, not code**: this VM's PostgreSQL cluster was a fresh, empty cluster (no `bla` role, no `bla_dev`/`bla_test` databases — the VM had been replaced since the V1 rebuild). The local test infrastructure was rebuilt exactly as in V1: `bla` role recreated (password taken programmatically from `prisma/.env`, never printed), `bla_dev` + `bla_test` created, all migrations applied via `prisma migrate deploy` (79 app tables in each), `bla_dev` re-seeded.
2. Full parallel run on the rebuilt DB: **321 passed, 37 skipped, 0 failed tests** — but 1 suite (`tests/integration/phase9-reports.test.ts`) failed at setup: its `beforeAll` permission-catalog sync raced other suites' concurrent catalog upserts on the empty database and hit a unique-constraint error on `RolePermission` (a test-harness race on a cold DB, not an application defect; recorded as defect T-1 below).
3. Solo re-run of that file: **37/37 passed** (19 s).
4. **Combined baseline: 358/358 tests accounted green** (321 parallel + 37 solo), consistent with the V1 final gate.

Test inventory: 29 files, 355 test cases by `it(`/`test(` count (60 unit + 295 integration); all integration tests are service/DB-level — **there are no component, render, or E2E tests anywhere** (no Testing Library / Playwright / Cypress). Vitest timeouts are 60 s (`vitest.config.ts`), set for this 1.5-CPU VM.

---

## 2. Module audit (spec §2.2)

Cross-cutting facts that apply to every row: authentication/authorisation is uniform and real — each role folder's `layout.tsx` gates with `requireDashboardActor([ROLE])` (`src/lib/auth/page-guards.ts`: role + `mustChangePassword` + MFA gates), pages call `requireActor()`, Server Actions use `getActorContext()` + `requireAccessGranted`, API routes use the same gate, and **permission + warehouse/vendor/customer scope are enforced inside services** via `requirePermAudited()` (`src/server/services/scoping.ts`) with denials audit-logged as `access.denied`. A full sweep found **no mock data, no hardcoded KPI numbers, no TODO/FIXME, and no dead buttons** (149 `<button>` tags parsed: every one is a submit inside a wired form or has a handler). The systemic UI gap is navigation — see defect H-1.

| Module | Existing UI | Backend | Permissions | Tests | Result |
|---|---|---|---|---|---|
| **Dashboard** | 10 role home pages under `src/app/(dashboards)/{admin,super-admin,warehouse,staff,rider,transport-driver,finance,vendor,customer,support}/page.tsx`; Admin/SA render live `OverviewPanel` (`src/components/reports/pages.tsx`); WA home is the richest (own warehouse card, members, zones + ops/transfer/delivery panels); **Support home is still the Phase-1 placeholder** (`src/components/dashboards/DashboardHome.tsx`) and Staff home leads with it. **No sidebar/nav anywhere** — `src/components/layout/DashboardShell.tsx` is a header-only frame whose own comment defers nav to "later phases" | Real services behind every home (`getOverviewReport`, warehouse ops summaries, vendor/customer/rider panels — all computed, no literals) | Layout role gate + service-level report permissions (`report.read_all`/`report.read_warehouse`); nav links are **not** permission-filtered (there is no nav to filter) | No dedicated dashboard tests; landing routing in `tests/unit/landing.test.ts`, figures behind homes in `tests/integration/phase9-reports.test.ts` | **Incomplete** — data is real, but there is no navigation system and one role home is a placeholder |
| **Warehouses** | Full CRUD: `admin|super-admin/warehouses/{page,new,[id]}` → `src/components/warehouses/pages.tsx` (list, detail, form, members, zones, invite-user); WA manages its own warehouse from `/warehouse` home | `src/server/services/warehouses.ts` (create/list/get/update/status/members/zones/locations/capacity) + actions + `src/app/api/warehouses/{route,[id]/route}.ts` | `warehouse.create/update/deactivate/assign_staff/manage_locations`, reads `read_all\|read_assigned`, all `requirePermAudited`; WA operational-field scoping + membership-role checks in service | `tests/integration/warehouses.test.ts` (isolation, cross-warehouse denial + audit, membership revocation, immutable code), `user-lifecycle`, `invitation-security` | **Complete** |
| **Inventory** | WA + Staff: `src/app/(dashboards)/{warehouse,staff}/{operations,inventory,handovers,supplies,arrivals}` → `src/components/warehouse-ops/pages.tsx` (receiving/inspection queue, stock by zone/location, movements history, handovers, supplies ledger). **No Admin inventory UI** despite Admin holding `inventory.read_all` | `src/server/services/inventory.ts` (receive w/ duplicate-scan + misroute handling, inspection chain, put-away, internal moves, ready-for-dispatch, capacity), `supplies.ts` (before/after stock ledger), `custody.ts` (handovers); APIs under `src/app/api/operations/` | `package.receive/inspect/sort`, `inventory.move_internal`, `supplies.manage`, `custody.handover` + `assertWarehouseScope` before every lifecycle transition; WA additionally holds `inventory.correct`/`package.hold`, Staff correctly does not | `tests/integration/warehouse-ops.test.ts` (atomic receive, idempotent scans, DB one-open-record invariants, damage quarantine, handover short-count, capacity, supplies chain), `phase4-custody-fixes.test.ts` | **Complete** — on its operational (WA/Staff) surface; Admin read UI gap recorded as defect M-6 |
| **Packages** | No standalone `/packages` or `/orders` route — the UI unit is the **Booking (= Order)**: `admin|super-admin|vendor/bookings{,/new,/[id]}`, `warehouse|staff/bookings{,/[id]}`, customer home lists own packages; booking detail embeds packages, printable labels (`src/components/packages/label.tsx`) and status; public `/track` + `/track/[trackingId]` | `src/server/services/bookings.ts` (booking → Shipment + Packages + tracking IDs in one transaction), `packages.ts` (get/list/label, public + phone-gated detailed tracking), `package-lifecycle.ts` — **sole writer** of `operationalStatus`, allow-list state machine in `src/lib/bookings/lifecycle.ts`; APIs `api/bookings`, `api/packages/[id]`, `api/track/[trackingId]` | Writes `booking.create/approve/cancel/update` via `requirePermAudited`; reads force-scoped in-query (vendor → own, customer → own, warehouse → related; cross-tenant = 404 + audit, P3-1 fix composes scope AND search); public tracking is unauthenticated **by design** with a minimal projection, exact-phone second factor for detail, per-IP failure budget (`src/server/services/tracking-access.ts`) | `tests/integration/bookings.test.ts` (COD split exactness, routing/UNROUTED, scope, projection field-set, lifecycle sole-writer source scan), `phase3-scope-fixes.test.ts`, deliveries suite (detailed tracking) | **Complete** — with the structural note that Order/Shipment/Package are only ever presented fused as "Booking"; no package-level list/detail UI exists |
| **Transfers** | WA + Staff: `{warehouse,staff}/transfers{,/new,/[id],/[id]/manifest}`, `arrivals`; line-haul driver home shows own active trip. Shared `src/components/transfers/pages.tsx` (list, create, detail with permission-gated sections, printable manifest). **No Admin transfers/trips UI** | `src/server/services/transfers.ts` (full lifecycle: items → submit → approve → manifest → crew → load → dispatch → destination receiving → reconcile → close), `trips.ts` (depart/arrive/checkpoints/delay); APIs `api/transfers/**`, `api/trips/[id]/{depart,arrive}` | Every mutation `requirePermAudited` (`transfer.create/prepare/approve/load/dispatch/receive/reconcile`); crew assignment requires **both** `driver.assign` + `vehicle.assign`; reads scoped by origin/destination membership or assigned driver (`assertTransferReadable`) | `tests/integration/transfers.test.ts` (full A→B journey, crew blockers, partial load refusal, missing-package reconciliation, late-scan recovery), `phase5-transfer-fixes.test.ts` | **Complete** — on WA/Staff/Driver surface; Admin UI gap = defect M-6 |
| **Drivers** | Fleet UI exists **only** for Admin/Super Admin: `{admin,super-admin}/{drivers,vehicles}/page.tsx` → `src/components/fleet/pages.tsx` (driver profiles, licence, employment status; vehicles, documents, assignment, maintenance). Crew picker inline in transfer detail; rider/line-haul homes show own work. **No WA fleet pages** despite WA holding `driver.manage/driver.assign/vehicle.assign` | `src/server/services/drivers.ts` (profiles, licence, employment, assignable-driver picker with PII withheld), `vehicles.ts` (CRUD, assignment blockers: status/insurance/registration/inspection, maintenance); actions `src/server/actions/fleet.ts`. **No `/api/drivers` or `/api/vehicles` read API** — Server Actions only | Writes `driver.manage`/`vehicle.manage`/`vehicle.assign`; `listDrivers` scopes non-global actors to own record / own-warehouse drivers; **`listVehicles` applies no warehouse scope at all** (in-code comment: "fleet data, no per-warehouse scope") | **No dedicated fleet tests** — indirect only via transfers (crew blockers), deliveries (eligibility), phase9 driver reports | **Incomplete** — service layer is real and complete, but role surfaces, read API, and direct tests are missing |
| **Vendors** | Admin/SA CRUD `admin|super-admin/vendors{,/new,/[id]}` → `src/components/vendors/pages.tsx`; vendor self-service: home (org status + recent bookings), profile, bookings, billing (invoices/settlements/statement), reports, tickets, incidents, notifications | `src/server/services/vendors.ts` (CRUD, verification lifecycle, addresses + approval, documents + review, warehouse assignment, vendor users); actions `src/server/actions/vendors.ts`; REST API is **list-only** (`src/app/api/vendors/route.ts` GET) | Exemplary org scoping: `requireVendorReadable/Manageable` (`vendors.ts:119,132`) — cross-vendor = 404 (no existence leak) + audit; self-manage requires a manager sub-role; booking blocked until `verificationStatus = APPROVED` | No dedicated file; embedded in `bookings`, `phase3-scope-fixes`, `finance`, `phase9-reports`, `tests/unit/permissions.test.ts` | **Complete** — only caveat: REST writes are action-only |
| **Customers** | Admin/SA CRUD `admin|super-admin/customers{,/new,/[id]}` → `src/components/customers/pages.tsx` (incl. merge). Self-service is thin: home = own packages, tickets, notifications page. **No customer profile, billing, or incident-report page** | `src/server/services/customers.ts` (CRUD, addresses, phone-normalised dedupe, merge-never-delete); actions `src/server/actions/customers.ts`. **No `/api/customers` at all** | `customer.read/manage` via `requirePermAudited`; address list has explicit self-check. **But CUSTOMER holds `invoice.read`, `payment.dispute.raise`, `incident.report`, `profile.update_own` with no UI surface for any of them**, and lacks `notification.read_own` so its notifications page is a placeholder by construction (defect H-3) | No dedicated file; embedded in `bookings`, `phase3-scope-fixes`, `deliveries`, `phase10-slice2-fixes` | **Incomplete** — admin side complete; customer self-service is packages + tickets only |
| **Finance** | Finance group: home (live KPIs from `getFinanceOverview`), `invoices{,/[id]}`, `ledger`, `remittances{,/[id]}`, `settlements{,/[id]}`, `adjustments` (refunds folded into the same page — no standalone refunds route), `reports`, `incidents`, `notifications`. Admin/SA get only settlements (+ adjustments for SA) pages | Complete service set: `invoices.ts`, `cod-remittances.ts`, `settlements.ts`, `finance-adjustments.ts` (refunds + adjustments, four-eyes), `finance-ledger.ts` (balanced-journal engine, append-only), `finance-overview.ts`, `reports-finance.ts`; every operation has an action and an API route under `src/app/api/finance/**`, all gated | Per-operation codes enforced in services (`invoice.*`, `cod.read/remit/verify`, `settlement.*`, `refund.process`, `finance.adjust/approve_adjustment`); **custody separation verified**: FINANCE holds no `custody.*`/receive/delivery permissions and warehouse roles hold no payment permissions. Bottleneck: `finance.approve_adjustment` is held **only by SUPER_ADMIN** and `settlement.approve` only by ADMIN/SUPER_ADMIN, so Finance can prepare/pay but approve nothing (defect M-1) | `tests/integration/finance.test.ts`, `phase7-finance-fixes.test.ts`, finance slices of phase9 suites, `tests/unit/permissions.test.ts` | **Complete** — with the approval-bottleneck and Admin/SA-surface caveats as defects |
| **Tasks** | Board + detail for 6 roles: `{admin,super-admin,warehouse,staff,rider,transport-driver}/tasks{,/[id]}` → `src/components/operations/pages.tsx` (board, overdue section, permission-gated create). **No task UI for Finance or Support** | `src/server/services/tasks.ts` (716 lines: create/assign/transitions with assignee-only completion + second-eyes verification); API `src/app/api/tasks/{route,[id]/route}.ts` | `task.create` on create; visibility = creator OR assignee OR warehouse-scope manager; verify/close requires `task.verify` and self-verify is blocked. **Mismatch:** FINANCE and SUPPORT both hold `task.create/assign/update_own/verify` in the catalog but have no route — API-only (defect M-2) | `tests/integration/phase8-operations.test.ts` (tasks describe), `phase8-security-review.test.ts`; no dedicated file | **Incomplete** — backend and 6 role UIs are real; two permissioned roles have no UI |
| **GPS** | **Nothing exists.** No map component, no driver tracking UI, no Live Operations module (`find src -iname '*map*'/'*location*'/'*gps*'` = empty) | **Nothing exists.** No `TrackingSession`/`DriverLocationPing`/`DriverCurrentLocation` model, no location API route, no ping ingestion. Trip progress is manual `TripStop` checkpoints only | No GPS permissions exist in the catalog (nothing to enforce yet); `Driver.lastSeenAt` column exists (`prisma/schema.prisma:1340`) but has **zero reads/writes in `src/`** | **Zero** — no test file mentions GPS | **Incomplete** — absent by V1 design ("no step depends on GPS", `src/server/services/trips.ts:29`); this is V2 Objective B, built in Phases 3–5 |

**Supporting modules (audited, not in the §2.2 table):** Support Tickets — **Complete** (per-role inboxes, `src/server/services/support-tickets.ts`, ownership-validated creation, public complaint intake). Incidents — **Complete** (auto-creation from transfer/delivery/finance link points, `src/server/services/incidents.ts`, proposer ≠ approver resolution; only gap: no customer-facing incident page). Notifications — **Incomplete** (complete for staff/vendor roles; functionally absent for Customer per H-3; EMAIL/SMS channels are intent-only `NOT_SENT_NO_PROVIDER` rows, honestly disclosed in the UI — consistent with free-first).

**Verdict count: 6 Complete** (Warehouses, Inventory, Packages, Transfers, Vendors, Finance) · **5 Incomplete** (Dashboard, Drivers, Customers, Tasks, GPS).

---

## 3. Per-role audit (all 10 roles)

| Role | Dashboard route | What actually works | Missing / placeholder |
|---|---|---|---|
| **Super Admin** | `/super-admin` | Live global overview (30-day figures); warehouses (incl. members + invitations), vendors, customers, bookings, drivers, vehicles, settlements, adjustments, incidents, tasks, tickets, reports, notifications | **No users/roles management UI** (backend `src/server/services/users.ts` + actions exist, consumed only by the warehouse-scoped MembersPanel; no `/api/users`); **no settings UI** (`settings.manage` granted, `system-settings.ts` has no UI consumer); **no audit-log viewer** (`audit.read` granted, AuditLog written everywhere, read nowhere); no invoices/ledger/remittances pages; home links only 4 of ~14 modules |
| **Admin** | `/admin` | Same overview; warehouses, bookings (full incl. create/approve), customers, vendors, drivers, vehicles, settlements, incidents, tasks, tickets, reports | Byte-for-byte route mirror of Super Admin with the same gaps, **plus** no adjustments page; no Inventory/Transfers/Deliveries UI despite `read_all` permissions (API-only) |
| **Warehouse Admin** | `/warehouse` | Richest home: own warehouse(s) only — info, members (staff assignment; suspend is Admin-only by design), zones; receive/scan, full transfer lifecycle (approve/dispatch/reconcile), deliveries + rider assignment, bookings detail, returns, incidents, tasks, reports — all force-scoped to membership warehouses in services | No `bookings/new` despite holding `booking.create` (API-only); no Drivers/Vehicles pages despite holding fleet permissions (crew assignment only inline in transfer detail); no Live Operations (Phase 5) |
| **Warehouse Staff** | `/staff` | Work queues are real: receive/scan, inspection → put-away → sort chain (row actions keyed by package status), internal movements, dispatch prep, transfers prepare/load/receive, deliveries, handovers, supplies, returns, incidents, tasks. Correctly lacks create/approve/dispatch/reconcile/assign permissions, and shared components hide those controls | Home leads with the Phase-1 placeholder identity card instead of queue counts; **two dead routes**: `/staff/transfers/new` and `/staff/deliveries/new` render create flows that throw in the service (Staff lacks the permissions) and, with no `error.tsx` anywhere, surface a raw error page |
| **Delivery Rider** | `/rider` | Home with own batches, batch detail (pickup, attempts, OTP delivery, POD), COD page (collected / to-remit position), returns, tasks, reports (own performance), notifications. Isolation verified in tests (rider sees only own assignments) | **Not mobile-first**: identical desktop shell, desktop tables, 13 px text, no enlarged touch targets; no GPS tracking section (Phase 4); no on-duty/shift concept in UI |
| **Line-haul Driver** | `/transport-driver` | Own active trip (`getMyActiveTrip`), manifest view via transfer detail, depart/arrive/checkpoint/delay actions, tasks, reports, notifications | Thinnest role home (home + tasks + reports + notifications only); trip progress is manual checkpoints only — no GPS (Phase 4); no breakdown-specific flow (delay reporting exists; incidents raisable via tasks/incidents surfaces of other roles) |
| **Vendor** | `/vendor` | Org home (verification status, recent bookings), bookings (create/list/detail with tracking), billing (invoices, settlements, statement incl. COD position), reports, tickets, incidents, notifications, profile. Org scoping is exemplary (cross-vendor = 404 + audit) | No bulk-booking UI; no tasks (consistent — no `task.*` grant); pickup-address coordinates never collected (see §5) |
| **Customer** | `/customer` | Own packages (force-scoped to `actor.customerId`), each linking to public tracking; tickets raise/reply. Public tracking (`/track/[trackingId]`) is account-free with milestones + phone-gated detail, as specified | Notifications page is a placeholder (H-3); `invoice.read`, `payment.dispute.raise`, `incident.report`, `profile.update_own` grants have **no UI**; no delivery-history view beyond the package list |
| **Finance** | `/finance` | Invoices + payments + void, ledger (read-only journal + balances), COD remittances (verify/resolve), settlements (prepare/pay), refunds + adjustments (create/request), reports, incidents, notifications. Correctly **cannot** touch custody (no grants; service checks fail) | Approves nothing (M-1); no tasks UI despite `task.*` grants (M-2); refunds have no standalone route (folded into adjustments page) |
| **Support** | `/support` | Dedicated group (not served by admin folder): tickets inbox + detail with full handling (assign/resolve/close/redelivery/address-correction/escalate-to-task), incidents queue + detail, notifications | **Home page is the untouched Phase-1 placeholder** — no queue counts or KPIs, and with no nav the working tickets/incidents pages are undiscoverable from it; no tasks UI despite grants; `customer.read`/`vendor.read_all`/`booking.read_all` usable only inside ticket/incident context |

**Navigation verdict for all roles:** there is no sidebar, no top-bar menu, no global search, and no profile menu in any dashboard. `DashboardShell` (`src/components/layout/DashboardShell.tsx`) renders a header (brand, role title, notifications bell, name/email as static text, sign-out) and the page body. Movement between modules is via in-page link chips (Admin/SA home "Modules" card links only Reports/Warehouses/Vehicles/Drivers; `FinanceNav` in `src/components/finance/pages.tsx` is the only multi-link nav fragment). This is the single largest UX gap and is Phase 1's core work.

---

## 4. Defect & gap list

Severity: **High** = blocks real operations or a whole role surface · **Medium** = feature/permission mismatch, partial surface, or scaling risk · **Low** = polish, docs, or narrow edge. "Fix phase" follows the V2 plan (spec §15).

### High

| # | Defect | Evidence | Fix phase |
|---|---|---|---|
| H-1 | **No navigation system in any dashboard.** Header-only shell; no sidebar, no top-bar menu, no global search, no profile menu; modules reachable only via scattered in-page links, several Admin/SA routes linked from nowhere | `src/components/layout/DashboardShell.tsx` (own comment: full Sidebar/TopBar "lands with the module phases" — never landed); `src/app/(dashboards)/admin/page.tsx` (Modules card links 4 of ~14 modules) | **1** (UI/UX foundation: shared shell, permission-filtered nav) |
| H-2 | **Support home is the untouched Phase-1 placeholder** ("operational modules arrive in later phases") — no ticket/incident counts; combined with H-1 its working pages are undiscoverable | `src/app/(dashboards)/support/page.tsx`; `src/components/dashboards/DashboardHome.tsx` | **1 + 6** |
| H-3 | **Customer notifications are dead by construction.** CUSTOMER is not granted `notification.read_own`, but every notification service function requires it — the inbox renders an explanatory placeholder, the bell count silently returns 0, and service calls would 403 | `src/lib/permissions/catalog.ts` (CUSTOMER block); `src/server/services/notifications.ts` (requirement + silent-zero count); `src/components/operations/pages.tsx` (placeholder branch); route `src/app/(dashboards)/customer/notifications/page.tsx` | **2** (catalog correction + tests) |
| H-4 | **Super Admin has no users/roles, settings, or audit-log UI** despite finished backends and granted permissions (`user.manage`, `role.manage`, `settings.manage`, `audit.read`). User administration exists only warehouse-scoped inside a warehouse's MembersPanel | Absence of `src/app/(dashboards)/super-admin/users/` and any settings/audit page; orphaned `src/server/services/users.ts`, `src/server/actions/users.ts`, `src/server/services/system-settings.ts` (no UI consumer); no `src/app/api/users/` | **6** (role dashboard completion; backend already exists) |

### Medium

| # | Defect | Evidence | Fix phase |
|---|---|---|---|
| M-1 | **Finance approval bottleneck:** `finance.approve_adjustment` held only by SUPER_ADMIN (not even ADMIN); `settlement.approve` only ADMIN/SUPER_ADMIN. Finance prepares/creates everything but can approve nothing; the Finance adjustments page permanently hides decision buttons | `src/lib/permissions/catalog.ts`; `src/server/services/finance-adjustments.ts`; `src/server/services/settlements.ts`; `src/components/finance/pages.tsx` (`canDecideAdjustments` always false for FINANCE) | **2** (policy decision — four-eyes is intentional; whether ADMIN should hold `finance.approve_adjustment` is Meena's call) |
| M-2 | **Tasks: Finance and Support hold full `task.*` permissions but have no task UI** (API-only) | Catalog FINANCE/SUPPORT blocks; absence of `src/app/(dashboards)/{finance,support}/tasks/`; `src/server/services/tasks.ts` | **6** |
| M-3 | **Customer holds 4 permissions with no UI surface:** `invoice.read`, `payment.dispute.raise`, `incident.report`, `profile.update_own` | `src/lib/permissions/catalog.ts` (CUSTOMER block); absence of `src/app/(dashboards)/customer/{billing,incidents,profile}/` | **6** |
| M-4 | **Warehouse Admin fleet permissions orphaned:** WA holds `driver.manage/driver.assign/vehicle.assign` but Drivers/Vehicles pages exist only under Admin/SA; WA can assign crew only inline in a transfer | Catalog WA block; absence of `src/app/(dashboards)/warehouse/{drivers,vehicles}/`; `src/components/fleet/pages.tsx` | **6** |
| M-5 | **Warehouse Admin cannot create a booking in the UI** despite holding `booking.create`; `bookings/new` exists only under Admin/SA/Vendor | `src/app/(dashboards)/warehouse/bookings/` (list + detail only) | **6** |
| M-6 | **Admin/Super Admin have no Inventory, Transfers, Deliveries, or Handovers UI** despite `inventory.read_all`/`transfer.read_all` — API-only, inconsistent with their Warehouses/Bookings/Fleet UIs; Admin/SA finance UI is likewise partial (settlements ± adjustments only, no invoices/ledger/remittances pages) | Absence of `src/app/(dashboards)/admin/{inventory,operations,transfers,deliveries,supplies,handovers,invoices,ledger,remittances}/` | **6** |
| M-7 | **Staff dead create routes:** `/staff/transfers/new` and `/staff/deliveries/new` render create flows Staff is not permitted to use; the service throws and, with **no `error.tsx` anywhere in `src/`**, the user gets a raw error page instead of a graceful denial | `src/app/(dashboards)/staff/transfers/new/page.tsx`; `src/app/(dashboards)/staff/deliveries/new/page.tsx`; `find src -name error.tsx` = ∅ | **2** (remove/gate routes + app-wide error boundary) |
| M-8 | **Drivers module surface gaps:** no `/api/drivers` or `/api/vehicles` read API (Server Actions only) and **no direct tests** for driver/vehicle CRUD, licence-expiry, or employment-status logic — correctness rests on transfer/delivery side-effects | Absence of routes under `src/app/api/`; test inventory §1 | **2** (tests) + **7** (API parity if needed) |
| M-9 | **Unindexed foreign keys on high-volume join tables:** `OrderItem.orderId`, `PackageItem.packageId`/`orderItemId` have **no index at all**; `PackageLabel.packageId` unindexed. Every order→items and package→items lookup is unindexed. (All 10 headline tables — Package, TrackingEvent, InventoryRecord, PackageCustody, LedgerTransaction, Payment, DeliveryAttempt, Notification, AuditLog, LoginAttempt — DO carry deliberate `@@index` sets; the gap is these three join tables plus a systematic pattern of unindexed actor/approver `*ById` FKs, low individual risk) | `prisma/schema.prisma` (`OrderItem`, `PackageItem`, `PackageLabel` models) | **2** (additive migration, with the §8 backup discipline) |
| M-10 | **No `FileAsset` model:** file references (`User.avatarFileId`, `Driver.profilePhotoFileId`, `PackageLabel.fileId`, `DeliveryAttempt.evidenceFileId`, `IncidentEvidence.fileId`, POD `signatureFileId`/`photoFileId`) are plain `String?` columns with no FK, no referential integrity, and no upload pipeline behind them ("plain column until FileAsset lands") | `prisma/schema.prisma` comments at the fields; no upload code in `src/` | **7** (operational workflows — evidence handling) |
| M-11 | **The 5 status domains are collapsed in the UI.** Data model is correct (`Package.operationalStatus/condition/paymentStatus/deliveryStatus/exceptionStatus`, `prisma/schema.prisma`), but booking detail shows only operational status; inventory merges condition+exception into one text suffix; `paymentStatus`/`deliveryStatus` are never displayed as package fields; and there are **5 divergent status-badge implementations** (only `src/components/bookings/ui.tsx` is colour-coded) | `src/components/bookings/pages.tsx` (single Status column); `src/components/warehouse-ops/pages.tsx`; badge components in bookings/warehouses/transfers/deliveries/operations UI files | **1** (one shared badge + domain display in the design system) |
| M-12 | **Rider interface is not mobile-first** (spec §7.5/§10.7): identical desktop shell, desktop tables, 13 px text, no large touch targets, no on-duty state | `src/app/(dashboards)/rider/layout.tsx`; `src/components/deliveries/pages.tsx` | **4 + 6** (GPS interface is mobile-first by design; broader rider redesign in 6) |

### Low

| # | Defect | Evidence | Fix phase |
|---|---|---|---|
| L-1 | Vehicles are globally readable by any `vehicle.assign`/`transfer.create` holder with no warehouse scoping (acknowledged in-code as by-design; broader than the isolation applied everywhere else) | `src/server/services/vehicles.ts` (`listVehicles`/`getVehicle`) | **2** (confirm or scope) |
| L-2 | Movement-history scope edge: if a package has no open inventory record and `currentWarehouseId` is null, the warehouse-scope check is skipped and any `inventory.read_warehouse`/`custody.read` actor can read its full movement history | `src/server/services/inventory.ts` (`listPackageMovements`) | **2** |
| L-3 | Error surfacing is inconsistent: no error boundary (see M-7), most pages let service errors propagate to Next's default screen, while two spots silently swallow errors (transfer sub-panels render empty on failure; vehicle maintenance history `.catch(() => [])`) | `src/components/transfers/pages.tsx`; `src/components/fleet/pages.tsx` | **1 + 2** |
| L-4 | Status conflation on the vendor home: booking badge shows approval status (`PENDING`) in the same slot other screens use for lifecycle status | `src/app/(dashboards)/vendor/page.tsx` vs `src/components/bookings/pages.tsx` | **1** (with M-11) |
| L-5 | **Stale design docs:** `docs/database-schema.md` and `docs/system-architecture.md` still describe a `GpsPing` model, Supabase Realtime `gps_positions`, MapTiler routing and a retention job; `docs/api-reference.md` still specifies `POST /api/drivers/me/gps` and `POST /api/cron/gps-cleanup` — **none of these exist** in code or schema | `docs/database-schema.md`, `docs/system-architecture.md`, `docs/api-reference.md` vs `prisma/schema.prisma` / `src/app/api/` | **8** (docs finalisation; V2 docs supersede) |
| L-6 | REST API gaps: vendors list-only; customers and users have no API at all (writes are Server Actions only — consistent internally, limiting for future native app; note the GPS endpoints in Phase 3 should be Route Handlers per spec §13, which also sets the precedent) | `src/app/api/vendors/route.ts`; absence of `src/app/api/{customers,users}/` | **7** (if/when needed) |
| L-7 | EMAIL/SMS notifications are intent-only (`NOT_SENT_NO_PROVIDER`) — honestly disclosed in UI and `docs/known-limitations.md`; consistent with free-first (no paid gateway without approval) | `src/server/services/notifications.ts` | Accepted limitation; revisit only with an approved free channel |
| L-8 | No dedicated test suites for Vendors, Customers, Tasks, Drivers, Dashboard (coverage embedded in bookings/phase-fix/operations suites — regressions are harder to isolate per module) | `tests/` inventory (§1) | **8** (with per-phase additions) |
| T-1 | Test-harness cold-DB race: parallel suites syncing the permission catalog against an empty test DB can collide on `RolePermission` upserts (observed once, §1) | `tests/integration/phase9-reports.test.ts` setup; full-suite log 2026-11-16 | **8** (serialise catalog sync in test setup) |

**Verified clean (explicitly not defects):** no hardcoded/mock dashboard data anywhere; no non-functional buttons; package lifecycle has a single writer (enforced by a source-scan test); money is integer paisa (`BigInt`) end-to-end with no float money; statuses are `String` + DB CHECK constraints with zero Prisma enums (the documented convention); COD is never treated as revenue (ledger separation verified in finance tests); every non-public API route is auth-gated; history (TrackingEvent + InventoryMovement + AuditLog) is append-only and trigger-protected.

---

## 5. GPS — current state and gap to spec §5

### What exists today (verified exhaustively)

- **Zero GPS functionality.** Grep of `src/`, `prisma/`, `scripts/` for `geolocation`, `watchPosition`, `leaflet`, `TrackingSession`, `DriverLocation`, `GpsPing`: **0 hits in code**. The single `GPS` occurrence in `src/` is a comment.
- **The design intent is documented in code**, `src/server/services/trips.ts:27-29`: *"Manual TripStop checkpoints are the progress mechanism; no step depends on GPS."* Mirrored on the schema, `prisma/schema.prisma` (`model Trip` comment): *"GPS is optional garnish and no workflow step depends on it."*
- **Static/evidence coordinates exist in 7 places** — all `Decimal? @db.Decimal(10,7)`, all nullable:
  | Model | Fields | Wiring |
  |---|---|---|
  | `WarehouseAddress` | `latitude/longitude` | **Fully wired** — validated writes (`src/server/services/warehouses.ts`), form + display in warehouse UI. The only coordinates the app actually collects |
  | `TripStop` | `latitude/longitude` | Service accepts them (`recordCheckpoint`, `src/server/services/trips.ts`); the only UI caller sends `{ label }` only — never populated from UI |
  | `DeliveryAttempt` | `latitude/longitude` | Service accepts (`recordAttempt`); no UI caller supplies them |
  | `ProofOfDelivery` | `latitude/longitude` | Service accepts (`confirmDelivery`); no UI caller supplies them |
  | `VendorAddress` | `latitude/longitude` | **Schema-only** — vendor address schema in the service omits them entirely |
  | `CustomerAddress` | `latitude/longitude` | **Schema-only** — same omission; values could only arrive via the one-off migration script |
  | `Package` | `deliveryLatitude/deliveryLongitude` | **Dead** — 0 hits in `src/`; booking creation never sets them; always NULL for app-created packages |
- **Orphaned column:** `Driver.lastSeenAt` (`prisma/schema.prisma:1340`, documented "(from GPS pings)") has zero reads/writes in `src/`.
- **Legacy GPS (pre-rebuild, deleted):** the old system pinged driver GPS every 5 min into a `gps_tracking` table, rendered MapTiler `LiveMap`/`OrderMap`, and pruned via a `cleanup_gps_tracking()` RPC driven by a GitHub Actions cron. All of it was deleted in Phase 10 slice 1 (commit `73182fc`, 125 files) and the pre-rebuild state is preserved under git tag `pre-rebuild-checkpoint`. Current disposition is documented in `docs/known-limitations.md` ("No GPS-based reporting… retired with the old backend") and `docs/deployment-guide.md` (TripStops retained with trips; no retention job). The stale-doc divergence is defect L-5.
- **`TrackingEvent` has no `driverId` and no evidence/location fields** (driver is reachable only via Trip/DeliveryAssignment) — a design decision point for Phase 3, not a defect per se.

### Gap to spec §5 (all of it is new build)

| Spec requirement | State |
|---|---|
| `TrackingSession` / `DriverLocationPing` / `DriverCurrentLocation` models + indexes | Absent → **Phase 3** |
| Secure location ingestion (identity from session only, session-ownership + active-assignment validation, rate limit, idempotency, transactional snapshot update) | Absent → **Phase 3** |
| Freshness calculation (Fresh/Delayed/Stale/Offline/denied/not-started/unavailable) | Absent → **Phase 3** |
| Driver/rider "Location Tracking" UI (permission at assignment start, watchPosition, foreground warning, auto-stop on completion, supervisor override with audit) | Absent → **Phase 4** |
| Live Operations map (`/admin/live-operations`, `/warehouse/live-operations`, Leaflet + OSM, polling 45–60 s, scoped visibility) | Absent → **Phase 5** |
| Retention job for detailed pings (proposed 30 days, configurable) + privacy doc | Absent → **Phase 3 + docs** |
| Useful seeds already present | Warehouse coordinates are real data (usable as origin/destination markers); TripStop/attempt/POD coordinate fields can carry event-driven location stamps once a client supplies them |

---

## 6. Free-service analysis (spec §4)

### What the running app actually uses today

The new app's **entire external footprint is one PostgreSQL database** (Supabase-hosted, accessed as plain Postgres via Prisma over `DATABASE_URL`). Verified: **zero hits in `src/`** for Cloudinary, MapTiler, OpenRouteService, EmailJS, Textlocal, and even `supabase` itself — no `@supabase/supabase-js`, no Supabase Auth/Storage/REST/Realtime (authentication is Auth.js + bcrypt + in-repo TOTP against Prisma). The only non-DB Supabase touch in the repo is the one-off migration script calling the Management API. There are **no third-party `fetch` calls in `src/`** at all.

`.env.example` key names and their real status:

| Keys (names only) | Status in the new app |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | **Used** — Prisma datasource (the one real dependency) |
| `AUTH_SECRET`, `AUTH_URL`, `TRUSTED_IP_HEADER`, `MFA_SECRET_ENCRYPTION_KEY` | **Used** — read in `src/lib/auth/*` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY` | **Unread by the app** — Supabase is used as a Postgres host only; keys matter to scripts/ops, not runtime |
| `CLOUDINARY_*` (3 keys) | **Legacy leftover, unused** — no SDK, no upload code, no FileAsset model |
| `MAPTILER_API_KEY` | **Legacy leftover, unused** — no map code exists |
| `OPENROUTESERVICE_API_KEY` | **Legacy leftover, unused** — no routing code or columns |
| `EMAILJS_*` (4 keys), `TEXTLOCAL_*` (2 keys) | **Legacy leftover, unused** — EMAIL/SMS notifications degrade by design to `NOT_SENT_NO_PROVIDER` rows |
| `SEED_*` (4 keys) | Seed scripts only (local/test) |

Recommendation (Phase 2 housekeeping): prune or clearly mark the unused keys in `.env.example` and correct `docs/deployment-guide.md`, which currently frames the leftovers as "optional integrations" — the app does not call them at all.

### What V2 adds — and what it costs

| Addition | Licence/cost | Notes |
|---|---|---|
| `leaflet` (1.9.x) | BSD-2, free | Rendering library only — provides no tiles |
| `react-leaflet` (v5) + `@types/leaflet` | MIT / types, free | See §7 for compatibility |
| OpenStreetMap standard tiles | Free under the OSM Tile Usage Policy — **not** an SLA service | Attribution, caching, no bulk use (§7) |
| Browser Geolocation API | Free, built into browsers | Foreground-only (§7) |
| Polling via existing Route Handlers + Postgres | Free | No WebSocket/Pusher/Realtime subscription added |

**Confirmation: V2 adds zero paid services, zero new subscriptions, and zero new external providers.**

### Honest remaining infrastructure costs (not zero, never promised zero)

- **Application hosting** — the app is not yet deployed to a host; running it publicly needs hosting (an existing server/VPS or a platform free tier with its limits). Unchanged by V2.
- **PostgreSQL hosting** — Supabase as today; the free tier has capacity limits (the legacy GPS table was pruned precisely to stay under the old 500 MB cap). GPS pings add data volume — the Phase 3 retention policy (proposed 30 days) exists partly to bound this.
- **Bandwidth** — map tiles are served by OSM's donation-funded servers, not ours; our bandwidth grows only by small JSON polling responses.
- **Devices & mobile data** — drivers'/riders' phones and their data plans carry GPS reporting; ping intervals in the spec (2–5 min + event-driven) keep this small.
- **Domain / email / SMS** — none added. Email/SMS notification delivery remains unavailable without a provider (L-7).

---

## 7. GPS feasibility & research (spec §3, §5.9)

### Browser Geolocation — what is and is not possible

- The Geolocation API is **secure-context only** (HTTPS, or localhost) and **permission-gated**: the browser prompts on first use, the user can deny or revoke at any time, and the app must handle `PERMISSION_DENIED` / `POSITION_UNAVAILABLE` / `TIMEOUT` as first-class states (the spec's freshness/permission states map directly onto these).
- `navigator.geolocation.watchPosition()` delivers position changes while the page is **alive and in the foreground**; `clearWatch()` stops it. There is **no web API for background location**: when the tab is hidden, the screen locks, or the OS suspends the browser (aggressively on iOS Safari/WebKit; background-tab freezing on Android Chrome), updates stop and no data is captured for the gap. A PWA install does **not** change this — service workers cannot call `navigator.geolocation`.
- **Design consequence (exactly the spec's stance):** tracking is reliable only while the driver keeps the tracking page open in the foreground; the UI must show a visible warning when updates stop; freshness states (Fresh ≤ ~5 min, Delayed ~5–15 min, Stale > 15 min, Offline) make gaps honest instead of pretending continuity; the ingestion API is built so a future native app can post to the same endpoints. Phase 4 must never claim background reliability, and §14 browser tests on real devices are a Phase 8 gate, not an assumption.
- The Page Visibility API pairs with this on both sides: the driver client can pause its watch when hidden, and the admin map pauses/reduces its 45–60 s polling when the dashboard tab is hidden (spec §5.5).

### Polling design (from the spec, feasibility confirmed)

No new infrastructure is needed: a permission-filtered `GET /api/live-operations` Route Handler reading the `DriverCurrentLocation` snapshot table (one row per active driver — the map never scans ping history), polled every 45–60 s while visible, plus event-driven ping inserts from the driver client (trip start/departure/arrival/pickup/delivery events bypass the periodic interval; movement/distance threshold + dedupe + minimum interval throttle the periodic ones). At pilot scale (tens of active drivers) this is a few small queries per minute — trivially within the existing Postgres capacity.

### Package compatibility — verified against official sources

| Package | Finding |
|---|---|
| **react-leaflet v5.0.0** | Peer dependencies: `react ^19`, `react-dom ^19`, `leaflet ^1.9` — **matches this app exactly** (React 19.3, Next.js 16). ESM-only distribution (CommonJS/UMD removed in v5); TypeScript definitions bundled; `@types/leaflet` still required for Leaflet's own types. |
| **SSR caveat (binding)** | React Leaflet's own documentation/README states the library "is not compatible with server-side rendering" — Leaflet touches `window`/`document` at import time, and `'use client'` alone is insufficient because client components are still pre-rendered on the server. **Required pattern:** isolate the map in a client component and load it via `next/dynamic` with `ssr: false`; import `leaflet/dist/leaflet.css` explicitly; set an explicit container height; handle Leaflet's default marker-icon asset URLs under the bundler. This is an integration pattern, not a blocker. |
| **leaflet 1.9.4** | Current stable 1.9.x line; satisfies react-leaflet v5's `^1.9` peer. BSD-2 licence. |
| **Next.js 16** | No conflict: the map is a client-side island inside an App Router page; data flows through Route Handlers (polling) as the spec prescribes. |

### OpenStreetMap tile policy — obligations (from the official policy)

Using `https://tile.openstreetmap.org/{z}/{x}/{y}.png` obliges us to: display **visible licence attribution** ("© OpenStreetMap contributors", typically bottom-right, never hidden behind toggles); send a **valid HTTP Referer** (browsers do this automatically from web pages) and a valid User-Agent for any non-browser fetching; **cache tiles per HTTP caching headers** (or ≥ 7 days); **never bulk-download, prefetch regions, or use tiles offline**; keep usage to reasonable application traffic — the servers are donation-funded, capacity is limited, there is **no SLA**, and abusive use may be blocked without notice. Design consequences already in the spec and confirmed here: pilot on the standard endpoint with attribution, tile provider **configurable** (a single constant) so production growth can move to self-hosted OSM-data tiles on existing infrastructure, and no route/ETA invention (no routing service is free at SLA grade; the map shows origin, destination, current position, and last update only).

### Sources (official)

- React Leaflet documentation — https://react-leaflet.js.org/ (components, setup, SSR incompatibility)
- Leaflet reference — https://leafletjs.com/reference.html
- OpenStreetMap Tile Usage Policy — https://operations.osmfoundation.org/policies/tiles/
- MDN, Geolocation API — https://developer.mozilla.org/en-US/docs/Web/API/Geolocation
- MDN, `Geolocation.watchPosition()` — https://developer.mozilla.org/en-US/docs/Web/API/Geolocation/watchPosition
- MDN, Page Visibility API — https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API
- Next.js, Authentication guide — https://nextjs.org/docs/app/guides/authentication · Route Handlers — https://nextjs.org/docs/app/getting-started/route-handlers
- OWASP, Authorization Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html
- shadcn/ui — https://ui.shadcn.com/docs · Vercel Geist — https://vercel.com/geist/introduction (Phase 1 design references)
- Nepal Privacy Act 2075 (2018) — reference for the Phase 3 retention/privacy review

**Feasibility verdict: GO.** Every V2 GPS requirement is implementable with the prescribed free stack on the existing architecture, with two honest limits that the design already respects: (1) browser GPS is foreground-only — freshness states and warnings, never fake continuity; (2) public OSM tiles are best-effort — configurable provider, attribution, no dependence beyond pilot scale.

---

## 8. Backup & rollback note (for Phases 2–3, before any migration)

**Live state at V2 start (read-only snapshot taken 2026-11-16):** Supabase project `glpysnaaoazoqxntwafl`, schema `app`: **79 tables, 1,015 columns, 280 indexes, 1,109 constraints**. Sample row counts: 9 users, 9 invitations, 4 warehouses, **0 packages** (no operational data yet — the only live records are the migrated master data and user shells from go-live). Full snapshot saved at `~/workspace/goals/bla-v2-live-gps-operations-ui-ux-redesign-free-first/hidden_files/live-app-schema-snapshot-v2-start.json` (goal workspace, not committed). Legacy `public` schema remains untouched, as throughout V1. Note: Meena reset the DB password himself on 2026-11-16, so Muse's stored `LIVE_DATABASE_URL` is stale — live SQL goes through the Management API (read-only in this phase), and any future live Prisma work needs a fresh connection route agreed with Meena.

**Rollback strategy for later phases:**

1. **Git:** tag `pre-v2-checkpoint` on `main` before the first V2 code change lands (V1's `pre-rebuild-checkpoint` tag is the precedent); every phase is small, verified commits that can be reverted independently.
2. **Schema:** a fresh Management-API schema snapshot (same method as this phase) is taken immediately before **every** live migration; migrations are **additive-only** (new tables/columns/indexes — the Phase 3 GPS models and the M-9 index additions qualify) so a rollback is "deploy previous code; new schema objects sit unused" rather than a destructive down-migration. No live migration runs without Meena-visible phase sign-off, per the standing gate.
3. **Data:** never wipe, regenerate, or re-key existing records (standing rule). The Phase 3 GPS tables start empty by construction; the only pre-existing live data at risk in any V2 phase is master data + user accounts, which no V2 phase needs to mutate.
4. **Local first:** every migration is proven on local `bla_dev`/`bla_test` (migrate deploy + full suite) before any live application, exactly as in V1.

---

## Appendix A — Independent AI review question sets (spec §3.1) — PREPARED, NOT RUN

*Prepared by the Phase 0 coordinator for the parent agent to run with ChatGPT and Gemini. No keys, passwords, or customer records are to be included — architecture and code-structure questions only. Each set is run independently with both models; answers are to be validated against official docs before any is adopted.*

### A.1 Architecture review
1. Given an Order → Shipment → Package model with a single-writer lifecycle service and five separate status domains (operational/condition/payment/delivery/exception), is the database design correct and complete for a multi-warehouse parcel operation? What would you change?
2. Warehouse permissions are enforced inside services (permission code + active membership scoping, denials audit-logged). Is this secure against a user modifying request parameters to reach another warehouse? What attack paths remain?
3. Are the custody and transfer workflows (one open inventory record + one open custody record per package, manifest-based transfers, reconciliation) logically consistent? Where can custody and recorded state diverge?
4. Financial records use an append-only balanced journal (integer minor units), reversals as compensating entries, and four-eyes approvals. Is this reliable for COD reconciliation and vendor settlements? What failure modes remain?
5. A GPS design stores TrackingSession + DriverLocationPing + a DriverCurrentLocation snapshot; the live map reads only snapshots; pings are throttled (2–5 min + event-driven) and retained 30 days. Is this efficient and correctly indexed? What would break at 100 concurrent drivers?
6. Statuses are stored as strings with database CHECK constraints and a code-level transition table, rather than Postgres enums. Trade-offs in this context?
7. Which of these is the highest-risk scaling bottleneck in year one: snapshot-table polling, tracking-event volume, or ledger growth — and why?

### A.2 UI review
1. A dashboard shell must serve 10 roles (from warehouse staff to super admin) with one shared, permission-filtered navigation. What structure keeps it intuitive without overwhelming low-frequency roles?
2. Are the important actions (receive, dispatch, assign rider, investigate incident) easy to locate if navigation is grouped by operations rather than by data entity?
3. The design target is calm and minimal (Linear/Geist/shadcn-like): neutral palette, one accent, no KPI walls. Review this direction for an operations tool used under time pressure — where does minimalism hurt?
4. Are there too many cards or unnecessary controls in a home layout of: 4–6 metrics, needs-attention list, current operations, recent activity, quick actions?
5. For a mobile rider interface (large touch targets, one active job, GPS state, COD position), what are the three most common usability failures in logistics apps, and how are they avoided?
6. A live operations map pairs a map with a side list of active movements. What makes this scannable at a glance, and what should never be on it?

### A.3 Security review
1. Can a warehouse user access another warehouse's records by modifying a package ID, warehouse ID, or transfer ID in a request, if checks live in the service layer (permission + membership) rather than in route handlers? What must be true for this to hold?
2. Can a driver forge a delivery status (e.g. mark delivered without being at the recipient) in a system with OTP + proof-of-delivery records? What additional evidence is proportionate?
3. A GPS endpoint derives driver identity only from the authenticated session and requires an active tracking session owned by that user. Can a user submit location data for another driver or after their trip completes? Walk the attack tree.
4. Payments use idempotency keys and an append-only ledger. Can a payment be duplicated by retry, double-submit, or concurrent requests? What invariant must the database enforce?
5. Package history is append-only with trigger protection. Can a privileged user modify previous tracking events through any application path? What about through direct database access, and how should that be governed?
6. Invitation tokens are stored hashed, single-use, expiring. What are the residual risks in an invitation-based first-login flow for privileged roles?

---

## Appendix B — Audit trail

- Auditors: 4 independent sub-agents (operations modules; business modules; GPS/schema/external-services; test coverage + UI shell), each read-only, every claim carrying a file path; coordinator re-verified headline claims (shell, catalog, schema counts, env usage) directly.
- Baseline commands run locally on 2026-11-16 against `main` @ `84f3f00`; local Postgres rebuilt (role/DBs/migrations/seed) before the valid test run, as recorded in §1.
- Live snapshot method: Supabase Management API, `information_schema`/`pg_indexes` SELECTs only; snapshot file lives in the V2 goal workspace (`hidden_files/`), never in the repo.
- This document is the Phase 0 deliverable. Phase 1 (UI/UX foundation) starts from defects H-1, M-11, L-3/L-4; Phase 2 from H-3, M-1, M-7, M-8 (tests), M-9, L-1, L-2.

## Appendix C — Independent AI review synthesis (spec §3.1) — RUN 2026-11-16

Both question sets from Appendix A were run independently by the parent agent: ChatGPT (web, Free plan) and Gemini (web, free tier), 2026-11-16. No credentials, keys, or customer data were shared — architecture and code-structure questions only. Every suggestion below was validated against the actual V1 design and the V2 spec before adoption; the full reviews and per-item validation notes are kept in the V2 goal workspace.

**Convergent verdict (both models):** the V1 architecture is fundamentally sound — keep Order → Shipment → Package, the single-writer lifecycle service, the five status domains as strings + CHECK + transition table, service-layer warehouse authorisation, append-only balanced journal, manifest transfers, and the snapshot-based GPS design. Neither model recommends replacing any of it. The residual risks both name are concurrency, atomicity, and cross-resource authorisation details — which is where the items below land.

**Adopted — Phase 2 (core validation):**
- Cross-resource IDOR discipline: validate parent and child resources together; bulk operations all-or-nothing; exports and background jobs under the same scope policy as interactive reads/writes.
- Cross-domain status invariants: a delivered package must have a completion record; a refund must reference a valid original payment; an unresolved missing-package incident must not be silently cleared by a normal status update.
- Lifecycle concurrency: transitions must be state-guarded so two simultaneous requests cannot both succeed.
- Journal balance as a database-enforced posting invariant (deferred constraint/trigger), not service-level only.
- Payment idempotency: database UNIQUE index on the idempotency key, a stored request fingerprint (same key + different payload ⇒ reject), and business-level uniqueness so one COD obligation can never be settled beyond its outstanding amount.
- Invitation hardening checks: atomic token consumption, rate limiting on the redemption endpoint; four-eyes approval for privileged-role invitations as a small candidate item.

**Adopted — Phase 3 (GPS backend):**
- Session validation atomic with the write: the TrackingSession row is locked inside the same transaction that inserts the ping and updates the snapshot; session stop takes the same lock (closes the validate-then-close race both models walked).
- Conditional snapshot upsert: an older recordedAt/sequence must never overwrite a newer snapshot.
- Indexes: TrackingSession(driverId, status); partial unique index for one ACTIVE session per driver; DriverLocationPing(trackingSessionId, recordedAt DESC); DriverCurrentLocation unique per driver.
- Ping validation: coordinate/accuracy/timestamp ranges, implausible future timestamps rejected, abandoned sessions expired server-side.

**Adopted — Phases 1/5/6 (UI):** navigation grouped by operations with contextual actions on the work queues themselves; urgency never visually quiet (failed scans get unmistakable feedback, not vanishing toasts); quick actions as a compact permission-filtered toolbar rather than card walls; rider targets 44–48px and few-tap flows; a GPS indicator must never look active when permission is revoked or tracking is paused; the live map leads with freshness, synchronises marker↔list selection, and never shows historical pings, phone numbers, or financial data.

**Considered and rejected (with reason):** ShipmentLeg/PackageRelation lineage entities (not in the V2 spec; the Transfer/Trip model covers movements — future consideration only); PostgreSQL row-level security (fragile with Prisma + pooled connections; service scoping + adversarial tests are the V2 control); offline/local-first rider queues and device attestation (impossible or out of scope for a foreground, online-by-design browser app — GPS and delivery evidence stay indicative, never proof, per spec §5.2); removing Recent Activity from dashboards (conflicts with spec §10.4); hash-chained audit logs (disproportionate here). Points where a reviewer assumed a missing structure that already exists (PackageItem junction, returns flow, transactional notifications, atomic transfer transactions) were verified against the schema and are re-verification items in Phases 2/7, not rebuilds.

---

## Addendum — V2 final state (Phase 8, 2026-11-16)

This audit describes the platform as found at V2 Phase 0
(`main` @ `84f3f00`, V1 complete). It is a point-in-time record and
has **not** been rewritten. What changed since, in brief:

- The Phase 1–7 build programme this audit scoped is **complete**:
  the navigation-registry shell (Phase 1), core validation and
  hardening (Phase 2), the GPS backend (Phase 3), the driver
  tracking panel (Phase 4), the Live Operations map (Phase 5),
  role-home completion and four-eyes invitations (Phase 6), and
  the Phase 7 completions (pickup leg, cross-warehouse returns,
  `REASSIGNED` tracking end, POD evidence hash-binding, bulk
  booking) are all built. Defect references (H-*, M-*, L-*, T-*)
  in this audit should be read as *findings at Phase 0*; their
  dispositions live in the phase records and in
  `docs/security-review.md` / `docs/known-limitations.md`.
- Generated final-state counts (Phase 8): **84 Prisma models,
  10 roles, 100 permissions, 98 API Route Handler files** — lists
  in `docs/database-schema.md` §14,
  `docs/role-permission-matrix.md` §7 and
  `docs/api-reference.md` §21.
- The canonical workflow references are now
  `docs/warehouse-transfers.md`, `docs/driver-operations.md` and
  `docs/delivery-operations.md`; the stack/cost position is in
  `docs/free-technology-stack.md`; production gating items are in
  `docs/deployment-guide.md` (Production Readiness Checklist).
- Still open at Phase 8 (unchanged by this addendum): the
  pre-production real-device GPS checklist and the Nepal Privacy
  Act 2075 legal review (`docs/known-limitations.md`), plus the
  open decisions listed in the deployment guide.
