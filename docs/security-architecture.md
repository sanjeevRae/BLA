# Security Architecture — BLA Logistics Platform (Next.js Rebuild)

**Status:** Phase 0 design document · 2026-11-15
**Sources:** master specification Part 21 (and Parts 4, 20.2, 23), `BLA-audit/backend-audit.md`
(§3, §6), `BLA-audit/frontend-audit.md` (§5, §10), `BLA-audit/database-audit.md` (§4, §6)
**Companion documents:** `system-architecture.md`, `role-permission-matrix.md`,
`database-schema.md`, `api-reference.md`

The old system's security posture, per the audits: roles resolved from the database
(the one sound idea, kept), undermined by a dev-bypass that disables every guard, an
open signup that mints super admins, entire route groups with no auth at all, and **no
warehouse isolation anywhere**. This document designs the replacement controls and
names, for each old hole, the control that closes it (§11).

---

## 1. Principles

1. **Deny by default.** Every Server Action, Route Handler and repository function
   requires an explicit permission. Absence of a check is a build failure, not a
   default-allow — protected handlers are wrapped so the permission argument is
   mandatory.
2. **Least privilege.** Roles carry only the permissions their job needs
   (`role-permission-matrix.md`). Nobody — including Super Admin — can silently
   delete financial transactions or historical package events (spec Part 4.1).
3. **Server-side enforcement only.** The frontend hides what a role cannot use, but
   hiding is never the control. Every check below runs on the server, on every
   request, against the current database state.
4. **Never trust client-supplied identity.** Roles, permissions, warehouse ids,
   vendor ids and driver ids are resolved from the server-side session and database.
   A warehouse id in a request is a *request to be checked*, never proof
   (spec Part 20.2).
5. **No custom cryptography.** Password hashing, session tokens and reset tokens use
   Auth.js and its vetted libraries only.
6. **Every sensitive action is auditable.** AuditLog is append-only (§8).

---

## 2. Authentication (Auth.js)

- **One login page** (`(public)/login`) for all roles — Super Admin through Vendor —
  per the owner's requirement and spec Part 24.2. After login the user is routed to
  their role's dashboard group; the landing decision is made server-side from the
  session, replacing the old backend's `dashboard_path` response and the old SPA's
  localStorage routing.
- **Provider:** Auth.js **credentials** provider. Passwords are verified against
  bcrypt hashes stored on the `User` record, using Auth.js/bcrypt — the application
  never implements its own hash or comparison. Existing Supabase Auth password hashes
  are bcrypt and migrate with the accounts (verified per account during the identity
  reconciliation, database audit R4), so users keep their passwords.
- **Sessions:** Auth.js **database sessions** (Session table), not stateless JWTs —
  chosen specifically so sessions can be **revoked**: on account suspension, on role
  or permission change, on password change/reset, and by an admin action
  (`revokeUserSessions`). Every request re-loads the user from the database and
  checks `is_active`; a suspended user's existing cookie stops working immediately
  (spec Part 23, Scenario 17).
- **Cookies:** session cookie is `HttpOnly`, `Secure`, `SameSite=Lax`, scoped to the
  app domain. No identity data is stored in browser storage — the old SPA's
  `localStorage` flags (`bla_is_authenticated`, `bla_user_role`, …) and its fabricated
  `access_token: "local"` session are abolished (frontend audit §5.1).
- **Expiry:** absolute session lifetime 7 days, idle timeout 24 hours for staff
  consoles and 12 hours for privileged roles (Super Admin, Admin, Finance), enforced
  by session `expires` + last-seen checks in the session callback. Expiry values live
  in SystemSetting so they can be tightened without a deploy.
- **Password reset:** request endpoint issues a single-use token (stored hashed,
  1-hour expiry), emailed via NotificationService. Reset invalidates all existing
  sessions for the account. The endpoint responds identically whether or not the
  email exists (no account enumeration).
- **Email verification:** required before a self-registered vendor account can leave
  `pending_verification`; staff-created accounts are verified by the creating admin's
  act of creation (flag recorded).
- **MFA:** TOTP via Auth.js-compatible library support. Policy flag in SystemSetting:
  MFA **required** for `super_admin` and `admin`, optional for others at launch;
  enrolment is part of first login for privileged roles.
- **Account creation:** there is **no public registration for any operational role**
  (§5). Accounts are created by Super Admin/Admin (UserService) or by invitation
  (UserInvitation: hashed token, expiry, single use, role fixed by the inviter).

