# BLA V3 — Current-State UI Audit (Step 1)

**Scope:** the V2 UI exactly as it stands at HEAD `959a069`, audited against
Meena's complaints ("too pale, too empty, washed out, basic CRUD feel") and the
V3 brief. Research + audit only — no application code was changed.

**Method.** The production build (`npm run build`, passing) was run locally
against a seeded `bla_dev` database. Because the seed alone leaves most
dashboards empty, a realistic operations fixture was planted *through the
platform's own services* (no direct table writes for business data): 6 vendor
bookings driven through pickup → receive → inspection (one DAMAGED, one left
in inspection) → inter-warehouse transfer KTM→PKR (one parcel received, one
MISSING — shortage incident auto-raised) → local delivery (one DELIVERED with
COD NPR 4,500 collected, one failed attempt RECIPIENT_UNAVAILABLE) → a COD
remittance left pending verification, a damaged-package incident with
follow-up tasks, and 3 support tickets. Screenshots were captured with
authenticated sessions per role at 1440×900 desktop and 390×844 mobile
(CDP device metrics), and every screenshot below was visually inspected.

**Screenshot inventory** — all files in the goal workspace
`hidden_files/screenshots-before/` (23 PNGs):

| Page | Desktop | Mobile (390px) |
|---|---|---|
| Login | login-desktop.png | login-mobile.png |
| Super Admin dashboard | super-admin-dashboard-desktop.png | — |
| Admin dashboard | admin-dashboard-desktop.png | — |
| Warehouse Admin dashboard | warehouse-admin-dashboard-desktop.png | — |
| Warehouse Staff dashboard | warehouse-staff-dashboard-desktop.png | warehouse-staff-dashboard-mobile.png |
| Rider dashboard | rider-dashboard-desktop.png | rider-dashboard-mobile.png |
| Line-haul dashboard | linehaul-dashboard-desktop.png | linehaul-dashboard-mobile.png |
| Vendor dashboard | vendor-dashboard-desktop.png | — |
| Customer portal | customer-portal-desktop.png | customer-portal-mobile.png |
| Customer tracking (public /track) | customer-tracking-desktop.png | customer-tracking-mobile.png |
| Finance dashboard | finance-dashboard-desktop.png | — |
| Support dashboard | support-dashboard-desktop.png | — |
| Live Operations | live-operations-desktop.png | live-operations-mobile.png |
| Packages (Bookings table) | packages-table-desktop.png | — |
| Transfer detail | transfer-detail-desktop.png | — |
| Package (Booking) detail | package-detail-desktop.png | — |

Caveats: (1) OpenStreetMap tiles cannot load inside the sandbox (proxy blocks
tile.openstreetmap.org), so Live Operations shots show the map frame, controls
and attribution with a grey tile area — layout is auditable, tile rendering is
not; it must be re-checked on Meena's network in Step 10, as in V2. (2) No
driver had a live GPS session at capture time, so Live Operations shows its
"No active movements" state. (3) The seeded customer's portal is empty because
the fixture's parcels belong to vendor bookings, not to that customer account;
the portal's empty composition is itself audited below.

**Scoring.** Each page is scored against a 15-question checklist reconstructed
from the brief's acceptance criteria (§22) and §5 dashboard questions, since
the digest does not reproduce §19.2's list verbatim: (1) Is the page's job
obvious in 3 seconds? (2) Is there one clear primary action? (3) Does
"needs attention" outrank totals? (4) Do KPIs read at a glance (size, icon,
context)? (5) Is hierarchy carried by type/weight, not decoration? (6) Is
colour spent on meaning, not everywhere? (7) Do statuses read without relying
on colour? (8) Are tables dense enough to work in, with aligned numerals?
(9) Is any screen area dead/void? (10) Are raw enums/IDs/UUIDs kept off the
screen? (11) Does the page feel like one system with the others? (12) Would
it survive bright light / small laptop? (13) Mobile: is the next action in
thumb reach at ≥44px? (14) Are empty states honest and useful? (15) Does it
look like a finished commercial product rather than scaffolding?

---

## 1. Global findings (all pages)

