# BLA — Testing Report (V2 Phase 8, final)

**Tree under test:** `main` at `6228f5b` (V2 Phases 0–7 complete +
Phase 8 work). **Environment:** local PostgreSQL 16, databases
`bla_dev` / `bla_test` (schema `app`), production build
(`next build` + `next start`) for the live smoke. Live Supabase was
never touched by any test in this report.

**Gate summary (final tree):**

| Gate | Result |
|---|---|
| Typecheck `npx tsc --noEmit` | Clean, 0 errors |
| Lint `npx eslint .` | 0 errors, 3 warnings (unused-variable warnings in V1-era test files) |
| Full test suite | 70 files, **904 tests** — parallel run 896/904; the 8 failures were all in `phase9-security-review.test.ts` (global report aggregates swung by finance fixtures planted concurrently by the new Phase 8 suites); solo re-run **23/23 green** → effective **904/904** |
| Production build | Succeeds (171 pages) |
| Live smoke (production build) | 8/8 checks (see §7) |

An earlier full run on the pre-final-review tree (69 files, 873
tests) showed the same documented flake class: 870/873 in parallel,
with `phase6-admin-staff.test.ts` (2 global-count assertions) and
`phase8-tracking-maintenance.test.ts` (1 idempotency assertion over
a database other suites were planting into) green on solo re-run
(14/14 combined). This is the standing shared-`bla_test`
interference pattern recorded since V1 Phase 6: suites asserting
*global* counts can be swung by concurrent suites' fixtures. Every
failure observed in Phase 8 was reproduced as this class and closed
by a solo green run; no failure traced to product code.

---

## 1. Functional, state machines, data integrity

Covered by the full suite. Per-file results on the final tree
(parallel run; files marked † failed only under concurrency and
passed solo as recorded above):

| File | Tests |
|---|---:|
| tests/component/live-operations.test.tsx | 17 |
| tests/component/location-tracking-panel.test.tsx | 11 |
| tests/component/phase6-approval-queue.test.tsx | 2 |
| tests/component/rider-home.test.tsx | 5 |
| tests/component/shell.test.tsx | 10 |
| tests/integration/bookings.test.ts | 16 |
| tests/integration/deliveries.test.ts | 14 |
| tests/integration/drivers.test.ts | 7 |
| tests/integration/finance.test.ts | 14 |
| tests/integration/incident-list-projection.test.ts | 3 |
| tests/integration/invitation-security.test.ts | 12 |
| tests/integration/phase10-production-gates.test.ts | 9 |
| tests/integration/phase10-security-review.test.ts | 11 |
| tests/integration/phase10-slice2-fixes.test.ts | 19 |
| tests/integration/phase2-adversarial.test.ts | 13 |
| tests/integration/phase2-finance-hardening.test.ts | 8 |
| tests/integration/phase2-permissions.test.ts | 5 |
| tests/integration/phase2-security-review.test.ts | 19 |
| tests/integration/phase3-scope-fixes.test.ts | 8 |
| tests/integration/phase3-security-review.test.ts | 46 |
| tests/integration/phase3-tracking.test.ts | 39 |
| tests/integration/phase4-custody-fixes.test.ts | 4 |
| tests/integration/phase4-security-review.test.ts | 9 |
| tests/integration/phase4-tracking-panel.test.ts | 12 |
| tests/integration/phase5-live-search.test.ts | 9 |
| tests/integration/phase5-security-review.test.ts | 27 |
| tests/integration/phase5-transfer-fixes.test.ts | 5 |
| tests/integration/phase6-admin-staff.test.ts | 10 |
| tests/integration/phase6-admin-surfaces.test.ts | 10 |
| tests/integration/phase6-customer-vendor.test.ts | 9 |
| tests/integration/phase6-delivery-fixes.test.ts | 10 |
| tests/integration/phase6-finance-support.test.ts | 5 |
| tests/integration/phase6-four-eyes.test.ts | 8 |
| tests/integration/phase6-rider-linehaul.test.ts | 10 |
| tests/integration/phase6-security-review.test.ts | 32 |
| tests/integration/phase6-warehouse.test.ts | 6 |
| tests/integration/phase7-bulk-booking.test.ts | 6 |
| tests/integration/phase7-chain.test.ts | 14 |
| tests/integration/phase7-driver-profile.test.ts | 9 |
| tests/integration/phase7-evidence.test.ts | 5 |
| tests/integration/phase7-finance-fixes.test.ts | 9 |
| tests/integration/phase7-incidents-tasks.test.ts | 17 |
| tests/integration/phase7-pickup-leg.test.ts | 5 |
| tests/integration/phase7-reassignments.test.ts | 8 |
| tests/integration/phase7-returns-cross-warehouse.test.ts | 6 |
| tests/integration/phase7-security-review.test.ts | 37 |
| tests/integration/phase8-api-validation.test.ts | 20 |
| tests/integration/phase8-final-review.test.ts | 31 |
| tests/integration/phase8-operations.test.ts | 17 |
| tests/integration/phase8-pickup-batch-permission.test.ts | 3 |
| tests/integration/phase8-security-review.test.ts | 20 |
| tests/integration/phase8-tracking-maintenance.test.ts | 4 |
| tests/integration/phase9-reports.test.ts | 37 |
| tests/integration/phase9-security-review.test.ts † | 23 |
| tests/integration/seed-safety.test.ts | 1 |
| tests/integration/transfers.test.ts | 12 |
| tests/integration/user-lifecycle.test.ts | 8 |
| tests/integration/verify-credentials.test.ts | 6 |
| tests/integration/warehouse-ops.test.ts | 23 |
| tests/integration/warehouses.test.ts | 11 |
| tests/unit/booking-domain.test.ts | 16 |
| tests/unit/landing.test.ts | 3 |
| tests/unit/login-guard.test.ts | 7 |
| tests/unit/navigation.test.ts | 15 |
| tests/unit/permissions.test.ts | 13 |
| tests/unit/phase10-gates.test.ts | 18 |
| tests/unit/phase8-tracking-client-permission.test.ts | 1 |
| tests/unit/reports-domain.test.ts | 9 |
| tests/unit/status-tones.test.ts | 7 |
| tests/unit/tracking-client-engine.test.ts | 29 |
| **Total** | **904** |

