# API Reference — BLA Logistics Platform (Next.js Rebuild)

**Status:** Phase 0 design document · 2026-11-15 — the **planned** API surface. **Superseded for the built surface by §21 (V2 Phase 8, 2026-11-16)**, which is generated from the actual Route Handler files. Sections 1–20 remain the design record; where a planned operation was never built (or was built differently), §21 governs.
**Sources:** master specification Parts 19–22, `BLA-audit/backend-audit.md` (§2 endpoint
inventory, §8 responsibilities map), `BLA-audit/frontend-audit.md` (§5.3 API client),
`BLA-audit/database-audit.md`
**Companion documents:** `system-architecture.md`, `security-architecture.md`,
`role-permission-matrix.md`, `database-schema.md`

---

## 1. Conventions

| Convention | Rule |
|---|---|
| Base path | All Route Handlers live under **`/api`**. Dashboard mutations are primarily **Server Actions** (listed as `Action: name`); Route Handlers serve public surfaces, file transfer, webhooks, cron, and any non-form consumer. Both call the same services — an operation exists in exactly one service regardless of surface. |
| Authentication | Auth.js **session cookie** (HTTP-only). No bearer tokens for app traffic, no identity in request bodies. Unauthenticated → `401`. |
| Authorization | Every operation lists its required **permission** (see `role-permission-matrix.md`). Scope (warehouse / vendor / driver / customer) is applied server-side inside the query — ids in paths are checked against the actor's scope, never trusted. |
| Success envelope | `{ "ok": true, "data": …, "meta": { "page": 1, "pageSize": 25, "total": 137 } }` (`meta` on lists only). |
| Error envelope | `{ "ok": false, "error": { "code": "PACKAGE_NOT_ELIGIBLE", "message": "…", "details": { … } } }`. Codes are stable and machine-readable; messages are safe (no exception text, no SQL, no stack traces). Standard codes: `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404 — also used for out-of-scope resources where existence must not leak), `VALIDATION_FAILED` (422), `CONFLICT` (409 — invalid state transition or concurrent update), `RATE_LIMITED` (429), `IDEMPOTENCY_REPLAY` is **not** an error — a replayed key returns the original success response. |
| Pagination | Lists accept `?page=` (default 1) and `?pageSize=` (default 25, max 100), `?sort=field:asc\|desc`, `?search=`, plus module filters (`status`, `warehouseId`, `vendorId`, `driverId`, `from`, `to` — dates interpreted in Asia/Kathmandu, stored/compared in UTC). Server-side only; thousands of rows are never shipped to the browser. |
| Idempotency | Mutations accept an **`Idempotency-Key`** header (actions: an `idempotencyKey` argument). **Required** for payment recording, COD collection/remittance, settlement creation, delivery confirmation and scan events. A repeated key returns the original result without re-executing. |
| Money | NPR, decimal strings in JSON (`"1250.00"`), never floats. |
| IDs | UUIDs for entities; human codes where operations use them (`BLA-YYYY-NNNN` order numbers, `BLA-PAR-YYYY-NNNNNN` tracking codes, warehouse codes). |
| Versioning | The app is a monolith (UI + API ship together), so no `/v1` prefix; breaking internal changes ship atomically. Public tracking (§17) is the only surface external consumers may cache against. |

The old API had none of these conventions: no envelope, raw `dict` bodies on auth,
mutations via query params (driver tasks), free-string statuses, and ~30 endpoints
with no auth at all. The "Replaces" column traces each new operation to the old
surface it retires (backend audit §2 numbering).

---

## 2. Auth & session

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `POST /api/auth/signin/credentials` (Auth.js) | public | Email + password login on the single login page; verifies bcrypt, records the attempt, creates a DB session, returns the role landing path. Replaces `POST /auth/login` — **without** the dev-bypass (any-password) behaviour and without returning identity for the client to store. |
| `POST /api/auth/signout` (Auth.js) | authenticated | Logout; deletes the session row. New (old backend had no logout). |
| `GET /api/auth/session` (Auth.js) | authenticated | Current actor: user, roles, permissions, warehouse memberships, vendor/driver links. Replaces `GET /auth/me` (the console gate becomes server-side route-group checks; portal hints are a UI concern driven by this payload). |
| `GET /api/session/bootstrap` | authenticated | Dashboard bootstrap in one call: actor profile + **scope-filtered** sidebar counts/badges + environment status. Replaces `GET /ops/profile` — minus its no-token "first staff user" fallback. |
| `POST /api/auth/password-reset/request` | public, rate-limited | Issues a hashed, single-use, 1-hour reset token by email; response is identical for unknown emails. New. |
| `POST /api/auth/password-reset/confirm` | public (token) | Sets a new password; revokes all sessions for the account. New. |
| `Action: changeOwnPassword` | authenticated | Verifies current password, sets new one, revokes other sessions. New. |
| `POST /api/auth/register/vendor` | public, rate-limited | Vendor self-registration → Vendor in `pending_verification` + Vendor Owner user with **no operational permissions**. Replaces `POST /auth/signup` — the privileged-role self-selection is removed; no other public registration exists. |
| `GET /api/auth/config` | public | Minimal public config (app name, whether vendor registration is open). Replaces `GET /auth/config` (which shipped the full role catalog). |

## 3. Users & roles

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `GET /api/users` | `user.manage` | Searchable, paginated user list (role, status, warehouse filters). New — users were previously only creatable via the signup hole. |
| `POST /api/users` | `user.manage` | Create an account with roles (+ warehouse memberships / vendor / driver links). Audited. |
| `GET /api/users/[id]` · `PATCH /api/users/[id]` | `user.manage` | Profile and role management; role changes revoke the user's sessions and are audited with before/after. |
| `POST /api/users/[id]/suspend` · `/reactivate` | `user.manage` | Suspension revokes sessions immediately and flags held custody/assignments for reassignment. |
| `POST /api/users/[id]/revoke-sessions` | `user.manage` | Force logout everywhere. |
| `POST /api/users/invitations` · `POST /api/invitations/[token]/accept` | `user.manage` / public (token) | Invitation flow: role fixed by inviter, hashed expiring token. |
| `GET /api/roles` · `GET /api/permissions` | `user.manage` | Role/permission catalog read for the Users & Roles screens. Replaces the catalog exposure inside `GET /auth/config` and `ROLE_CATALOG`. |

## 4. Warehouses & memberships

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `GET /api/warehouses` | `warehouse.read_all` or `warehouse.read_assigned` | List; assigned-scope actors see only their warehouses. Replaces public `GET /ops/warehouses`. |
| `POST /api/warehouses` | `warehouse.create` | Create with unique code, address, district/province, geo, contact, type, capacity. |
| `GET /api/warehouses/[id]` · `PATCH /api/warehouses/[id]` | `warehouse.read_*` (scoped) / `warehouse.update` | Detail incl. performance summary; edits audited. |
| `POST /api/warehouses/[id]/deactivate` | `warehouse.update` | Deactivate/archive — warehouses with history are never deleted. |
| `GET/POST /api/warehouses/[id]/zones` · `/locations` | `warehouse.update` (scoped) | Zones (receiving, inspection, sorting, storage, dispatch, damaged, returns) and storage locations (`WH-KTM / ZONE-A / RACK-03 / SHELF-02`). New. |
| `GET /api/warehouses/[id]/memberships` · `POST …/memberships` · `POST …/memberships/[membershipId]/revoke` | `warehouse.assign_staff` | Assign/revoke warehouse admins and staff. Formalizes the live-only `warehouse_memberships` table; this is the scope source for all warehouse queries. |
| `GET /api/warehouses/[id]/capacity` | `warehouse.read_*` (scoped) | Current load vs configured capacity (count/weight/zone), warning state. New. |
| `GET /api/warehouses/[id]/inventory-summary` | `inventory.read_warehouse` (scoped) | Held packages by status/condition for the warehouse dashboard. Feeds Part 4.3 dashboard. |

## 5. Bookings & orders

One booking path (BookingService). Vendor-created bookings enter the approval queue;
staff-created follow policy; counter drop-off is the same operation with
`intakeMode: "counter"`.

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `POST /api/bookings` | `package.create` (staff) / vendor (own) | Create booking: sender, recipient, package lines → Order + Shipment + one Package per physical parcel, tracking ids, labels. Idempotency-Key accepted. Replaces `POST /workflow/orders`, classic `POST /orders`, **and** `POST /warehouse-intake/` (legacy parallel path retired). |
| `GET /api/bookings` | scoped list | Filters: status, approval, warehouse, vendor, service, payment, date range. Replaces `GET /orders` (was public) and the vendor portal's order list. |
| `GET /api/bookings/[id]` | scoped | Full order detail composite: order, shipment, packages, journey stage, map payload (waypoints, live vehicle position), unified timeline. Replaces `GET /workflow/orders/{id}/detail` — with the ownership check that endpoint's docstring claimed but never implemented. |
| `PATCH /api/bookings/[id]` | `package.create` (scoped, stage-limited) | Eligible corrections by stage (Part 6.4); post-pickup changes go through controlled corrections, post-dispatch through exceptions. Replaces `PUT /orders/{id}` (full replace incl. item delete/re-insert). |
| `GET /api/bookings/pending-approval` | `order.approve` | The approval queue. Replaces `GET /workflow/orders/pending` — which any logged-in user could read. |
| `POST /api/bookings/[id]/approve` · `/reject` | `order.approve` | Approve/reject with note; stamps approver + time; audit event. Replaces `PATCH /workflow/orders/{id}/approval`. |
| `POST /api/bookings/[id]/intake` | `package.receive` (scoped to origin warehouse) | Warehouse intake of an approved booking: verified weight/dims/type, route kind (same district → last-mile, else inter-warehouse), destination warehouse match. Replaces `POST /workflow/orders/{id}/intake`. |
| `POST /api/bookings/[id]/cancel` | scoped | Stage-validated cancellation with reason/approver/charges; post-pickup cancellation opens a return instead of cancelling (Scenario 9). Replaces `DELETE /orders/{id}` (hard delete abolished). |
| `GET /api/bookings/[id]/labels` · `/receipt` | scoped | Printable labels (QR/barcode per package) and booking receipt. New (codes existed; no label surface). |

## 6. Packages & internal tracking

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `GET /api/packages` | `package.read_all` / `package.read_assigned` (scoped) | Search by tracking id; filters: warehouse, status, condition, vendor, driver, date. Replaces `GET /ops/packages` (was public) and `GET /shipments` list semantics. |
| `GET /api/packages/[trackingId]` | scoped | The Part 24.4 detail page data: header (status tracks, warehouse, custodian), shipment info, operations (assignments, trip, custody), finance block, full timeline. Replaces `GET /shipments/{id}` + fragments of order detail. |
| `POST /api/packages/[trackingId]/receive` | `package.receive` (scoped) | Receiving scan at a warehouse: condition, verified weight, storage location → inventory record + custody + TrackingEvent, one transaction. Idempotent per scan key (duplicate scan returns the original + a clear message, Scenario 7). Absorbs `POST /warehouse/scans` receive-type events. |
| `POST /api/packages/[trackingId]/transition` | `package.change_status` (scoped) | The **only** status-change operation: body names the target state; PackageLifecycleService validates against the transition table and writes the event. Replaces free-form `PATCH /shipments/{id}/status` and `PATCH /orders/{id}/status`. |
| `POST /api/packages/[trackingId]/scan` | `package.change_status` (scoped) | Non-transition scans (sorted, picked, loaded…) recorded as events with warehouse + actor. Replaces `POST /warehouse/scans` / `GET /warehouse/scans`. |
| `POST /api/packages/[trackingId]/hold` · `/release` | `package.change_status` (scoped) | Authorized holds with reason (damage, investigation, address clarification). |
| `GET /api/packages/[trackingId]/events` | scoped | Internal chronological event trail (actor, role, warehouse, prev/new status, evidence links). Replaces `GET /shipments/{id}/events` (was public). |
| `POST /api/packages/[trackingId]/report-issue` | scoped | Raises an incident linked to the package (damage, missing, wrong warehouse…). Routes to §14. |

---

## 7. Inventory & custody

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `GET /api/inventory` | `inventory.read_all` / `inventory.read_warehouse` (scoped) | Parcel inventory: package, warehouse, storage location, condition, status, custody, received-at. A package out with a driver never appears as in-stock. Replaces `GET /ops/inventory`. |
| `POST /api/inventory/movements` | `inventory.read_warehouse` (scoped) | Internal movements: put-away, rack-to-rack, quarantine — with from/to locations and reason. Recorded as InventoryMovement; never creates an inter-warehouse transfer. Gives the live-but-unused `inventory_movements` table its writer. |
| `GET /api/inventory/discrepancies` | scoped | Open count/custody discrepancies per warehouse. New. |
| `POST /api/handovers` | scoped | Create a custody handover (from/to person or location, package list, expected count). Replaces `POST /warehouse/handovers`. |
| `POST /api/handovers/[id]/confirm` | scoped (receiving party) | Confirm received count; a count mismatch automatically opens a discrepancy incident and keeps the handover open. Replaces `PATCH /warehouse/handovers/{id}/confirm`. |
| `GET/POST /api/stock-items` · `POST /api/stock-movements` | `inventory.read_warehouse` (scoped) | Supplies inventory (boxes, tape, labels…) — separate from parcel inventory, with min levels and adjustments. New surface over the SQL-era `inventory` design. |

## 8. Transfers, trips & vehicles

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `POST /api/transfers` | `transfer.create` (scoped to origin) | Draft transfer: origin/destination, packages selected **from origin inventory only**, expected arrival. |
| `GET /api/transfers` · `GET /api/transfers/[id]` | scoped (origin or destination membership) | List + detail with manifest, scans, discrepancies, reconciliation state. Gives the old `listTransfers`/`listTripManifest` client functions the UI they never had. |
| `POST /api/transfers/[id]/submit` · `/approve` · `/reject` | `transfer.create` / `transfer.approve` | Approval workflow where policy requires it. |
| `POST /api/transfers/[id]/assign` | `transfer.dispatch` | Assign line-haul driver + vehicle (capability and availability checked; invalid/unavailable vehicles rejected). |
| `POST /api/transfers/[id]/load-scan` | `transfer.dispatch` (scoped) | Per-package loading scans (idempotent); loaded count vs manifest. |
| `POST /api/transfers/[id]/dispatch` | `transfer.dispatch` | Confirm dispatch → Trip starts; packages become in-transit under the driver's custody. Replaces `POST /warehouse/transfers` (single-parcel, no manifest). |
| `POST /api/transfers/[id]/receive-scan` | `transfer.receive` (scoped to destination) | Per-package unloading scans at destination. |
| `POST /api/transfers/[id]/complete-receiving` · `/reconcile` | `transfer.receive` | Close receiving with expected-vs-received comparison; missing/excess/damaged auto-create incidents; transfer can only close when reconciled or formally exceptioned. Replaces `PATCH /warehouse/transfers/{id}/receive` (mark-received with no reconciliation). |
| `GET /api/trips` · `GET /api/trips/[id]` | scoped / driver (own) | Trip list + detail (manifest, checkpoints, incidents, times). Replaces `GET /trips` and `GET /trips/{id}` — the latter was **public**. |
| `POST /api/trips/[id]/status` | driver (own) / `transfer.dispatch` | Validated trip transitions (planned → loading → dispatched → in transit → delayed → arrived → unloading → completed) with departed/arrived stamps. Replaces `PATCH /trips/{id}/status`. |
| `POST /api/trips/[id]/checkpoints` | driver (own) | Named checkpoint with optional geo; **ownership-checked** (the old endpoint had none). Replaces `POST /trips/{id}/checkpoints`. |
| `POST /api/trips/[id]/report-incident` | driver (own) | Breakdown/delay/accident reporting → incident + dispatcher notification; supports authorized driver/vehicle reassignment with custody handover (Scenario 6). |
| `GET /api/vehicles` · `POST /api/vehicles` · `GET/PATCH /api/vehicles/[id]` | `vehicle.manage` for writes | Fleet registry + the fleet overview (active trip, driver, route, parcels onboard, live position). Replaces `GET /vehicles/fleet`, `GET /vehicles/{id}/detail`, public `GET /ops/vehicles`. |
| `POST /api/vehicles/[id]/maintenance` | `vehicle.manage` | Maintenance/inspection records; expired insurance/inspection blocks assignment. New. |

## 9. Drivers & delivery

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `GET /api/drivers` · `POST /api/drivers` · `GET/PATCH /api/drivers/[id]` | `driver.manage` for writes; reads scoped | Driver profiles: home warehouse, category, capabilities, availability (derived from assignments), licence + expiry, documents via §18. Replaces public `GET /drivers` and `GET /drivers/{driver_id}/assignments` (any caller could read any driver's work). |
| `GET /api/drivers/me/tasks` · `GET /api/drivers/me/trips` | rider / linehaul (own) | The rider and transport-driver dashboard feeds — only the caller's own assignments. Replaces the query-param `GET /driver-tasks` / `GET /trips` driver views. |
| `POST /api/drivers/me/gps` | rider / linehaul (own) | GPS ping ingestion (validated coordinates); updates last-known position; Realtime fans out. Replaces `POST /drivers/gps` **and** the direct anon-key table inserts — one write path. |
| `POST /api/deliveries/assign` | `delivery.assign` | Assign eligible packages to a rider (capability, availability, area, workload checks) with route calculation stored on the assignment. Replaces `POST /orders/{id}/assign` and `POST /driver-tasks` (query-param API retired). |
| `POST /api/deliveries/batches` · `GET /api/deliveries/batches/[id]` | `delivery.assign` | Delivery batches grouped by city/municipality/ward/zone. New. |
| `POST /api/deliveries/[assignmentId]/start` | rider (own) | Scan-out / out-for-delivery confirmation. |
| `POST /api/deliveries/[assignmentId]/attempts` | rider (own) | Record a delivery attempt (result, reason, contact outcome, evidence) — a real attempt record, replacing the `failed_attempts` counter. |
| `POST /api/deliveries/[assignmentId]/confirm` | `delivery.confirm` (own assignment) | Confirm delivery: OTP and/or signature/photo per policy + COD amount/method captured — package event, proof FileAsset, COD collection and ledger entries in **one transaction**. Idempotency-Key required. Replaces the side effects hidden in `PATCH /driver-tasks/{id}/status` and the separate `POST /drivers/pod`. |
| `POST /api/deliveries/[assignmentId]/fail` | rider (own) | Coded failure (unavailable, refused, wrong address, closed, inaccessible, payment unavailable, damaged) → next action per policy (redelivery / support / return). |
| `POST /api/deliveries/[assignmentId]/return-to-warehouse` | rider (own) | Undelivered packages returned into warehouse custody via handover. |

## 10. Returns

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `POST /api/returns` | scoped | Open a return (refusal, unreachable, wrong address, vendor request, damaged, undeliverable) linked to the original shipment. New — returns were statuses only. |
| `GET /api/returns` · `GET /api/returns/[id]` | scoped | Return list/detail with custody trail and charges. |
| `POST /api/returns/[id]/approve` · `/collect` · `/receive` · `/complete` | `return.approve` / scoped | The return workflow steps (Part 12), each a lifecycle transition with events; vendor notified on completion. |

## 11. Finance — invoices, payments, COD, settlements, ledger

Financial records are append-only; corrections are reversal/adjustment rows linked to
the original (spec Part 13.5). COD is a liability to the vendor, never company revenue.

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `GET /api/finance/overview` | `finance.read` | Revenue (paid/outstanding shipping charges), COD pending collection / awaiting remittance / awaiting settlement, vendor payable, disputes, unreconciled counts. Replaces the finance parts of `/analytics/*` and public `GET /ops/payments`. |
| `GET/POST /api/finance/invoices` · `GET /api/finance/invoices/[id]` | `finance.read` / `payment.record` | Invoice generation and reads, linked to orders/vendors. New (no invoicing existed). |
| `POST /api/finance/payments` | `payment.record` | Record a payment (cash, bank transfer, wallet, prepaid balance, credit) with allocation to charges. **Idempotency-Key required** — a duplicate request returns the original transaction (Scenario 12). Replaces `PATCH /workflow/orders/{id}/payment` (status-flag setting) with real transactions. |
| `POST /api/finance/payments/online-session` | `payment.record` / vendor, customer (own) | Create a gateway payment session for an order (NPR). Replaces `POST /payments/intent` (whose currency defaulted to INR and whose staff check used the raw JWT claim). |
| `POST /api/webhooks/payments/[provider]` | provider signature | Signed webhook → payment fulfilment; idempotent by provider event id. Replaces `POST /payments/webhook`. |
| `POST /api/finance/payments/[id]/refund` | `finance.adjust` | Refund as a reversal transaction linked to the original; original is never edited. New (no refund flow existed). |
| `POST /api/finance/adjustments` | `finance.adjust` (+ approval for sensitive amounts) | Financial adjustments with mandatory reason; audited. New. |
| `GET /api/finance/ledger` | `finance.read` | Ledger transactions with account, type, reference, related order/package, actor, reversal links. New — the old system had no ledger. |
| `GET /api/finance/cod` | `finance.read` / rider (own) / vendor (own) | COD register: declared, collected, remitted, verified, discrepancies. Replaces `GET /settlements/cod`. |
| `POST /api/finance/cod/remittances` | rider (own) | Rider submits a remittance (amount, method, evidence) against collected COD. **New** — the old system never compared collected vs remitted. |
| `POST /api/finance/cod/remittances/[id]/verify` | `cod.verify` | Finance verifies a remittance; a shortfall keeps the original collection intact, records the discrepancy, and opens a finance incident (Scenario 5). |
| `GET /api/finance/settlements` · `POST /api/finance/settlements` | `finance.read` / `settlement.approve` for creation | Vendor settlements computed **from the ledger** for a period (gross COD, deductions, net payable). Replaces `GET/POST /settlements` (gross summed in Python from `cod_collections`; creation was super-admin-only — now a finance operation with approval). |
| `POST /api/finance/settlements/[id]/approve` · `/mark-paid` | `settlement.approve` | Settlement lifecycle (pending → approved → paid, ⇄ disputed) with stamps. Replaces `PATCH /settlements/{id}/status`. |
| `GET /api/finance/statements/me` | vendor (own) | Vendor statement: charges, COD collections, settlements, outstanding balance. Replaces the vendor portal's settlements list. |

---

## 12. Vendors & customers

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `GET /api/vendors` · `GET /api/vendors/[id]` | `vendor.read` (staff) / vendor (own) | Vendor list/detail incl. verification status. Replaces `GET /vendors`, `GET /vendors/{id}`. |
| `POST /api/vendors` · `PATCH /api/vendors/[id]` | `vendor.manage` | Create/update vendor master data (field-whitelisted, as before). Replaces super-admin-only `POST/PUT /vendors`. |
| `POST /api/vendors/[id]/verify` · `/suspend` · `/reactivate` | `vendor.approve` | Verification lifecycle (pending → under review → approved / rejected / suspended / inactive). New — no verification status existed. |
| `GET/POST /api/vendors/[id]/users` · `GET/POST /api/vendors/[id]/addresses` | `vendor.manage` / vendor owner (own) | Vendor-internal users (Owner/Manager/Booking/Accounts) and pickup addresses. New. |
| `GET /api/vendors/me/bookings` · `/me/shipments` · `/me/statement` | vendor (own) | Vendor portal data feeds — every query force-scoped to the caller's vendor (the old handler-level `vendor_id` forcing, now in the repository layer). |
| `GET /api/customers` · `POST /api/customers` · `GET/PATCH /api/customers/[id]` | `customer.read` / `customer.manage` | Customer records with search and duplicate handling. Replaces the **completely unauthenticated** `/customers` CRUD — including its public DELETE, which is abolished (records are merged/archived, not deleted). |
| `GET /api/customers/[id]/shipments` | `customer.read` / support | A customer's shipment history for support work. |

## 13. Tasks (work management)

Distinct from delivery assignments: tasks are accountable work items (spec Part 15).
The old `/tasks` router was cron-only; the console's "Tasks" section pointed at
driver tasks. This module is new.

| Operation | Permission | Purpose |
|---|---|---|
| `GET /api/tasks` · `POST /api/tasks` | `task.assign` for creation; reads scoped to assignee/creator/warehouse | Task list (mine / my warehouse / all) and creation with priority, due date, related package/transfer/incident. |
| `GET /api/tasks/[id]` · `PATCH /api/tasks/[id]` | scoped | Detail + edits; reassignment requires a reason and is recorded. |
| `POST /api/tasks/[id]/accept` · `/start` · `/block` · `/submit` · `/verify` · `/close` | assignee / creator per step | The Part 15.2 workflow (assigned → accepted → in progress → blocked → submitted → under review → verified → closed), each step timestamped with its actor. |
| `POST /api/tasks/[id]/comments` | scoped | Comments and evidence uploads (via §18). |

## 14. Incidents & support

| Operation | Permission | Purpose |
|---|---|---|
| `GET /api/incidents` · `POST /api/incidents` | `incident.manage` / any staff (report) | Incident register across all Part 16 categories (missing, damaged, wrong warehouse, transfer shortage/excess, COD discrepancy, theft suspicion, unauthorized access…). Auto-created by transfers, handovers, COD verification and lifecycle exceptions; manual reports land here too. |
| `GET /api/incidents/[id]` · `PATCH /api/incidents/[id]` | `incident.manage` (scoped) | Investigation record: severity, linked package/order/transfer/trip, evidence, notes, resolution + approval. Workflow: reported → acknowledged → assigned → investigating → awaiting information → escalated → resolution proposed → resolution approved → resolved → closed. |
| `POST /api/incidents/[id]/notes` · `/escalate` · `/resolve` | `incident.manage` | Investigation actions, each audited. A missing package stays an open discrepancy — it is never deleted from inventory by resolution. |
| `GET /api/support/tickets` · `POST /api/support/tickets` | support / customer, vendor (own) | Complaint tickets (non-receipt, damage, disputes, address corrections) with communication history. |
| `POST /api/support/tickets/[id]/request-redelivery` · `/request-address-correction` | support | Support actions that create operational follow-ups (delivery retry, controlled address correction) without support touching custody or money directly. |

## 15. Notifications, help & settings

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `GET /api/notifications` · `POST /api/notifications/[id]/read` · `POST /api/notifications/read-all` | authenticated (own) | Per-user in-app notifications across the Part 17 categories. Replaces the global `admin_notifications` feed inside `GET /analytics/admin-feed`. |
| `GET/PATCH /api/notifications/preferences` | authenticated (own) | Per-user channel preferences (in-app / email / SMS). New. |
| `GET /api/help` | authenticated | Help articles. Replaces the `admin_help` portion of the admin feed. |
| `GET /api/settings` · `PATCH /api/settings` | `settings.manage` | System settings (session lifetimes, GPS retention, notification toggles, MFA policy) over the `admin_settings` key/value foundation. |
| `GET/PATCH /api/settings/pricing` · `/service-areas` · `/services` | `pricing.manage` | Tariff configuration: pricing rules (volumetric divisor, billable-weight rule), service areas, shipping services. New — prices were never configurable and must never be hardcoded in components (Part 6.3). |
| `GET /api/audit-logs` | `audit.read` | Immutable audit trail reads (actor, action, resource, result incl. denials). New. |

## 16. Reports

All figures are SQL aggregations over the real operational tables (ReportingService) —
no Python full-table aggregation, no cached fake numbers. Every report accepts the
§1 filters and is permission-scoped (a warehouse report for Warehouse B is denied to
Warehouse A's admin).

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `GET /api/reports/overview` | `report.read` | Company overview: bookings, packages by status track, delivered/failed/returns, revenue, outstanding, COD state — the dashboard's data source. Replaces `GET /analytics/overview`, `/trends`, `/revenue`, `/activity`, `/cashflow`, `/payments-summary` (three of which the old console fetched and never rendered). |
| `GET /api/reports/daily?date=` | `report.read` | Daily operational summary — also the data source of the cron daily-report email. Replaces `GET /analytics/daily`. |
| `GET /api/reports/warehouses` · `/api/reports/warehouses/[id]` | `report.read` (scoped) | Receiving/dispatch volume, inventory aging, capacity, discrepancies, staff activity. |
| `GET /api/reports/drivers` · `/api/reports/vendors` | `report.read` (scoped) | Driver performance (assigned/completed/failed, COD collected vs remitted, trips) and vendor performance (bookings, success rate, charges, payable). |
| `GET /api/reports/finance` | `finance.read` | Revenue, collections, reconciliation state, settlements, refunds, disputes. |
| `GET /api/reports/[name]/export?format=csv` | same as the report | Authorized export of the same scoped data. New. |

## 17. Public tracking (no login)

Rate-limited per IP and per tracking id. Responses contain **only** the public
projection — never internal notes, driver personal data, vendor data, or financials.

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `GET /api/public/track/[trackingId]` | public | Minimal status: tracking id, booking date, public status, 5-step progress (Received → At warehouse → Out for transfer/delivery → Out for delivery → Delivered, mapped from the lifecycle), origin/destination city, last update, estimated window where available. Replaces `GET /orders/by-number/{n}` and `GET /shipments/by-tracking/{code}` — both of which returned full recipient PII with no verification. The tracking page keeps its `?order=` deep-link behaviour, resolving order numbers to the same projection. |
| `POST /api/public/track/[trackingId]/verify` | public (tracking id + recipient phone) | Second factor unlocks the detailed timeline, delivery attempts and the live driver position (the `track-<id>` realtime channel). New control; the detail was previously public. |
| `POST /api/public/track/[trackingId]/complaint` | public (verified) | Report non-receipt / damage → support ticket. |
| `POST /api/public/track/[trackingId]/address-correction` · `/reschedule` | public (verified) | Customer requests that enter the controlled correction/redelivery workflows — they never edit the booking directly. |

## 18. Files

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `POST /api/files/upload` | authenticated; purpose-scoped (`pod`, `damage-photo`, `vendor-document`, `driver-document`, `incident-evidence`, `task-evidence`) | Server-validated upload (content-sniffed type, size limit, safe filename) to Cloudinary **private** storage; returns a FileAsset id. Replaces `POST /drivers/pod` (public URL, no validation). |
| `GET /api/files/[id]/signed-url` | permission on the related entity | Short-lived signed URL after an authorization check on the asset's owner entity (e.g. vendor → own shipments' POD only). New. |
| `DELETE /api/files/[id]` | owner / `user.manage` | Removes an unattached asset; attached evidence is retained per record-retention rules. |

## 19. Cron & health

| Operation | Permission | Purpose · replaces |
|---|---|---|
| `POST /api/cron/daily-report` | `CRON_SECRET` bearer, **fail-closed** | Computes the daily summary and emails it (EmailJS via NotificationService). Replaces `POST /tasks/daily-report` (GitHub Actions 01:30 UTC schedule kept). |
| `POST /api/cron/gps-cleanup` | `CRON_SECRET` bearer, fail-closed | Prunes GPS telemetry older than the configured retention (default 7 days). Replaces `POST /tasks/cleanup-gps` + the `cleanup_gps_tracking` RPC. Telemetry only — never shipment/financial history. |
| `POST /api/cron/notification-dispatch` | `CRON_SECRET` bearer, fail-closed | Drains pending notifications with dedupe keys (no duplicate sends on retry). New. |
| `GET /api/health` | public | Liveness + DB reachability flag for the host's health check. Replaces `GET /health` and the root `GET /` service-info route (dropped). |

---

## 20. Retired without replacement

Recorded so nothing is silently lost: `GET /` (service info) · the classic order
endpoints superseded by §5 (`PUT/DELETE /orders…`) · `POST /warehouse-intake/` (§5) ·
`GET /ops/*` lookup lists (folded into their modules above) · `GET /analytics/*`
(§16) · `GET /payments/config` (gateway publishable key is delivered by
`POST /api/finance/payments/online-session` responses) · the driver-app's direct
Supabase table writes (§9 GPS) · FastAPI `/docs` (not exposed in production).

---

## 21. V2 final state — the built API surface (Phase 8, generated)

**Method (reproduce it, do not hand-edit this section):** the table
below was generated from the Route Handler files themselves —
`find src/app/api -name route.ts` for the paths, and the exported
`GET` / `POST` / … functions in each file for the methods.
**API Route Handler count: 98 files.** Dashboard mutations that are
not in this table are Server Actions over the same service layer
(the §1 convention); this section lists only real Route Handlers.

**V2 additions since the design above** (all in the table):

- **Tracking (Phase 3/4):** `POST /api/tracking/session/start`,
  `POST /api/tracking/session/pause`,
  `POST /api/tracking/session/resume`,
  `POST /api/tracking/session/stop`,
  `GET /api/tracking/session/current`,
  `POST /api/tracking/location`.
- **Live Operations (Phase 5):** `GET /api/live-operations`,
  `GET /api/live-operations/[trackingSessionId]`
  (`operations.live_view`, warehouse-scoped).
- **Bookings bulk (Phase 7):** `POST /api/bookings/bulk` — 1–50
  bookings, all-or-nothing in one transaction.
- **Driver incidents (Phase 7 surface over the Phase 8-operations
  service):** `GET/POST /api/incidents`, `GET /api/incidents/[id]`
  (`incident.report` to create; scope composed server-side).
- Also built and listed below: delivery batch
  `pickup` / `collect` / `reassign` / `close`, assignment
  `pickup-attempt` / `attempt` / `deliver` / `regenerate-otp`,
  `POST /api/deliveries/scan-back`, transfer
  `load` / `dispatch` / `receive` / `finish-receiving` /
  `complete-receiving` / `reconcile`, returns
  `approve` / `inspect` / `complete` / `reject`, and the finance /
  reports / support sets. Planned operations with **no** Route
  Handler (e.g. §18 files upload, §19 cron endpoints, §3 user CRUD)
  are delivered as Server Actions / pages or not at all — absence
  from this table is the accurate statement.

| Route | Methods | Source file |
|---|---|---|
| `/api/auth/[...nextauth]` | — | `src/app/api/auth/[...nextauth]/route.ts` |
| `/api/bookings/[id]` | GET | `src/app/api/bookings/[id]/route.ts` |
| `/api/bookings/bulk` | POST | `src/app/api/bookings/bulk/route.ts` |
| `/api/bookings` | GET, POST | `src/app/api/bookings/route.ts` |
| `/api/deliveries/assignments/[id]/attempt` | POST | `src/app/api/deliveries/assignments/[id]/attempt/route.ts` |
| `/api/deliveries/assignments/[id]/deliver` | POST | `src/app/api/deliveries/assignments/[id]/deliver/route.ts` |
| `/api/deliveries/assignments/[id]/pickup-attempt` | POST | `src/app/api/deliveries/assignments/[id]/pickup-attempt/route.ts` |
| `/api/deliveries/assignments/[id]/regenerate-otp` | POST | `src/app/api/deliveries/assignments/[id]/regenerate-otp/route.ts` |
| `/api/deliveries/batches/[id]/assignments` | POST | `src/app/api/deliveries/batches/[id]/assignments/route.ts` |
| `/api/deliveries/batches/[id]/close` | POST | `src/app/api/deliveries/batches/[id]/close/route.ts` |
| `/api/deliveries/batches/[id]/collect` | POST | `src/app/api/deliveries/batches/[id]/collect/route.ts` |
| `/api/deliveries/batches/[id]/pickup` | POST | `src/app/api/deliveries/batches/[id]/pickup/route.ts` |
| `/api/deliveries/batches/[id]/reassign` | POST | `src/app/api/deliveries/batches/[id]/reassign/route.ts` |
| `/api/deliveries/batches/[id]` | GET | `src/app/api/deliveries/batches/[id]/route.ts` |
| `/api/deliveries/batches` | GET, POST | `src/app/api/deliveries/batches/route.ts` |
| `/api/deliveries/scan-back` | POST | `src/app/api/deliveries/scan-back/route.ts` |
| `/api/finance/accounts` | GET | `src/app/api/finance/accounts/route.ts` |
| `/api/finance/adjustments/[id]/approve` | POST | `src/app/api/finance/adjustments/[id]/approve/route.ts` |
| `/api/finance/adjustments/[id]/reject` | POST | `src/app/api/finance/adjustments/[id]/reject/route.ts` |
| `/api/finance/adjustments` | GET, POST | `src/app/api/finance/adjustments/route.ts` |
| `/api/finance/cod-position` | GET | `src/app/api/finance/cod-position/route.ts` |
| `/api/finance/invoices/[id]/payments` | POST | `src/app/api/finance/invoices/[id]/payments/route.ts` |
| `/api/finance/invoices/[id]` | GET | `src/app/api/finance/invoices/[id]/route.ts` |
| `/api/finance/invoices/[id]/void` | POST | `src/app/api/finance/invoices/[id]/void/route.ts` |
| `/api/finance/invoices` | GET, POST | `src/app/api/finance/invoices/route.ts` |
| `/api/finance/ledger` | GET | `src/app/api/finance/ledger/route.ts` |
| `/api/finance/overview` | GET | `src/app/api/finance/overview/route.ts` |
| `/api/finance/refunds/[id]/approve` | POST | `src/app/api/finance/refunds/[id]/approve/route.ts` |
| `/api/finance/refunds/[id]/process` | POST | `src/app/api/finance/refunds/[id]/process/route.ts` |
| `/api/finance/refunds/[id]/reject` | POST | `src/app/api/finance/refunds/[id]/reject/route.ts` |
| `/api/finance/refunds` | GET, POST | `src/app/api/finance/refunds/route.ts` |
| `/api/finance/remittances/[id]/resolve` | POST | `src/app/api/finance/remittances/[id]/resolve/route.ts` |
| `/api/finance/remittances/[id]` | GET | `src/app/api/finance/remittances/[id]/route.ts` |
| `/api/finance/remittances/[id]/verify` | POST | `src/app/api/finance/remittances/[id]/verify/route.ts` |
| `/api/finance/remittances` | GET, POST | `src/app/api/finance/remittances/route.ts` |
| `/api/finance/settlements/[id]/approve` | POST | `src/app/api/finance/settlements/[id]/approve/route.ts` |
| `/api/finance/settlements/[id]/cancel` | POST | `src/app/api/finance/settlements/[id]/cancel/route.ts` |
| `/api/finance/settlements/[id]/pay` | POST | `src/app/api/finance/settlements/[id]/pay/route.ts` |
| `/api/finance/settlements/[id]` | GET | `src/app/api/finance/settlements/[id]/route.ts` |
| `/api/finance/settlements` | GET, POST | `src/app/api/finance/settlements/route.ts` |
| `/api/finance/vendor-statement` | GET | `src/app/api/finance/vendor-statement/route.ts` |
| `/api/incidents/[id]` | GET | `src/app/api/incidents/[id]/route.ts` |
| `/api/incidents` | GET, POST | `src/app/api/incidents/route.ts` |
| `/api/live-operations/[trackingSessionId]` | GET | `src/app/api/live-operations/[trackingSessionId]/route.ts` |
| `/api/live-operations` | GET | `src/app/api/live-operations/route.ts` |
| `/api/me` | GET | `src/app/api/me/route.ts` |
| `/api/notifications` | GET, POST | `src/app/api/notifications/route.ts` |
| `/api/notifications/unread-count` | GET | `src/app/api/notifications/unread-count/route.ts` |
| `/api/operations/custody` | GET | `src/app/api/operations/custody/route.ts` |
| `/api/operations/handovers/[id]/close` | POST | `src/app/api/operations/handovers/[id]/close/route.ts` |
| `/api/operations/handovers/[id]/confirm` | POST | `src/app/api/operations/handovers/[id]/confirm/route.ts` |
| `/api/operations/handovers` | POST | `src/app/api/operations/handovers/route.ts` |
| `/api/operations/inventory` | GET | `src/app/api/operations/inventory/route.ts` |
| `/api/operations/receive` | POST | `src/app/api/operations/receive/route.ts` |
| `/api/packages/[id]` | GET | `src/app/api/packages/[id]/route.ts` |
| `/api/public/track/[trackingId]/complaint` | POST | `src/app/api/public/track/[trackingId]/complaint/route.ts` |
| `/api/reports/[name]/export` | GET | `src/app/api/reports/[name]/export/route.ts` |
| `/api/reports/cod` | GET | `src/app/api/reports/cod/route.ts` |
| `/api/reports/daily` | GET | `src/app/api/reports/daily/route.ts` |
| `/api/reports/drivers` | GET | `src/app/api/reports/drivers/route.ts` |
| `/api/reports/drivers/self` | GET | `src/app/api/reports/drivers/self/route.ts` |
| `/api/reports/finance` | GET | `src/app/api/reports/finance/route.ts` |
| `/api/reports/overview` | GET | `src/app/api/reports/overview/route.ts` |
| `/api/reports/transfers` | GET | `src/app/api/reports/transfers/route.ts` |
| `/api/reports/vendors` | GET | `src/app/api/reports/vendors/route.ts` |
| `/api/reports/warehouses` | GET | `src/app/api/reports/warehouses/route.ts` |
| `/api/returns/[id]/approve` | POST | `src/app/api/returns/[id]/approve/route.ts` |
| `/api/returns/[id]/complete` | POST | `src/app/api/returns/[id]/complete/route.ts` |
| `/api/returns/[id]/inspect` | POST | `src/app/api/returns/[id]/inspect/route.ts` |
| `/api/returns/[id]/reject` | POST | `src/app/api/returns/[id]/reject/route.ts` |
| `/api/returns` | GET, POST | `src/app/api/returns/route.ts` |
| `/api/support/tickets/[id]/request-address-correction` | POST | `src/app/api/support/tickets/[id]/request-address-correction/route.ts` |
| `/api/support/tickets/[id]/request-redelivery` | POST | `src/app/api/support/tickets/[id]/request-redelivery/route.ts` |
| `/api/support/tickets/[id]` | GET | `src/app/api/support/tickets/[id]/route.ts` |
| `/api/support/tickets` | GET, POST | `src/app/api/support/tickets/route.ts` |
| `/api/tasks/[id]` | GET | `src/app/api/tasks/[id]/route.ts` |
| `/api/tasks` | GET, POST | `src/app/api/tasks/route.ts` |
| `/api/track/[trackingId]/details` | POST | `src/app/api/track/[trackingId]/details/route.ts` |
| `/api/track/[trackingId]` | GET | `src/app/api/track/[trackingId]/route.ts` |
| `/api/tracking/location` | POST | `src/app/api/tracking/location/route.ts` |
| `/api/tracking/session/current` | GET | `src/app/api/tracking/session/current/route.ts` |
| `/api/tracking/session/pause` | POST | `src/app/api/tracking/session/pause/route.ts` |
| `/api/tracking/session/resume` | POST | `src/app/api/tracking/session/resume/route.ts` |
| `/api/tracking/session/start` | POST | `src/app/api/tracking/session/start/route.ts` |
| `/api/tracking/session/stop` | POST | `src/app/api/tracking/session/stop/route.ts` |
| `/api/transfers/[id]/complete-receiving` | POST | `src/app/api/transfers/[id]/complete-receiving/route.ts` |
| `/api/transfers/[id]/dispatch` | POST | `src/app/api/transfers/[id]/dispatch/route.ts` |
| `/api/transfers/[id]/finish-receiving` | POST | `src/app/api/transfers/[id]/finish-receiving/route.ts` |
| `/api/transfers/[id]/load` | POST | `src/app/api/transfers/[id]/load/route.ts` |
| `/api/transfers/[id]/receive` | POST | `src/app/api/transfers/[id]/receive/route.ts` |
| `/api/transfers/[id]/reconcile` | POST | `src/app/api/transfers/[id]/reconcile/route.ts` |
| `/api/transfers/[id]` | GET | `src/app/api/transfers/[id]/route.ts` |
| `/api/transfers` | GET, POST | `src/app/api/transfers/route.ts` |
| `/api/trips/[id]/arrive` | POST | `src/app/api/trips/[id]/arrive/route.ts` |
| `/api/trips/[id]/depart` | POST | `src/app/api/trips/[id]/depart/route.ts` |
| `/api/vendors` | GET | `src/app/api/vendors/route.ts` |
| `/api/warehouses/[id]` | GET | `src/app/api/warehouses/[id]/route.ts` |
| `/api/warehouses` | GET | `src/app/api/warehouses/route.ts` |