**G1 — The "pale" complaint is measurable, and it is mostly borders + faint
text, not the background.** The card border token `line #e6ebf0` sits at
**1.20:1** against white cards and **1.12:1** against the page — cards are
nearly edgeless, so pages read as text floating on grey. The `faint #94a3b8`
text colour (timestamps, footers, placeholders, "workspace" captions) is
**2.56:1 on white — a hard WCAG AA failure** wherever it carries information.
`slate2 #64748b` secondary text passes on white (4.76:1) but **fails on the
page background (4.43:1) and on cream (4.34:1)**, and cream is exactly where
the neutral badge uses it. Full table in §3.

**G2 — Blue is spent everywhere, so nothing is primary.** The single brand
blue `#2563eb` colours every button (the Warehouse Admin header carries four
solid blue buttons in a row), every link, the active nav item, the logo tile,
and the info badge text. With everything emphasised, nothing is: the eye
cannot find the one action a page wants. This is the "basic CRUD scaffold"
feel Meena named — it is the default admin-template look.

**G3 — KPI cards are bare numbers.** Across all 10 dashboards the stat card
is: small caps grey label, a ~16–20px number, a faint context line. No icon,
no tinted container, no comparison window, values far under the brief's
28–34px, and most are not clickable. The Super Admin dashboard is the extreme
case: 8 identical cards over two full-width "per day" panels whose 30 bars
are almost all zero — half the first screen is empty grey tracks (Q4, Q9
fail).

**G4 — Raw machine values leak onto screens.** Transfer detail shows
`RECEIVED_AT_DESTINATION` and `ARRIVED_AT_DESTINATION · MISSING` as table
text; the Finance activity table shows ledger accounts as
`VENDOR_PAYABLE:bc38788-fffe-4dbf-…` (a raw UUID) and type `COD_COLLECTED`;
booking detail wraps a tracking ID mid-string (`BLA-⏎8331509862`) because IDs
aren't set in a mono, non-wrapping style. Statuses render via
`statusLabel()` (underscores → spaces, uppercased) — there is no friendly
label dictionary (Q10 fail).

**G5 — Badges are pastel-on-pastel and mutually confusable.** The bookings
table shows two amber-family pills per row (approval PENDING + status
SUBMITTED) that read as the same signal; staff task badges ASSIGNED (pale
blue) vs ACCEPTED (pale grey) are near-indistinguishable; package detail
stacks four domain badges (operational/condition/payment/delivery) as
anonymous pills with tiny domain captions. The deep-text pairs themselves
pass AA (green 4.53, amber 4.63, red 5.66) — the failure is differentiation
and labelling, not the text contrast (Q7 partial fail).

**G6 — The shell is competent but characterless.** Light sidebar (240/68px)
with a blue "B" tile, grouped nav (workspace/operations/business/
administration), header with breadcrumb, global search (nav + tracking
lookup), quick actions, warehouse selector, notifications, profile menu.
Structure is sound and consistent across roles (a V2 strength to keep);
identity is nil — nothing about it says "BLA" or "operations", the active
item is a faint blue wash, and group labels are the failing faint grey.

**G7 — Empty and low-data states dominate real pages.** Line-haul's home is
four stacked cards, two of them empty-state text, over a half-viewport void.
The customer portal is a column of zero-KPI cards and empty panels. Vendor's
"current operations" card is two sentences of prose. Empty states are honest
(no fake data — good) but compositionally untreated: no icon, no guidance
action, no visual hierarchy (Q9, Q14 fail).

**G8 — Mobile is responsive but not designed.** At 390px nothing overflows
horizontally (verified on rider, line-haul, staff, customer, live ops,
tracking, login) and the shell collapses to a hamburger + title bar. But
mobile pages are the desktop stack scrolled: rider's tracking panel repeats
near-identical batch rows (seed leftovers included) above "Today's
deliveries", pushing the actual work below the fold; buttons are desktop
sized, not thumb-anchored (Q13 fail).

## 2. Per-page verdicts

**Login** (login-desktop/mobile). Centred white card, text-only "BLA
Logistics", blue button, footer note in failing faint grey. Functional,
zero brand presence. *Verdict: weakest brand surface in the product — the
brief's text+mark treatment lands here first.* Q1✓ Q2✓ Q6✗ Q9✗ Q15✗.

