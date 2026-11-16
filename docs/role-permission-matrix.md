# Role–Permission Matrix — BLA Logistics Platform (Next.js rebuild)

**Status:** Target design for the rebuild (spec Parts 4, 20, 21) — **regenerated against the built catalog in V2 Phase 8 (2026-11-16), §7.** The code catalog (`src/lib/permissions/catalog.ts`) is now the single source of truth; §7 records the generated counts and the V2 grant changes that supersede the §3 tables where they differ. The Prisma schema (Phase 1) seeds `Role`, `Permission`
and `RolePermission` rows from §3 of this document, and every Server Action / Route
Handler checks a permission from this list before doing work.

---

## 1. Where we are today (audit findings, 2026-11-15)

| Aspect | Today | Problem |
|---|---|---|
| Identity | Supabase `auth.users` owns credentials; `public.users` mirrors it 1:1 by UUID **by convention only** (no FK) and holds one `role` column | Mirror can drift; seed files use fabricated UUIDs that match no Auth account |
| Roles | Single enum `user_role`, 10 values: `admin, dispatcher, warehouse, driver, customer, super_admin, warehouse_admin, vendor, micro_driver, big_driver` | No Permission / RolePermission / UserRole tables exist — permissions are implicit in code |
| Driver split | `users.role` is plain `driver` for all 4 live drivers; the operational split lives in `drivers.driver_type` (`micro`/`big`). `micro_driver`/`big_driver` enum values are unused live | Two sources of truth for what a driver may do |
| Warehouse scoping | Live-only table `warehouse_memberships` (user × warehouse × `role_purpose`: `driver_home` ×4, `admin` ×1) holds the real assignments, but the SQL RLS model **does not use it** — `is_staff()` grants every staff role global cross-warehouse access | Warehouse isolation depends on old backend code, not the database |
| Vendor scoping | `users.vendor_id` (single vendor per user, no sub-roles) | A vendor's booking staff and accounts staff share one identity class |
| Enforcement | FastAPI backend connects with the **service_role key (bypasses RLS entirely)**; its own gate is behind `REQUIRE_AUTH` (false in the provided dev `.env`) and a **blank** `SUPABASE_JWT_SECRET` | With `REQUIRE_AUTH=false`, `/auth/login` accepts **any password** for an existing email; `/auth/signup` lets a caller **self-select `super_admin`**; live `shipment_events` carry actor_role `dev-bypass` |
| Fail behaviour | If the DB is unreachable, `_effective_role()` falls back to the **untrusted JWT `user_metadata.role`** hint | Fail-open exactly when the system is in trouble |

**Rebuild rule:** none of the above carries over. The Next.js app is the only backend;
it loads the user, roles, permissions and warehouse memberships from the database on
every request, denies by default, and fails closed.

## 2. Roles in the new system

| Code | Role | Who | Legacy mapping |
|---|---|---|---|
| SA | **Super Admin** | Platform owner | `super_admin` (legacy `admin` was treated as super-admin by `is_super_admin()` — that equivalence is **removed**; live `admin` accounts migrate to Admin unless Meena promotes them) |
| AD | **Admin / Operations Admin** | Company operations management | `admin`, `dispatcher` (dispatch functions become permissions, not a role) |
| WA | **Warehouse Admin** | Manages exactly the warehouse(s) they are a member of | `warehouse_admin` |
| WS | **Warehouse Staff / Operator** | Physical package handling in one warehouse | `warehouse` |
| DR | **Delivery Rider** | Pickup and/or final-mile delivery; capability-flagged (see §5.3) | `driver` (type `micro`), `micro_driver` |
| LD | **Line-haul Driver** | Warehouse-to-warehouse transport | `driver` (type `big`), `big_driver` |
| VN | **Vendor** | Business customer; four sub-roles (§5.4) | `vendor` |
| CU | **Customer / Recipient** | Package recipient; **no account required to track** | `customer` |
| FN | **Finance / Accounts** | Payments, COD, settlements | *(new — no legacy equivalent)* |
| SP | **Customer Support** | Complaints, cases, investigations | *(new — no legacy equivalent)* |

