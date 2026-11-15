# BLA — Business Requirements

**Project:** Complete rebuild of the BLA delivery operations platform as a single
Next.js (App Router, TypeScript) application on PostgreSQL (Supabase), replacing
the FastAPI backend and unifying the four existing frontends (admin SPA,
customer-tracking, driver-app, vendor-portal) into one application.

**Primary currency:** NPR (Nepalese Rupees) — displayed as `Rs.`
**Timezone:** Asia/Kathmandu for all operational display; timestamps stored in UTC.
**Status:** Derived from the master project specification. Where this document
and the built system disagree, this document wins until it is amended.

---

## 1. The central principle

> **Every package must have a known location, a known status, an accountable
> custodian, a complete history and a clear next action.**
>
> **Every warehouse must have controlled inventory and independent
> responsibilities. Every transfer must be physically reconciled. Every
> delivery must have a recorded outcome. Every payment must be financially
> traceable. Every user must have only the permissions required for their job.**

All users operate on **one** centralized system and **one** database. Different
roles see different dashboards and permissions, but package, inventory,
transfer, payment and tracking records are shared and consistent for everyone.

The system must be able to run a real parcel delivery company — initially the
existing Nepal network (Kathmandu Central Hub `WH-KTM-01`, Pokhara Regional
Hub `WH-PKR-01`, Chitwan Warehouse `WH-CHT-01`, Lalitpur Depot `WH-LTP-01`),
and architecturally ready to grow to dozens of warehouses, hundreds of
drivers and tens of thousands of packages per day without a rewrite.

## 2. Non-negotiable requirements (Part 1.3)

These are hard constraints. Any design or implementation that violates one is
rejected at review, regardless of how convenient it is.

- [ ] No separate databases for individual warehouses — one centralized PostgreSQL database.
- [ ] A warehouse user can never access another warehouse's private records (inventory, staff, internal operations) — enforced on the server, in the query, not by hiding UI.
- [ ] Permissions are never enforced by frontend hiding alone. Every Server Action and Route Handler checks authorization server-side.
- [ ] A package's location never changes by manual edit — only through a recorded movement (receiving, put-away, internal movement, dispatch, transfer, handover).
- [ ] Historical shipment and financial records are never deleted. Corrections are new linked records (adjustments, reversals), never edits or overwrites.
- [ ] A package is not "received" because an admin changed its status — receiving requires a physical receiving event (scan + inspection record).
- [ ] A package is not "delivered" without delivery evidence (OTP, signature, photo, or authorized-recipient record) or an authorized, recorded exception.
- [ ] A transfer is not complete until received quantities are reconciled against the manifest. Partial receipt keeps the transfer open.
- [ ] COD money is never treated as company delivery revenue. COD collected for a vendor is a liability until reconciled and settled.
- [ ] No fake dashboard numbers. Every figure on every dashboard is computed from real records.
- [ ] No mock data as a production data source. Seed data exists only for development/testing and is clearly identified.
- [ ] No dead UI: every button, form, filter and action in the shipped UI performs a real server-side operation.
- [ ] Existing useful frontend design and features are preserved (see `docs/project-audit.md`); the backend is rebuilt, the dashboard is not replaced with a generic template.
- [ ] No insecure shortcuts to finish faster (no auth bypass flags, no self-selected privileged roles, no secrets in browser code).

## 3. Core concepts that must stay separate

| Concept | Meaning | Example |
|---|---|---|
| **Order** | The booking request | `ORD-1001` — a vendor books 5 boxes |
| **Shipment** | The transportation/delivery consignment for an order | `SHP-1001` |
| **Package** | One individual physical parcel, with its own tracking ID, custody and history | `PKG-1001` … `PKG-1005` |

Financial concepts that must also never be merged (Part 13.1): shipping
revenue · shipping charges paid · shipping charges outstanding · COD collected
from recipient · COD held by driver · COD remitted to company · COD payable to
vendor · vendor settlement · refund · financial adjustment.