The logistics end-to-end set (spec §14) is
`phase7-chain.test.ts`: one continuous scenario — booking → pickup
collection → receiving → inspection → inventory → transfer with
partial receive → missing-parcel investigation → damaged parcel →
delivery attempts → partial delivery → cross-warehouse return →
COD → remittance discrepancy → settlement — with custody,
inventory and ledger assertions at every step.

## 2. Authorization & security

- Per-phase independent review suites (phase2/3/4/5/6/7
  `*-security-review.test.ts`) remain in the tree as regressions:
  19 + 46 + 9 + 27 + 32 + 37 tests.
- **Final independent review (Phase 8): PASS, no findings at any
  severity** — 31 live proof-of-concept attacks in
  `phase8-final-review.test.ts`, all repelled: GPS identity spoofing
  and cross-driver session control (6), Live Operations scope
  widening and COD gating (4), admin-surface escalation boundaries
  (5), four-eyes invitation attacks (4), Phase 7 surfaces —
  incidents, bulk booking, reassignments, returns, evidence,
  driver profile (9), Phase 8 additions — kind gate, maintenance
  non-exposure, malformed-JSON handling (3), with the IDOR sweep
  folded across the new `[id]` routes. Full record in
  `docs/security-review.md` (V2 Phase 8 final section).
- Open-item dispositions closed with evidence in Phase 8: L-1
  vehicle read scope (accepted, compensating controls named) and
  the PICKUP batch permission gate (fixed) — both in
  `docs/security-review.md`.

## 3. API request validation (new in Phase 8)

`tests/integration/phase8-api-validation.test.ts` (20 tests) at
route-handler level for the V2 endpoints (tracking ping/session,
live-operations, bulk booking, single booking, incidents):

- **Malformed JSON → 400, never 500.** Found and fixed: three
  routes (`/api/bookings`, `/api/bookings/bulk`, `/api/incidents`)
  used a bare `await request.json()` and threw a raw SyntaxError.
  The remaining eight files of the same class (handovers,
  handovers confirm, receive, tasks, support tickets + 2
  sub-routes, public complaint) were swept to the repo-standard
  `.catch(() => ({}))` form; no route in `src/app/api` now parses a
  body without the catch.