A user holds **one primary role** plus, for WA/WS/DR/LD, one or more
`WarehouseMembership` rows, and for VN exactly one vendor organisation with a
vendor sub-role. Capabilities (rider pickup/delivery, driver vehicle classes) are
data on the driver profile, not extra roles.

## 3. Permission matrix

Legend: **✓** allowed · **—** denied · **W** scoped to own warehouse membership(s) ·
**V** scoped to own vendor organisation · **A** assigned work only · **O** own records only ·
**P** public, with tracking-ID + verification factor (no login).

### 3.1 Identity, users, system

| Permission | SA | AD | WA | WS | DR | LD | VN | CU | FN | SP |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `user.manage` (create/update/deactivate/suspend users) | ✓ | ✓¹ | — | — | — | — | — | — | — | — |
| `user.invite` | ✓ | ✓¹ | W² | — | — | — | V³ | — | — | — |
| `role.manage` (edit role→permission mapping) | ✓ | — | — | — | — | — | — | — | — | — |
| `settings.manage` (system settings, status rules, notification config) | ✓ | — | — | — | — | — | — | — | — | — |
| `pricing.manage` (tariffs, volumetric divisor, service config) | ✓ | ✓ | — | — | — | — | — | — | — | — |
| `service_area.manage` | ✓ | ✓ | — | — | — | — | — | — | — | — |
| `audit.read` | ✓ | ✓⁴ | W | — | — | — | — | — | ✓⁴ | — |
| `profile.update_own` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

¹ AD cannot create, promote or suspend SA/AD accounts, and cannot grant permissions
they do not themselves hold. ² WA may invite WS/DR for their own warehouse only; the
invitation carries no role above WS/DR. ³ Vendor Owner only, inside own organisation.
⁴ AD/FN see the audit log without organisation-security events (role changes,
permission edits, SA actions on accounts); FN sees financial events only.

### 3.2 Warehouses and locations

| Permission | SA | AD | WA | WS | DR | LD | VN | CU | FN | SP |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `warehouse.create` | ✓ | ✓ | — | — | — | — | — | — | — | — |
| `warehouse.read_all` | ✓ | ✓ | — | — | — | — | — | — | ✓⁵ | ✓⁵ |
| `warehouse.read_assigned` | ✓ | ✓ | W | W | W⁶ | W⁶ | — | — | — | — |
| `warehouse.update` | ✓ | ✓ | W⁷ | — | — | — | — | — | — | — |
| `warehouse.deactivate` (never delete) | ✓ | ✓ | — | — | — | — | — | — | — | — |
| `warehouse.assign_staff` | ✓ | ✓ | W⁸ | — | — | — | — | — | — | — |
| `warehouse.manage_locations` (zones, racks, shelves, bins) | ✓ | ✓ | W | — | — | — | — | — | — | — |
| `warehouse.capacity.read` | ✓ | ✓ | W | W | — | — | — | — | — | — |

⁵ Read-only directory data (name, code, city) for finance/support context — never
inventory or staff detail. ⁶ Home warehouse identity only (name/code for trip and
assignment display). ⁷ WA edits operational fields of own warehouse (hours, contact,
capacity warnings); code, type and status changes are AD/SA. ⁸ WA assigns existing
WS/DR users to own warehouse; creating users is `user.invite`.

### 3.3 Bookings, orders, packages

