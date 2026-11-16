# BLA — Security Review Record

Running record of security-review findings and their dispositions,
phase by phase. Each phase appends its own section; entries name the
audit defect they close (or deliberately defer), the decision taken,
and the evidence (code + tests) behind it.

---

## V2 Phase 2 — Permission reconciliation (audit H-3, M-1, M-7; orphaned-grant review)

**Date:** 2026-11-16 · **Scope:** the Phase 0 audit's permission
findings (`docs/current-implementation-audit.md` §4) and every
catalog grant that had no consuming UI or service surface. Two
grants changed; the rest were reconciled by decision, recorded
below — an orphaned grant is kept only when a named later phase
owns its surface.

### Grants changed in this phase

| Defect | Change | Evidence |
|---|---|---|
| **H-3** — Customer notifications dead by construction: CUSTOMER lacked `notification.read_own`, so every notification service call would 403 and the bell count silently returned 0 | CUSTOMER is granted `notification.read_own` in `src/lib/permissions/catalog.ts`. The customer notifications nav item (gated on that permission in `src/lib/navigation/registry.ts`) now renders | `tests/integration/phase2-permissions.test.ts` (customer reads/lists/marks own notifications end to end; a second customer is denied, audited); `tests/unit/navigation.test.ts` (customer nav now includes `/customer/notifications`) |
| **M-1** — Finance approval bottleneck: `finance.approve_adjustment` was held only by SUPER_ADMIN, so Finance could prepare/create everything but approve nothing, and the Finance adjustments page permanently hid its decision buttons | FINANCE is granted `finance.approve_adjustment` in the catalog. No UI change was needed: `AdjustmentsPage` (`src/components/finance/pages.tsx`) already derives `canDecideAdjustments` from `hasPermission(actor, "finance.approve_adjustment")`, so the decision buttons light up from the grant alone. Four-eyes is unchanged and service-enforced: `approveAdjustment` and `approveRefund` both reject the creator/requester, so a second FINANCE user must decide. Refunds already flowed through `refund.process`, which FINANCE held | `tests/integration/phase2-permissions.test.ts` (finance-created adjustment: self-approve throws the four-eyes error, second finance user applies it with a balanced `ADJ-…` journal; refund: request → self-approve refused → second finance user approves → processed, payment `PARTIALLY_REFUNDED`; WAREHOUSE_STAFF approval attempt still denied) |
| **M-7** — Dead staff create routes: `/staff/transfers/new` and `/staff/deliveries/new` rendered create flows WAREHOUSE_STAFF is not permitted to use (no `transfer.create`, no `delivery.assign`) | Both route directories deleted. The navigation registry never linked the staff variants and the shared components already hide the create links from staff; the warehouse variants (`/warehouse/transfers/new`, `/warehouse/deliveries/new`) remain | `tests/integration/phase2-permissions.test.ts` (route-file existence assertions: staff `new` pages absent, warehouse `new` pages present); `tests/unit/navigation.test.ts` (staff nav still excludes both paths) |

### Orphaned grants — reconciliation decisions (all KEEP)

Each grant below exists in the catalog with no (or only partial)
consuming surface today. None is revoked: each has a named owning
phase, and the service layer already enforces the permission
wherever a surface does exist, so keeping the grant is not an
exposure — removing and re-adding it later would only churn the
catalog and its tests.

| Grant(s) | Holder | Decision | Rationale / consuming surface |
|---|---|---|---|
| `driver.manage`, `driver.assign`, `vehicle.assign` | WAREHOUSE_ADMIN | **KEEP → Phase 6** warehouse fleet pages (audit M-4) | Drivers/Vehicles pages exist only under Admin/Super Admin today. The grants are not wholly dormant: transfer crew assignment already consumes them inline — `assignTransferCrew` (`src/server/services/transfers.ts`) requires both `driver.assign` and `vehicle.assign` — so a Warehouse Admin can crew a transfer today and gains the standalone fleet pages in Phase 6 |
| `booking.create` | WAREHOUSE_ADMIN | **KEEP → Phase 6** warehouse `bookings/new` page (audit M-5) | `/warehouse/bookings` is list + detail only; the create route exists under Admin/Super Admin/Vendor. The booking service already enforces `booking.create`, so the Phase 6 page is a pure UI addition |
| `invoice.read`, `payment.dispute.raise`, `incident.report` | CUSTOMER | **KEEP → Phase 6** customer self-service pages (audit M-3) | No customer billing, dispute, or incident-report page exists yet (`/customer` is packages + tickets + notifications). The grants describe the intended self-service surface; the Phase 6 pages will consume them |
| `profile.update_own` | CUSTOMER | **KEEP — consumed today; profile PAGE → Phase 6** | Consumed today by `/api/me` (`src/app/api/me/route.ts`), whose handler requires `profile.update_own`. Record corrected during this review: the route currently exports a GET handler only — there is no PATCH handler — so the live consumption is the identity read gate, not a profile write. The customer-facing profile page lands in Phase 6 (with audit M-3) |
| `task.create`, `task.assign`, `task.update_own`, `task.verify` | FINANCE, SUPPORT | **KEEP → Phase 6** task UI for those roles (audit M-2) | The task service is complete and already enforces these permissions via the API; six roles have board/detail UI, Finance and Support do not. Phase 6 adds their task pages rather than stripping grants the workflow needs |

