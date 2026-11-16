# BLA — UI/UX Guidelines (V2 Phase 1 Design System)

**Status:** Durable reference from V2 Phase 1. Later phases follow this document; deviations need a deliberate update here, not a local improvisation.
**Token source of truth:** `src/app/globals.css`. If a value in this document and a value in `globals.css` disagree, `globals.css` wins and this document is corrected.
**Context:** The Phase 0 audit (`docs/current-implementation-audit.md` §3, defect H-1) found no navigation system in any dashboard — a header-only shell, modules reachable only via scattered in-page links. The shell, registry, and shared primitives below are the fix.

---

## 1. Principles

- **Calm, minimal, professional.** Linear / Geist / shadcn-inspired — studied, not copied. Flat surfaces, 1px borders, small radii, restrained shadows. No decoration that does not carry information.
- **Dashboards answer in this order:**
  1. What needs attention
  2. What is happening now
  3. What to do next
  4. What recently changed
- **4–6 high-value metrics max per dashboard.** No KPI walls. If a number does not change a decision, it does not go on the home screen.
- **Actions live on the work, not in the navigation.** Contextual actions sit on the work queues themselves — a receiving queue carries its own *Continue receiving* action. Navigation is the secondary discovery path, never the only way to do the next step of a job already in front of the user.
- **Urgency is never visually quiet.** Critical feedback — a failed scan, a rejected OTP, a blocked action — is unmistakable and persistent. It stays on screen until resolved or explicitly dismissed by the user. It is never a vanishing toast.
- **No placeholder buttons. No fake success states.** Every control does what it says, or it is not rendered. A success message means the operation actually succeeded.

## 2. Design tokens

All tokens are defined in `src/app/globals.css` (`@theme`). Use the token names (Tailwind utilities generated from them), never raw hex values in components.

### Surfaces and text

| Token | Value | Use |
|---|---|---|
| `page` | `#f5f7fa` | Page background |
| `surface` | `#ffffff` | Cards, panels, tables, dialogs |
| `cream` | `#f1f5f9` | Neutral tint background; inactive / not-started fills |
| `ink` | `#0f172a` | Primary text, headings |
| `slate2` | `#64748b` | Secondary text, metadata |
| `faint` | `#94a3b8` | Tertiary metadata, placeholders — never statuses or actions |

### Accent and semantics

| Token | Value | Token | Value | Use |
|---|---|---|---|---|
| `brand` | `#2563eb` | `accentbg` | `#eff6ff` | The **one** accent: primary actions, links, active navigation, info tone |
| `green` | `#16a34a` | `greenbg` | `#e8f7ee` | Success |
| `amber` | `#f59e0b` | `amberbg` | `#fdf3e0` | Pending / warning |
| `red` | `#dc2626` | `redbg` | `#fdecec` | Failed / critical |

### Deep text variants

| Token | Value | Pairs with |
|---|---|---|
| `greendeep` | `#15803d` | `greenbg` |
| `amberdeep` | `#9a6206` | `amberbg` |
| `reddeep` | `#b91c1c` | `redbg` |

The bright semantic hues fail contrast at small sizes on their own tint backgrounds. Badge and label **text** on a tint uses the deep variant; the bright hue is for icons, dots, and borders. This is why the deep variants exist — do not delete them as duplicates.

### Structure

| Token | Value | Use |
|---|---|---|
| `line` | `#e6ebf0` | All borders and dividers (1px) |
| `radius-sm` | `2px` | Badges, focus outline, small controls |
| `radius-md` | `3px` | Inputs, buttons |
| `radius-lg` | `4px` | Cards |
| `radius-xl` | `8px` | Dialogs, drawers, large overlays |
| `shadow-card` | `0 1px 2px rgb(15 23 42 / 0.04)` | Restrained card lift only; cards rest primarily on their `line` border |
| `shadow-pop` | `0 8px 28px rgb(15 23 42 / 0.14), 0 2px 6px rgb(15 23 42 / 0.08)` | Overlays only: dialogs, drawers, menus, popovers |
| Font stack | `ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif` | Everything; no webfont loading |
| `.tnum` | `font-variant-numeric: tabular-nums` | Money, counts, and any column of numbers that must align |

### Hard rules

- **Purple and orange are legacy-only.** `purple` `#7c3aed` / `purplebg` `#f1e9fd` and `orange` `#ea580c` / `orangebg` `#fff1e6` are retained in `globals.css` because existing screens reference them. They are **forbidden in new work** and are removed when the screens using them are rebuilt.
- **No gradients anywhere.**
- **Colour is used only for meaning:** green = success, amber = pending/warning, red = failed/critical, gray/cream = inactive, `brand` = primary actions, links, and active navigation. Never colour for decoration or to distinguish arbitrary categories.