| Permission | SA | AD | WA | WS | DR | LD | VN | CU | FN | SP |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `booking.create` | ✓ | ✓ | W | — | — | — | V | — | — | — |
| `booking.read_all` | ✓ | ✓ | — | — | — | — | — | — | ✓⁹ | ✓⁹ |
| `booking.read_warehouse` | ✓ | ✓ | W | W | — | — | — | — | — | — |
| `booking.read_vendor` | — | — | — | — | — | — | V | — | — | — |
| `booking.update` (pre-pickup corrections) | ✓ | ✓ | W | — | — | — | V¹⁰ | — | — | ✓¹¹ |
| `booking.cancel` (stage rules apply) | ✓ | ✓ | W | — | — | — | V¹⁰ | — | — | — |
| `package.create` (generate packages + tracking IDs) | ✓ | ✓ | W | — | — | — | V | — | — | — |
| `package.read_all` | ✓ | ✓ | — | — | — | — | — | — | ✓⁹ | ✓⁹ |
| `package.read_assigned` | ✓ | ✓ | W | W | A | A | — | — | — | — |
| `package.receive` (receiving scan → inventory) | ✓ | ✓ | W | W | — | — | — | — | — | — |
| `package.inspect` (condition, weight, damage record) | ✓ | ✓ | W | W | A¹² | — | — | — | — | — |
| `package.sort` (storage location, sorting) | ✓ | ✓ | W | W | — | — | — | — | — | — |
| `package.hold` / release hold | ✓ | ✓ | W | — | — | — | — | — | — | ✓¹³ |
| `package.change_status` | — | — | — | — | — | — | — | — | — | — |
| `package.return_initiate` | ✓ | ✓ | W | — | A¹⁴ | — | V¹⁵ | O¹⁶ | — | ✓¹³ |
| `tracking.read_public` | P | P | P | P | P | P | P | P | P | P |

⁹ Finance/support see booking/package headers and financial or tracking fields
relevant to their function — never internal warehouse notes (SP) or custody detail
(FN). ¹⁰ Vendor: own bookings, only while stage rules allow (before pickup; after
pickup it becomes a return/cancellation workflow, never an edit). ¹¹ SP may submit an
address-correction **request**; applying it is AD/WA. ¹² Rider records condition and
weight at pickup for assigned packages only. ¹³ SP raises the request; the state
change is executed by AD/WA through the lifecycle service. ¹⁴ Rider records refusal/
failure at the door; the return itself is created by WA/AD. ¹⁵ Vendor requests return
of own shipments. ¹⁶ Recipient requests return/reschedule through the verified
tracking flow.

**`package.change_status` is granted to no role.** Statuses change only when the
PackageLifecycleService executes a validated transition as a side effect of a real
operation (receive scan, dispatch, delivery confirmation…). There is no endpoint
that sets a status directly — this is the enforcement of spec §1.3 ("do not consider
a package received simply because an admin changed its status").

### 3.4 Inventory and custody

| Permission | SA | AD | WA | WS | DR | LD | VN | CU | FN | SP |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `inventory.read_all` | ✓ | ✓ | — | — | — | — | — | — | — | — |
| `inventory.read_warehouse` | ✓ | ✓ | W | W | — | — | — | — | — | — |
| `inventory.move_internal` (rack/zone moves) | ✓ | ✓ | W | W | — | — | — | — | — | — |
| `inventory.correct` (with reason + incident link) | ✓ | ✓ | W | — | — | — | — | — | — | — |
| `supplies.manage` (boxes, tape, labels stock) | ✓ | ✓ | W | W | — | — | — | — | — | — |
| `custody.handover` (offer/confirm a handover) | ✓ | ✓ | W | W | A | A | — | — | — | — |
| `custody.read` | ✓ | ✓ | W | W | A | A | V¹⁷ | — | — | ✓⁹ |

¹⁷ Vendor sees custody at milestone level for own packages ("at Pokhara hub",
"with delivery rider") — never staff identities.

### 3.5 Transfers, trips, vehicles, drivers

| Permission | SA | AD | WA | WS | DR | LD | VN | CU | FN | SP |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `transfer.create` | ✓ | ✓ | W¹⁸ | — | — | — | — | — | — | — |
| `transfer.read_all` | ✓ | ✓ | — | — | — | — | — | — | — | ✓⁹ |
| `transfer.read_warehouse` | ✓ | ✓ | W | W | — | A¹⁹ | — | — | — | — |
| `transfer.approve` | ✓ | ✓ | W²⁰ | — | — | — | — | — | — | — |
| `transfer.prepare` (manifest, picking) | ✓ | ✓ | W | W | — | — | — | — | — | — |
| `transfer.load` (loading scans) | ✓ | ✓ | W | W | — | A¹⁹ | — | — | — | — |
| `transfer.dispatch` | ✓ | ✓ | W | — | — | — | — | — | — | — |
| `transfer.receive` (destination receiving + scans) | ✓ | ✓ | W | W | — | — | — | — | — | — |
| `transfer.reconcile` | ✓ | ✓ | W²¹ | — | — | — | — | — | — | — |
| `trip.read_assigned` | ✓ | ✓ | W | — | A | A | — | — | — | — |
| `trip.update_progress` (checkpoints, delay, arrival) | ✓ | ✓ | W | — | A | A | — | — | — | — |
| `trip.report_incident` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — | — |
| `vehicle.manage` | ✓ | ✓ | — | — | — | — | — | — | — | — |
| `vehicle.assign` | ✓ | ✓ | W | — | — | — | — | — | — | — |
| `driver.manage` (profiles, documents, activation) | ✓ | ✓ | W²² | — | — | — | — | — | — | — |
| `driver.assign` (work assignment) | ✓ | ✓ | W | — | — | — | — | — | — | — |
| `driver.read_self` | — | — | — | — | O | O | — | — | — | — |

¹⁸ Origin warehouse must be own warehouse. ¹⁹ LD sees and loads only the transfer/
trip assigned to them. ²⁰ WA approves transfers **into or out of** own warehouse
where approval is configured; AD/SA approve any. ²¹ The **destination** WA reconciles
receipt; the origin WA and AD can view but not close a transfer into a warehouse
they don't administer. ²² WA manages riders home-based at own warehouse (availability,
assignment) — license/document verification is AD/SA.

