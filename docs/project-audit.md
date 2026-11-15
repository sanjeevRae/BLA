# BLA — Project Audit (Phase 0 Deliverable)

**Date:** 2026-11-15
**Purpose:** Complete inspection of the existing BLA repository, frontends, backend and
database, performed **before any rebuild changes**, as required by the master
specification (Part 2.2 and Part 27, Phase 0). This document is the factual basis for
the rebuild design documents and the implementation roadmap.
**Sources:** three read-only audits of the live repository and the live Supabase
database (frontend audit, backend audit, database audit, all dated 2026-11-15),
plus `README.md` and `gap.md`. No production data was modified during the audit.
Git checkpoint of the pre-rebuild state: tag `pre-rebuild-checkpoint`.

> ⚠️ **`gap.md` is partially stale.** It claims the `dev-bypass` was removed and that
> Stripe is absent from the backend config; both are no longer true (see §3.4 and
> §3.3). Where `gap.md` and the code disagree, this audit follows the code.

---

## 1. Repository inspection summary

The repository contains **four separately deployed frontends, one Python backend,
and a set of hand-applied SQL files**:

| Area | Path | What it is |
|---|---|---|
| Admin dashboard | `admin-dashboard/` | Vite 5 + React 18 SPA — the operations console |
| Customer tracking | `customer-tracking/` | Public no-login parcel tracking page (vanilla JS) |
| Driver app | `driver-app/` | Mobile-first driver page, micro + big driver flows (vanilla JS) |
| Vendor portal | `vendor-portal/` | Vendor self-service page (vanilla JS) |
| Backend | `backend/` | FastAPI 0.111 monolith on Render (free tier), ~5,200 lines of Python |
| Database files | `db/` | `schema.sql` (consolidated) + Phase 1/2/3 incremental SQL + demo seeds |
| CI | `.github/workflows/` | Backend smoke checks; two cron workflows (daily report, GPS cleanup) |

Key structural facts established by the audit:

- **There is no single source of truth for the database.** The repo's SQL files
  define 30 tables; the live database has 33, including 3 tables and ~31 columns
  that exist **nowhere in the repo** (§4.3). The live database — not the SQL
  files — is the real schema.
- **There are two parallel generations of the data model**: a v1 order-centric
  model (`orders` / `packages` / `delivery_assignments`) and a v2 parcel-centric
  model (`shipments` / `driver_tasks` / `trips`), loosely joined by
  `orders.shipment_id`, with payment state duplicated in three places.
- **There are two parallel order-creation paths** in the backend (classic
  `/orders` and Phase-3 `/workflow/orders`) writing the same tables differently,
  plus a third legacy warehouse-intake path duplicating the workflow intake.
- **Authorization has effectively lived in the old FastAPI backend**, which
  connects to Supabase with the service-role key (bypassing RLS entirely).
  Warehouse isolation in particular exists only in backend code and in a
  live-only `warehouse_memberships` table that the repo's SQL does not define.
- **Live transactional data is demo/test data.** The real assets worth migrating
  are master data only: 4 warehouses, 9 users, 4 drivers, 4 vehicles,
  5 warehouse memberships, 1 customer (§4.4).

---

## 2. Existing frontend inventory

### 2.1 The four deployables

| App | Stack | Role |
|---|---|---|
| `admin-dashboard/` | Vite 5.4.21, React 18.3.1, React Router 7.18.4, Tailwind 3.4.19 | Operations console (admins) |
| `customer-tracking/` | Vanilla JS + MapTiler SDK (CDN) | Public tracking by order number, `?order=` deep link |
| `driver-app/` | Vanilla JS + Supabase JS (CDN) | Micro-driver tasks; big-driver trips; GPS ping every 5 min |
| `vendor-portal/` | Vanilla JS + Supabase JS (CDN) | Order submission into admin approval queue; own orders/parcels/settlements |

The three static apps each carry their own `config.js` (Supabase URL + anon key +
API base URL). All admin data flows through one fetch wrapper
(`admin-dashboard/src/lib/api.js`, ~57 endpoint functions). Supabase is used
directly from the browser only for **Auth** and **Realtime** (orders-table changes
refresh the console; `gps_tracking` inserts move live-map markers), plus direct
table reads in the customer-tracking fallback path.

### 2.2 Admin dashboard structure

The SPA is **two applications with two auth systems** (§2.5):

- `src/App.tsx` — a TypeScript auth shell + router. There is **no `tsconfig.json`
  and no TypeScript toolchain**; the `.tsx` files are transpiled by esbuild with
  no type checking anywhere.
- `src/App.jsx` (713 lines) — the real operations console, mounted by the shell
  for `admin` / `super_admin` users. In-console navigation is a `page` state
  variable switching 13 sections (no router): **Dashboard, Orders, Items,
  Drivers, Clients, Packages, Payments, Vehicles, Warehouses, Parcels, Trips,
  Vendors, Tasks** (sidebar defined in `components/Sidebar.jsx`, with live count
  badges from `GET /ops/profile`).