Package state is tracked on **separate axes**, not one overloaded status:
operational status, package condition, payment status, delivery status,
exception status. Damage, for example, is a condition plus an active
exception — it does not erase the operational status.

## 4. Roles (Part 4)

One login page for everyone. After login, each user lands on the dashboard
for their role, loaded from server-side role/permission data — never from
stale frontend state.

### 4.1 Super Admin
Organization-wide authority. Sees the full operational and financial picture
(total orders/shipments/packages, packages per state, warehouses, employees,
drivers, vehicles, vendors, customers, shipping revenue, outstanding charges,
COD pending collection/settlement, vendor payable, recent activity) with
filters by date range, warehouse, status, vendor, service type, payment
status, driver and delivery area. Manages administrators, warehouses and
their assignments, all drivers/vendors/customers, transfers, exceptions,
financial approvals, service areas and pricing, status rules, notification
settings, permissions, system settings and audit logs; can suspend users and
reassign responsibilities. Still audit-logged; sensitive actions require
confirmation, a reason, and approval where configured. Cannot silently delete
financial transactions or package history.

### 4.2 Admin / Operations Admin
Day-to-day company-wide operations: same operational overview as Super Admin
minus organization-security settings and Super-Admin-only finance. Manages
warehouses (create/edit/status/assignments/performance), bookings and
tracking IDs, pickup/delivery rider assignment, holds, returns, exceptions;
views inventory across all warehouses; manages driver profiles, documents,
activation and assignments; registers/approves/suspends vendors; handles
customer records and complaints; creates/approves transfers and monitors
manifests; creates and reviews tasks; views authorized finance data and
requests/approves adjustments per permission.

### 4.3 Warehouse Admin
Assigned to exactly one warehouse (e.g. Kathmandu) and scoped to it.
Dashboard: packages in warehouse, incoming/outgoing transfers, awaiting
sorting/dispatch, rider assignments, available riders, staff, received/
dispatched today, damaged/missing, pending/overdue tasks, inventory
discrepancies. Runs receiving, scanning, weight/condition verification,
damage and incorrect-package recording, storage-location assignment, sorting,
dispatch preparation; manages own-warehouse inventory, transfers (create,
manifest, load, dispatch, receive, reconcile), local rider assignment and
staff tasks. **Cannot** create global admins or other warehouses, see another
warehouse's inventory, view company-wide finance, change another warehouse's
custody, bypass transfer reconciliation, delete shipment history, or raise
their own permissions.

### 4.4 Warehouse Staff / Operator
Physical package handling. Dashboard: assigned tasks, packages awaiting
receiving/scanning/sorting/dispatch, internal movement tasks, recent scans,
reported issues. Scans QR/barcodes, receives assigned packages, verifies
tracking ID, weight and dimensions (where authorized), records condition,
damage and suspicious packages, assigns storage locations, moves packages
between racks, sorts by destination, prepares manifests, scans during
loading, confirms handovers, reports missing/incorrect packages. Cannot
change sender, recipient, payment or financial records without a specific
permission.

### 4.5 Delivery Rider
Pickup and/or final-mile delivery, with configurable capabilities (pickup,
delivery, or combined). Dashboard: today's pickups and deliveries, packages
collected, in custody, out for delivery, delivered, failed attempts, COD to
collect / collected / pending remittance, returns, daily activity. Pickup:
view assignment and sender, navigate, confirm arrival, scan, verify package
details and condition, record pickup evidence, confirm collection, report
failed pickup. Delivery: view recipient/address, scan before departure,
confirm out-for-delivery, record attempts, verify OTP or signature, upload
permitted evidence, record COD collected and payment method, confirm
delivery, return undelivered packages, report refusal/address/damage issues.
Sees **only** assigned work. Cannot view all packages, change a package's
warehouse, assign work to others, edit prices, delete packages, complete a
delivery without satisfying delivery rules, or alter submitted COD records.

