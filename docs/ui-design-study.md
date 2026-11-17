# BLA V3 — Internet Design Study

**Step 1 of the V3 "Teal & Graphite" redesign (research only — no code).**
Method: three parallel research passes over primary sources — (1) the brief's named
references (Linear, Vercel Geist, shadcn/ui), (2) shipped logistics/fleet/warehouse
operations products and their design write-ups, (3) WCAG 2.2, NN/g complex-application
research, the cmdk command-palette pattern, and chart-perception literature.
Full working papers: goal workspace `hidden_files/research/study-refs.md`,
`study-logistics.md`, `study-a11y-patterns.md`. This document is the synthesis:
each pattern states its source, what it is, and an **ADOPT / ADAPT / REJECT**
verdict for BLA with the reason. Principles only — no branding, copy, or assets
were copied from any source.

Binding constraints applied to every verdict: the brief's Teal & Graphite palette;
UI-only scope (frozen backend, permissions, lifecycle); no fake data, trends, or
ETAs; Leaflet/OpenStreetMap only; WCAG 2.2 AA; statuses always icon + label,
never colour alone; riders work outdoors on phones.

---

## A. Shell, navigation, and visual foundation

### A1. Neutrals first; the brand colour is spent only on meaning
- **Source:** Linear design refresh; Vercel Geist colour system.
- **What:** Both systems build the interface almost entirely from a neutral ramp
  and let the brand hue appear only where it carries meaning — primary action,
  active state, focus, links. Geist organises each colour family as numbered
  "steps" with assigned jobs (backgrounds → borders → solid fills → text), so a
  token's job is fixed, not improvised per screen.
- **Verdict: ADOPT.** This is exactly the brief's intent: graphite-teal neutrals
  carry the UI; teal `#0F766E` is reserved for the primary action, the active nav
  state, focus, and links. The design system (docs/ui-design-system.md) assigns
  every V3 token a fixed job in Geist's step style. The current UI fails this in
  reverse — blue is spent on every button, so nothing reads as primary.

### A2. Strong dark shell, quiet content
- **Source:** Linear (dark sidebar shell); Samsara's redesigned platform
  (vertical nav grouped by responsibility); NN/g-reviewed reading research
  (Piepenbrock et al.) as summarised in dashboard-design surveys.
- **What:** A visually strong navigation shell anchors wayfinding while content
  stays light and quiet. The reading research is decisive for the split: dark
  text on light background (positive polarity) outperforms dark mode on visual
  acuity and proofreading, and the advantage *grows as type gets smaller* —
  precisely the dense 13–14px table condition of an operations tool used in
  bright offices and warehouses, with paper printouts still in the workflow.
- **Verdict: ADOPT the brief's split** — dark sidebar `#172F2B`, light content
  `#F1F4F2`/white. **REJECT full-dark themes and dark-mode toggles** for V3: a
  naive inversion taxes small-type readability, prints badly, and the brief
  forbids it. A future night-dispatch wallboard would be a separate view
  designed dark from scratch, not a toggle.

### A3. One border system; shadow only for floating layers
- **Source:** Linear/Geist/shadcn component anatomy.
- **What:** Cards and panels are delineated by 1px borders on flat surfaces;
  shadows are reserved for elements that genuinely float (menus, dialogs,
  drawers, the command palette). Radii are a small closed set.
- **Verdict: ADOPT.** Matches the brief (no heavy shadows, no glass/blur). V3
  keeps the V2 "cards rest on borders" rule, strengthens the border token's
  *jobs* (see C3 in the design system: decorative dividers vs control-identifying
  boundaries are different tokens), and uses one pop shadow for floating layers.

### A4. Navigation renders only what the role can reach
- **Source:** Motive (permission-shaped nav); Samsara (nav grouped by
  responsibility, not data object); WCAG 3.2.3/3.2.4 (consistent navigation and
  identification).
- **What:** Unauthorised items are *absent*, never greyed out; groups are named
  for the work (the brief's OVERVIEW / OPERATIONS / NETWORK / WORK MANAGEMENT /
  FINANCE / MANAGEMENT), and the same function keeps the same name and icon in
  every role.
- **Verdict: ADOPT.** BLA's registry already permission-gates every item; V3
  finishes the job visually — re-bucketed group names, hidden (not disabled)
  items, empty groups omitted. Greyed-out nav is rejected: it advertises
  functions the user cannot have and invites misuse.