**Super Admin dashboard.** 8 bare KPI cards (G3); two giant 30-day bar-list
panels, almost all zeros, occupying the entire work area; no needs-attention
strip despite 2 open incidents existing; "Full reports" is the only strong
action. *Verdict: worst offender #1 — this is the screenshot that proves
"too pale, too empty".* Q3✗ Q4✗ Q9✗ Q15✗.

**Admin dashboard.** The best-composed page: needs-attention chips (incidents
by severity, COD remittances awaiting verification, overdue tasks, failed
attempts) with real incident rows, 6 stat cards, current-operations grid,
live-operations strip. Still pale: chips are washed, stat values small,
incident severity relies on small pastel pills. *Verdict: structure to keep,
skin to replace.* Q3✓ Q4✗ Q6✗.

**Warehouse Admin dashboard.** Warehouse identity header done right (hub
name as title). Incident alert card is pale pink text on white — an
exception that whispers. 6 bare stat cards; "Current operations" is a prose
sentence where a queue should be; quick actions are a row of 10 identical
outline buttons (no primary). Header carries 4 solid blue buttons (G2).
*Verdict: strong content, no hierarchy.* Q2✗ Q3~ Q4✗.

**Warehouse Staff dashboard ("My work").** Task list with status + priority
pills, queue stat cards (arrivals/inspection/dispatch), quick actions. The
right content for the role; badges confusable (G5), stat cards bare, and the
page is a long undifferentiated stack. Mobile stacks acceptably. *Verdict:
functional, visually flat.* Q4✗ Q7~ Q13~.

**Rider dashboard.** The V2 tracking panel leads with a paragraph of consent
text and a stack of near-identical batch rows each with a big blue "Start
tracking" button (5 rows on desktop, including stale seed batches) — the
rider's actual deliveries start below the fold. No shift status, no COD
summary visible in the first screen. Mobile identical, longer. *Verdict:
worst offender #2 for a field role — the next action is buried under
repetition.* Q1✗ Q9✗ Q13✗.

**Line-haul dashboard.** Profile card, empty "current trip" card, one
completed-trip row, reports card — half the viewport is void (G7). When a
trip is active the same skeleton carries it, but the idle state is the
emptiest page in the product. *Verdict: worst offender #3 (emptiness).*
Q9✗ Q14✗ Q15✗.

**Vendor dashboard.** Business-name header with APPROVED pill; 6 bare stat
cards; "current operations" as prose; recent-bookings rows are sparse
(link … destination … pill, with a wide empty middle). *Verdict: honest
data, spreadsheet-with-padding feel.* Q4✗ Q8✗ Q9✗.

**Customer portal.** All-zero KPI cards, empty needs-attention, empty
tracking panel, empty recent-activity (fixture has no parcels for this
account — see caveats). Composition is a stack of empty bordered boxes;
a real first-run customer would read the product as broken. *Verdict:
empty-state design is the gap, not the data.* Q9✗ Q14✗.

**Public tracking (/track/:id).** The timeline is the best customer-facing
element — real event history, plain labels ("Arrived at destination hub").
But completed steps render as pale grey dots with no connector emphasis and
only the current step is blue: progress doesn't *read* as progress. Page is
a narrow centred column with wide voids either side; the status pill is a
raw-ish uppercase label. Mobile is the same column, timestamps wrap.
*Verdict: good bones; needs the brief's timeline treatment (completed =
success tone + check, current = teal pulse, connector line).* Q7~ Q9✗ Q15~.

**Finance dashboard.** Remittance awaiting verification leads (correct
priority); 6 bare money cards; queue rows are prose lines with right-side
links; recent-activity table leaks UUIDs and raw enums (G4) — unacceptable
on a finance surface. *Verdict: priorities right, presentation leaks the
database.* Q4✗ Q10✗.

**Support dashboard.** Two alert banners (unassigned tickets, high-severity
incidents) are the only saturated elements on any page — proof the system
*can* signal; ticket rows are pale with small OPEN pills; queue counts are a
plain stacked list. *Verdict: closest to the target feel in its banners;
the rest is flat.* Q3✓ Q4✗ Q7~.