### 4.6 Warehouse-to-Warehouse (Line-Haul) Driver
Separate role from riders. Dashboard: assigned trips, vehicle, origin and
destination warehouses, schedule, expected arrival, manifest, loaded/awaiting
counts, in-transit state, delivery confirmation, incidents. Views approved
manifests, scans during loading, confirms loaded quantities and departure,
updates trip progress, reports delays/breakdowns/accidents, records arrival,
hands over to receiving warehouse staff with evidence, views trip history.
Cannot select arbitrary packages, edit a dispatched manifest without an
authorized amendment, move packages into destination inventory himself, mark
missing packages received, access unrelated warehouse inventory, or modify
payment records.

### 4.7 Vendor
A registered business customer. Dashboard: total bookings/packages, pending
pickups, picked-up, in transit, delivered, failed, returned, COD collected
and pending, outstanding shipping charges, vendor payable, recent bookings.
Registers the business, submits verification documents, manages pickup
addresses; creates bookings (sender, recipient, address, package description,
quantity, declared weight/dimensions, service, pickup or drop-off, prepaid or
COD, handling instructions); tracks own packages, downloads receipts, views
delivery attempts and permitted proof-of-delivery; views invoices, shipping
charges, COD records, settlement history, outstanding balance, statements;
raises disputes. A business may have several users (Owner, Manager, Booking
Staff, Accounts Staff), all scoped to the vendor organization. Never accesses
another vendor's records; cannot change verified delivery status, custody
history, receiving records, driver data or settlements.

### 4.8 Customer / Recipient
**No account required to track a parcel.** Public tracking by tracking ID
plus a verification factor (phone number). Sees: tracking ID, booking date,
current public status, origin/destination city, estimated delivery window,
last update, delivery attempts, progress, support contact. Never sees:
internal warehouse notes, driver personal details, vendor private
information, other customers' details, internal investigations, unrelated
financial records. Can request address correction and rescheduling through a
secure process, confirm delivery by OTP where supported, report non-receipt
or damage, and submit complaints. Receives notifications at: booking
confirmed, picked up, arrived at destination warehouse, out for delivery,
attempt failed, delivered, delayed, address clarification needed.

### 4.9 Finance / Accounts Staff
Dashboard: shipping revenue, paid/unpaid charges, COD collected, COD pending
collection, COD awaiting remittance, vendor payable, settlement due, refunds,
disputes, driver cash balances, unreconciled transactions. Records payments
and cash, generates invoices, verifies payment references, reconciles driver
remittances and vendor settlements, calculates vendor payable, processes
authorized refunds, creates financial adjustments, generates reports.
**Cannot change physical package custody.** Adjustments never rewrite the
original payment event — they are linked adjustment/reversal records in an
immutable ledger.

### 4.10 Customer Support Staff
Dashboard: open complaints, missing-package reports, delivery disputes,
address-correction requests, failed deliveries, damage reports, overdue
cases, communication history. Searches packages, views authorized tracking
data, creates complaint tickets, contacts recipients/vendors, requests
address corrections and redelivery, creates investigation tasks, escalates
incidents, adds case notes, closes resolved cases after required
verification. Cannot directly change payment transactions or package custody.

## 5. Modules (Part 19 navigation)

The Admin / Super Admin dashboard is organized into these modules — each with
list view, search, filters, detail page, create/edit where permitted,
history, and empty/loading/error states:

1. Overview · 2. Orders · 3. Packages · 4. Warehouses · 5. Inventory ·
6. Transfers · 7. Trips and Vehicles · 8. Drivers · 9. Vendors ·
10. Customers · 11. Assignments · 12. Tasks · 13. Exceptions and Incidents ·
14. Finance · 15. Payments · 16. COD Management · 17. Vendor Settlements ·
18. Reports · 19. Notifications · 20. Users and Roles · 21. Audit Logs ·
22. Settings.