Principal screens and components (19 component files, ≈5,129 lines in `src/`):

- **Dashboard** — 8 KPI cards with sparklines and % change (`StatsBar`), a
  hand-rolled SVG revenue/orders chart, payment-status donut, recent activity
  table, recent orders, quick actions, compact live map.
- **Orders** — the operational core: vendor **ApprovalQueue** → orders list /
  **LiveMap** (MapTiler; big drivers only, warehouse markers, GPS trails,
  realtime marker movement) / **AssignPanel** triptych, and an **OrderDetail**
  drawer (per-order map, 6-step journey stage bar, timeline, and the
  approve → intake → dispatch → payment workflow forms). Dispatch distinguishes
  same-district **last-mile** (micro driver) from cross-district
  **inter-warehouse** (vehicle + destination warehouse).
- **List pages** (`components/Pages.jsx`, generic `ListPage` + `DataTable`):
  Items, Drivers, Packages, Payments, Warehouses, Parcels/Shipments (with
  register-parcel form, Advance-along-a-flow actions, scan events), Trips
  (create + advance), Driver Tasks (assign + advance), Vendors (CRUD +
  activate/deactivate), Vehicles (fleet list → **VehicleDetail** drill-down with
  map, route progress, cargo, checkpoints).
- **Reusable UI worth keeping:** `Sidebar`, `TopBar`, `PageHeader`, `DataTable`
  (+ `Badge`), `StatsBar`, `RevenueChart`, `Sparkline`, `Donut`, `StatusPill`,
  `LiveMap`, `OrderMap`, and the `Rs.` money formatters (`fmtINR` with en-IN
  grouping; `fmtCompactINR` with k/L/Cr compact form).

### 2.3 Design system (to be preserved)

- Tailwind 3.4 with custom tokens: page `#F5F7FA`, surface `#FFFFFF`, ink
  `#0F172A`, slate2 `#64748B`, faint `#94A3B8`, brand `#2563EB`, green `#16A34A`,
  orange `#EA580C`, purple `#7C3AED`, red `#DC2626`, amber `#F59E0B`, line
  `#E6EBF0`. Map colours reuse the same palette.
- Flat, sharp visual language: 1 px `line` borders instead of shadows, border
  radii 2–4 px, content max-width 1450 px, system font stack (no webfont),
  tabular numerals for money/counts (`.tnum`), 11 px uppercase micro-labels.
- All charts and icons are hand-rolled inline SVG — no chart or icon library.
- **Design debt:** the TSX login/signup pages use a completely different visual
  language (default slate palette, `rounded-2xl`, `shadow-xl`). The rebuild
  unifies on the console's token system.
- **Build bug:** `tailwind.config.js` content glob is `./src/**/*.{js,jsx}` —
  it **excludes `.tsx`**, so utility classes used only in TSX files may be
  missing from the production CSS.
- The three static apps mirror the same palette via CSS variables.

### 2.4 Role coverage today

| Role | Current experience |
|---|---|
| `super_admin`, `admin` | Full operations console (identical UI for both; differentiation is backend-only) |
| Vendor | Real experience only in the static `vendor-portal/`; inside the SPA, a placeholder |
| Driver (micro / big) | Real experience only in the static `driver-app/`; inside the SPA, a placeholder |
| Customer | Public `customer-tracking/` page (no login) |
| Warehouse admin / staff, dispatcher | **No dedicated UI exists anywhere** — routes land on a placeholder whose Quick Action buttons are dead |

### 2.5 The two auth systems (both must be replaced)

1. **Outer shell (live entry):** `POST /auth/login` / `/auth/signup` via relative
   URLs (Vite-proxy only). On success the shell stores identity as **plain
   `localStorage` flags with no token** (`bla_is_authenticated`, `bla_user_role`,
   …) and `App.jsx` even fabricates a session object (`access_token: "local"`).
   This is **client-asserted identity** — anyone can set the flags and be
   "logged in". Additionally, neither `vercel.json` nor `netlify.toml` proxies
   `/auth/*` to the backend, so this login is likely broken on the static hosts
   as configured.
2. **Console gate:** Supabase Auth sign-in (`Login.jsx`) + `GET /auth/me`
   DB-role check; rendered only when the backend reports `REQUIRE_AUTH=true`.
   The DB-authoritative role concept here is sound and is carried into the
   rebuild's design; the mechanism is not.

### 2.6 What must be preserved (frontend)