### A5. Collapsible chrome
- **Source:** Samsara platform redesign; Linear's Cmd+B sidebar toggle.
- **What:** Users collapse the sidebar (and, on Live Operations, the queue
  panel) to give the work surface — especially the map — near-full width, and
  restore it to triage. Preference persists per user.
- **Verdict: ADOPT.** Brief already specifies 248/72px sidebar states; V3 adds
  the queue-panel collapse on Live Operations and keeps a slim exception strip
  visible even in map-max mode so collapsing never hides a critical alert.

## B. Dashboards and KPI cards

### B1. Exception-first composition
- **Source:** Intugine control-tower guidance ("put the exception summary front
  and centre — not the total shipment count, not the map"); project44 Movement
  (exceptions prioritised by impact, each with why/who/what-next); NN/g
  dashboard research (a dashboard imparts at-a-glance information to act on,
  fast; operational vs analytical dashboards are different jobs).
- **What:** The first screenful answers *what is stuck and needs me*, sorted by
  severity/time-to-breach, before totals or maps. Every metric must pass: "if
  this number doesn't change what the team does, remove it."
- **Verdict: ADOPT.** This becomes the composition law for all 10 role
  dashboards: needs-attention first, then the role's KPI row, then the work
  area, then activity. It also satisfies BLA's honesty rule — an exception is a
  recorded state with an owner, not a decorative alert count. (V2's dashboards
  already carry needs-attention data; V3 gives it visual primacy instead of a
  pale strip among equals.)

### B2. KPI card anatomy: value + comparison + explicit window + drill-through
- **Source:** SaaS KPI-card pattern survey (Stripe/Vercel/Linear/PostHog/
  Datadog as shipped); Fleetio widgets (value with week-over-week change);
  Motive (click a KPI → the detail page pre-filtered to that metric and range).
- **What:** Label (muted) → hero value (large, tabular) → delta against a
  *named* prior period → context line stating the window in words ("vs
  yesterday") → optional target. Clicking lands on the filtered list, never a
  generic page. Loading, genuine-zero, no-data, and error are four visually
  distinct states.
- **Verdict: ADOPT with BLA's honesty constraint.** The brief mandates trend
  indicators only when a real historical comparison exists. Where no honest
  baseline exists, the card shows the value plus a breakdown line ("12 assigned
  · 8 out · 3 delivered") instead of a delta — never an invented one. Delta
  colour follows the metric's *good direction* (B3), and every KPI click
  drills to the filtered list (already a brief requirement).

### B3. Decouple delta direction from sentiment
- **Source:** SaaS KPI-card patterns.
- **What:** Arrow = which way the number moved; colour = whether that is good
  *for this metric*. Rising exceptions render red-up; falling failed-deliveries
  render green-down.
- **Verdict: ADOPT.** Half of BLA's important metrics are lower-is-better
  (exceptions, COD outstanding, failed attempts). The StatCard contract carries
  `goodDirection: up | down`. Arrow + text remain, so sentiment is never
  colour-only (WCAG 1.4.1).

### B4. Sparklines only when they show the real shape of the same period
- **Source:** Tufte/Few principles via KPI-pattern literature; Stripe/Linear
  canonical cards.
- **What:** A 24–40px axis-less line sharing exactly the card's period, kept
  subordinate to the value. If it needs axes, it belongs in a chart, not a tile.
- **Verdict: ADAPT.** Sparklines appear only where BLA has real time-series at
  that granularity (e.g. bookings per day over the card's window, from the same
  reporting queries the dashboards already run). Rejected on snapshot metrics
  (riders on duty, vehicles in workshop) — a line through three points is fake
  precision and violates the no-fake-data rule.

### B5. Restraint: 4–6 KPIs, one composition per dashboard
- **Source:** Ant Design visualization-page principles (summary → filters →
  details; 5–9 modules; one card, one topic); NN/g (salience by subtraction —
  "removing nonessential elements can be equally or more effective" than adding
  emphasis; no decorative icons on numbers).
- **What:** One page composition repeated across roles: attention strip → KPI
  row (4–6, identical structure) → primary work area → chart only where a real
  series answers a glance question → table/activity.
- **Verdict: ADOPT.** This is the direct cure for the audited failure mode —
  the Super Admin dashboard's eight identical bare-number cards over two
  wall-sized zero-bar panels. Note the tension with the brief's StatCard icon:
  the brief requires an icon in a tinted container; NN/g warns against
  decorative icons on KPI numbers. Resolution: the icon is *functional*
  (identifies the metric family, consistent per metric across roles), small,
  and subordinate — never an illustration.

## C. Tables, queues, and work surfaces

### C1. Design the queue around the work loop; the 20-second test
- **Source:** Dense-admin operator research (HiperFusion); NN/g data-table
  research (four tasks: find, compare, view/edit one, act on records).
- **What:** Find → assess → act → confirm → next, in one screen. The list stays
  stable while a non-modal detail pane/drawer changes. Litmus: an experienced
  operator completes the role's top task in under 20 seconds without another
  system.
- **Verdict: ADOPT** as a V3 acceptance criterion per role (assign a delivery,
  receive a shipment, verify a remittance, resolve an exception). Detail opens
  in a drawer/side panel, not a modal that covers the records being referenced
  (NN/g explicitly warns against modal editing over tables).

### C2. Exception-queue anatomy
- **Source:** Warehouse exception-management practice (Optichain; KSN
  Warehouse Tower — "problems get owners instead of rumors").
- **What:** Each row: entity + commitment, current state + when it entered it,
  time remaining to cutoff/promise, reason in plain language, named owner of
  the next action, next action + due time, last activity. Sort defaults to
  time-to-breach, not age alone and never a bare count.
- **Verdict: ADOPT** as the spec for BLA's incident/exception lists. Where the
  backend has no explicit "owner of next action" field, the row shows the
  recorded assignee/responsible role from the existing record — and if none
  exists, "Unassigned" in the Pending tone; the field is never silently
  dropped and never invented.

### C3. Density via hairlines, tabular numerals, progressive disclosure
- **Source:** Stripe/Linear/Ramp/Mercury table practice; NN/g table tasks.
- **What:** 40–44px rows; numbers right-aligned in tabular figures; hierarchy
  from type and whitespace, not cards-in-cards; only the 6–12 decision fields
  are columns — the rest live in the detail drawer; frozen header row on long
  tables; filters visibly active; column hide/reorder available without
  drag-only interaction.
- **Verdict: ADOPT.** Becomes the V3 DataTable spec (comfortable 44px /
  compact 40px, user-toggleable). Current BLA tables are honest but sparse —
  6 rows floating in a void; density + grouping (by status/assignee where the
  role works that way) is the fix, not smaller type.

### C4. Bulk actions with a dry-run summary
- **Source:** Onfleet Table View (selection + bulk bar); HiperFusion safe
  bulk-ops; WCAG 3.3.4 (error prevention for financial/data submissions).
- **What:** Checkbox + range selection; a bulk bar appears on selection
  stating the affected count; money/custody-affecting bulk changes require an
  explicit confirmation showing the count.
- **Verdict: ADOPT where the backend already supports the bulk operation** —
  V3 invents no bulk endpoints; where only single-record services exist, the
  UI keeps single-record actions (1–2 labelled inline + a labelled overflow
  menu, ≥24px hit areas, never hover-only, never icon-only crowds).

## D. Status systems

### D1. Small, closed, lifecycle-ordered status sets; split orthogonal dimensions
- **Source:** Upper Route Planner (exactly five route statuses, fixed order);
  ANTE (one main status + independent Delivery and Payment chips).
- **What:** One main lifecycle status per entity (aim ≤6 states); dimensions
  that move independently (delivery vs payment vs condition) get separate
  chips instead of a merged mega-status.
- **Verdict: ADOPT — and BLA already complies structurally.** The frozen
  backend's five status domains (operational / condition / payment / delivery
  / exception + generic) in `src/lib/status/status-tones.ts` are exactly this
  pattern. V3 changes only the *rendering*: tones map 1:1 onto the brief's five
  statuses, and detail pages present the domains as separate labelled chips
  (the audited package detail already shows four domains — V3 makes them
  labelled, consistently ordered, and legible instead of four anonymous pastel
  pills).

### D2. Status = icon + word, same word everywhere
- **Source:** NAGANO design system ("status color always comes with an icon
  and a word"; one tone per status system-wide); Samsara map icon states;
  WCAG 1.4.1.
- **What:** The badge component takes a status value and renders dot/icon +
  label; it *cannot* render colour-only. One glossary: the same state has the
  same word in every role and surface.
- **Verdict: ADOPT.** Two concrete upgrades over V2: (1) an icon joins the
  existing label; (2) a **friendly-label dictionary** replaces today's raw
  enum rendering (`statusLabel()` uppercases `RECEIVED_AT_DESTINATION` onto
  the screen — visible in the audited transfer detail). Labels are a UI-layer
  dictionary over frozen enum values; no status logic changes. In dense
  tables the badge compacts to dot + label; in detail headers and rider cards
  it renders the full pill — same status, two densities, one glossary.

## E. Maps and Live Operations

### E1. List and map are one selection model
- **Source:** Onfleet (tasks as pins, Zoom-to-Fit on selection, one filter set
  governing map and table); Samsara Fleet Overview; Geotab.
- **What:** Selecting in the list highlights the marker and vice versa;
  filters are shared state; "fit to selection" is a first-class control.
- **Verdict: ADOPT** as the Live Operations contract on the existing
  Leaflet/OSM implementation. Separate map/list views with independent
  filters are rejected — the first count disagreement destroys trust. (V2
  already shares filters; V3 adds the bidirectional highlight and fit-to-
  selection behaviour within the existing data flow.)

### E2. Freshness is a first-class visual state
- **Source:** Verizon Connect Reveal (marker popup shows status, time in
  status, last update); Navistream (icons visibly age when updates stop);
  Geotab refresh cadence.
- **What:** Every marker popup and driver row shows "last updated … ago" in
  text; stale/offline states are labelled, with thresholds.
- **Verdict: ADOPT — it is already BLA's V2 honesty design** (freshness states
  exist in the tracking backend). V3's job is purely presentational: the
  existing freshness states get the brief's tone treatment + text labels on
  markers, rows, and popups. Never animate a marker as live when its fix is
  old; no invented movement or ETAs — **project44/Intugine-style predictive
  ETAs are REJECTED** (no model or data exists; presenting them would violate
  the no-fake-data rule).

### E3. Clustering with count badges — tuned to BLA's scale
- **Source:** Samsara (clusters with total count); Geotab (auto-cluster at
  500+).
- **Verdict: ADAPT.** Kathmandu density can overlap pins well below 500;
  cluster at ~30–50 markers in viewport with a numeric badge, zoom to expand,
  legend always visible. Heatmaps rejected for V3 — no role decision needs
  one.

## F. Mobile field work (rider / line-haul / warehouse floor)

### F1. One next job; POD as one linear, scan-first flow
- **Source:** Onfleet driver app; Bringg (gated POD captures); POD UX practice
  (Circuit/Spoke); taps-per-stop economics (~3s × 100 stops is a shift cost).
- **What:** Jobs in completion order, one dominant "next" card (address,
  recipient, window, notes, COD large). Completion is one sequence —
  scan → photo → signature/payment as required — defaulting to the common
  outcome, no intermediate dialogs. Exception actions sit one tap away with
  equally fast capture (a painful exception path is where data quality dies).
- **Verdict: ADOPT** within the existing flows: V3 re-presents the V2 rider
  panel/jobs (≤3 taps job-card → completed on the happy path; scan primary;
  COD amount large on card and confirmation). No new backend actions.

### F2. Field ergonomics as hard requirements
- **Source:** UPS Zebra handheld usability findings (gloves: 2.4 taps/target
  vs 1.1 bare-handed; 5 of 7 drivers shaded screens outdoors); POD/fleet app
  guidance; WCAG 2.5.5 (44×44 AAA) read together with 2.5.8 (24px AA floor).
- **What:** ≥48px targets for gloved use, primary action anchored in the
  thumb zone, body ≥16px on job cards, contrast targeting AAA (7:1) on
  critical job-card fields — outdoor glare is the routine condition.
- **Verdict: ADOPT** as non-negotiable rider/line-haul specs. The desktop AA
  floor (24px) must never be shrunk into field screens. Validation note: an
  outdoor midday check on a mid-range Android remains a Step-10 task — it
  cannot be verified from the sandbox.

### F3. Offline completion and non-blocking confirmation
- **Source:** Rosistem POD guidance; Bringg; driver-system design write-ups.
- **Verdict: ADAPT — presentation only.** BLA's frozen backend defines what
  sync exists; V3's obligation is honesty in presentation: captured-offline
  work must read as "captured — awaiting sync" with its capture time, never
  as server-confirmed. Where the current client already queues, V3 surfaces
  the queue state quietly; V3 does not promise new offline capability the
  backend doesn't have.

## G. Command menu (Ctrl+K)

### G1. The palette is a product feature, taught in context
- **Source:** Linear/Vercel/Raycast pattern; cmdk (composable combobox on
  Radix Dialog, VoiceOver-tested ARIA); NN/g complex-apps §2 (users satisfice
  — teach accelerators at the moment of the task).
- **What:** Ctrl+K *and* Cmd+K toggle from anywhere (handling only `metaKey`
  breaks Windows); a visible labelled trigger ("Search… Ctrl K") also opens
  it; focus lands in the input; arrows move a virtual highlight while DOM
  focus stays in the input (`aria-activedescendant`); Enter runs via the
  item's select handler; Escape closes (one level if nested) and returns
  focus to the trigger; groups (Navigate / Actions / Records) hide when
  empty; empty-query state shows per-user recents; every row is icon +
  human label + secondary disambiguator + shortcut hint on the right.
- **Verdict: ADOPT, built on cmdk** (MIT, ~10KB, the ARIA combobox pattern is
  the hard part and cmdk is the tested implementation). Hand-rolling the
  combobox is rejected — the accessibility failure modes are subtle and
  numerous. BLA-specific obligations: results are **permission-filtered
  server-side** (client-side hiding of fetched records is not enforcement);
  unauthorised commands are never rendered, not even disabled; executing an
  action re-checks the same permission as the button path and still passes
  through any confirmation step (WCAG 3.3.4) — the palette is an alternate
  route, never a bypass. Record search is server-filtered/debounced (cmdk's
  comfortable client-side scale is ~2–3k items); the command registry stays
  local and instant. V2's existing header search (nav items + tracking
  lookup) is the seed data source; the palette generalises it.

## H. Charts

### H1. Length and position encode quantity; colour never encodes magnitude
- **Source:** NN/g dashboard research (preattentive processing); Cleveland &
  McGill perceptual ranking.
- **Verdict: ADOPT as chart law.** Bars for comparison, lines for trend;
  **pie/donut/gauge/treemap REJECTED** for dashboard use; **3D REJECTED**
  always; bar axes start at zero; categorical bars sorted by value unless a
  natural order exists; direct labels preferred over legends; every chart
  carries axis titles with units (NPR, kg, count, %) and its time range.

### H2. Chart restraint and accessible alternatives
- **Source:** Ant Design (one card one topic, 5–9 modules); NN/g (colour is a
  secondary cue — reinforce with labels/shape; ~8% of men have colour-vision
  deficiency); WCAG 1.4.11 (distinguishing chart elements need 3:1), 1.4.13
  (hover content dismissible/persistent), 2.1.1 (keyboard route to values).
- **Verdict: ADOPT.** Primary series in teal `#0F766E`; context series in
  neutral greys (highlight-and-mute); status colours only when the series
  *is* a status; the pale status tints are text backgrounds, never chart
  fills on white. Every chart's data is also present as the adjacent table/
  text (the dashboards' work tables satisfy this), and tooltips are
  keyboard-reachable. A chart that doesn't change an action doesn't ship.

## I. Accessibility foundations (cross-cutting)

### I1. The six traps the palette must be specced around
- **Source:** WCAG 2.2 (W3C Recommendation) + WebAIM checklist; all ratios
  computed from the brief's hex values (full table in the design system).
1. **Focus colour is context-specific.** Teal on the dark sidebar is
   **2.60:1** — fails the 3:1 non-text minimum. Light surfaces: teal ring
   (5.47:1 on white). Dark sidebar: white/`#F1F4F2` ring (14.21/12.83:1).
   A single global focus colour cannot work (amber passes on dark ~9.3:1,
   fails on light ~1.5:1). Design target: 2px ring meeting 3:1 (WCAG 2.4.13
   is AAA, adopted as BLA's *target*; 2.4.11 "not entirely obscured" is the
   AA conformance floor).
2. **The border token is decorative, not functional.** `#D1DDD7` is
   1.40:1 on white / 1.26:1 on bg — fine for dividers, but inputs/selects
   need a ≥3:1 identifying boundary or equivalent cue in every state
   (1.4.11). The design system therefore splits border tokens by job.
3. **Secondary text is at the floor.** `#52645D` passes (5.68:1 on bg,
   6.29:1 on white); anything lighter — timestamps, placeholders, axis
   labels — fails 4.5:1. There is no lighter grey in V3.
4. **Pending status has almost no headroom** (4.59:1): never at reduced
   opacity, never blended, never on a different background.
5. **24px is a desktop floor, not a field standard** (2.5.8 vs 2.5.5):
   field/phone surfaces are built to 44px+.
6. **Three separate criteria, three separate fixes:** colour-only status
   (1.4.1), colour-only errors (3.3.1 — errors need text naming the field
   *and* the known correction, 3.3.3), visual-only toasts (4.1.3 — status
   messages must be live-region announcements that don't steal focus).

### I2. Complex-app behaviours adopted from NN/g
- Flexible, non-linear pathways (jump booking ↔ customer ↔ trip ↔ payment
  without forced sequences); working-memory offloading (activity trails,
  saved filters, recently viewed); staged disclosure (density for experts is
  not clutter — removing capability to look clean is a failure); consistent
  help in one fixed shell position (WCAG 3.2.6); redundant-entry ban in
  multi-step flows (3.3.7 — carry sender/address/hub forward); authentication
  that allows paste and password managers, including the TOTP step (3.3.8).
- **Verdict: ADOPT** as design-system rules; each maps to existing BLA
  behaviour or presentation, none requires backend change.

## J. Rejected patterns (with reasons)

| Pattern | Source of temptation | Why rejected for BLA |
|---|---|---|
| Full-dark theme / dark-mode toggle | Template galleries, "fleet command" Dribbble shots | Small-type readability loss in bright rooms (A2); prints badly; brief forbids |
| Rainbow KPI cards, per-card hues | SaaS templates | Brief forbids; destroys status-colour meaning; fails salience-by-subtraction (B5) |
| Gradients, glassmorphism, neon, big illustrations | Template galleries | Brief forbids; hostile to glare, print, and AA |
| Predictive ETAs / AI priority scores | project44, Intugine (enterprise) | No model/data exists; presenting them violates no-fake-data (E2) |
| Pie/donut/gauge charts | Generic dashboard kits | Perceptually poor for quantity (H1) |
| Decorative sparklines on snapshot metrics | KPI-card fashion | Fake precision (B4) |
| Colour-only status dots; whole-row priority tinting | Template tables | Fails 1.4.1; destroys status scannability and print (D2) |
| Map and list as separate pages/filters | Legacy GIS tools | Counts diverge; trust loss (E1) |
| Desktop tables shrunk onto rider phones | Responsive shortcut | Fails field ergonomics (F2) |
| Free-form widget customisation (v1) | Fleetio | Roles have known jobs; opinionated per-role defaults first, reorder later if asked |
| Heatmaps on Live Operations | GIS products | No role decision needs density in V3 (E3) |

## K. What the study changes in practice (pointers into the design system)

1. Token jobs are fixed Geist-style (A1) — see design system §2.
2. Border splits into divider vs control-boundary tokens (I1.2) — §2.3.
3. Focus tokens are per-surface (I1.1) — §2.5.
4. StatCard contract gains `goodDirection`, window line, drill-through (B2/B3) — §7.5.
5. DataTable spec: 44/40px densities, drawer detail, bulk-bar rules (C1/C3/C4) — §7.6.
6. Status rendering: icon + friendly label dictionary over the frozen tone
   module (D2) — §4.
7. Live Operations: shared selection model + freshness labels (E1/E2) — §7.11.
8. Field targets 48px / AAA job-card contrast (F2) — §9.
9. Command menu on cmdk with server-side permission filtering (G1) — §8.
10. Charts: hand-rolled SVG primitives under H1/H2 law — §7.12 (decision and
    rationale, including why Recharts was not chosen).

*Research inputs: hidden_files/research/study-refs.md (Linear/Geist/shadcn),
study-logistics.md (Samsara, Onfleet, Motive, Fleetio, Intugine, project44,
Geotab, Verizon Connect, Bringg, KSN, NN/g-adjacent operator literature),
study-a11y-patterns.md (WCAG 2.2, WebAIM, NN/g, Ant Design, cmdk). All
contrast ratios were computed from the WCAG relative-luminance formula and
cross-checked between two independent passes.*