Supporting domains behind these modules: warehouse zones and storage
locations (`WH-KTM / ZONE-A / RACK-03 / SHELF-02`), supplies inventory (kept
separate from parcel inventory), returns/reverse logistics, pricing rules
(configurable tariff + volumetric divisor — never hardcoded in components),
service areas, and shipping services.

## 6. Operating rules that shape the data model

- **Booking:** declared weight, actual weight, volumetric weight
  (`L × W × H / configured divisor`) and billable weight (per tariff rule,
  typically max of actual and volumetric) are stored separately, with who
  measured and when. Booking edits are stage-dependent; cancellation records
  requester, approver, reason, stage and applicable charges.
- **Lifecycle:** all package status changes pass through one central
  lifecycle service with an explicit transition table (Part 7). Examples:
  no pickup without assignment or authorized direct receipt; no inventory
  without a receiving scan; no dispatch without an approved manifest; no
  delivered without required proof.
- **Tracking history:** append-only events storing event type, previous/new
  status, actor and role, warehouse, location, related transfer/trip, notes,
  evidence, and an idempotency key. Ordinary users can never edit or delete
  history.
- **Custody:** the system always knows who holds a package. Every handover
  records from/to, package IDs, time, confirmation and evidence. A count
  mismatch at handover (dispatched 25, received 23) automatically creates a
  discrepancy.
- **Transfers:** draft → requested → approved → preparing → ready →
  dispatched → in transit → arrived → (partially) received → reconciliation
  pending → reconciled → closed. The destination warehouse never has to
  accept a manifest quantity it did not physically receive.
- **Finance:** every ledger transaction records account, amount, currency
  (NPR), type, reference, related order/package, method, time, actor,
  approval and reversal/adjustment linkage. Multi-record financial updates
  run in database transactions; duplicate submissions are idempotent and can
  never double-count a payment.
- **Warehouse capacity:** configurable by package count, area, zone, size
  and weight. Approaching the limit warns the Warehouse Admin; a hard safety
  limit blocks acceptance — packages are never falsely reported as received.

## 7. Final acceptance criteria (Part 29)

The project is complete only when **all** of the following hold, verified by
the testing strategy in `docs/testing-strategy.md`:

### Organization
- Super Admin can manage the organization; Admin can manage authorized company operations.
- Warehouses can be created and managed; staff can be assigned to individual warehouses.
- Permissions are enforced server-side on every operation.

### Warehouse
- Warehouse Admin manages only their assigned warehouse's operations.
- Staff can receive and scan packages; inventory reflects actual physical custody.
- Internal movements are recorded; warehouse capacity can be monitored.

### Packages
- Vendors can create bookings; packages receive unique tracking IDs.
- Every package has a complete history; multiple packages per shipment are supported.
- Partial delivery is supported; package status transitions are validated.

### Transfers
- Packages transfer between warehouses with maintained manifests.
- Drivers and vehicles can be assigned; receiving is scan-based.
- Missing and damaged packages are investigated; transfers are reconciled before closure.

### Drivers
- Pickup and delivery riders have their own dashboards; line-haul drivers have trip dashboards.
- Assignments are controlled; driver custody is recorded; delivery evidence is stored.

### Vendors and customers
- Vendors manage their own bookings and access their own statements.
- Customers can track packages; private information is protected.

### Finance
- Prepaid and COD are separated; driver cash is reconciled.
- Vendor settlements are traceable; refunds and adjustments preserve transaction history.
- Financial reports use real data.

### Safety and security
- Unauthorized access is denied, including cross-warehouse access.
- Historical events are preserved; duplicate requests do not duplicate transactions.
- Sensitive actions are audited; database backups and recovery procedures exist.

### Quality
- All core workflows are tested; no critical TypeScript errors.
- No broken dashboard routes; no non-functional buttons; no fake production statistics.
- Production build succeeds; responsive interfaces work; errors are handled properly.