Per the master spec Part 2.3, the rebuild preserves: the console design system
(tokens, flat cards, small radii, 1450 px width, system fonts, tabular
numerals); the sidebar structure with 13 sections, count badges and the
system-status card; the TopBar (global search, notification indicator, operator
identity); the dashboard composition (8 KPI cards, revenue chart, payment
donut, activity table, quick actions); the hand-rolled SVG chart components and
`Rs.` formatting; the Orders operations screen including the
approve → intake → dispatch (last-mile vs inter-warehouse) → payment workflow;
live-fleet-map semantics (big drivers only, hub markers, trails, realtime);
all list pages and their columns; the generic Advance-along-a-flow action
pattern; vehicle fleet → detail drill-down; driver-app behaviour (micro task
flow with COD + proof at delivery, failed-delivery reporting, big-driver trip
flow with checkpoints, 5-minute GPS); vendor-portal behaviour (submission into
the approval queue; own orders/parcels/settlements); public tracking
(order-number lookup, 5-step progress, live driver map, `?order=` deep link,
no internal data exposure); role-based landing paths; and the realtime
behaviours (order changes refresh the console, GPS inserts move markers).

### 2.7 Broken / dead / mock inventory (frontend)

| # | Item | Severity |
|---|---|---|
| 1 | **Vendor order submission is broken as shipped**: `app.js` looks up `r-submit`, the button's id is `r-order-submit` → TypeError on submit | Broken feature |
| 2 | Client-asserted auth (localStorage flags, no token, fabricated session) | Security — replace |
| 3 | "Continue without login (dev only)" bypasses shipped in driver + vendor apps; driver login page prints demo credentials | Security — remove |
| 4 | Non-admin placeholder dashboard: all four Quick Action buttons dead | Dead UI |
| 5 | Sidebar **Notifications** and **Help Center** buttons have no handlers | Dead UI |
| 6 | TopBar date-range button is decorative; the analytics `days` window (120) has no control anywhere | Dead UI / hidden hardcode |
| 7 | `/analytics/overview`, `/analytics/cashflow`, `/analytics/admin-feed` are fetched on every refresh and **never rendered** | Dead data flow |
| 8 | **14 `api.js` functions are never called** (all COD/settlement, scan, transfer, handover, manifest, customer-CUD functions) → whole backend areas have no admin UI | Missing UI |
| 9 | `rsuite` dependency declared and locked but never imported | Dead dependency |
| 10 | `src/index.tsx` duplicate entry point; `src/1.webp`, `src/2.webp` orphan assets | Dead files |
| 11 | Tailwind content glob excludes `.tsx` (§2.3) | Build bug risk |
| 12 | Order create/edit form always submits `items: []` — line items are never captured | Incomplete feature |
| 13 | No warehouse-admin or dispatcher UI exists | Missing feature (spec Part 4) |
| 14 | `vendor-portal/README.md` describes `POST /shipments` registration; code uses `POST /workflow/orders` | Stale docs |
| 15 | **No mock-data fixtures exist** — all displayed data comes from the API; empty states are real | Clean (noted for the record) |

---

## 3. Existing backend inventory

### 3.1 Stack and deployment

- **FastAPI 0.111.0** + Uvicorn 0.30.1, Python 3.11, Pydantic 2.7.4.
- Data access: **supabase-py 2.5.1 PostgREST REST client only** — no ORM, no
  direct Postgres connection from the app, **no multi-statement transactions**
  anywhere. `backend/app/models/` is an empty placeholder; the data model lives
  in `db/schema.sql`. One `lru_cache`d service-role client singleton serves all
  requests (RLS bypassed for everything the backend does).
- Entry point `backend/app/main.py`; deployed via `backend/render.yaml` as a
  single free-tier Render web service (`bla-api`, health check `/health`,
  auto-deploy on, spins down after 15 min idle).
- Other integrations: Cloudinary (POD photos, the only upload in the system),
  EmailJS (order confirmations, daily summary), Textlocal SMS (order
  confirmation + classic order-status changes), MapTiler → OpenRouteService
  route calculation (classic driver assignment only), Stripe (payments router).
- Background work: two HTTP cron endpoints (`/tasks/daily-report`,
  `/tasks/cleanup-gps`) triggered by **GitHub Actions** (01:30 / 02:00 UTC).
  No in-process scheduler, queue or worker exists.
- **Realtime is not provided by the backend at all**: it is Supabase Realtime
  over table changes, subscribed to directly by the browsers. Any replacement
  backend must re-provide this fan-out or keep Supabase Realtime.
- A Postgres trigger (`log_order_status_change`) silently performs half of the
  order status-history work (history row + `delivered_at`); the service layer
  adds a second, richer row. This split is easy to lose in a rewrite.
- Tests: 22 DB-free unit tests (pure functions only — transitions, routing
  decisions, role guards, schemas). **Zero endpoint/integration tests.** CI runs
  only the smoke file plus a syntax/import check.

### 3.2 Endpoint inventory (~81 endpoints, 17 routers)