### 3.6 Pickup and delivery

| Permission | SA | AD | WA | WS | DR | LD | VN | CU | FN | SP |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `pickup.assign` | ✓ | ✓ | W | — | — | — | — | — | — | — |
| `pickup.confirm` (collect, scan, condition) | ✓ | ✓ | W | — | A | — | — | — | — | — |
| `delivery.assign` (incl. batching) | ✓ | ✓ | W | — | — | — | — | — | — | — |
| `delivery.attempt.record` | ✓ | ✓ | W | — | A | — | — | — | — | — |
| `delivery.confirm` (proof + COD capture) | ✓ | ✓ | W | — | A | — | — | — | — | — |
| `delivery.read_assigned` | ✓ | ✓ | W | — | A | — | — | — | — | — |
| `delivery.reschedule_request` | — | — | — | — | — | — | V | O | — | ✓ |

### 3.7 Finance, COD, settlements

| Permission | SA | AD | WA | WS | DR | LD | VN | CU | FN | SP |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `finance.read` | ✓ | ✓²³ | — | — | — | — | — | — | ✓ | — |
| `invoice.create` | ✓ | — | — | — | — | — | — | — | ✓ | — |
| `invoice.read` | ✓ | ✓²³ | — | — | — | — | V | O²⁴ | ✓ | — |
| `finance.record_payment` | ✓ | — | — | — | — | — | — | — | ✓ | — |
| `finance.adjust` (linked adjustment, never edit) | ✓ | — | — | — | — | — | — | — | ✓²⁵ | — |
| `finance.approve_adjustment` | ✓ | — | — | — | — | — | — | — | ✓³³ | — |
| `cod.collect` (record at delivery) | — | — | — | — | A | — | — | — | — | — |
| `cod.remit` (submit remittance) | — | — | — | — | O | — | — | — | — | — |
| `cod.verify` (finance verifies remittance) | ✓ | — | — | — | — | — | — | — | ✓ | — |
| `cod.read` | ✓ | ✓²³ | W²⁶ | — | O | — | V | — | ✓ | — |
| `settlement.read` | ✓ | ✓²³ | — | — | — | — | V | — | ✓ | — |
| `settlement.prepare` | ✓ | — | — | — | — | — | — | — | ✓ | — |
| `settlement.approve` | ✓ | ✓²⁷ | — | — | — | — | — | — | — | — |
| `settlement.pay` (record payout) | ✓ | — | — | — | — | — | — | — | ✓ | — |
| `refund.process` | ✓ | — | — | — | — | — | — | — | ✓ | — |
| `payment.dispute.raise` | — | — | — | — | — | — | V | O | — | ✓ |