- **Wrong types / ranges → 400 with no DB write:** string
  coordinates, out-of-range lat/lng, negative/zero/over-max
  accuracy, unparseable and far-future `recordedAt` (13 variants).
- **Missing required fields → 400** (ping, session start, bulk row,
  incident).
- **Oversized payloads rejected with no partial write:** 51-row
  bulk (limit 50), 5,000-char name, 100,000-char incident
  description, `sequenceId` beyond int4.
- **Expired/invalid session → 401** on all five V2 route groups.

## 4. Failure behaviour

- **Duplicate GPS ping replay:** first POST 200
  `deduplicated:false`, replay 200 `deduplicated:true`, exactly one
  ping row (API level, Phase 8; service level since Phase 3).
- **Duplicate create:** bulk booking has **no idempotency key** —
  an identical retried submission creates a second distinct
  booking. Documented as a finding with a named test, recorded in
  `docs/known-limitations.md`; fixing it is a design decision
  (client submission IDs), not a patch. **Double-approve** is
  guarded: second `approveBooking` → ConflictError, state stays
  APPROVED.
- **Permission revoked mid-session:** membership removal takes
  effect on the next request — proven in Phase 2
  (`phase2-adversarial.test.ts`) and re-verified in Phase 8 against
  a V2 scoped read (revoked WA loses the live-operations movement
  immediately).
- **GPS permission denied mid-trip:** new unit test
  (`phase8-tracking-client-permission.test.ts`) — after successful
  sends, a PERMISSION_DENIED watch error surfaces as an engine
  error state, emits `geo-error`, fabricates no sends, and leaves
  the last-sent fix untouched.
- **Network interruption during polling:** the Live Operations
  board keeps last-good data and flags it possibly stale
  (component suite `live-operations.test.tsx`).
- **Stale data presentation:** freshness is computed from the
  receive clock on every read and never upgrades itself — a
  snapshot stored as FRESH with a 20-minute-old receive time reads
  back STALE twice, byte-unchanged, with zero pings materialised
  (Phase 8 test).
- **Polling pause on hidden tab / snapshot-only map reads:**
  component + service coverage from Phases 3/5, re-run green in
  this suite.

## 5. GPS maintenance (new in Phase 8)

`scripts/tracking-maintenance.ts` +
`src/server/services/tracking-maintenance.ts`
(`runTrackingMaintenance({ dryRun, now })`): expires abandoned
sessions, then prunes pings past retention, config-driven
(`tracking.config`: 30 days / 120 min defaults), idempotent,
dry-run supported, logs counts only.
`phase8-tracking-maintenance.test.ts` (4 tests): dry-run writes
nothing; a real run ends a 3-hour-abandoned session as EXPIRED and
leaves a fresh session ACTIVE; an immediate second run reports
exactly 0/0; the prune boundary keeps a ping at exactly the
retention age (`lt` semantics) and deletes one 1 second older.
Smoke: `--dry-run` against `bla_dev` exited 0 with counts-only
output.

## 6. UI/UX + accessibility (structural pass)

Method: static analysis only — a Node script computing WCAG
contrast ratios from the `globals.css` tokens, a TypeScript-AST
scan of all 267 `.tsx` files under `src/app` + `src/components`,
and class-level audits. **No page was rendered for this pass; no
screenshot, screen-reader, or real-device claim is made.**

- **Contrast (31 pairs computed):** every *designed* text pair
  passes AA — ink on surface 17.85, brand on white 5.17, white on
  brand 5.17, badge pairs greendeep/greenbg 4.53, amberdeep/amberbg
  4.63, reddeep/redbg 5.66, brand/accentbg 4.75. Findings (flagged,
  no token changed — each failing token is shared with
  icons/placeholders/borders): the `faint` tertiary colour fails as
  text (2.34–2.56) in ~74 uses, a material share of them real
  11–12px informational text (sidebar group headers, profile menu,
  shell footer); `slate2` is marginal off-white (4.43/4.34/4.37 vs
  4.5, passes 4.76 on surface); bright semantic hues are used as
  text in a few older components contrary to the guidelines —
  `OkBox` green-on-tint 2.98, tracking-panel amber status text
  1.95–2.15 and green 3.30, `ErrorBox` red-on-tint 4.23, legacy
  orange 3.22/3.56. Recommended follow-ups are recorded in the raw
  results (swap informational `text-faint` to `text-slate2`
  case-by-case; use deep variants for the named boxes/panel lines).