| Router | Endpoints | Summary |
|---|---|---|
| `auth.py` | 4 | Login (Supabase-verified in prod), signup, `/auth/me` console gate, `/auth/config` |
| `orders.py` | 9 | Classic order CRUD + items, status, driver assignment with route computation |
| `customers.py` | 4 | Customer CRUD — **entirely unauthenticated, including DELETE** |
| `drivers.py` | 5 | Driver list, per-driver assignments, assignment status, GPS ping, POD upload |
| `ops.py` | 6 | `/ops/profile` shell bootstrap (operator + 12 table counts) + 5 public lookup lists |
| `analytics.py` | 8 | Overview, cashflow, admin feed, daily, revenue, trends, activity, payments summary — **all public, no auth on any route** |
| `tasks.py` | 2 | Cron: daily report email, GPS pruning (token check passes if `CRON_TOKEN` is unset) |
| `payments.py` | 4 | Stripe PaymentIntent create/reuse, status poll, signed webhook → `orders.payment_status` |
| `shipments.py` | 6 | Parcel registration + tracking-code generation, status (terminal-state lock only), public lookups |
| `warehouse_ops.py` | 6 | Scans, single-parcel transfers + receive (no reconciliation), handovers + confirm |
| `warehouse_intake.py` | 1 | Counter drop-off intake — **no role check**; duplicates workflow intake with different district logic |
| `driver_tasks.py` | 3 | Micro-driver task assign/list/status (all inputs as query params); COD capture is a hidden side effect of the status update |
| `trips.py` | 5 | Big-driver trips, manifests, checkpoints, status machines |
| `workflow.py` | 7 | Phase-3 pipeline: create → approval → intake → dispatch → payment track → detail/pending |
| `vehicles.py` | 2 | Fleet overview + vehicle detail (assembled in Python from full-table reads) |
| `vendors.py` | 4 | Vendor CRUD (super-admin writes) |
| `settlements.py` | 4 | COD collections register; settlement create (super) + 5-state lifecycle |
| `main.py` | 2 | `/` service info, `/health` |

Cross-cutting state: no rate limiting anywhere, no idempotency on any mutation,
no standard error envelope (plain-string `detail`; some list endpoints return
`[]` on any DB error, masking outages as empty data), no security headers,
unversioned API, FastAPI `/docs` exposed in production, CORS locked to
localhost + env list with credentials enabled.

### 3.3 Auth implementation (as found)

- Passwords are verified **only by Supabase Auth**; the backend never stores or
  compares passwords. `POST /auth/login` looks up `public.users` by email, then
  (prod only) verifies via Supabase Auth — notably by signing in **on the shared
  service-role client singleton**, a stateful side effect on the trusted client.
  The backend **issues no token/session**; session ownership stays with the
  frontend's Supabase client. There is no backend logout, revocation, refresh,
  password reset or MFA.
- JWTs are verified locally (HS256, `SUPABASE_JWT_SECRET`, `verify_aud=False`).
  If the secret is unset, any token-bearing request fails with a 500.
- Since commit `addc0c6`, roles are **DB-authoritative**: `_effective_role()`
  resolves the role from `public.users.role`; JWT `user_metadata.role` is an
  untrusted display hint. Fail-closed in prod (no `users` row or `is_active =
  false` → no role → 403). **But** if the DB is unreachable, `_effective_role()`
  silently falls back to the untrusted JWT hint — fail-open under exactly the
  wrong conditions. Enforcement is also inconsistent: `POST /payments/intent`
  authorises staff from the raw JWT claim; settlements scope vendors via the
  JWT hint while shipments use the enforced role; workflow routes re-implement
  role lists inline (the prebuilt role dependencies in `workflow.py` are dead
  code), and `GET /workflow/orders/{id}/detail` and `/workflow/orders/pending`
  have **no ownership/role check at all** despite docstrings claiming otherwise.

### 3.4 Critical security remnants (must not survive the rebuild)

1. **`REQUIRE_AUTH=false` disables every guard**, and in that mode
   `POST /auth/login` **accepts any password** for an existing user row —
   including super_admin. The `{"role": "dev-bypass"}` sentinel is still
   returned by `require_user` and is even asserted by a smoke test, despite
   `gap.md` claiming it was removed. All 13 live `shipment_events` rows were
   written by a `dev-bypass` actor — the bypass was used against the live
   system.
2. **Open self-registration as super_admin:** `POST /auth/signup` lets the
   caller self-select any role from a whitelist that includes `super_admin`
   and `admin`, and creates the DB profile row — a full privilege-escalation
   path that defeats the DB-role hardening.
3. **Entire route groups have no auth dependency at all** (open even with
   `REQUIRE_AUTH=true`): all of `/analytics/*`; full customer CRUD including
   DELETE; `/ops` list endpoints; order/driver/shipment/trip GETs — including
   **public tracking lookups that return full PII** (recipient name, phone,
   addresses, full shipment event trail) with **no verification factor**,
   contrary to spec Part 4.8.