²³ AD sees operational finance (outstanding charges, COD totals, settlement status)
but cannot record, adjust or pay — those are FN with SA approval where noted.
²⁴ Customer sees invoices for own shipments only. ²⁵ FN creates the adjustment;
a **different** SA user must approve it (`finance.approve_adjustment`) before it
posts — no self-approval. ²⁶ WA sees COD expected on packages dispatched from own
warehouse and remittance status per rider — not amounts held by other warehouses.
²⁷ AD may approve settlements below a configured NPR threshold; above it, SA only.

### 3.8 Tasks, incidents, support, notifications, reports

| Permission | SA | AD | WA | WS | DR | LD | VN | CU | FN | SP |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `task.create` | ✓ | ✓ | W | — | — | — | — | — | ✓²⁸ | ✓²⁸ |
| `task.assign` | ✓ | ✓ | W | — | — | — | — | — | ✓²⁸ | ✓²⁸ |
| `task.update_own` (accept, progress, submit) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | ✓ |
| `task.verify` (review + close) | ✓ | ✓ | W | — | — | — | — | — | ✓²⁸ | ✓²⁸ |
| `incident.report` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | V²⁹ | O²⁹ | ✓ | ✓ |
| `incident.manage` (triage, assign, investigate) | ✓ | ✓ | W | — | — | — | — | — | ✓³⁰ | ✓ |
| `incident.resolve` | ✓ | ✓ | W³¹ | — | — | — | — | — | ✓³⁰ | ✓³¹ |
| `support.ticket.manage` | ✓ | ✓ | — | — | — | — | — | — | — | ✓ |
| `notification.read_own` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓³³ | ✓ | ✓ |
| `report.read_all` | ✓ | ✓ | — | — | — | — | — | — | ✓³² | — |
| `report.read_warehouse` | ✓ | ✓ | W | — | — | — | — | — | — | — |
| `report.read_vendor` | — | — | — | — | — | — | V | — | — | — |
| `report.read_self` (driver performance/COD) | — | — | — | — | O | O | — | — | — | — |

²⁸ Within own function (FN: finance investigations; SP: customer investigations).
²⁹ Vendor/recipient report incidents about **own** packages only (damage,
non-receipt). ³⁰ FN manages COD/payment incidents only. ³¹ Resolution of incidents
involving money or package write-off requires AD/SA approval regardless of who
investigates. ³² FN: financial reports only.

## 4. Scoping rules (enforced in the data-access layer)

### 4.1 Warehouse membership scoping
1. Every warehouse-scoped table carries an explicit `warehouseId` (or a FK chain to
   a row that does). There is no "global staff" read.
2. On each request the server loads the authenticated user **from the database**
   (never from client-supplied claims), resolves active `WarehouseMembership` rows,
   and injects the allowed warehouse ID set into every query as a `WHERE` clause.
3. A `warehouseId` sent by the browser is treated as an **untrusted filter**, never
   as proof of permission: if it is outside the membership set, the query returns
   nothing and the attempt is audit-logged (spec Scenario 11).
4. WA/WS with memberships in two warehouses switch an "active warehouse" context;
   each request is still checked against the full membership set, and writes record
   the warehouse they were performed under.
5. Removing a membership takes effect on the next request (no cached roles in a
   long-lived token) and, with account suspension, revokes sessions immediately.

### 4.2 Vendor organisation scoping
1. Every vendor-owned row carries `vendorId`. Vendor queries are force-scoped
   server-side (`vendorId = session.vendorId`); a `vendorId` in the request is
   ignored, not trusted — the same force-scoping the old backend applied in
   `shipments.py`, now applied uniformly.
2. Vendor sub-roles (§5.4) further restrict which modules inside the organisation
   respond: Booking staff never receive finance rows, Accounts staff never receive
   operational write access.
3. Vendors never receive: other vendors' data, staff identities, internal notes,
   custody detail beyond milestones, or driver personal data.

### 4.3 Rider / driver assigned-only scoping
1. DR/LD read sets are computed from live assignments: packages on their active
   pickup/delivery assignments or trip manifests, plus today's completed work.