- **Form labels:** 319 raw controls scanned; unlabelled 38 → 14
  after 24 `aria-label` fixes on key flows (booking review/cancel,
  delivery reassign/cancel/pickup-failed, transfer load/receive
  scans + package picker, receiving put-away chain, incident
  report/workflow, public tracking phone gate). Login, booking
  create, delivery confirm and the main incident form already
  passed. The remaining 14 (task/ticket workflow controls,
  stock-movement, one fleet select) are listed in the raw results.
- **Images/icons:** 2 `<img>` in the app, both with descriptive
  alt; 222 buttons scanned, 0 icon-only buttons without an
  accessible name.
- **Headings/landmarks:** 10/10 role homes have exactly one
  rendered h1 and no skipped levels (source-level reconstruction
  through each page's component tree); landmarks uniform from the
  Phase 1 shell.
- **Touch targets:** shell/nav ≥44px; rider home and tracking
  panel deliberately 48px. Exceptions recorded, not fixed (shared
  desktop console classes): delivery-form action buttons on the
  rider batch page ≈31–37px, driver load-scan/trip submits ≈37px,
  shared inputs ≈38px, transfer picker checkbox ≈16px with no
  row-toggle, one rider-home link ≈31px.
- **Focus visibility:** present — global `:focus-visible` 2px
  brand outline in `globals.css` (5.17:1 against white).
- Raw results: goal workspace
  `hidden_files/phase8-a11y-results.md`.

## 7. Live smoke — production build (Phase 8)

Production build served by `next start` against `bla_dev`, driven
in headless Chrome (CDP) with a throwaway smoke Super Admin
(fixture data only in the dev database):

1. Login page renders; **real credential login** succeeds →
   redirected to MFA setup. PASS
2. Enrolment secret read from the setup page; TOTP code computed
   locally (RFC 6238) and confirmed → landed on the Super Admin
   home. PASS
3. Super Admin home renders real content (2,049 chars). PASS
4. `/super-admin/live-operations` loads; "Live Operations"
   present. PASS
5. Leaflet map container (`.leaflet-container`) renders. PASS
   (Tile *pixels* come from the OSM tile server, which the sandbox
   proxy blocks — tile rendering on a real network is on the
   pre-production checklist in `docs/known-limitations.md`.)
6. Booking created through the real API in page context → 201,
   order `ORD-1021`, origin = the smoke warehouse. PASS
7. Booking appears in the admin bookings list under server-side
   search (`/admin/bookings?search=ORD-1021` → 200, order number
   present in the served HTML; verified by direct authenticated
   HTTP after a navigation race in the headless driver missed it).
   PASS
8. Malformed JSON posted to a swept public route
   (`/api/public/track/[id]/complaint`) → **400, not 500**. PASS

## 8. Backup/restore rehearsal (Phase 8)

Executed against `bla_dev` (PostgreSQL 16): `pg_dump -n app`
(816,017 bytes) → restore into a scratch database → verification
identical on every measure (85 app tables, Package 18, Order 18,
LedgerTransaction 6, 30 migrations, **0 unbalanced journals**, the
`LedgerTransaction_journal_balanced` trigger present in the copy).
Full record and the rehearsed commands: `docs/backup-and-recovery.md`
§3a.

## 9. NOT verified — pre-production checklist (honest list)

Nothing in this report covers the following; they are recorded as
the pre-production device checklist in `docs/known-limitations.md`
and must be done on real hardware/networks before GPS is relied on
in production:

- Android Chrome background / screen-lock tracking behaviour.
- iOS Safari `watchPosition` behaviour and permission UX.
- Real GPS fix cadence and jitter vs the configured intervals.
- Per-browser permission re-enable flows.
- Driver panel + Live Operations pixel checks at 390 / 768 / 1440.
- OSM tile rendering on a real network.
- Screen-reader behaviour (NVDA/VoiceOver/TalkBack) and live
  keyboard traversal — the accessibility pass in §6 is static.

Until that checklist is complete, production GPS is a pilot aid:
scans and custody records remain the operational record.