4. **No warehouse scoping exists anywhere in the backend.** There is no
   membership concept in any guard; a `warehouse_admin` token can operate on
   any warehouse's shipments and transfers. (The live DB has a memberships
   table; the backend guards do not use it.)
5. **`stripe` is imported by `payments.py` but missing from
   `requirements.txt`** — a clean install cannot import the app, so the CI
   import check would fail in a clean environment. Stripe env vars are also
   undocumented (absent from `.env.example` and `render.yaml`), and the Stripe
   currency defaults to **INR**, not NPR. Online payments are invisible to
   settlements (which only sum `cod_collections`).
6. **Cron token check passes when `CRON_TOKEN` is unset** — both `/tasks/*`
   endpoints are then open to anyone.
7. `/ops/profile` with no token falls back to **the first staff user in the DB
   as "the operator"** (a dev/demo identity assumption in production code).
8. `/auth/login` and `/auth/signup` return raw exception strings to clients
   (information leakage). No rate limiting or lockout on login/signup.
9. Hard deletes exist for orders and customers; multi-write flows are sequences
   of independent REST calls with try/except-and-continue, so partial failure
   leaves partial state (no transactions, no idempotency, no optimistic
   locking).
10. Leftover one-off scripts at repo root (`_sec_patch.py`, `_gen_payments.py`
    — the former hardcodes a Windows `A:/bla/...` path) are dev artifacts, not
    part of the running system.

### 3.5 Responsibilities the new server layer must replace

The backend audit's §8 contains a 45-row responsibilities map (one line per
responsibility). The easy-to-miss items, which the rebuild plan explicitly
carries over:

- Supabase Realtime fan-out (the backend provides no websockets today).
- The `log_order_status_change` trigger's half of status history.
- GPS ingestion **and** the fact that drivers also write GPS directly to
  Supabase (two write paths).
- COD capture and parcel/payment status mirroring as hidden side effects of
  the driver-task status update.
- The two GitHub-Actions cron jobs (daily report; GPS retention pruning via
  the `cleanup_gps_tracking` RPC, which keeps the DB under the free-tier cap).
- The per-order composite map payload the OrderDetail screen is built on.
- Role catalog + dashboard-path mapping the login UI renders from.

---

## 4. Database inventory

### 4.1 What the repo's SQL defines

`db/schema.sql` is the consolidated source (base + Phase 1 + Phase 2 inlined);
`phase1_identity.sql`, `phase2_identity.sql`, `phase3a/3b/3c` are incrementals;
`seed.sql`, `phase1_seed.sql`, `phase2_seed.sql`, `admin_updates.sql` are demo
seeds. `phase1a_enum_roles.sql` is an **empty file (0 bytes)**.

- **30 tables**, **10 PostgreSQL enums** (`user_role`, `order_status`,
  `assignment_status`, `vehicle_type`, `payment_status`, `payment_method`,
  `parcel_status`, `driver_task_status`, `trip_status`,
  `cod_settlement_status`), 7 RLS helper functions, the order-status-history
  trigger set, `set_updated_at` triggers on 15 tables, and
  `cleanup_gps_tracking()`. RLS is enabled on all 30 tables in the SQL.
- Two model generations (§1): v1 order-centric and v2 parcel-centric. The
  **Package concept is split across two tables** — `packages` (dimensions +
  POD, no status/location of its own) and `shipments` (the tracked parcel with
  status/custody) — and must be unified in the rebuild.
- Identity is a **custom `public.users` table mirroring Supabase `auth.users`
  1:1 by UUID** (by convention only — no FK is declared), with a single
  `user_role` enum (10 values). There are **no Role/Permission/UserRole/Session
  tables**; the spec's permission-matrix model does not exist. Driver
  operational type lives separately in `drivers.driver_type` ('micro'/'big');
  the `micro_driver`/`big_driver` enum values are unused live.
- Finance is weak: `payments` (per-order, `transaction_ref` **not unique**, no
  idempotency key, no allocations/reversals) plus `payment_method` /
  `payment_status` duplicated as columns on both `orders` and `shipments` —
  three sources of payment truth. `cod_collections` + `settlements` exist, but
  there is **no driver-remittance table, no COD ledger, no discrepancy
  handling** (spec Scenario 5 — collect Rs. 5,000, remit Rs. 4,500 — cannot be
  represented).
- Tracking history is fragmented into four trails (`delivery_status_history`,
  `shipment_events`, `scan_events`, `order_events`) with free-text event
  vocabularies, no prev/new status pairs, and no idempotency keys on scans.
- `ON DELETE CASCADE` is pervasive (see Risk R5, §6).
- India leftovers: `payments.currency` defaults to `'INR'`, `customers.country`
  and `vendors.country` default to `'IN'`, `upi` is a `payment_method` enum
  value, and the seed warehouse is Bengaluru (`WH-BLR-01`) — against the spec's
  NPR / Asia/Kathmandu / Nepal-district requirements.