## 3. Typography & density

| Element | Style |
|---|---|
| Page title | 22px, bold, `ink`, with an 11px uppercase eyebrow above it (section / role context) |
| Section title | 15px, semibold, `ink` |
| Body | 13px, `ink`; metadata in `slate2` / `faint` |

Density rules:

- **Operations screens stay dense:** 13px table rows, `px-3 py-2` cells. Staff scan hundreds of rows; minimalism never buys whitespace at the cost of scan speed.
- Whitespace is spent on grouping and hierarchy, not on inflating row height.
- Muted text (`slate2`, `faint`) is for metadata only — **never for statuses or actions**. A status or a clickable action rendered faint is a bug.
- Numbers use `.tnum` so columns of counts and amounts align while scanning.

## 4. The shell

One shared shell serves all 10 role dashboards: `src/components/layout/DashboardShell.tsx` + `ShellFrame`.

- **Sidebar:** collapsible — 240px expanded, 68px icon mode with tooltips when collapsed.
- **Mobile:** below `lg` the sidebar becomes a drawer.
- **Top bar:** breadcrumbs, global search, quick actions, warehouse context, notifications bell, profile menu.

### Navigation rules

- **One registry:** `src/lib/navigation/registry.ts`. Every navigation item declares its route, label, icon, group, and permission gate. There is no second source of navigation anywhere (no per-page link lists as a substitute).
- **Groups:** Workspace / Operations / Business / Administration.
- **Permission filtering:** items the actor's permissions do not cover are **hidden entirely — never greyed out**. A greyed item advertises a route the user cannot use and invites support questions.
- **Active item:** the registry item with the **longest href that prefixes the current route** is active. The home item is active on **exact match only** (otherwise it would be active everywhere).
- **New pages must register in the registry in the same change.** An unregistered page is an unreachable page — this is exactly audit defect H-1, and it is not repeated.
- **Nav visibility is UX only, never a security boundary.** Hiding an item does not protect its route; every route and service enforces its own permission and scope checks server-side, as before.

### Top-bar elements

- **Quick actions:** compact `brand` buttons in the top bar, permission-filtered like nav items, only for create/receive flows **whose routes already exist**. No quick action may point at a planned route.
- **Global search:** searches the actor's *visible* navigation (same permission filter as the sidebar) plus package tracking, which opens public tracking. It does not search across data the actor cannot already reach.
- **Warehouse selector:** sets a **requested scope only**. The server validates that scope against the actor's memberships on every request. Selecting a warehouse in the UI never authorises anything.

## 5. Components inventory

Build new screens from these shared primitives. Do not create a local badge, table, or dialog variant — that is how the pre-V2 codebase grew five divergent badges (audit defect M-11).

| Primitive | Path | Intended use |
|---|---|---|
| `StatusBadge` | `src/components/ui/StatusBadge.tsx` + tone map `src/lib/status/status-tones.ts` | The **only** badge. Takes a status domain + value, renders the tone from §6. No screen defines its own badge colours. |
| `DataTable` | `src/components/ui/` | Server-driven search / sort / pagination; filter and date-range slots; column visibility; built-in empty state. Lists do not hand-roll table behaviour. |
| `Dialog` | `src/components/ui/` | Modal confirmations and focused tasks; `shadow-pop`, `radius-xl`. |
| `Drawer` | `src/components/ui/` | Detail panels that keep the underlying list in context (e.g. package detail over a queue). |
| Form primitives | `src/components/ui/` — `Field`, `TextInput`, `TextArea`, `Select` | Label + control + inline error, wired with `aria-describedby` so the error is announced and associated with the field. |
| `Skeleton` / `SkeletonRows` | `src/components/ui/` | Loading states for panels and tables (§8). |
| `EmptyState` | `src/components/ui/` | Zero-data states: what would appear here + the permitted next action. |
| `ErrorState` | `src/components/ui/` | Recoverable in-panel errors with a retry where one exists. |
| Error boundaries | `error.tsx` per dashboard group | Route-level failure boundary per dashboard group, plus a shared not-found state. A raw framework error page is never an acceptable user-facing outcome (audit defects M-7 / L-3). |

## 6. Status colour semantics