### Deliberately NOT granted in this phase

- **`settlement.approve` for FINANCE — open policy item.** M-1's
  scope was adjustments and refunds, and both now run four-eyes
  inside Finance. Settlement approval stays with ADMIN /
  SUPER_ADMIN. Whether Finance should also approve settlements
  (with four-eyes against the preparer) is a policy decision for
  Meena, not a defect fix; it stays open until he decides.

### Deferred by decision — four-eyes approval for privileged-role invitations (Appendix C candidate)

- **Deferred to Phase 6** (Phase 8 backstop). The independent
  reviews suggested a second approver before a SUPER_ADMIN / ADMIN
  invitation becomes usable. Implementing it cleanly needs a new
  `PENDING_APPROVAL` invitation state, approver fields, and — most
  importantly — an approval surface: no admin users/invitations UI
  exists yet (audit H-4; the only invitation surface is the
  warehouse MembersPanel). Adding the state without the surface
  would strand privileged invitations unapprovable and break the
  onboarding path already used in production (the first Super
  Admin's invitation was created and accepted through this exact
  flow on 2026-11-16). Phase 6 builds the Super Admin users UI,
  which is the natural home for an approval queue.
- **Mitigations already in force meanwhile:** only a Super Admin
  can invite another Super Admin; only `user.manage` holders
  (Super Admin / Admin) can invite company roles at all, and
  scoped inviters are confined to Warehouse Staff in their own
  warehouse (P2-1); tokens are SHA-256-hashed, single-use
  (atomic claim, P2-5), and expire in 7 days; acceptance refuses
  established accounts (P2-2); SUPER_ADMIN and ADMIN must enrol
  TOTP MFA before dashboard access (Phase 10 gate); every invite
  and acceptance is audit-logged; and Phase 2 adds a per-IP
  failure budget (20 / 10 min) on the redemption endpoint, which
  refuses with the same generic message as an invalid token.

### Confirm-or-scope decision (audit L-1)

- **Vehicles stay globally readable in Phase 2.** Fleet vehicles
  are company-level assets: the `Vehicle` model carries no
  warehouse ownership (only a nullable `homeWarehouseId` hint), so
  there is no ownership scope to enforce. `listVehicles`
  (`src/server/services/vehicles.ts`) therefore remains global for
  actors holding `vehicle.manage`, `vehicle.assign`, or
  `transfer.create`. Recorded as confirmed for Phase 2 and noted
  for re-review in Phase 8, alongside the other isolation audits.

### Independent security review (Phase 2)

An independent reviewer (no part in building Phase 2) attacked the
Phase 2 diff with live proof-of-concept tests against the test
database (`tests/integration/phase2-security-review.test.ts`, kept
as a regression suite). Verdict: **no High or Medium findings.**
Held under live attack: the journal-balance trigger (including
concurrent split-transaction composition attempts and leg UPDATEs),
four-eyes under the new FINANCE grant (including concurrent
approvals — exactly one applies, the journal posts exactly once),
customer notification isolation (including the userId-NULL
DELIVERY_OTP tracking rows — never listed, never markable),
the L-2 movement-touch scope fix (including no regression for
unscoped SUPPORT readers), staff-route removal (direct service
calls denied), fingerprint canonicalisation, and invitation race
accounting (exactly one success + one failure row for simultaneous
accepts).

Four Low findings, all dispositioned in-phase:

- **F-1 (fixed)** — a client-supplied `paidAt` was excluded from
  the payment fingerprint although it is stored and becomes the
  journal's `occurredAt`: two payments differing only in date
  collapsed under one idempotency key. `paidAt` is now part of the
  fingerprint whenever the client supplies it; faithful retries
  (which reproduce the omission or the value) still replay.
- **F-2 (fixed)** — pre-fingerprint payments (`requestFingerprint`
  NULL) accepted any replay payload. The expected fingerprint is
  now derived from the stored row (amount, method, transactionRef
  and allocations are all persisted) and compared; `paidAt` is
  excluded on both sides for legacy rows only, because a legacy
  row cannot distinguish a client-supplied value from the server
  default.
- **F-3 (accepted, gated)** — the invitation limiter's per-IP
  budget can be burned for a victim IP only where clients can set
  `x-forwarded-for` themselves. The documented deployment
  (Vercel, or a proxy that overwrites the header per
  `docs/deployment-guide.md` §3) is not exposed; that proxy
  requirement is a hard go-live gate for any self-hosted topology.
  A per-(token, IP) composite budget is the recorded future
  hardening if a non-overwriting topology is ever adopted.
- **F-4 (fixed)** — expired invitation tokens returned a distinct
  "has expired" message, an oracle distinguishing token states.
  Expired tokens now refuse with the same generic message as every
  other refusal class; the EXPIRED status flip and attempt
  recording are unchanged.

Two by-design observations were recorded without action: the
creator of an adjustment can self-REJECT it (rejection moves no
money and is the safe direction), and a warehouse actor who
legitimately handled a package sees its full movement history
including legs at other warehouses (continuity for handlers; the
pre-existing scope branch behaves the same way).
