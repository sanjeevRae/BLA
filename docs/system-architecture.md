# System Architecture — BLA Logistics Platform (Next.js Rebuild)

**Status:** Phase 0 design document · 2026-11-15 — **updated to V2 final state in Phase 8 (2026-11-16), §11.** Sections 1–10 are the original design record; where the built system differs (GPS, maps, realtime), §11 governs.
**Sources:** master specification (Parts 3, 20, 22, 24, 25), `BLA-audit/backend-audit.md`,
`BLA-audit/frontend-audit.md`, `BLA-audit/database-audit.md`
**Companion documents:** `database-schema.md`, `entity-relationships.md`,
`role-permission-matrix.md`, `security-architecture.md`, `api-reference.md`,
`package-lifecycle.md`, `deployment-guide.md`

---

## 1. Target architecture at a glance

The rebuilt BLA is **one Next.js application** (App Router, TypeScript) that replaces
four deployables (Vite admin SPA, customer-tracking, driver-app, vendor-portal) and the
FastAPI backend with a **modular monolith**:

| Layer | Technology | Notes |
|---|---|---|
| Framework | Next.js (App Router) + TypeScript | One codebase, one deployment. Server Components by default; client components only where interactivity requires them. |
| UI | Migrated admin-dashboard components + Tailwind CSS | Existing design system carried over token-for-token (§7). No generic admin template. |
| Database | PostgreSQL — the **existing Supabase project** | Same database the old system uses. New schema is built by Prisma migrations alongside the old tables; master data (4 warehouses, 9 users, 4 drivers, 4 vehicles, 5 warehouse memberships) is carried over; demo transactional data is not (database audit §2.1). |
| ORM | **Prisma** (only ORM — never mixed with Drizzle) | All data access goes through Prisma via the repository layer (§3). Multi-write flows run in real database transactions — the old backend had none (backend audit §5). |
| Authentication | **Auth.js** (credentials provider), database sessions, HTTP-only cookies | One login page for every role (spec Part 21 + owner's requirement). Replaces both old auth systems (§8). |
| Authorization | RBAC + resource-based checks, enforced server-side | Permission catalog in `role-permission-matrix.md`; design in `security-architecture.md`. |
| Validation | Zod | One schema per input, shared between forms and server actions. |
| Forms | React Hook Form where appropriate | Bound to the same Zod schemas. |
| Mutations | Server Actions for dashboard workflows; Route Handlers for public/API surfaces | Both call the same service layer — business logic exists exactly once (spec Part 22). |
| File storage | Cloudinary, **private** assets with signed URLs | Replaces the old public-URL proof-of-delivery upload (§6). |
| Realtime | Supabase Realtime (Postgres changes) | The old system's fan-out mechanism, kept and re-scoped (§5). |
| Background jobs | Database-backed job records + scheduled Route Handlers | No new paid services, no queue infrastructure (§9). |
| Notifications | In-app first; EmailJS (email) and Textlocal (SMS) as providers | Same providers the old backend used, behind a NotificationService (§4). |
| Currency / time | **NPR** everywhere; timestamps stored UTC, displayed Asia/Kathmandu | Fixes the old schema's INR / `country='IN'` defaults (database audit §5). |

### Why a modular monolith

Per spec Part 3.2: one application, one centralized database, separate business
modules, shared authorization/lifecycle/inventory/transfer/finance services. The old
system's failure mode — the same rule implemented differently in two routers
(e.g. district comparison case-sensitive in `warehouse_intake.py`, case-insensitive in
the workflow path) — is exactly what shared domain services prevent.

---

## 2. Layer model (spec Part 3.3)

Every request flows through five layers. Dependencies point **downward only**; a lower
layer never imports from a higher one.

```
┌─────────────────────────────────────────────────────────────────┐
│ PRESENTATION   app routes, pages, forms, tables, charts          │
│                (Server Components read via services;             │
│                 Client Components call Server Actions)           │
├─────────────────────────────────────────────────────────────────┤
│ APPLICATION    use-case orchestration: BookingService creates    │
│                order+shipment+packages in one transaction;       │
│                TransferService runs dispatch→receive→reconcile   │
├─────────────────────────────────────────────────────────────────┤
│ DOMAIN         pure rules: lifecycle transition table, custody   │
│                rules, billable-weight & pricing rules, COD and   │
│                settlement math, authorization policies           │
├─────────────────────────────────────────────────────────────────┤
│ DATA ACCESS    Prisma repositories; every query takes an         │
│                ActorContext and applies warehouse/vendor/driver  │
│                scope inside the query                            │
├─────────────────────────────────────────────────────────────────┤
│ INFRASTRUCTURE Prisma client, Auth.js, Cloudinary, Supabase      │
│                Realtime, EmailJS/Textlocal, MapTiler/ORS,        │
│                structured logging, job runner                    │
└─────────────────────────────────────────────────────────────────┘
```

- **Presentation** — `src/app/**` pages and `src/components/**`. Pages never query
  Prisma directly; they call services (reads) and Server Actions (writes).
- **Application** — `src/server/services/**` (spec Part 22 list, §4). One service owns
  one workflow end-to-end, including its transaction boundary.
- **Domain** — `src/modules/*/domain/**` and `src/lib/permissions/**`: the package
  lifecycle transition table (spec Part 7.3), volumetric/billable weight rules
  (Part 6.3), settlement state machine, permission definitions. Pure functions,
  unit-tested (see `testing-strategy.md`).
- **Data access** — `src/server/repositories/**`. Repository functions accept an
  `ActorContext` (authenticated user id, roles, permission set, warehouse membership
  ids, vendor id, driver id) and build scoped Prisma queries. There is no unscoped
  "get everything" repository function exposed to request handlers.
- **Infrastructure** — `src/lib/db` (Prisma singleton), `src/lib/auth`, `src/lib/storage`,
  `src/lib/logging`, provider clients. Server-only; nothing in this layer is imported
  by a Client Component.

---

## 3. Module map (spec Part 25, adapted to this codebase)

```text
src/
  app/
    (public)/
      login/                 # ONE login page for all roles
      register/vendor/       # vendor self-registration → pending verification only
      tracking/              # public tracking (replaces customer-tracking/)
      forgot-password/  reset-password/
    (dashboards)/
      super-admin/           # organization dashboard (Part 4.1)
      admin/                 # operations dashboard (Part 4.2, nav per Part 19)
      warehouse/             # warehouse admin (Part 4.3)
      staff/                 # warehouse staff/operator (Part 4.4)
      rider/                 # pickup/delivery rider (Part 4.5; replaces driver-app micro flow)
      transport-driver/      # line-haul driver (Part 4.6; replaces driver-app big flow)
      vendor/                # vendor portal (Part 4.7; replaces vendor-portal/)
      customer/              # signed-in customer view (tracking stays public)
      finance/               # finance/accounts (Part 4.9)
      support/               # customer support (Part 4.10)
    api/                     # Route Handlers — see api-reference.md
      auth/[...nextauth]/  files/  public/track/  webhooks/  cron/  …
    layout.tsx  globals.css  # Tailwind + migrated design tokens (§7)

  components/
    ui/          # Button, Input, Badge, StatusPill, Modal, DataTable primitives
    layout/      # Sidebar, TopBar, PageHeader (migrated from admin-dashboard)
    dashboards/  # StatsBar/MetricCard, role dashboard panels
    tables/      # DataTable + ListPage pattern (migrated)
    forms/       # shared field kit (replaces the per-file FIELD/BTN constants)
    charts/      # RevenueChart, Sparkline, Donut (hand-rolled SVG, migrated)
    maps/        # LiveMap, OrderMap (MapTiler SDK)
    tracking/    # public progress tracker, timeline
    warehouse/   packages/   transfers/   delivery/

  modules/                 # business modules (domain + application logic)
    auth/  users/  warehouses/  bookings/  orders/  shipments/  packages/
    inventory/  custody/  transfers/  transport/  drivers/  delivery/
    returns/  vendors/  customers/  finance/  cod/  settlements/
    tasks/  incidents/  notifications/  reports/

  lib/
    auth/         # Auth.js config, session helpers, requirePermission()
    permissions/  # permission catalog + policy functions
    db/           # Prisma client
    validation/   # shared Zod schemas
    storage/      # Cloudinary private upload + signed URL helpers
    realtime/     # Supabase browser client (anon key) + channel helpers
    logging/  errors/  security/   # error envelope, headers, rate limiting

  server/
    services/       # Part 22 services (§4)
    repositories/   # scoped Prisma repositories
    policies/       # resource-level authorization policies

  types/            # shared TypeScript types (ActorContext, envelopes, DTOs)

prisma/
  schema.prisma     # new schema — see database-schema.md
  migrations/
  seed.ts           # development seed only (roles, permissions, settings)

tests/  unit/  integration/  e2e/
docs/               # this document set
```

Route-group notes:

- **One `(dashboards)` tree, role-gated by layout.** Each role group's `layout.tsx`
  calls `requirePermission`/role checks server-side and renders that role's sidebar
  configuration. A warehouse admin who manually types `/admin/…` gets a server-side
  403, not a hidden menu (spec Part 21.3).
- **Admin navigation** follows spec Part 19's 22 modules, grouped in the migrated
  Sidebar (Overview · Operations: Orders, Packages, Inventory, Transfers, Trips and
  Vehicles, Drivers, Assignments · Network: Warehouses, Vendors, Customers ·
  Work: Tasks, Exceptions and Incidents · Money: Finance, Payments, COD Management,
  Vendor Settlements · Insight: Reports, Notifications, Audit Logs · System: Users
  and Roles, Settings). This supersedes the old console's 13 flat sections while
  keeping its sidebar component, badge counts and status card.
- **The old static apps become route groups**, not separate deployables:
  `customer-tracking/` → `(public)/tracking`, `driver-app/` → `(dashboards)/rider` +
  `(dashboards)/transport-driver`, `vendor-portal/` → `(dashboards)/vendor`.

---

## 4. Central services (spec Part 22)

All services live in `src/server/services/`. A workflow exists in exactly one service;
Server Actions, Route Handlers and jobs all call the same function.

| Service | Responsibility (one line) | Old code it absorbs |
|---|---|---|
| AuthenticationService | Auth.js integration, session lifecycle, password reset, login-attempt recording | `routers/auth.py`, `core/auth.py` (partially) |
| AuthorizationService | Permission checks, ActorContext construction, warehouse/vendor/driver scope resolution | `core/auth.py` role sets + every handler's inline role lists |
| UserService | Account creation by admins, role assignment, suspension (+ session revocation), invitations | The `/auth/signup` hole becomes an admin-only operation here |
| WarehouseService | Warehouse CRUD (deactivate, never delete), zones, storage locations, operating hours, capacity status | `GET /ops/warehouses` + new |
| WarehouseMembershipService | Assign/revoke staff & admins per warehouse; the scope source for all warehouse queries | Formalizes the live-only `warehouse_memberships` table (database audit §3.1) |
| BookingService | **The single booking path**: creates Order + Shipment + Packages + labels in one transaction; approval queue; counter intake mode | Classic `POST /orders`, `POST /workflow/orders`, **and** `POST /warehouse-intake/` (legacy parallel path, deleted) |
| OrderService | Order reads, eligible edits by stage, cancellation workflow | `routers/orders.py`, workflow order reads |
| ShipmentService | Shipment grouping, partial-fulfilment state | Parts of `services/workflow.py` |
| PackageService | Package detail assembly (Part 24.4), holds, corrections | `routers/shipments.py` reads |
| PackageLifecycleService | **The only way a package status changes**: validates the transition table, writes the TrackingEvent, updates custody/inventory — one transaction | `PATCH /shipments/{id}/status`, `PATCH /orders/{id}/status`, **and the Postgres trigger `log_order_status_change`** (see §8) |
| TrackingService | Public + internal timeline assembly from TrackingEvents | `delivery_status_history` + `shipment_events` + `order_events` (three fragmented trails → one) |
| CustodyService | Handovers with counts; mismatch auto-creates a discrepancy incident | `/warehouse/handovers*`, live `shipments.custody_*` columns |
| InventoryService | Parcel inventory, internal movements, supplies stock + movements, capacity warnings | `GET /ops/inventory`, live `inventory`/`inventory_movements` |
| TransferService | Transfer draft → manifest → approval → load scans → dispatch → receive scans → reconciliation → close | `/warehouse/transfers*` (single-parcel, no reconciliation today) |
| ManifestService | Manifest assembly, expected-vs-received comparison | `trip_manifests` handling in `routers/trips.py` |
| TripService | Trip lifecycle, checkpoints, incidents, driver/vehicle reassignment with custody handover | `routers/trips.py` |
| VehicleService | Fleet registry, availability, maintenance/expiry blocking | `routers/vehicles.py`, `GET /ops/vehicles` |
| DriverService | Driver profiles, capabilities (pickup/delivery/combined/line-haul), availability from assignments, documents | `routers/drivers.py` |
| DeliveryService | Assignment (with RoutingService), batches, attempts, OTP/signature/photo proof, COD capture at confirm — one transaction | `POST /orders/{id}/assign`, `routers/driver_tasks.py` incl. its hidden COD side effects, `POST /drivers/pod` |
| ReturnService | Return authorization, collection, receiving, inspection, vendor notification, charges | New (statuses only, today) |
| VendorService | Vendor registration/verification lifecycle, vendor users, addresses, statements | `routers/vendors.py` |
| CustomerService | Customer records, duplicate resolution, recipient-side requests | `routers/customers.py` (currently unauthenticated — gated here) |
| PaymentService | Payments, allocations, gateway sessions + webhooks (NPR), refunds as reversals | `routers/payments.py`, `PATCH /workflow/orders/{id}/payment` |
| CODService | Collection register, driver remittances, verification, discrepancy incidents | The `cod_collections` insert hidden inside driver-task updates |
| SettlementService | Vendor payable from the ledger, settlement lifecycle, statements | `routers/settlements.py` |
| TaskService | Work tasks, comments, submission/verification workflow | New (old `/tasks` router was cron-only) |
| IncidentService | Exceptions/incidents across all Part 16 categories, investigation workflow | New (only free-text exception columns exist today) |
| NotificationService | In-app notifications + preferences; EmailJS/Textlocal dispatch with dedupe keys | `services/notifications.py`, `admin_notifications` feed |
| ReportingService | All dashboards/reports as SQL aggregations over real tables | `services/analytics.py` (531 lines of Python aggregation) |
| AuditService | Immutable AuditLog writes for sensitive actions and denied access | New (no general audit log exists today) |
| RoutingService | MapTiler → OpenRouteService route calculation, server-side | `services/routing.py` (workflow path gains the route calc it never had) |

---

## 5. Realtime

The old system's realtime fan-out is **Supabase Realtime over Postgres changes**
(FastAPI provides no WebSockets — backend audit §8 #15). The rebuild keeps this
mechanism; the database stays on Supabase, so no new realtime infrastructure is
introduced.

**What is subscribed to** (new schema equivalents of today's publication tables
`orders`, `gps_tracking`, `shipments`, `driver_tasks`, `trips`, `checkpoints`,
`shipment_events`):

| Channel (per old naming) | New source | Consumers |
|---|---|---|
| `orders-live` | `packages` / `orders` changes | Admin + operations dashboards refresh |
| `drivers-live` | `gps_positions` inserts | LiveMap markers (big/line-haul drivers only, as today) |
| `track-<id>` | `tracking_events` + `gps_positions` for one shipment | Public tracking page progress + driver position |
| `notifications-<userId>` | `notifications` inserts | Bell/badge in every dashboard |

**Authorization for realtime.** Browsers connect with the Supabase **anon key** only.
Because authentication is Auth.js (not Supabase Auth), the server mints a short-lived
Supabase-compatible JWT (HS256, signed with `SUPABASE_JWT_SECRET`) after login,
carrying our user id and role claims; the browser client passes it via
`realtime.setAuth()`. Row-Level Security policies on the realtime-exposed tables
(packages, tracking events, GPS positions, notifications) are written against those
claims, so a vendor's browser physically cannot subscribe to another vendor's rows.
This is the one place RLS is load-bearing — as a transport filter for subscriptions;
application authorization still lives in the service layer (see
`security-architecture.md` §10). `SUPABASE_JWT_SECRET`, blank in the old `.env`,
becomes a required server-only secret for this purpose.

**GPS ingestion changes.** Today drivers write GPS both via `POST /drivers/gps` and
directly into Supabase with the anon key. In the rebuild there is **one write path**:
the rider/transport apps POST pings to `POST /api/drivers/me/gps`; DeliveryService
validates and inserts via Prisma; Realtime broadcasts the insert. Ping cadence stays
5 minutes (frontend audit §8.2), positions are telemetry, and the retention job (§9)
prunes old pings as today.

---

## 6. File storage

Old state: exactly one upload — proof-of-delivery photos to Cloudinary with **public**
URLs, no type/size validation, URL stored on the package row (backend audit §4.11).

New design:

- All uploads go through `POST /api/files/upload` (authenticated, purpose-scoped:
  `pod`, `damage-photo`, `vendor-document`, `driver-document`, `incident-evidence`,
  `task-evidence`). The server validates content type by sniffing bytes (not the
  browser's MIME or extension), enforces per-purpose size limits, generates a safe
  random filename, and uploads to Cloudinary with **authenticated (private) delivery
  type**.
- Every file is a `FileAsset` row (owner, purpose, related entity, uploaded-by,
  content type, size). Business tables reference the FileAsset id — never a raw URL.
- Reads go through `GET /api/files/[id]/signed-url`: the server checks the caller's
  permission on the related entity (e.g. vendor sees POD for its own shipments only),
  then returns a Cloudinary signed URL valid for minutes. Private documents (driver
  licences, vendor verification documents) are never publicly addressable.
- Delivery proof capture (photo at the door) uses this path with purpose `pod`,
  replacing `POST /drivers/pod`.

---

## 7. Preserved design system (frontend audit §6, §9)

The admin console's design is carried into the Next.js UI unchanged in language:

- **Tailwind tokens ported 1:1** into the new `tailwind.config` + CSS variables:
  page `#F5F7FA`, surface `#FFFFFF`, cream `#F1F5F9`, ink `#0F172A`, slate2 `#64748B`,
  faint `#94A3B8`, brand `#2563EB`, accentbg `#EFF6FF`, green `#16A34A` /
  greenbg `#E8F7EE`, orange `#EA580C` / orangebg `#FFF1E6`, purple `#7C3AED` /
  purplebg `#F1E9FD`, red `#DC2626`, amber `#F59E0B`, line `#E6EBF0`. Map colours reuse
  the same palette (route blue, warehouse amber, destination violet, delivery green).
- **Shape & rhythm:** flat cards with 1px `line` borders instead of shadows, radius
  tokens 2/3/4 px, content max-width 1450px, system font stack (no webfont),
  `.tnum` tabular numerals for money/counts, micro-labels 11px uppercase
  tracking-[0.14em], page titles 22–26px, section titles 15px.
- **Money formatting kept verbatim:** `fmtINR` semantics renamed in code only —
  output stays `Rs. ` prefix with **en-IN** grouping, plus `fmtCompactINR` compact
  form (k / L / Cr). Currency is NPR; the formatting convention is the business's own
  and does not change.
- **Components migrated, not redrawn:** Sidebar, TopBar, PageHeader, DataTable +
  ListPage pattern, StatsBar/MetricCard (8 KPI cards with sparklines and % change),
  the hand-rolled SVG charts (**RevenueChart, Sparkline, Donut** — no chart library is
  introduced), StatusPill/Badge, LiveMap and OrderMap (MapTiler SDK), OrdersList,
  AssignPanel, ApprovalQueue, OrderDetail (map + journey stage bar + timeline),
  VehicleDetail.
- **StatusPill is extended, not replaced:** its colour map grows from the 7 old order
  statuses to the spec's separate tracks — operational status, package condition,
  payment status, delivery status, exception status (spec Part 7.2) — using the same
  pill visuals.
- **Fixes applied during migration:** the Tailwind content glob is corrected to
  include `.ts/.tsx` (today's glob silently drops TSX-only classes); the shared form
  kit (`FIELD`/`BTN` constants, currently duplicated per file) becomes
  `components/forms`; `window.confirm` is replaced by the modal pattern already used
  by the order dialog; dead UI (sidebar Notifications/Help buttons, placeholder
  Quick Actions, decorative date button, the hard-wired 120-day window) is either
  wired to real data or removed — nothing ships non-functional (spec Part 1.3).
- **The TSX login/signup pages' separate visual language** (default slate palette,
  `rounded-2xl`, `shadow-xl`) is **discarded**; the new single login page is built in
  the console token system, like the old in-console `Login.jsx` already was.

---

## 8. Replacement map — old piece → new piece

| Old piece | Replaced by |
|---|---|
| 17 FastAPI routers (~81 endpoints) | Server Actions (dashboard mutations) + Route Handlers (`/api/**`) over the same services — full mapping in `api-reference.md` |
| Classic `POST /orders` **and** Phase-3 `POST /workflow/orders` (two order paths writing one table differently) | **One BookingService** (§4); order numbers `BLA-YYYY-NNNN` and tracking codes `BLA-PAR-YYYY-NNNNNN` formats preserved, generated with DB unique constraints + retry instead of probe loops |
| `POST /warehouse-intake/` (legacy parallel intake; calls a notification function that does not exist) | BookingService counter-intake mode; the standalone path is deleted |
| Postgres trigger `log_order_status_change` (writes status history + `delivered_at` from inside the DB) | **PackageLifecycleService**: transition validated against the Part 7.3 table, TrackingEvent written (with previous/new status, actor, warehouse, idempotency key), package/order state updated — all in one Prisma transaction. The trigger is dropped in the cutover migration so history has exactly one writer. |
| supabase-py REST client with service-role key for all data access | Prisma repositories with ActorContext scoping and real transactions. The service-role key leaves request handling entirely (kept server-side only for Realtime token minting support tasks — see security doc). |
| Supabase Auth passwords + HS256 JWT verification in FastAPI | Auth.js credentials + DB sessions (§security doc). Existing password **hashes migrate** (Supabase Auth stores bcrypt; Auth.js verifies bcrypt), so users keep their passwords — verified per-account during the `public.users` ↔ `auth.users` reconciliation (database audit R4). |
| `REQUIRE_AUTH` flag + `{"role": "dev-bypass"}` sentinel | **Deleted, no equivalent.** There is no bypass mode in the new app, in any environment. |
| `POST /auth/signup` with caller-selected role (incl. `super_admin`) | Closed. Admins create accounts (UserService); vendors self-register into `pending_verification` with no operational access. |
| `services/analytics.py` Python aggregation over full-table reads | ReportingService: SQL aggregations via Prisma over the real tables, paginated and scoped |
| EmailJS / Textlocal calls scattered in order flows | NotificationService with in-app notifications first and EmailJS/Textlocal as dispatch providers, deduped by event key |
| Cloudinary public POD upload (`POST /drivers/pod`) | Private FileAsset flow (§6) |
| GitHub Actions → `POST /tasks/*` cron endpoints (token check fails open when unset) | Same schedules → `POST /api/cron/*` with a fail-closed shared secret (§9) |
| Role enum (10 values, split across `users.role` and `drivers.driver_type`) | Roles per spec Part 4: `super_admin`, `admin`, `warehouse_admin`, `warehouse_staff`, `rider`, `linehaul_driver`, `vendor`, `customer`, `finance`, `support`. Mapping: old `dispatcher` → `admin` (operations) unless reassigned; `warehouse` → `warehouse_staff`; `driver`/`micro_driver` → `rider` (+ capabilities); `big_driver` → `linehaul_driver`. Driver capabilities (pickup/delivery/combined/line-haul) become `DriverCapability` rows, not role names. |
| Four separate frontend deployables + per-app `config.js` | One Next.js deployment; one server-side env surface (security doc §9) |

---

## 9. Background jobs

No in-process scheduler, no Redis (the old `REDIS_URL` was never used), no paid queue.
The pattern that already works operationally is kept and hardened:

- **JobRecord table** — every job run is a row (job name, scheduled/started/finished,
  status, summary, idempotency key per scheduled slot). Job handlers are idempotent:
  re-running a slot is a no-op.
- **Triggers** — the existing GitHub Actions schedules (daily report 01:30 UTC, GPS
  cleanup 02:00 UTC) now call `POST /api/cron/daily-report` and
  `POST /api/cron/gps-cleanup` with a `CRON_SECRET` bearer token that **fails closed**
  (the old `_check_token` passed when `CRON_TOKEN` was unset). Vercel Cron can replace
  GitHub Actions later without code changes — the handlers are plain Route Handlers.
- **Jobs at launch:** daily summary email (EmailJS, via NotificationService), GPS
  retention pruning (ports `cleanup_gps_tracking`, retention from SystemSetting,
  default 7 days — telemetry only; no shipment/financial history is ever pruned),
  notification dispatch (drains pending in-app/email/SMS notifications with dedupe
  keys so retries never double-send, spec Part 17), capacity-warning evaluation,
  overdue-task/incident escalation checks.
- Longer work (settlement computation over a period) runs as a job with progress on
  its JobRecord, never inside a request.

---

## 10. Cross-cutting decisions

- **Error handling:** one standard envelope for every Route Handler and action result
  (`api-reference.md` §1) with stable error codes; raw exception text is never
  returned to clients (the old `/auth/*` leaked `str(e)`).
- **IDs and codes:** UUID primary keys (as today); human codes (`BLA-YYYY-NNNN`,
  `BLA-PAR-YYYY-NNNNNN`, warehouse codes like `WH-KTM-01`) are unique-constrained
  columns, generated transactionally.
- **Deletion:** warehouses, users, vendors, vehicles are deactivated/archived, never
  hard-deleted; history-bearing foreign keys use RESTRICT/SET NULL in the new schema
  (the old pervasive ON DELETE CASCADE chains are a documented migration risk,
  database audit R5). Financial and tracking records are append-only; corrections are
  reversal/adjustment rows.
- **Maps:** MapTiler stays the map provider (browser SDK with the public MapTiler
  key, as today); geocoding/routing calls that today happen from the browser
  (Nominatim in the order form) move server-side into RoutingService so keys and
  behaviour are consistent.
- **Environments:** `development` (local Postgres or the Supabase dev branch) and
  `production`. There is no auth-disabled environment at any level.

---

## 11. V2 final state (Phase 8 addendum — what was actually built)

This addendum records the V2 deltas against the design above. It does
not rewrite §§1–10; it corrects them where the build diverged.

### 11.1 GPS tracking subsystem (V2 Phases 3–5) — new, replaces §5's GPS design

§5 above describes the *V1-era* design (Supabase Realtime fan-out,
`POST /api/drivers/me/gps`, 5-minute pings, MapTiler maps). **None of
that is the built system.** The built GPS subsystem is:

- **Three models** in the `app` schema: `TrackingSession` (one
  engagement per driver/assignment; at most one ACTIVE session per
  driver), `DriverLocationPing` (the accepted-fix ledger,
  idempotent on `(trackingSessionId, sequenceId)`), and
  `DriverCurrentLocation` (one snapshot row per driver — the only
  table live views read). Vocabulary: `src/lib/tracking/domain.ts`;
  config: `src/lib/tracking/config.ts`.
- **One write path:** the driver's browser posts fixes to
  `POST /api/tracking/location` inside a transaction that locks the
  session row, re-validates the assignment, rate-limits (30 s server
  floor), and conditionally upserts the snapshot so an older fix
  never moves the marker backwards. Session control:
  `POST /api/tracking/session/start|pause|resume|stop` and
  `GET /api/tracking/session/current` (all `tracking.manage_own`;
  supervisor stop via `operations.live_view`).
- **Polling, no websockets.** There is no Supabase Realtime, no
  socket layer, and no server push anywhere in the built app. The
  driver panel polls `session/current` (~30 s while active); the
  Live Operations board polls `GET /api/live-operations` every 50 s
  while the document is visible. Freshness (`FRESH` / `DELAYED` /
  `STALE` / `OFFLINE`) is computed at read time from the snapshot's
  server receive time — a stale marker is never presented as live.
- **Foreground-only browser Geolocation** (`watchPosition`): updates
  stop when the app is backgrounded, the screen locks, or the tab
  is suspended. There is no background tracking. Full design:
  `docs/live-gps-tracking.md`; policy: `docs/gps-privacy-and-retention.md`.

### 11.2 Live Operations map (V2 Phase 5)

Pages `/admin/live-operations`, `/super-admin/live-operations`,
`/warehouse/live-operations` render one shared board
(`src/components/live-operations/`) over the two endpoints above,
gated on `operations.live_view` and warehouse-scoped for Warehouse
Admins (origin **or** destination membership). The map is Leaflet +
OpenStreetMap public tiles (tile URL/attribution in exactly one
place, `src/lib/maps/config.ts`) — **not** the MapTiler SDK named
in §§1/7/10. Markers encode movement type and freshness; the detail
view shows tracking IDs and statuses only (no recipient PII), and
COD totals only for actors already holding `finance.read` /
`cod.read`. There are no road routes and no ETAs.

### 11.3 Four-eyes invitations (V2 Phase 6)

Privileged-role invitations are **four-eyes**: an invitation for a
privileged role is created in `PENDING_APPROVAL` and becomes a
redeemable `PENDING` invitation only when a *second* eligible
approver approves it (`src/server/services/invitations.ts`). The
inviter can never approve/reject their own invitation (refused and
audit-logged), a Super Admin invitation can only be approved by a
Super Admin, an expired invitation can no longer be decided, and
the approve/reject transition is a conditional update so two racing
approvers cannot both succeed. Non-privileged invitations follow
the ordinary single-step flow. Supporting models: `UserInvitation`
(approval fields) and `InvitationAttempt` (redemption throttling,
V2 Phase 2).

### 11.4 Other corrections to the design record

- **Maps/routing:** no MapTiler or OpenRouteService call exists on
  the built critical path; routing output, where shown, is a
  suggested order only. See `docs/free-technology-stack.md`.
- **File storage / FileAsset:** no object-storage provider is wired
  and there is **no `FileAsset` model** in the built schema. POD
  evidence is a reference string made tamper-evident by Phase 7
  hash-binding (`DeliveryEvidenceBinding`) — see
  `docs/known-limitations.md` (M-10) and
  `docs/delivery-operations.md` §6.
- **Background jobs:** no `JobRecord`-driven queue is scheduled in
  the app. Scheduled work is external-cron-invoked scripts: the
  daily operations summary (`scripts/daily-ops-summary.ts`) and the
  tracking maintenance sweeps (hourly expiry / daily prune via
  `scripts/tracking-maintenance.ts`, wrapping
  `src/server/services/tracking.ts`).
- **Counts at V2 final state** (generated, Phase 8): 84 Prisma
  models, 10 roles, 100 permissions, 98 API Route Handler files —
  see `docs/database-schema.md`, `docs/role-permission-matrix.md`
  and `docs/api-reference.md` for the generated lists.