A package carries **five separate status domains** — operational, condition, payment, delivery, exception. They are displayed as **separate badges, each with its domain label**, never collapsed into one badge or one column (audit defect M-11). One domain's state must never be inferred from another's badge.

### Tone table

| Tone | Colour | Meaning | Examples |
|---|---|---|---|
| `success` | green (`greenbg` + `greendeep` text) | Completed / healthy terminal states | Delivered, received, reconciled, paid |
| `warning` | amber (`amberbg` + `amberdeep` text) | Awaiting action, held, attempted | Pending approval, on hold, delivery attempted, awaiting pickup |
| `danger` | red (`redbg` + `reddeep` text) | Failed, cancelled, missing, damaged | Failed delivery, cancelled, missing, damaged, rejected |
| `info` | brand tint (`accentbg` + `brand` text) | In motion | In transit, out for delivery, assigned |
| `neutral` | cream / gray (`cream` + `slate2` text) | Not started, draft, none | Draft, not started, no exception |

The tone for a status value is defined once in `src/lib/status/status-tones.ts` and consumed only through `StatusBadge`. Adding a status value means adding its tone there, in the same change.

**Freshness (for the GPS / Live Operations phases):** any freshness or live-location display must show its **last-update time** alongside the state. Stale data is never styled as live — an old position rendered with live styling is a false claim, worse than showing nothing.

## 7. Accessibility & responsive baseline

- **Visible keyboard focus:** the global `:focus-visible` rule in `globals.css` (2px `brand` outline, offset 1px) applies everywhere. Never remove an outline without an equivalent visible replacement.
- **Icon-only buttons carry an `aria-label`.** No exceptions — sidebar icon mode, bell, and table row actions included.
- **Touch targets:** nav links and shell controls are **≥44px** in height.
- **Contrast:** status colours are used as the deep-variant-on-tint pairs from §2, chosen to pass contrast at badge sizes. Do not substitute the bright hues for text.
- **Breakpoints:**
  - Below `lg` (1024px): sidebar collapses to a drawer.
  - Below `md`: the top-bar search drops to a second row.
  - Tables **scroll horizontally** rather than crushing columns below readable width.
- **Verification:** check every new screen at ~390px (mobile), tablet, and desktop widths before calling it done.

## 8. Feedback rules

- **Success:** confirmations are brief and specific — name what happened ("Booking BK-1042 created"), not a generic "Success". And only after the operation has actually succeeded (§1).
- **Destructive and financial actions:** confirm first, with the **consequence named** in the confirmation ("Void invoice INV-88? This reverses its ledger entries and cannot be undone."). A bare "Are you sure?" is not a confirmation.
- **Form errors are inline at the field** (via the form primitives' `aria-describedby` wiring), not a banner alone. A banner may summarise, but the user must be able to find the failing field from the field itself.
- **Critical operational feedback is persistent** (§1): failed scans, rejected OTPs, and blocked actions stay visible until resolved or explicitly dismissed — never auto-expiring toasts.
- **Loading:** use skeletons (`Skeleton` / `SkeletonRows`) shaped like the content they replace, not spinners over blank space for panels and tables.
- **Empty states:** say what would appear here and offer the permitted next action ("No packages awaiting inspection. New receipts appear here when a transfer arrives."). An empty state with no explanation and no action is a dead end.

---

## Addendum — V2 final state (Phase 8, 2026-11-16)

This document remains the durable Phase 1 design-system reference
and has **not** been rewritten. What changed since it was written:

- **All ten role homes are built** on the shell and navigation
  registry this document specifies (Phase 6 completed the set:
  Super Admin users/settings/audit surfaces, Warehouse Admin fleet
  and booking-create, Finance/Support tasks, Customer
  self-service). Navigation is derived solely from
  `src/lib/navigation/registry.ts` — there is still no second
  hand-maintained menu.
- **Two V2 surfaces follow these rules and extend the examples,
  not the tokens:** the driver Location Tracking Panel (≥48 px
  touch targets; tracking state, last-update time and accuracy
  always visible; a signal problem flips the panel to an
  unmistakable problem state immediately — urgency is never
  visually quiet, §1) and the Live Operations board (freshness is
  always paired with its last-update time; stale/offline markers
  are visually muted and never look live). See
  `docs/live-gps-tracking.md` §§8/10.
- **Verification caveat:** the §7 instruction to check screens at
  ~390 px / tablet / desktop stands. On-device pixel checks at
  390 / 768 / 1440 px for the GPS surfaces are part of the
  pre-production real-device checklist and are **not yet
  verified** — see `docs/known-limitations.md`.