### 4.2 What the live database actually contains

**33 tables + 9 RPC functions** are exposed via PostgREST. All 30 SQL-defined
tables exist live, and the Phase 3a/3b column migrations **have** been applied
live. Row counts at audit time (2026-11-15):

| Group | Tables | Live state |
|---|---|---|
| Master data (real) | `warehouses` (4), `users` (9), `drivers` (4), `vehicles` (4), `warehouse_memberships` (5), `customers` (1) | See §4.4 |
| Demo vendor | `vendors` (1) | The Phase-1 seed demo vendor (Acme Retail, Bengaluru, IN) |
| Transactional (empty) | `orders`, `order_items`, `order_events`, `packages`, `delivery_assignments`, `delivery_status_history`, `payments`, `cod_collections`, `warehouse_transfers`, `warehouse_transfer_items`, `handovers`, `checkpoints`, `inventory_movements` | **0 rows each** |
| Demo activity | `shipments` (2), `trip_manifests` (2), `scan_events` (2), `driver_tasks` (1), `trips` (1), `gps_tracking` (12), `shipment_events` (13) | Exactly the Phase-2 seed parcels + one test session |
| Admin content | `admin_notifications` (6), `admin_messages` (6), `admin_settings` (3), `admin_help` (16), `settlements` (1) | Seed content + app-written rows; the settlement is a zero-amount placeholder |

### 4.3 Live-only structures (exist nowhere in the repo)

Verified by full-repo search — created and used entirely outside the recorded
codebase:

| Structure | Detail |
|---|---|
| `warehouse_memberships` (11 cols, **5 rows**) | user × warehouse × `role_purpose` with assign/revoke audit fields. **This is the live warehouse-scoping mechanism** — exactly the spec's WarehouseMembership concept, which the SQL schema lacks entirely |
| `inventory_movements` (11 cols, 0 rows) | Stock-movement ledger for `inventory` (the spec's StockMovement) — designed, never used |
| `warehouse_transfer_items` (12 cols, 0 rows) | Line items linking transfers to inventory/intake rows — designed, never used |
| `shipments` +8 columns | `custody_type`, `custody_ref_id` (polymorphic, **no FK**), `received_at`/`dispatched_at`, `received_by`/`dispatched_by`, `exception_reason`, `exception_notes` |
| `orders` +3 columns | `pickup_type`, `pickup_warehouse_id`, `recipient_email` |
| `trip_manifests` +8 columns | `load_status`, `receipt_status`, `loaded_at`/`received_at`, `loaded_by`/`received_by`, `exception_reason`, `exception_notes` — the closest thing to transfer reconciliation that exists |
| `inventory` +12 columns | The table was **repurposed from SKU stock into a parcel-intake register** (sender/receiver/product/rate/delivery_location, `status='stored'`); its 7 live rows have SKU all NULL |
| RPC `rls_auto_enable` | Supabase-side helper, not in repo SQL |

**Phase 3c was never applied live:** `warehouses.district` is missing. The
Phase-3 routing design (same district → last-mile, other district →
inter-warehouse) depends on that column; against the live database the backend
must be falling back to city matching or failing silently.

**Verification limit:** PostgREST cannot expose live RLS policy bodies, check
constraints, triggers or index lists. For the 3 live-only tables, their
RLS/index state is **unknown** and must be checked in `pg_catalog` during
migration planning — if RLS is off on any of them, they are readable by anyone
holding the public anon key.

### 4.4 Data assessment — what is real, what is demo

**Real master data (must be preserved):**

- **4 warehouses — a genuine Nepal network**, created through the app, present
  in no seed file: `WH-KTM-01` Kathmandu Central Hub, `WH-PKR-01` Pokhara
  Regional Hub, `WH-CHT-01` Chitwan Warehouse (Bharatpur), `WH-LTP-01` Lalitpur
  Depot.
- **9 user accounts** — roles: admin ×2, driver ×4, dispatcher ×1, customer ×1,
  warehouse_admin ×1. Seven use `@bla.test` addresses; two (`@bla.com`,
  `@gmail.com`) are shaped like real people's accounts (project
  owner/developer). There are **no** live `super_admin`, `vendor`,
  `micro_driver` or `big_driver` users — live accounts were managed through
  the app, not the seed files.
- **4 drivers** (all `driver_type='micro'`; 3 available), **4 vehicles** (2 vans,
  2 bikes, all 'idle'), **5 warehouse memberships** (4× `driver_home`, 1×
  `admin`, all active), **1 customer** (a real-shaped Nepali record, Lalitpur).

