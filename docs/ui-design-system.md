# BLA V3 — Design System: Teal & Graphite Operations UI

**Step 2 of the V3 redesign.** This document is the binding specification for
Steps 3–10. It is built from the brief (goal `hidden_files/spec-v3-digest.md`),
the internet design study (`docs/ui-design-study.md`), and the current-state
audit (`docs/ui-current-state-audit.md`). UI/UX only: no backend, schema,
permission, lifecycle, or service changes are specified or permitted anywhere
in this document. Every colour pairing below was computed with the WCAG
relative-luminance formula and cross-checked in two independent passes.

## 1. Principles

1. **Neutrals carry the UI; teal is spent only on meaning** — primary action,
   active state, focus, links, the primary chart series. (Study A1.)
2. **Exception-first.** Every dashboard leads with what needs attention,
   then KPIs, then work. (Study B1.)
3. **Density is a feature.** Hairline dividers, 40–44px rows, tabular
   numerals; detail lives in drawers, not in ever-longer pages. (Study C3.)
4. **Status is icon + word, always.** Colour is redundant encoding, never
   the only channel. (Study D2; WCAG 1.4.1.)
5. **Honesty is a design token.** No fake trends, ETAs, or deltas; where no
   real comparison exists, show a breakdown line instead. Genuine-zero,
   no-data, loading, and error are four different states.
6. **One system, ten roles.** Same shell, vocabulary, and components;
   dashboards differ in *which* queue and KPIs lead, never in language.
7. **Field work is not shrunk desktop.** Rider/line-haul surfaces follow
   the field rules in §8.

## 2. Colour tokens

Tokens are specified as CSS custom properties in the Tailwind v4 `@theme`
(the V2 mechanism — token *values and names* change in Step 3, the mechanism
does not). Each token has one job; do not improvise new pairings.

### 2.1 Core palette (from the brief §2.2, verified)

| Token | Hex | Job |
|---|---|---|
| `--color-primary` | #0F766E | Primary buttons, active indicators, links, focus on light, primary chart series |
| `--color-primary-dark` | #115E59 | Primary hover/pressed; sidebar active-item fill; text on primary-light |
| `--color-primary-light` | #D9F0EB | Teal tint surfaces: selected rows, icon containers for brand-tinted StatCards |
| `--color-sidebar` | #172F2B | Sidebar background; strong dark surfaces (login panel) |
| `--color-ink` | #172823 | Primary text |
| `--color-ink-2` | #52645D | Secondary text — **the floor; nothing lighter may carry text** |
| `--color-page` | #F1F4F2 | App background |
| `--color-card` | #FFFFFF | Card / panel surface |
| `--color-surface-2` | #E7EEEA | Secondary surface: table header row, chip fills, inset panels |
| `--color-accent` | #41B7A4 | **Restricted** — see §2.3 |

### 2.2 Contrast verification — every text pairing used by this system

| Pair | Ratio | AA (4.5 text / 3 large+non-text) |
|---|---|---|
| ink on card / page / surface-2 | 15.39 / 13.90 / 13.06 | Pass (AAA) |
| ink-2 on card / page / surface-2 | 6.29 / 5.68 / 5.33 | Pass |
| white on primary (button label) | 5.47 | Pass |
| white on primary-dark (hover) | 7.58 | Pass (AAA) |
| primary-dark on primary-light | 6.36 | Pass |
| primary on card (links, large text, icons) | 5.47 | Pass |
| primary on page | 4.94 | Pass |
| primary on surface-2 | 4.64 | Pass |
| Success text #18794E on its tint #E3F4E8 | 4.73 | Pass |
| Pending text #99610A on its tint #FFF0D6 | 4.59 | Pass — **tightest pair; never at reduced opacity, never blended** |
| Failed text #B42318 on its tint #FDE8E7 | 5.60 | Pass |
| Info text #285EA8 on its tint #E7EFFB | 5.57 | Pass |
| Neutral text #53635D on its tint #EDF1EE | 5.56 | Pass |
| Status texts on white (all five) | 5.16–6.57 | Pass |
| Sidebar nav text #C3D4CB on sidebar | 9.20 | Pass (AAA) |
| Sidebar group label #8FA89D on sidebar | 5.59 | Pass |
| White on sidebar (active label, wordmark) | 14.21 | Pass (AAA) |

**Result: the brief's palette passes AA for every text pairing with zero
hex changes.** The deviations below are *additions* (tokens the brief didn't
name) and *restrictions* (pairings that fail and are therefore forbidden),
not alterations to the brief's colours.

### 2.3 Restrictions and added tokens (deviations, with reasons)