### Login rate limiting and failed-login monitoring

- Per-account **and** per-IP throttling on the credentials endpoint and the
  password-reset request endpoint: counters in a `LoginAttempt` table (email, IP,
  success, timestamp). After 5 consecutive failures for an account: exponential
  backoff; after 10: temporary lock (15 minutes) and a `login.locked` audit event.
  Public tracking and file-upload endpoints carry their own per-IP limits (§7).
- Failed-login monitoring: AuditService records every failure; a burst (≥20 failures
  across accounts from one IP in 10 minutes) creates an admin notification
  (NotificationService, category `critical_incident` per spec Part 17).
- The old system had **no rate limiting anywhere** (backend audit §6); these limits
  are implemented in the auth layer itself, not as optional middleware.

---

## 3. Authorization model

### 3.1 Roles (spec Part 4)

`super_admin` · `admin` · `warehouse_admin` · `warehouse_staff` · `rider` ·
`linehaul_driver` · `vendor` · `customer` · `finance` · `support`.

Vendor-internal roles (Vendor Owner / Manager / Booking Staff / Accounts Staff,
spec Part 14.2) are `VendorUser` roles scoped to one vendor organization; they refine
the `vendor` role rather than adding global roles. Driver *capabilities*
(pickup / delivery / combined / line-haul, spec Part 10.2) are capability rows used
by assignment logic, not permissions.

### 3.2 Permissions

Permissions are dot-named capabilities (spec Part 21.2), stored as
`Role` / `Permission` / `RolePermission` / `UserRole` tables and seeded from
`role-permission-matrix.md`. The catalog includes, at minimum:

`warehouse.create`, `warehouse.read_all`, `warehouse.read_assigned`,
`warehouse.update`, `warehouse.assign_staff`, `package.create`,
`package.read_all`, `package.read_assigned`, `package.receive`, `package.dispatch`,
`package.change_status`, `inventory.read_all`, `inventory.read_warehouse`,
`transfer.create`, `transfer.approve`, `transfer.dispatch`, `transfer.receive`,
`delivery.assign`, `delivery.confirm`, `finance.read`, `finance.adjust`,
`settlement.approve`, `user.manage`, `audit.read` — plus module permissions for
orders, drivers, vehicles, vendors, customers, tasks, incidents, reports, settings
and pricing (`order.approve`, `driver.manage`, `vehicle.manage`, `vendor.approve`,
`payment.record`, `cod.verify`, `return.approve`, `task.assign`, `incident.manage`,
`report.read`, `settings.manage`, `pricing.manage`, …). The full matrix is the
companion document; this doc defines how permissions are *enforced*.

Role names alone never authorize anything. A handler asks "does this actor hold
`transfer.approve` **and** is this transfer within their scope?", never "is this
user a warehouse_admin?".

### 3.3 The central authorization-aware data layer

- Every request builds an **ActorContext** once, server-side: `{ userId, roles,
  permissions, warehouseIds (from active WarehouseMemberships), vendorId (from
  VendorUser), driverId, customerId }`. It is constructed from the session + database
  on each request — never from request input, never cached in the client.
- `requirePermission(actor, 'package.receive')` guards every Server Action and Route
  Handler as its first statement. Actions without the guard do not exist: the action
  wrapper's signature requires a permission argument.
- **Repositories are scope-enforcing.** A repository function takes the ActorContext
  and applies scope inside the Prisma query (`where: { warehouseId: { in:
  actor.warehouseIds } }`, `vendorId: actor.vendorId`, …). There is no repository
  function that returns unscoped operational data to a request handler; unscoped
  access exists only inside services that themselves check `*.read_all`-style
  permissions first.
- **Warehouse scope resolution follows spec Part 20.2 exactly:** authenticate →
  load the current user from the database → determine active roles → determine
  warehouse memberships → check the requested warehouse against memberships → apply
  the scope inside the query → return only authorized data.
- Finance and custody are mutually exclusive by permission construction: no role
  holds both `finance.adjust` and any custody-changing permission
  (`package.receive/dispatch`, `delivery.confirm`) — finance staff cannot change
  physical custody and warehouse staff cannot touch financial records
  (spec Parts 4.9, 26.3).

### 3.4 Denied access