**Demo/test data (safe to discard or re-seed, after owner confirmation):** both
shipments (`BLA-DEMO-0001/0002`), the demo trip + manifest + COD driver task
(Rs. 1,299, pending), all scan/shipment events (written by `dev-bypass`), the
12 GPS pings (one test session, 2026-10-28 → 29), the Acme demo vendor, the
zero-amount settlement, and the admin seed content. The 7 `inventory` rows look
like genuine intake tests performed through the running app (they contain
personal-data-shaped fields) — disposable, but confirm with the owner before
wiping because they were created through the product, not a seed script.

**Absent:** there is **no real order, payment, COD or delivery history at all**
in this database — `orders`, `payments` and `cod_collections` are empty. Either
the business has not run production volume through this database, or a
different database holds it (one open confirmation question for the owner).

### 4.5 Spec concepts with no existing table

Role, Permission, RolePermission, UserRole, Session, UserInvitation ·
WarehouseZone, StorageLocation, WarehouseOperatingHours · VendorUser,
VendorAddress, CustomerAddress, CustomerContact · PackageItem, PackageLabel ·
PackageCondition · VehicleMaintenance, DriverCapability, TripStop ·
DeliveryBatch, DeliveryAttempt (only a counter exists), DeliveryRoute,
ProofOfDelivery (fields scattered) · Invoice, PaymentAllocation,
FinancialAccount, LedgerTransaction, DriverRemittance, Refund, 
FinancialAdjustment · Task, TaskComment, Issue, Incident, IncidentEvidence,
Approval, Notification (per-user), NotificationPreference, AuditLog ·
FileAsset, ServiceArea, PricingRule, ShippingService, JobRecord. Also missing:
declared vs actual vs volumetric vs billable weight separation, any
pricing/tariff configuration, and returns as an entity (statuses only).

---

## 5. Dependency report

### 5.1 Admin dashboard (from `package.json`, locked versions)

| Package | Locked | Notes |
|---|---|---|
| react / react-dom | 18.3.1 | |
| react-router-dom | 7.18.4 | |
| @supabase/supabase-js | 2.108.2 | Auth + Realtime only (§2.1) |
| @maptiler/sdk | 2.5.1 | Maps (admin); static apps load v2.4.0 UMD from CDN |
| **rsuite** | 6.2.5 | **Never imported — dead dependency, remove** |
| vite / @vitejs/plugin-react | 5.4.21 / 4.7.0 | Dev |
| tailwindcss / postcss / autoprefixer | 3.4.19 / 8.5.15 / 10.5.0 | Dev |

No test runner, no linter config, no TypeScript toolchain. Scripts: `dev`,
`build`, `preview` only. Deployed as a static SPA (`vercel.json`, `netlify.toml`).

### 5.2 Backend (from `requirements.txt`)