1. **Accent #41B7A4 is forbidden as text or icon colour on light surfaces**
   (2.46:1 on white — fails text and non-text). Permitted jobs only:
   (a) the sidebar active-item indicator bar (5.77:1 on sidebar, non-text ✓);
   (b) chart secondary series / map-adjacent accents on dark or as large
   graphical elements ≥3:1 contexts; (c) decorative shapes carrying no
   information. Where a bright teal is needed on light, use primary.
2. **Sidebar text tones (added).** The brief names no sidebar text colour.
   Added: nav item default `#C3D4CB` (9.20), group label `#8FA89D` (5.59),
   active item = white text on `primary-dark` fill + accent indicator bar.
   Teal `#0F766E` text on the sidebar is **forbidden** (2.60:1 — fails).
3. **Border splits into two jobs (added token).** Brief border `#D1DDD7`
   measures 1.40:1 on white / 1.26:1 on page — correct for *dividers and
   card edges* (decorative; WCAG exempts them), but it cannot be the sole
   identifier of a form control (WCAG 1.4.11 needs 3:1). Therefore:
   - `--color-border` #D1DDD7 — dividers, card edges, table rules.
   - `--color-border-control` **#7D8F86** (added) — input/select/checkbox
     boundaries: 3.42:1 on white, 3.09:1 on page. On surface-2 it is 2.90:1,
     so controls placed on surface-2 panels additionally get the primary
     focus/hover strengthening in §2.5 — in practice form panels are white.
4. **No lighter grey than ink-2 exists.** Timestamps, placeholders, axis
   labels, captions — all use ink-2 minimum. (V2's `faint` at 2.56:1 is
   abolished, not renamed.)

### 2.4 Status colours

The brief's five statuses are the only status colours. Full mapping onto the
existing tone module is §3.

| Status | Text | Tint bg | Icon (Lucide-style, existing icon set) |
|---|---|---|---|
| Success | #18794E | #E3F4E8 | check-circle |
| Pending | #99610A | #FFF0D6 | clock |
| Failed | #B42318 | #FDE8E7 | alert-octagon / x-circle |
| Info | #285EA8 | #E7EFFB | info / truck (in-transit contexts) |
| Neutral | #53635D | #EDF1EE | minus-circle |

### 2.5 Focus tokens (per surface — a single global focus colour cannot pass)

| Surface | Focus indicator | Ratio |
|---|---|---|
| Light (card/page/surface-2) | 2px outline `primary` + 1px offset | 5.47 / 4.94 |
| Dark sidebar | 2px outline white (or page #F1F4F2) + 1px offset | 14.21 / 12.83 |
| On primary buttons | 2px outline `primary-dark` outside + white inner line | 7.58 |

Target: WCAG 2.4.13's 2px/3:1 geometry adopted as the design target (it is
AAA; 2.4.11 "not entirely obscured" is the AA floor and is also required —
sticky headers/toolbars must carry `scroll-margin` so focused rows are
never fully covered).

### 2.6 Brand treatment (no logo exists — audit §4)

No logo file, brand guideline, or illustration set exists anywhere in the
product. The system therefore specifies a **text + mark treatment built
from the existing name only** — nothing is invented beyond typography and
the palette:

- **Mark:** a 32px rounded-square (radius 8) in `primary-dark`→`primary`
  flat fill (no gradient), containing the letter "B" in Inter semibold
  white, or — preferred where the icon set allows — a simple package/route
  glyph in white. One mark, used identically in sidebar, login, favicon.