2. A package ID outside that set returns 404 (not 403 — existence is not leaked).
3. Assignment is capability-checked at write time (a delivery-only rider cannot be
   assigned a pickup; an LD cannot confirm a final-mile delivery).

### 4.4 Customer / recipient scoping
1. Tracking is public but gated: tracking ID **plus** a verification factor
   (recipient phone number). Response contains only the public projection (§24 of
   the spec): no internal notes, no driver personal data, no vendor data, no
   financial detail beyond the recipient's own COD due.
2. Logged-in customers see only shipments where their verified phone/email matches
   sender or recipient contact.

### 4.5 Finance separation
Finance permissions never include custody or package-state permissions, and
operational roles never include `finance.record_payment` / `finance.adjust` /
`settlement.pay`. This separation is a permission-matrix property, not a UI
convention (spec §4.9: "Finance staff must not change physical package custody").

## 5. Role-specific rules

### 5.1 Super Admin is still audited
SA holds every permission but is not exempt from control: sensitive actions
(`role.manage`, `finance.approve_adjustment`, `warehouse.deactivate`,
`user.manage` on admin accounts, settlement approval above threshold) require a
confirmation step with a **reason**, are written to the append-only audit log, and
financial history cannot be deleted by anyone, including SA.

### 5.2 Admin vs Super Admin
AD runs the company day to day. Only SA touches organisation security: role→
permission mapping, system settings, admin account lifecycle, and approval of
financial adjustments. Dashboards are otherwise the same operational overview.

### 5.3 Rider capabilities
`DriverProfile.capabilities` is a set drawn from `{pickup, delivery}` for DR:
- pickup-only, delivery-only, or combined. Assignment services check the set on
  every assignment. LD is a separate role because trip/manifest permissions differ
  in kind, not just degree (spec §4.6).

### 5.4 Vendor sub-roles
| Sub-role | Extra permissions inside own organisation |
|---|---|
| Vendor Owner | All vendor permissions incl. `user.invite` (own org), settlement statements, disputes |
| Vendor Manager | All operational vendor permissions; no user management, no dispute approval |
| Vendor Booking Staff | `booking.create/read_vendor`, `package.create/read`, tracking — **no finance rows** |
| Vendor Accounts Staff | `invoice.read`, `settlement.read`, `cod.read`, statements, `payment.dispute.raise` — **no booking writes** |

### 5.5 Deny by default, checked everywhere
- Every Server Action and Route Handler begins with a permission check against
  this matrix; page-level checks are a UX convenience only.
- Permission checks live in one AuthorizationService; business services receive an
  already-authorised actor context and re-check resource scope (warehouse/vendor/
  assignment) at the query.
- Denied cross-scope attempts return an authorization error and are audit-logged
  without exposing the target record's data.
- Sessions: HTTP-only secure cookies, server-side session records, revocable on
  suspension, role change, or membership removal. No `REQUIRE_AUTH`-style global
  off switch exists in the new codebase, and there is no self-registration path
  that can grant a staff role — staff accounts are created by invitation only
  (`user.invite`), vendor self-registration lands in *Pending verification* with
  the Vendor role and no staff permissions.

## 6. Migration notes (from the live system)

- The 9 live accounts map as: `admin` ×2 → AD, `warehouse_admin` ×1 → WA (with its
  `warehouse_memberships` row, `role_purpose='admin'`), `driver` ×4 → DR or LD per
  `drivers.driver_type` (with `role_purpose='driver_home'` memberships), `dispatcher`
  ×1 → AD, `customer` ×1 → CU. No live `super_admin` exists: Meena designates the
  first SA explicitly at Phase 1 seed time; nobody is auto-promoted.
- The live `warehouse_memberships` table is the direct ancestor of the new
  `WarehouseMembership` model and its 5 rows migrate as-is.
- Legacy RLS helper functions (`is_staff()` etc.) are retired with the old schema;
  PostgreSQL RLS may be layered later as defence-in-depth but is **not** the
  authorisation mechanism of record — the Next.js data-access layer is (spec §20.2).