**Live Operations.** Filter chips (All/Transfers/Pickups/Deliveries/Active/
Delayed/Stale), movement list + map split, list/map toggle on mobile —
the control-room skeleton is real. With no active movements it shows a
centred empty card; map area is a grey void in the sandbox (tiles blocked,
see caveats). Freshness text is present ("Last refreshed… · Board generated
…"). *Verdict: structure ADOPT; needs the brief's control-room density,
legend, and side panel once tiles/drivers are live.* Q1✓ Q9~ Q15~.

**Packages table (Bookings).** Clean table, correct columns, COD in
tabular numerals — but two confusable amber pills per row (G5), generous
row padding with only 6 rows then a full void, no visible sort/filter
affordance in the first screen, sender column repeats identically with no
grouping. *Verdict: the "basic CRUD" archetype Meena described.* Q7✗ Q8~ Q9✗.

**Transfer detail.** Solid anatomy: route header with status pill, overview
grid (origin/destination/driver/vehicle/dates), packages table, manifest
card, trip card. Raw enums in the packages table (G4) and everything at one
visual volume — the MISSING parcel does not stand out from the RECEIVED one.
*Verdict: keep the anatomy; the exception must shout, not whisper.* Q7✗ Q10✗.

**Package (Booking) detail.** Approval queue with primary action, shipments
& packages with the four-domain badge cluster (informative, noisy — G5),
cancel section, printable label with QR. Tracking ID wraps mid-string (G4).
*Verdict: rich and correct; needs label hierarchy and ID typography.*
Q7~ Q10✗.

## 3. Current palette — computed WCAG contrast (WCAG luminance formula)

| Pair (as used) | Ratio | AA verdict |
|---|---|---|
| ink #0f172a on white / page | 17.85 / 16.63 | Pass (AAA) |
| slate2 #64748b on white (secondary text) | 4.76 | Pass, thin margin |
| slate2 #64748b on page #f5f7fa | 4.43 | **Fail** normal text |
| slate2 on cream #f1f5f9 (neutral badge pair) | 4.34 | **Fail** normal text |
| faint #94a3b8 on white / page / cream | 2.56 / 2.39 / 2.34 | **Fail** everywhere |
| brand #2563eb on white; white on brand | 5.17 | Pass |
| brand on accentbg #eff6ff (info badge) | 4.75 | Pass |
| greendeep #15803d on greenbg #e8f7ee | 4.53 | Pass, thin margin |
| amberdeep #9a6206 on amberbg #fdf3e0 | 4.63 | Pass |
| reddeep #b91c1c on redbg #fdecec | 5.66 | Pass |
| amber icon #f59e0b on amberbg (non-text) | 1.95 | **Fail** 3:1 non-text |
| green icon #16a34a on greenbg (non-text) | 2.98 | **Fail** 3:1 non-text (by 0.02) |
| red icon #dc2626 on redbg (non-text) | 4.23 | Pass |
| border line #e6ebf0 on white / page | 1.20 / 1.12 | Decorative only — cards nearly edgeless |

Reading: body text and badge *text* mostly pass; the failures concentrate
exactly where Meena's eye reported them — faint informational text, invisible
card boundaries, and bright icon hues that fail as graphical objects.

## 4. Inventory — what exists today

- **Shell** (`src/components/layout/ShellFrame.tsx`): light sidebar 240px /
  68px collapsed, blue "B" tile + "BLA Logistics" wordmark; header =
  breadcrumb + GlobalSearch (nav-item search + tracking-ID lookup) +
  role quick-action buttons + warehouse selector (admin trees) + notification
  bell with count + profile menu; content max-width 1450px. Mobile: sidebar
  becomes a slide-over via hamburger.
- **Navigation** (`src/lib/navigation/registry.ts`): per-dashboard item lists
  with `anyOf` permission gates; groups today are **workspace / operations /
  business / administration**; routes are role-tree-relative
  (`/<dashboard><path>`, e.g. `/super-admin/bookings`). 10 dashboards: admin
  and super-admin share a tree (SA adds /adjustments, /settings); warehouse
  and staff share a tree; rider, transport-driver (line-haul), vendor,
  customer, finance, support have their own. Registry order is the nav order.
- **Primitives** (`src/components/ui/`): DataTable, Dialog, Drawer,
  StatusBadge, form controls, Skeleton/Empty/Error states. One StatusBadge
  for all domains (V2 Phase 1).
- **Status system** (`src/lib/status/status-tones.ts`): five tones
  (success/warning/danger/info/neutral) × six domains (operational,
  condition, payment, delivery, exception, generic); unknown values fall
  back to neutral; `statusLabel()` renders the raw enum, title-cased by CSS.
- **Tokens** (`src/app/globals.css`, Tailwind v4 `@theme`): page #f5f7fa,
  surface #ffffff, cream #f1f5f9, ink #0f172a, slate2 #64748b, faint #94a3b8,
  brand #2563eb (blue), line #e6ebf0; badge pairs green/amber/red + legacy
  orange/purple (guidelines: do not use in new work); radii 2/3/4/8px;
  shadows card (0.04) + pop; `.tnum` tabular-numeral utility; global
  `:focus-visible` 2px brand outline.
- **Font actually loaded:** none — the system stack
  (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial`).
  Rendering therefore differs per OS; there is no webfont dependency today.
- **Brand assets:** **none.** `public/` holds only default Next.js SVGs;
  `src/app/favicon.ico` is the default Next.js icon; the logo is a blue
  rounded square with a white "B"; the login page is text-only. There is no
  logo file, no brand guideline, no illustration set. The V3 design system
  therefore specifies a text+mark treatment from the existing name
  ("BLA Logistics") — see docs/ui-design-system.md §2.6. Nothing may be
  invented beyond that.

## 5. Gap list, mapped to the brief

| # | Gap | Brief section | Where it lands in V3 |
|---|---|---|---|
| 1 | Faint text + invisible borders fail AA and read "washed out" | §2, §20 | New token set + border jobs (design system §2) |
| 2 | Blue spent on every action; no primary hierarchy | §2, §4 | Teal primary discipline; one primary per view (design system §7.3) |
| 3 | KPI cards bare (no icon/context/window/drill) | §5 | StatCard spec (design system §7.5) |
| 4 | SA dashboard: 8 equal cards + zero-bar walls | §6 | Exception-first composition; chart restraint (design system §7.12) |
| 5 | Rider home buries today's work under tracking rows | §9 | Rider layout spec; tracking panel demoted (design system §9) |
| 6 | Line-haul + customer portal emptiness untreated | §10, §12 | Empty-state system with guidance actions |
| 7 | Raw enums / UUIDs / wrapped IDs on screen | §16, §19 | Friendly-label dictionary; mono ID style (design system §4 + §3) |
| 8 | Badges confusable across domains; no icons | §2, §16 | StatusBadge v3: icon + label, labelled domain chips (design system §4) |
| 9 | Nav groups don't match brief §4.2; admin tree lacks Packages/Inventory/Transfers/Assignments/Payments/COD items | §4.2 | Mapping table + honest gap flags (design system §6) |
| 10 | No command menu; header search is nav+tracking only | §4 | Ctrl+K design on cmdk (design system §8) |
| 11 | No charts library or primitives; bar-lists only | §6, §16 | Hand-rolled SVG chart primitives (design system §7.12) |
| 12 | Sidebar has no identity; login has no brand | §2, §4 | Dark sidebar + text+mark treatment (design system §2.6, §7.1) |
| 13 | Tables sparse; no density option; filters not prominent | §16, §18 | DataTable spec 44/40px densities (design system §7.6) |
| 14 | Tracking timeline progress doesn't read as progress | §12 | PackageTimeline spec (design system §7.10) |
| 15 | Focus colour is a single blue; no dark-surface focus token exists | §20 | Per-surface focus tokens (design system §2.5) |
| 16 | Live Operations lacks legend/selection sync prominence | §15 | LiveMap/LiveMovementPanel specs (design system §7.11) |

*Fixture and screenshot tooling were local-only (seeded bla_dev); no
production or live data was touched. The planted fixture used the platform's
own services end-to-end, so every value in the screenshots is a real record
produced by the frozen backend.*