- **Wordmark:** "BLA" in Inter semibold 17px ink (white on sidebar),
  followed by "Logistics" in regular weight ink-2 (sidebar: #C3D4CB).
- **Login:** split treatment — left panel in `sidebar` #172F2B carrying the
  mark + wordmark + one line of existing product copy ("Delivery operations
  platform"); right panel the form on white. On mobile the dark panel
  collapses to a top band. Footer text in ink-2 (never V2's faint).
- **Favicon:** regenerate from the mark (teal rounded square + B) in
  Step 3; the default Next.js favicon is retired.
- If Meena later supplies a real logo, it drops into the mark's slot
  unchanged (32px sidebar / 40px login) — the slot is the contract.

## 3. Typography

**Decision: Inter (variable), self-hosted via the Fontsource npm package
(`@fontsource-variable/inter`), SIL Open Font License 1.1 — free.**

Rationale, against the alternatives:
- *Keep the system stack:* rejected. Rendering differs per OS (the audited
  screenshots are Segoe UI on Windows, Roboto elsewhere), numerals and
  small-size legibility are inconsistent, and the "generic admin template"
  feel is partly a font problem. Zero-cost is its only virtue.
- *Geist (Vercel):* also free (OFL, via the `geist` npm package) and a
  legitimate alternative; rejected on fit, not licence — Geist's character
  is display-oriented (tighter, more geometric), while Inter is designed
  for UI text at 12–15px, has mature tabular figures, and wider weight
  coverage at small sizes. If Meena prefers Geist's look, swapping is a
  one-token change before Step 3 and a breaking change after.
- *Delivery:* Fontsource self-hosts the woff2 (no build-time or runtime
  fetch to Google Fonts — builds stay hermetic, which this repo's sandbox
  and Vercel builds both need). Load the variable font, weights 400–700.
- **Mono:** the system mono stack (`ui-monospace, "SF Mono", "Cascadia
  Mono", Consolas, monospace`) for tracking IDs, order numbers, and ledger
  references — no new dependency; IDs never wrap mid-string (`nowrap` +
  ellipsis in narrow columns).

**Type scale (tokens):**

| Token | Size / weight | Job |
|---|---|---|
| page-title | 26px / 600 (brief range 25–30) | One per page |
| section-title | 18px / 600 (17–20) | Card/panel headings |
| kpi-value | 30px / 650 (28–34) | StatCard values |
| card-title | 15px / 600 (14–16) | Card headers |
| body | 14px / 400 (13–15) | Default text |
| table | 13.5px / 400 (13–14) | Table cells; headers 12px/600 uppercase ink-2 |
| meta | 12.5px / 400 (12–13) | Timestamps, context lines — in ink-2, never lighter |
| nav | 14px / 500 | Sidebar items; group labels 11.5px/600 uppercase |

Rules: headings medium/semibold only (no bold-700 display type); tabular
numerals (`font-variant-numeric: tabular-nums`) are **mandatory** for all
numbers, currency (NPR), counts, and IDs — the V2 `.tnum` utility becomes a
token-level default on StatCard, DataTable numeric columns, and finance
surfaces; line-height 1.45 body / 1.25 headings; no fixed-height text
containers that clip under WCAG 1.4.12 text-spacing overrides.

## 4. Status system — mapping onto the frozen tone module

**No status logic changes.** `src/lib/status/status-tones.ts` keeps its five
tones and all six domain vocabularies exactly as they are. V3 changes only
(a) the hex values behind each tone, (b) adds an icon per tone, (c) adds a
friendly-label dictionary. The tone → brief-status mapping is 1:1:

| Tone (existing) | Brief status | Text / bg (new) | Was (V2) |
|---|---|---|---|
| success | Success | #18794E / #E3F4E8 | #15803d / #e8f7ee |
| warning | Pending | #99610A / #FFF0D6 | #9a6206 / #fdf3e0 |
| danger | Failed | #B42318 / #FDE8E7 | #b91c1c / #fdecec |
| info | Info | #285EA8 / #E7EFFB | #2563eb / #eff6ff |
| neutral | Neutral | #53635D / #EDF1EE | #64748b / #f1f5f9 |

How each domain lands (examples — the module's tables are unchanged):
- **operational:** DELIVERED→Success; OUT_FOR_DELIVERY / IN_TRANSIT /
  DISPATCHED / PICKED_UP→Info; INSPECTION_PENDING / DELIVERY_ATTEMPTED→
  Pending; CANCELLED→Failed; unlisted states→Neutral (existing fallback).
- **condition:** GOOD→Success; SUSPECTED_DAMAGE / PACKAGING_COMPROMISED→
  Pending; DAMAGED→Failed.
- **payment:** PAID / COD_SETTLED / COD_REMITTED→Success; COD_COLLECTED→
  Info; COD_DUE / PENDING→Pending; REFUNDED / NOT_APPLICABLE→Neutral.
- **delivery:** DELIVERED→Success; ATTEMPTED / RETURN_INITIATED→Pending;
  FAILED / REFUSED→Failed; ASSIGNED / OUT_FOR_DELIVERY→Info; NOT_STARTED /
  RETURNED_*→Neutral.
- **exception:** RESOLVED→Success; ON_HOLD / DELAYED / MISROUTED /
  ADDRESS_CLARIFICATION_REQUIRED / CUSTOMER_UNAVAILABLE→Pending; MISSING /
  LOST_UNDER_INVESTIGATION / DAMAGED / DELIVERY_FAILED→Failed; NONE→Neutral.
- **generic:** the long tail (APPROVED/ACTIVE/COMPLETED→Success; OPEN/
  SUBMITTED/PENDING_*→Pending; REJECTED/SUSPENDED/CRITICAL/HIGH→Failed;
  IN_PROGRESS/ASSIGNED→Info; DRAFT/LOW/ARCHIVED→Neutral) — unchanged.

**Friendly labels (new UI-layer dictionary, Step 3).** `statusLabel()`'s
raw enum rendering is replaced at the component level by a label dictionary
keyed by (domain, value) — e.g. operational `RECEIVED_AT_DESTINATION` →
"Received at destination", payment `COD_COLLECTED` → "COD collected",
generic `RECONCILIATION_PENDING` → "Reconciliation pending". Unlisted
values fall back to a humanised transform (underscores → spaces, sentence
case) — never the raw SCREAMING_SNAKE enum. The dictionary changes words
only; tone and logic are untouched.

**Badge anatomy (StatusBadge v3):** tint background, status text colour,
tone icon (14px) + label (12.5px/550). Two densities: full pill (detail
headers, cards, rider) and compact dot+label (dense table rows). On detail
pages, multi-domain packages show **labelled domain chips** in fixed order
— Operational · Condition · Payment · Delivery · Exception — each chip
prefixed by its domain name in ink-2, replacing V2's anonymous pill stack.
Priority is a separate element (PriorityBadge: flag icon + word, Failed
tone for HIGH/CRITICAL, Pending for MEDIUM, Neutral for LOW) — never
merged into the status badge (study C/D).

## 5. Scales and shell dimensions

**Spacing** — closed 4px vocabulary (study A/C): 4, 8, 12, 16, 20, 24, 32,
40, 48. Page padding 24 (desktop) / 16 (mobile); card padding 20; section
gap 24; KPI grid gap 16; form field gap 16. No arbitrary values.

**Radius** — 6 (chips, inputs, small buttons), 12 (cards, panels, buttons),
16 (dialogs, drawers, the command palette). V2's 2/3/4/8 set is retired;
pill radius is reserved for badges and filter chips only ("pill-everything"
is forbidden by the brief).

**Shadow** — cards rest on borders (no shadow). One pop shadow for floating
layers only (menus, dialogs, drawers, palette, map popups):
`0 12px 32px rgb(23 40 35 / 0.16), 0 2px 8px rgb(23 40 35 / 0.10)`
(graphite-tinted, replacing V2's slate-tinted pop).

**Shell dimensions** — sidebar 248px expanded / 72px collapsed (brief);
header 60px; content max-width none (fluid) with 24px gutters — V2's
1450px cap is retained as the *reading* max for detail pages only;
dashboards and tables go full width. Sidebar collapses to icons at 72px
(tooltips + aria-labels on every item); below 1024px the sidebar is a
slide-over drawer with scrim; the map/list panels on Live Operations
collapse per §7.11.

## 6. Navigation grouping (brief §4.2 mapped onto the existing registry)

Rules: display re-grouping and renaming only — **no route is invented, no
permission gate changes**. An item renders only when the actor passes its
existing registry gate (`anyOf`); a group with no visible items is omitted.
Full routes are `/<dashboard><path>`; the Admin and Super Admin trees share
every row below except where marked SA-only.

| Brief group | Label (V3) | Route (admin tree) | Registry permission gate |
|---|---|---|---|
| OVERVIEW | Overview | `/admin` · `/super-admin` | — (role home) |
| OPERATIONS | Live Operations | `…/live-operations` | operations.live_view |
| OPERATIONS | Orders | `…/bookings` | booking.read_all |
| OPERATIONS | New booking *(quick action, not a nav row)* | `…/bookings/new` | booking.create |
| NETWORK | Warehouses | `…/warehouses` | warehouse.read_all |
| NETWORK | Drivers | `…/drivers` | driver.manage / driver.assign |
| NETWORK | Vehicles | `…/vehicles` | vehicle.manage / vehicle.assign |
| NETWORK | Vendors | `…/vendors` | vendor.read_all |
| NETWORK | Customers | `…/customers` | customer.read |
| WORK MGMT | Tasks | `…/tasks` | task.create / task.assign / task.update_own |
| WORK MGMT | Exceptions | `…/incidents` | incident.manage / incident.resolve |
| WORK MGMT | Support Tickets | `…/tickets` | support.ticket.manage |
| FINANCE | Settlements | `…/settlements` | settlement.read |
| FINANCE | Adjustments *(SA tree only)* | `/super-admin/adjustments` | finance.adjust / finance.approve_adjustment |
| MANAGEMENT | Reports | `…/reports` | report.read_all |
| MANAGEMENT | Users & Roles | `…/users` | user.manage |
| MANAGEMENT | Audit Logs | `…/audit` | audit.read |
| MANAGEMENT | Settings *(SA tree only)* | `/super-admin/settings` | settings.manage |
| (shell) | Notifications | `…/notifications` | notification.read_own — stays in the header bell + OVERVIEW group bottom |

**Honest gaps — brief items with NO route in the Admin/SA tree.** These are
recorded, not papered over; V3 does not invent routes or pages for them:
- **Packages** — no standalone admin route exists. Packages are managed
  inside Booking detail and found via the command menu's package search
  (§8). The brief's "Packages" is served by Orders → booking detail.
- **Inventory** — exists only in the warehouse tree
  (`/warehouse/inventory`, `/staff/inventory`). Admin/SA reach stock through
  Warehouses and Reports.
- **Transfers** — exists only in the warehouse tree (`/warehouse/transfers`).
  Admin/SA see transfers in Live Operations and booking detail.
- **Assignments** — delivery batches/assignments live in the warehouse tree
  (`/warehouse/deliveries`). No admin-tree equivalent exists.
- **Payments** — no `/payments` route exists anywhere; the Finance tree
  carries Invoices and Ledger instead (`/finance/invoices`,
  `/finance/ledger`).
- **COD** — COD surfaces exist as `/finance/cod-remittances` (Finance tree)
  and driver-tree `/cod`; the Admin tree reaches COD state via Settlements
  and dashboard attention cards.
- **Financial Reports** — the registry has a single Reports item; it sits
  in MANAGEMENT per the brief's own grouping, and its finance views serve
  the FINANCE group's reporting need. It is listed once, not duplicated.

**Derivation rule for the other eight dashboards.** Same six group names,
same order. Each role's *existing* registry items are bucketed by function:
role home + tasks + notifications → OVERVIEW; the role's operational queues
and create actions → OPERATIONS; entities the role manages (fleet, vendors,
customers, warehouses) → NETWORK; tasks/exceptions/tickets → WORK
MANAGEMENT; money items → FINANCE (the Finance dashboard's own tree leads
with this group); reports/profile/settings-class items → MANAGEMENT.
Concretely: Warehouse/Staff trees put Receive & Scan, Arrivals, Inventory,
Transfers, Deliveries, Handovers, Supplies, Returns, Bookings in OPERATIONS
and Drivers/Vehicles (WA only) in NETWORK; Rider/Line-haul trees are
OVERVIEW + OPERATIONS (COD for riders) only — groups they don't have simply
don't render; Vendor: OPERATIONS = Bookings/New booking, WORK MGMT =
Incidents/Tickets, FINANCE = Billing, MANAGEMENT = Reports/Profile;
Customer: OVERVIEW + OPERATIONS (track/bookings) + WORK MGMT (tickets);
Support: WORK MGMT leads (Tickets, Incidents, Tasks). Permission gates are
untouched everywhere — the bucketing is a display property added to the
registry item, and items a role cannot open never render (study A4).

## 7. Component specifications

### 7.1 ApplicationSidebar
248/72px, background `sidebar` #172F2B. Top: brand mark + wordmark (§2.6).
Groups in §6 order with group labels (#8FA89D, 11.5px uppercase). Item:
36px row, 14px/500, icon 18px + label, text #C3D4CB; hover = white text on
white/6% wash; **active = white text on `primary-dark` fill + 3px accent
(#41B7A4) left indicator bar**. Count badges (e.g. open exceptions) render
as small pills in the status tint of their meaning — counts only where the
registry/dashboard already computes them. Bottom: user card (avatar
initials, name, role) + collapse toggle. Collapsed (72px): icon-only,
tooltip + aria-label per item, group separators as hairlines. Focus: §2.5
dark-surface ring. Mobile: slide-over with scrim, same content.

### 7.2 ApplicationHeader (60px, white, bottom border)
Left: sidebar toggle + BreadcrumbNavigation (ink-2 separators, current page
ink/600). Centre-left: the command-menu trigger styled as a search field
("Search or jump to…  Ctrl K") — opens §8; on narrow screens it collapses
to a search icon button. Right: quick-create menu (permission-filtered,
same source as the registry's `quickAction` items), warehouse selector
(admin trees, unchanged behaviour), notification bell with count badge
(Failed tint when the count includes critical, else primary), profile menu
(name, role, sign out — existing items only). Nothing new is wired; every
control maps to an existing action.

### 7.3 Buttons
- **Primary:** `primary` bg, white label, radius 12, 14px/550, padding
  10×16 (40px height); hover `primary-dark`; one per view (page action bar
  or card) — never a row of primaries (audit G2).
- **Secondary:** white bg, `border-control` border, ink label; hover =
  surface-2 bg.
- **Ghost:** transparent, ink-2 label; hover surface-2, ink label.
- **Danger:** Failed text on Failed tint for destructive-adjacent; solid
  #B42318 + white only inside confirmation dialogs for the final commit.
- Icon buttons: 36px desktop hit area (44px field), icon 18px, mandatory
  aria-label matching the visible tooltip (WCAG 2.5.3). Disabled = 45%
  opacity + `aria-disabled`, never colour-only.

### 7.4 PageHeader + PageActionBar
PageHeader: optional eyebrow (role/context, ink-2 12.5px uppercase),
page-title, one-line description (ink-2), right-aligned action group
(primary + up to two secondary; overflow into a "More" menu). PageActionBar:
the sticky bar under the header on work pages — filters left, view toggles
centre, bulk actions appear on selection with the count stated (§7.6).

### 7.5 StatCard
Anatomy (brief §5 + study B2/B3/B5): top row = label (12.5px uppercase
ink-2) + **icon container** (32px rounded-8, tint background, 18px icon);
value (kpi-value 30px, tabular); context line (meta, ink-2) stating the
window in words ("Today", "Last 30 days", "vs yesterday −3"); optional
TrendIndicator and optional sparkline (§7.12 rules). **Icon tint rule:**
the container tint is the *status tint of the metric's meaning* or
primary-light for neutral operational metrics — Success tint for delivered/
healthy, Pending for waiting/ageing, Failed for exceptions/failures, Info
for in-motion, Neutral otherwise. No per-card hues, no rainbow (brief
forbidden list). Whole card is a link when a filtered list exists (KPI
click → filtered list, brief §5) with hover border `primary` + focus ring;
cards without a real destination are not links and don't pretend.
States: skeleton (card-shaped), genuine zero (calm, normal styling),
no-data ("No records in this period" in context line), error (Failed-tinted
context line + retry) — four distinct renderings.

### 7.6 DataTable + DataTableToolbar
Header row: surface-2 bg, 12px/600 uppercase ink-2 labels, sort indicators
as icons + text (never colour-only). Rows: **44px comfortable / 40px
compact** (user toggle, persisted), hairline `border` dividers, hover
surface-2 wash, selected row primary-light wash + left indicator. Text
left, numbers right in tabular figures, IDs in mono nowrap. First column =
human-readable identifier (order number, tracking ID, name). Toolbar:
search field, FilterBar (chips with visible active state + "Clear all"),
density toggle, column visibility menu (not drag-only), export where the
page already offers it. Row actions: ≤2 labelled inline + labelled overflow
menu, ≥24px hit areas (32 preferred), never hover-only. Bulk: checkbox
column + action bar stating the selected count; money/custody bulk actions
confirm with the count (WCAG 3.3.4). Detail opens in DetailDrawer (§7.8),
not a modal. Sticky header with scroll-margin (WCAG 2.4.11). Pagination
keeps the existing server behaviour; result counts are live-region
announced (WCAG 4.1.3).

### 7.7 FilterBar / SearchBar / DateRangePicker
Filter chips: surface-2 fill, ink label; active chip = primary-light fill +
primary-dark label + check icon. DateRangePicker presents the existing
ranges the dashboards already compute (Today / Last 7 / Last 30 / Custom)
— no new query semantics. SearchBar debounces into the page's existing
search parameter. All filters state visibly when active (study C3).

### 7.8 DetailDrawer + ConfirmationDialog
Drawer: right slide-over, 480px (640 for finance detail), white, pop
shadow, header with title + StatusBadge + close; body sections mirror the
detail pages' anatomy; footer action bar sticky. The underlying list stays
visible and scrollable (study C1). Dialog: centred, radius 16, reserved
for confirmations and short forms; destructive/financial confirmations
state the affected records and count, require the explicit commit button
(danger style), and are reversible where the backend already supports
reversal — the dialog never becomes the only path (WCAG 2.5.7/3.3.4).

### 7.9 Forms and feedback
Persistent visible labels (never placeholder-as-label); format hints before
entry ("10-digit mobile", "NPR"); errors as text naming the field + the
known correction, `aria-describedby`/`aria-invalid`, summary at top linking
to fields on long forms (WCAG 3.3.1/3.3.3). Multi-step flows carry data
forward (3.3.7). Toasts are live-region status messages (4.1.3) with the
same text visible; success = Success tint + check icon, failure = Failed
tint + icon + what to do next. EmptyState: icon (Neutral tint container),
one-line honest description, and the page's real primary action when one
exists. LoadingSkeleton mirrors the final layout (never a centred spinner
on dashboards). ErrorState states what failed and offers retry.

### 7.10 PackageTimeline (customer tracking + package detail)
Vertical timeline: completed steps = Success-tone filled circle with check
icon + ink label + timestamp; current step = primary filled circle with a
subtle pulse ring + semibold label; future steps = Neutral outline circle
+ ink-2 label. Connector line: Success for completed segments, `border`
for future. This replaces the audited all-grey dot column where progress
didn't read as progress. Labels come from the existing public-tracking
event vocabulary; expected-delivery shows **only** when the data carries
it (brief §12; no invented ETA).

### 7.11 LiveMap + LiveMovementPanel + LocationFreshnessIndicator
Leaflet/OSM unchanged (existing implementation, polling, and APIs).
Layout: filter chip row (existing filters) → split view: movement list
(left, 360px, collapsible per study A5) + map (right, fluid). Legend is
always visible (marker = driver state, with text labels). Markers use the
status tones + shape coding; the selected list row and its marker highlight
each other (study E1); "Fit active drivers" / "Fit selection" controls
remain first-class. Marker popup and list rows show driver, vehicle, trip,
package count, and **LocationFreshnessIndicator**: "Updated 40s ago" text
with tone by the backend's existing freshness states (fresh = Success,
delayed = Pending, stale = Failed, offline = Neutral + "last seen …"). No invented routes,
movement animation, or ETAs. Mobile: List/Map toggle (existing), map
height 60vh, list cards at field density.

### 7.12 Charts — decision: hand-rolled SVG primitives
**Decision: build three small SVG primitives in-repo — `BarChart`,
`LineChart`, `DistributionBar` — and do not add a chart library.**
Rationale: (1) the needed set is fixed and small (daily bookings bars,
delivery completion, status distribution, weekly performance); (2)
Recharts (MIT) would add ≈100KB gzip + d3-scale/shape dependencies to
every dashboard bundle for four chart shapes, and its default styling
fights the token system (tooltips, legends, and colours all need
overriding); (3) hand-rolled SVG gives exact token control, direct labels
instead of legends, and trivially correct accessible alternatives.
Revisit only if interactive analytical charting (brushing, multi-series
exploration) becomes a real requirement.
Rules (study H1/H2): bars encode by length with zero baseline; lines for
time trend; status distribution = a single stacked horizontal
DistributionBar with labelled segments (not a pie/donut); primary series
`primary`, context series neutral greys, status colours only for status
series; every chart has axis titles with units, its time range, direct
labels where feasible, keyboard-reachable tooltips (WCAG 1.4.13), and its
data present as adjacent text/table. Data sources are the existing
reporting/dashboard queries only — the SA/Admin dashboards' current
per-day series are the first consumers. **A chart renders only when its
series has real data; an all-zero series renders the honest empty state,
not a wall of empty bars** (audit G3).

## 8. Command menu (Ctrl+K) — design

**Implementation: cmdk (MIT) composed with the existing Dialog primitive**
(study G1 — the ARIA combobox pattern is the hard part; cmdk is the tested
implementation; ~10KB). Delivered in Step 3 with the shell.

- **Open/close:** Ctrl+K and Cmd+K toggle from anywhere (`preventDefault`
  so the browser binding doesn't also fire); the header trigger (§7.2)
  opens it by click; Escape closes and returns focus to the trigger; focus
  is trapped while open.
- **Data sources (existing only):** (1) *Navigate* — the actor's registry
  items (already permission-gated by construction); (2) *Actions* — the
  registry's quick-action items + page actions the actor holds; (3)
  *Records* — the existing header-search services generalised: packages by
  tracking ID, orders by number, vendors, customers, warehouses, drivers —
  each group served by the search endpoints the current GlobalSearch
  already calls, extended per entity only where an endpoint exists.
- **Permission rule (non-negotiable):** filtering happens **server-side**
  for record search; unauthorised pages/actions/records are never returned
  and never rendered (not even disabled); executing an action re-checks
  the same permission as its button path and passes through the same
  confirmation step. The palette is an alternate route, never a bypass.
- **Behaviour:** typing filters instantly (local groups) and debounces
  record search (server); groups (Navigate / Actions / Packages / Orders /
  People / Places) hide when empty; empty query shows the actor's recent
  selections (per-user, stored client-side, cleared on sign-out); each row
  = icon (same icon as nav — WCAG 3.2.4) + human label + secondary
  disambiguator in ink-2 (route, status, town) + shortcut hint where one
  exists; ↑/↓ move the highlight with `aria-activedescendant`, Enter runs,
  mouse parity for every row; designed no-results state ("No matches for
  'x'") and a loading row for record search; result counts announced via
  live region.
- **Anatomy:** centred panel, 640px max, radius 16, pop shadow, white;
  input row with search icon + Esc hint; list max-height 60vh. On mobile
  it is a full-screen sheet.

## 9. Responsive rules and field rules

Breakpoints (brief §18): **1440+** full shell, KPI row 6-up where specced;
**1366** (Meena's effective laptop class) KPI row wraps 3+3, Live Ops list
320px; **768** sidebar → slide-over, KPI 2-up, tables keep horizontal
scroll *inside the table region only* (tables are the WCAG 1.4.10
exception; the page itself never scrolls horizontally); **390 / 360**
single column, KPI 1-up (2-up for compact stat pairs), header collapses to
toggle + title + bell + palette icon.

**No-horizontal-overflow contract:** at every breakpoint, `document`
scrollWidth ≤ viewport width outside designated table scroll regions;
verified by screenshot pass at all five widths in Step 10. Long IDs,
addresses, and account strings truncate with ellipsis + full value in the
drawer — they never stretch the page (audit G4).

**Field rules (rider, line-haul, warehouse floor — study F2):** touch
targets ≥48px with no adjacent destructive actions; primary action
anchored at the bottom of the viewport (thumb zone); job-card essentials
(recipient, address, COD) at ≥16px with AAA-target contrast (ink on card =
15.39 ✓); driver navigation limited to the role's 3–5 destinations;
scan-first flows (camera fills codes, typing is the fallback); desktop
density toggles do not exist on field surfaces. Offline/sync states, where
the client already queues work, are labelled honestly ("Captured —
awaiting sync" + capture time) — V3 adds no offline promises (study F3).

## 10. Component plan — brief §16 mapped to existing primitives

Steps refer to the brief §21 implementation order. "Extend" = the V2
primitive in `src/components/ui/` (or the layout/tracking components)
evolves; "New" = built in that step. No component is built twice.

| Brief §16 component | Disposition | Delivered |
|---|---|---|
| ApplicationSidebar | Extend ShellFrame sidebar | Step 3 |
| ApplicationHeader | Extend ShellFrame header | Step 3 |
| BreadcrumbNavigation | Extend existing breadcrumb | Step 3 |
| PageHeader | Extend existing page headers into one component | Step 3 |
| PageActionBar | New (from existing filter/action rows) | Step 3 |
| StatCard | Extend existing stat cards | Step 3 (spec), Steps 4–8 (per-dashboard adoption) |
| TrendIndicator | New (inside StatCard) | Step 4 |
| StatusBadge | Extend (icon + label dictionary + densities) | Step 3 |
| PriorityBadge | New (split from status per study D) | Step 3 |
| QuickActionMenu | Extend header quick actions | Step 3 |
| RecentActivityList | Extend existing activity lists | Step 4 |
| ActivityTimeline | Extend (audit/activity surfaces) | Step 9 |
| DataTable | Extend existing DataTable | Step 3 (spec), Step 9 (full polish) |
| DataTableToolbar | Extend DataTable | Step 3 |
| SearchBar | Extend GlobalSearch field styling | Step 3 |
| FilterBar | Extend existing filter rows | Step 3 |
| DateRangePicker | Extend existing range controls | Step 4 |
| EmptyState / LoadingSkeleton / ErrorState | Extend existing states | Step 3 |
| ConfirmationDialog | Extend Dialog | Step 3 |
| DetailDrawer | Extend Drawer | Step 3 |
| PackageTimeline | Extend public-tracking timeline | Step 7 |
| PackageSummaryCard | New (from booking-detail sections) | Step 9 |
| DriverSummaryCard | New (from drivers pages) | Step 9 |
| WarehouseSummaryCard | New (from warehouses pages) | Step 9 |
| TransferSummaryCard | New (from transfer detail) | Step 9 |
| FinancialSummary | New (from finance dashboard rows) | Step 8 |
| LiveMap | Extend V2 Phase 5 map component | Step 9 (visual pass) |
| LiveDriverMarker | Extend V2 markers | Step 9 |
| LiveMovementPanel | Extend V2 panel | Step 9 |
| LocationFreshnessIndicator | Extend V2 freshness rendering | Step 6 (driver surfaces), Step 9 (ops) |
| CommandMenu (brief §4) | New, on cmdk | Step 3 |
| BarChart / LineChart / DistributionBar | New SVG primitives (§7.12) | Step 4 |

## 11. Decisions and open items for Meena (before Step 3)

1. **Font:** Inter is specified (§3). Geist is the one-line alternative —
   decide before Step 3; after tokens land, swapping is a breaking change.
2. **Nav gaps (§6):** Packages / Inventory / Transfers / Assignments /
   Payments / COD have no Admin/SA-tree routes today. V3 maps around them
   honestly; creating those pages would be new features (backend exists
   for some via other trees) — out of V3's UI-only scope unless Meena
   explicitly expands it.
3. **"Orders" label:** the brief says Orders; the product's word today is
   Bookings (routes, copy, tests). This system keeps the label **Bookings**
   in nav (grouped under OPERATIONS) to avoid a product-wide rename —
   flagging it as a deviation from the brief's wording, taken for
   consistency (WCAG 3.2.4). Meena can overrule; it is a label-only change.
4. **cmdk dependency:** one small MIT package for the command menu (§8) —
   the only new runtime dependency V3 proposes. (Fontsource Inter is a
   build-time asset package, also MIT/OFL.)
5. **Logo:** none exists (audit §4). The text+mark treatment (§2.6) is
   specified; if a real logo is supplied later it drops into the same slot.

*Consistency: palette, scale, and status language match
docs/ui-design-study.md (verdicts A1–I2) and the audit's gap list
(docs/ui-current-state-audit.md §5) item-for-item; where the brief and the
frozen backend disagree (expected-arrival/ETA, §6 gaps), the backend and
the no-fake-data rule win, and the disagreement is recorded rather than
designed over.*