³³ **V2 correction (Phase 8):** the built catalog grants this
permission — see §7. The §3 cell above has been corrected to match
`src/lib/permissions/catalog.ts`; the footnote ²⁵ text (a *different*
Super Admin must approve a Finance-created adjustment) describes the
original design intent and is superseded by the service rule in §7.

---

## 7. V2 final state — regenerated from the catalog (Phase 8, 2026-11-16)

**Method (reproduce it, do not hand-edit these numbers):** the
counts below were generated programmatically from
`src/lib/permissions/catalog.ts` — roles from the `ROLE_CODES` array
/ `ROLES` definitions, permissions from the `PERMISSIONS` array
(every `P("code", …)` entry between `PERMISSIONS` and
`PERMISSION_CODES`), grants from `ROLE_PERMISSIONS`.

- **Role count: 10** — `SUPER_ADMIN`, `ADMIN`, `WAREHOUSE_ADMIN`,
  `WAREHOUSE_STAFF`, `RIDER`, `LINEHAUL_DRIVER`, `VENDOR`,
  `CUSTOMER`, `FINANCE`, `SUPPORT`. (Display abbreviations in §2 —
  SA/AD/WA/WS/DR/LD/VN/CU/FN/SP — map to these codes in that order.
  Landing paths per role are `ROLE_LANDING_PATH` in the same file,
  e.g. RIDER → `/rider`, LINEHAUL_DRIVER → `/transport-driver`.)
- **Permission count: 100** — the full code list is the
  `PERMISSIONS` array in the catalog; the seed
  (`prisma/seed.ts`) upserts exactly these rows and rebuilds
  `RolePermission` from `ROLE_PERMISSIONS` on every run. One
  permission, `package.change_status`, is defined but **granted to
  no role by design** — statuses change only as side effects of real
  operations through the lifecycle service.
- **Sync warning:** catalog grants reach an *existing* database
  only when the seed's permission sync runs. Deploying new code
  alone does not add new grants to a live database — see
  `docs/deployment-guide.md` (Production Readiness Checklist).

### 7.1 V2 grant changes (supersede §3 where they differ)

- **CUSTOMER — `notification.read_own` (V2 Phase 2, audit H-3).**
  Customers now hold `notification.read_own`, so the Customer
  dashboard's Notifications item renders and the notification
  service calls behind it are authorised (navigation registry,
  `src/lib/navigation/registry.ts`). The §3.8 cell is corrected
  above. Customer grants in full (catalog): `profile.update_own`,
  `tracking.read_public`, `package.return_initiate`,
  `delivery.reschedule_request`, `invoice.read`, 
  `payment.dispute.raise`, `incident.report`,
  `notification.read_own`.
- **FINANCE — `finance.approve_adjustment` (V2 Phase 2).** The
  catalog grants FINANCE both `finance.adjust` (create) and
  `finance.approve_adjustment` (approve). The §3.7 cell is
  corrected above. Separation of duties is preserved at the
  *service* layer, not by withholding the permission: an adjustment
  must be approved by a **different user** than its creator
  (self-approval is refused), which is the four-eyes rule the
  finance workflow enforces for adjustments and refunds.
  SUPER_ADMIN also holds both permissions.
- **WAREHOUSE_ADMIN — `cod.read` note.** Warehouse Admin holds
  `cod.read` (scoped to own warehouse: COD expected on packages
  from own warehouse and remittance status per rider — footnote
  ²⁶), but does **not** hold `finance.read`. Consequence beyond the
  COD screens: on the Live Operations board, a batch item carries
  `codCollectedPaisa` when the actor holds `finance.read` **or**
  `cod.read` — so a Warehouse Admin sees COD collected on movements
  in their scope, while actors with neither permission (e.g. a
  viewer granted only `operations.live_view` outside these roles)
  receive payloads with the field absent entirely. See
  `docs/live-gps-tracking.md` §3.
- **GPS-era grants (V2 Phases 3–5), for completeness:**
  `tracking.manage_own` is held by RIDER and LINEHAUL_DRIVER only;
  `operations.live_view` by SUPER_ADMIN, ADMIN and
  WAREHOUSE_ADMIN only. No other role can start a session or open
  the live board, and the APIs deny them regardless of the UI.