Out-of-scope resource access returns an authorization error (403 for an authenticated
actor acting outside scope; 404 where revealing existence would leak another tenant's
data — e.g. package detail by tracking id outside the actor's scope). Every denial on
a sensitive resource writes an AuditLog row (`access.denied`, actor, resource,
attempted scope) **without** copying the protected data into the log
(spec Part 23, Scenario 11).

---

## 4. Session revocation and account lifecycle

| Event | Effect |
|---|---|
| Account suspended/deactivated (`is_active=false`) | All sessions deleted; login refused; audit event. If the user holds package custody or open assignments, the suspending admin is warned and custody reassignment is required (Scenario 17). |
| Role/permission change | All sessions deleted (user re-logs-in with the new permission set); audit event with before/after. |
| Password change or reset | All other sessions deleted. |
| Admin "revoke sessions" action | Sessions deleted; audit event. |
| Vendor suspended | Vendor users' sessions deleted; vendor bookings frozen (no new bookings, in-flight packages continue). |
| Driver deactivated | Sessions deleted; open tasks/trips must be reassigned through DeliveryService/TripService so custody handovers are recorded (Scenario 14). |

---

## 5. Registration and the closed signup hole

The old `POST /auth/signup` accepted a caller-selected role from a whitelist that
included `super_admin` and `admin` — a complete privilege-escalation path that
bypassed the DB-role hardening because the attacker *created* the DB row
(backend audit §3.5). In the rebuild:

- **No public endpoint creates an operational account.** Staff, driver, finance and
  support accounts are created by Super Admin/Admin in the Users module, or via
  invitation with the role fixed by the inviter.
- **Vendor self-registration is the only public signup**, and it creates: a `Vendor`
  in `pending_verification`, and one Vendor Owner user with **no operational
  permissions** until an admin approves the vendor (verification lifecycle:
  pending → under review → approved / rejected / suspended, spec Part 14.1). A
  pending vendor cannot create bookings, see rates beyond the public tariff, or read
  any operational data.
- **Customers do not register to track.** Public tracking needs no account
  (spec Part 4.8); a customer account is optional and created at booking time or by
  the customer with email verification, holding only `customer`-scope permissions.
- The old SPA's hardcoded `role: "customer"` signup call and the demo credentials
  printed on the driver login page (frontend audit §8.2) do not carry over; neither
  do the "continue without login (dev only)" bypasses in the driver and vendor apps.

---

## 6. Input validation, injection, and error hygiene

- **Zod everywhere.** Every action/handler input is parsed by a strict Zod schema
  (unknown keys rejected, string lengths bounded, enums drawn from the lifecycle
  tables). This replaces the old mix of raw `dict` bodies (`/auth/login`,
  `/auth/signup`), all-query-param mutations (driver tasks), and `extra="ignore"`
  schemas (backend audit §6).
- **SQL injection** is structurally prevented by Prisma's parameterized queries; raw
  SQL is confined to ReportingService aggregations, uses bound parameters only, and
  is covered by the security test set.
- **Error envelope:** all failures return the standard envelope (`api-reference.md`
  §1) with a stable code and a safe message. Raw exception text is logged
  server-side, never returned (the old auth endpoints returned `str(e)`).
  List endpoints never mask a database failure as an empty result (the old
  `/workflow/orders/pending` and vehicle helpers returned `[]` on any error).
- **Output encoding** is React's default escaping; the public tracking page renders
  only the redacted public projection (§7), never raw internal notes.

---

## 7. Endpoint-level protections

- **CSRF:** Server Actions are same-origin by framework design and carry Auth.js's
  CSRF token; session cookies are `SameSite=Lax`. Mutating Route Handlers
  additionally verify the `Origin`/`Referer` host matches the app origin.
- **Security headers** (set globally in Next.js config/middleware): `Strict-Transport-
  Security`, `Content-Security-Policy` (self + MapTiler + Cloudinary origins),
  `X-Content-Type-Options: nosniff`, `frame-ancestors 'none'` (replacing
  X-Frame-Options), `Referrer-Policy: strict-origin-when-cross-origin`. The old
  backend set **none** of these.
- **CORS:** the API is same-origin (one Next.js app serves UI + API). No wildcard
  CORS is configured; the old `allow_origins` env list and `allow_methods=["*"]`
  setup disappears with the separate backend.
- **Rate limits:** login and password reset (§2), public tracking (per IP +
  per tracking id), file upload (per user), and a global per-IP ceiling on `/api/**`.
  Counters are database-backed (LoginAttempt / rate-limit table) so limits hold
  across instances.
- **Public tracking privacy:** the old lookups (`GET /orders/by-number/{n}`,
  `GET /shipments/by-tracking/{code}`, `GET /shipments/{id}/events`) returned full
  recipient name/phone/address and the internal audit trail with **no verification
  factor**. The new public endpoint returns a minimal projection (status, progress,
  origin/destination city, last update) for a tracking id alone; the detailed
  timeline and live driver position require the second factor — the recipient phone
  number on the booking (spec Part 4.8). Internal notes, driver personal details,
  vendor data and financial fields are never in the public projection.
- **Cron endpoints** authenticate with a `CRON_SECRET` bearer token compared in
  constant time, and **fail closed**: an unset secret disables the endpoints
  (the old check passed when `CRON_TOKEN` was unset).
- **Webhooks** (payment gateway) verify the provider signature before any processing
  and are idempotent by provider event id (§8).
- **API docs surface:** no interactive API docs are exposed in production (the old
  FastAPI `/docs` was).

---

## 8. Idempotency, concurrency, and the audit log

- **Idempotency keys** (spec Parts 20.1, 23 Scenarios 7 & 12): clients send an
  `Idempotency-Key` on mutations that must not duplicate — payment recording, COD
  collection/remittance, settlement creation, scan events, delivery confirmation.
  Keys are stored with the actor and request fingerprint under a unique constraint;
  a retry returns the original result. At the database level: unique
  `transaction_ref` on payments (absent today), unique idempotency key on
  TrackingEvent/scan records so a double scan is detected and reported to the
  scanner instead of duplicating inventory (Scenario 7).
- **Concurrency:** multi-step operations run in Prisma transactions; package and
  transfer rows carry a version column for optimistic concurrency — two staff
  racing to receive/dispatch the same package get one success and one conflict
  response, never two custody records (Scenario 8).
- **AuditLog (immutable):** append-only table (no update/delete grants; corrections
  are new rows). Records: logins (success/failure), account and role changes,
  permission changes, warehouse membership changes, sensitive financial actions
  (adjustments, refunds, settlement approvals — with reason and approver),
  denied-access events, settings changes, and every Super Admin action
  (spec Part 4.1: Super Admin is audited too). Domain history (package events,
  custody, money) lives in TrackingEvent / LedgerTransaction, which are likewise
  append-only; financial corrections are linked reversal/adjustment rows, never
  edits (spec Part 13.5).

---

## 9. Secrets and environment

- **Server-only secrets** (never in browser code, never `NEXT_PUBLIC_`): database
  connection URL (pooled + direct for migrations), `AUTH_SECRET`, Cloudinary API
  secret, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `CRON_SECRET`,
  EmailJS private key, Textlocal API key, OpenRouteService key, payment-gateway
  secret + webhook secret.
- **Public by design** (the only values shipped to browsers): Supabase URL + **anon
  key** (RLS-filtered realtime only, §10), MapTiler public key. The old app shipped
  the same public set; the rebuild's difference is that nothing else joins it — in
  particular the **service-role key never reaches the client** and is used only by
  server-side admin utilities, never in request handling for data access (Prisma
  replaces it).
- `.env` files are git-ignored (as in the old repo); `.env.example` documents names
  only — including the payment-gateway variables the old code used but never
  documented (backend audit §2.8). Production values live in the host's secret
  store, not in `render.yaml`-style plaintext.
- The old `SUPABASE_JWT_SECRET` was blank in the provided env while the backend
  500'd any token-bearing request without it; in the rebuild the secret is required
  at boot (for realtime token minting) and the app refuses to start without it —
  fail closed, with a clear log line, instead of per-request 500s.

---

## 10. Row-Level Security — defense in depth, not the control

Per spec Part 20.2: RLS is an **additional** protection, never a substitute for
application authorization. Concretely:

- The Next.js app connects via Prisma as the database owner role, which bypasses
  RLS. **All** authorization for app traffic is therefore the service/repository
  layer (§3). Nobody may point at RLS as the reason a query is safe.
- RLS stays **enabled** on all tables, and policies are maintained for the two
  surfaces that do not go through Prisma: (a) **Supabase Realtime subscriptions**
  from browsers, where policies keyed to the minted JWT's claims are the transport
  filter (§system-architecture §5); (b) any direct PostgREST access, which is
  restricted to the same realtime tables — all other tables get deny-all policies
  for `anon`/`authenticated` roles so the public anon key cannot read operational
  data directly (today, coarse `is_staff()` policies give every staff role global
  cross-warehouse read/write at the SQL level — database audit §4; those policies
  are tightened or closed as tables migrate).
- During migration, the three live-only tables (`warehouse_memberships`,
  `inventory_movements`, `warehouse_transfer_items`) — whose live RLS state could
  not be verified via REST (database audit R2) — are checked in `pg_catalog` before
  cutover; if RLS is off on any of them, it is enabled before the new app ships.

---

## 11. Old hole → new control (traceability)

| # | Old hole (audit reference) | New control |
|---|---|---|
| 1 | `REQUIRE_AUTH=false` disables **all** guards; `/auth/login` accepts any password for an existing user; `{"role": "dev-bypass"}` sentinel asserted by a test (backend §3.4) | No bypass mode exists. Auth.js verifies bcrypt on every login, in every environment. The sentinel and its test are deleted. |
| 2 | `POST /auth/signup` lets anyone self-register as `super_admin`/`admin` (backend §2.1, §3.5) | No public operational registration (§5). Admin-created/invited accounts only; vendor signup lands in `pending_verification` with zero operational permissions. |
| 3 | Client-asserted identity: localStorage flags, fabricated `access_token: "local"`, no token at all (frontend §5.1) | Database sessions in HTTP-only cookies; identity resolved server-side per request (§2). |
| 4 | Entire route groups with **no auth dependency**: all of `/analytics/*`, full customer CRUD incl. DELETE, `/ops` lists, order/driver/shipment GETs (backend §2) | Deny-by-default wrapper: every action/handler declares its permission (§3.3). Customer CRUD requires `customer.*` permissions; analytics become permission-checked report endpoints. |
| 5 | Public tracking returns full PII + internal audit trail, no verification factor (backend §2.2, §2.9) | Redacted public projection + phone second factor (§7). |
| 6 | No warehouse scoping anywhere — a warehouse_admin token operates on any warehouse (backend §3.5) | Membership-scoped repositories; scope inside every query (§3.3, spec Part 20.2 flow). Proven by security tests (Warehouse A → B denied + logged). |
| 7 | Role fallback to the **untrusted JWT metadata hint** when the DB is unreachable (backend §3.3) | ActorContext is built from session + DB or the request fails closed. There is no hint path. |
| 8 | `/ops/profile` with no token resolves "the operator" as the **first staff row in the DB** (backend §2.5) | Bootstrap endpoint requires a session and returns the actual actor's profile and scoped counts. |
| 9 | Cron token check passes when `CRON_TOKEN` is unset (backend §2.7) | Fail-closed `CRON_SECRET` (§7). |
| 10 | No rate limiting or lockout on login/signup (backend §6) | Per-account + per-IP limits, lockout, monitoring (§2). |
| 11 | Raw exception strings returned to clients; DB errors masked as empty lists (backend §6) | Standard error envelope; failures surface as errors, logged server-side (§6). |
| 12 | Payments authorised by raw JWT role claim instead of the DB role; Stripe currency defaulted to INR (backend §2.8) | All authorization via ActorContext permissions; currency is NPR by schema default and configuration (spec Part 13). |
| 13 | POD photos public on Cloudinary, no type/size validation (backend §4.11) | Private assets, content-sniffed validation, signed URLs after permission check (system-architecture §6). |
| 14 | Demo credentials printed on the driver login page; "continue without login" links shipped (frontend §8.2/§8.3) | Removed; no demo accounts exist in production seed. |
| 15 | Hard deletes of orders/customers; cascade chains wipe history (backend §2.2; database R5) | Deactivation/archival + RESTRICT on history-bearing FKs; financial/tracking records append-only (§8). |
| 16 | No idempotency anywhere — duplicate payment/scan creates duplicates (database R8) | Idempotency keys + unique constraints (§8). |

---

## 12. Security verification (summary)

The full test plan is in `testing-strategy.md`; the security-critical cases are:
cross-warehouse access denied at the API (not just hidden in UI), cross-vendor
access denied, rider access limited to assigned work, finance↔custody separation,
suspended-user session rejection, unauthenticated action/handler rejection,
ID-tampering (modified ids in URLs and payloads) denied and logged, duplicate
payment/scan replays returning the original result, and public tracking exposing
no internal fields. No phase is reported complete until its security cases pass
(spec Part 26.3, Part 30 rule 25).