FastAPI 0.111.0, Uvicorn 0.30.1, Pydantic 2.7.4, pydantic-settings 2.3.4,
supabase 2.5.1, httpx 0.27.0, cloudinary 1.40.0, PyJWT 2.8.0,
python-multipart, python-dotenv; tests: pytest 8.2.1, pytest-asyncio, respx.
**⚠️ `stripe` is imported by the app but absent from this file** — a clean
install cannot import the app (§3.4 #5). The entire Python dependency set is
retired with the backend in Phase 10 of the roadmap.

### 5.3 External services (all free tiers today)

Supabase (PostgreSQL + RLS + Realtime + Auth; 500 MB DB cap drives the GPS
retention job), Render (backend hosting), Vercel/Netlify (static frontends),
MapTiler (tiles + routing), OpenRouteService (routing fallback, 2,000
directions/day), Cloudinary (POD photos), EmailJS (200 emails/mo), Textlocal
(SMS), GitHub Actions (cron + CI), Stripe (keys configured in code only;
undocumented env vars). Env surface: 26+ variables; production values live in
the Render dashboard, not the repo.

### 5.4 Target stack for the rebuild (per master spec Part 3.1)

One Next.js application (App Router, TypeScript) preserving the existing
frontend design and components; PostgreSQL (the existing Supabase project) with
**Prisma** as the single ORM; **Auth.js** for authentication (secure HTTP-only
session cookies, established library — no hand-rolled cryptography); RBAC +
resource-based authorization enforced server-side on every operation; Zod
validation; Route Handlers + Server Actions backed by central service modules
(spec Part 22); Cloudinary retained for file storage (private delivery for
sensitive documents); Supabase Realtime retained as the realtime backbone while
the preserved frontends depend on it. Currency **NPR**, timezone
**Asia/Kathmandu** throughout (UTC storage).

---

## 6. Identified risks

**R1 — Live DB ≠ repo SQL: migration must start from a full live backup (top
risk).** Three tables and ~31 columns exist only live; nothing in the repo
references them. Provisioning a rebuild from `db/*.sql` would silently lose
`warehouse_memberships` (with its 5 real assignment rows), the shipments
custody/exception block, the trip-manifest load/receipt block, the orders
pickup block, and the inventory intake columns the running app writes to.
**Mitigation:** full `pg_dump` (schema + data) of the live project before any
rebuild step; the new Prisma schema is designed by migrating *from the live
schema*, and live-only structures are inspected in `pg_catalog` (RLS state of
the 3 live-only tables is unverifiable via REST).

**R2 — Warehouse isolation lived only in the old backend.** The SQL RLS model
gives every staff role global cross-warehouse access (`is_staff()` is global);
the memberships table that actually scopes users to warehouses is live-only
and unused by the SQL policies; the FastAPI guards contain no warehouse
scoping at all. If the old backend is retired before the new Next.js server
layer enforces membership-based scoping on every query, the anon-key frontends
are protected only by the coarse SQL policies. **Mitigation:** authorization
is built in Phase 1 and warehouse scoping in Phase 2 — long before the old
backend is removed in Phase 10 — and cross-warehouse denial is an explicit
acceptance test (spec Scenario 11).

**R3 — `ON DELETE CASCADE` vs the spec's "never delete history" rule.**
Deleting an order wipes its items, packages, assignments, payments and status
history; deleting a shipment wipes scans, transfers, handovers, tasks,
manifest rows, COD collections and its entire event trail; deleting a vendor
wipes its settlements; deleting a warehouse wipes inventory and inbound
transfers; deleting a driver wipes assignments, tasks, trips and GPS history.
The old API also exposes hard deletes for orders and customers, and
`cleanup_gps_tracking()` hard-deletes GPS rows on a 7-day cycle.
**Mitigation:** the new schema uses soft-delete/archival and RESTRICT/SET NULL
on history-bearing foreign keys; historical shipment and financial records are
never deleted (spec Parts 1.3, 20.1).

**R4 — INR leftovers vs NPR.** Currency default `'INR'` (payments table and
Stripe), country default `'IN'`, `upi` payment method, Bengaluru seed data —
while the business, the live master data and the spec are Nepal/NPR.
**Mitigation:** NPR and Nepal defaults throughout the new schema and services;
IN artefacts treated as removable demo residue during master-data migration.

**R5 — Auth identity reconciliation.** `public.users.id` is supposed to equal
`auth.users.id` but nothing enforces it, and the seeds use fabricated UUIDs.
Any live profile row without an Auth counterpart cannot log in after the auth
migration; any Auth user without a profile row gets no role. Reconciliation
requires dashboard/SQL access (not visible via REST) and must happen before
the Phase 1 auth cut-over; the two real-shaped accounts matter most.

**R6 — Two parallel data models (v1 vs v2).** Payment state exists in three
places and tracking history in four; existing frontends may read from either
generation. Dropping a generation without an endpoint-by-endpoint usage
inventory would silently blank dashboards. The roadmap's phased migration
(§roadmap, Migration strategy) keeps both readable until each module is
replaced.

**R7 — Status-model rigidity.** Core lifecycles are PostgreSQL enums with
7–10 values; the spec's lifecycle needs ~20 operational states plus separate
condition/payment/exception tracks, and enum values cannot be added inside the
transaction that uses them (the repo's own comments document error 55P04). The
new schema follows the Phase-3 pattern (text + CHECK) or lookup tables for
lifecycle states.

**R8 — No idempotency or uniqueness where money and scans are concerned.**
`payments.transaction_ref` is not unique; scan/event tables have no
idempotency keys; order numbers and tracking codes are made unique by
race-prone random-generate-then-probe loops in app code. Spec Scenarios 7
(duplicate scan) and 12 (duplicate payment) are unenforceable at the database
level today. The new schema adds unique constraints and idempotency keys, with
generation enforced by constraint + retry.

**R9 — Audit gaps.** The order-history trigger records `changed_by =
auth.uid()`, which is NULL for all service-role (backend) writes — most real
writes are unattributed. There is no audit trail at all for user/role changes,
settings changes or financial edits. The new system implements the spec's
append-only TrackingEvent + AuditLog from Phase 1 onward.

**R10 — Operational couplings to preserve.** The `supabase_realtime`
publication membership (11 tables), `set_updated_at` triggers and the RLS
helper functions are load-bearing for the existing frontends; GPS retention
must be re-implemented in the new job system before real fleet use; the
EmailJS/Textlocal notification triggers exist only on the classic order flow
(parcel flows notify nobody today).

---

## 7. Phase 0 conclusion

The inspection is complete: frontend, backend and database are fully
inventoried; the design system and the functionality to preserve are itemised
(§2.6); the old backend's responsibilities are mapped (§3.5); the real data to
migrate is identified and is small (§4.4); and the risks that shape the
migration order are recorded (§6). No production data was modified. The
rebuild proceeds per `implementation-roadmap.md`, starting with the Phase 1
foundation (Next.js + Prisma + Auth.js + permissions + audit) — with the full
live backup of Risk R1 taken before the new schema is first applied to the
live database.
