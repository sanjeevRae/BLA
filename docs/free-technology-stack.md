# Free Technology Stack — BLA Logistics Platform (V2)

**Status:** V2 Phase 8 reference. **Sources:** dependency versions are
read from `package.json` / `package-lock.json` in this repository;
tile obligations are from `src/lib/maps/config.ts` and
`docs/live-gps-tracking.md` §10. **No prices are stated in this
document** — where a component is free, this document says *why* it
is free (open-source licence / usage policy / no per-request fee),
not what a paid alternative would cost.

The design rule for the rebuild was *free-first*: every capability
the platform needs is provided by open-source software or a
no-per-request-fee service, so the running software itself creates
no licence bill and no per-request API fees. What still costs money
is *infrastructure the company must have anyway* (§3) — a place to
run the app, a database, and a domain — not the stack below.

---

## 1. Genuinely free: the application stack

All of the following are open-source projects used under their
licences. There are no licence fees, no seat fees, and no
per-request API fees for any of them.

| Component | Version in repo | Role | Why it costs nothing |
|---|---|---|---|
| Next.js (App Router) | `next` 16.4.6 | The single application: dashboards, public tracking, API Route Handlers | Open source (MIT). Self-hostable with `next build && next start`; no fee to run it. |
| React / React DOM | 19.3.0 | UI rendering | Open source (MIT). |
| TypeScript | `typescript` ^5 | Language / type safety | Open source (Apache-2.0). |
| Tailwind CSS | 4.3.3 | Styling (design tokens in `src/app/globals.css`) | Open source (MIT). |
| Prisma (ORM + Migrate) | `prisma` / `@prisma/client` ^6.19.3 | The only ORM; all data access and migrations | Open source (Apache-2.0). The CLI and client used here need no paid plan. |
| PostgreSQL | via Supabase project (see §3) | The database engine | Open source (PostgreSQL Licence). The *engine* is free; hosting it is infrastructure (§3). |
| Auth.js (NextAuth) | `next-auth` ^5.0.0-beta.32 | Single login, database sessions, credentials provider | Open source (ISC). No per-user / per-login fee. |
| bcryptjs | ^3.0.3 | Password hashing | Open source. |
| Zod | ^4.6.7 | Input validation (one schema shared by forms and server) | Open source (MIT). |
| Leaflet | ^1.9.4 | Live Operations map rendering | Open source (BSD-2-Clause). No API key, no per-map-load fee. |
| react-leaflet | ^5.0.0 | React bindings for Leaflet | Open source. |
| QRCode | `qrcode` ^1.5.4 | Package label QR payloads | Open source. |
| Browser Geolocation API | — (browser built-in) | Driver position fixes (`watchPosition` / `getCurrentPosition`) | Part of every modern browser. No key, no fee. Requires HTTPS and an explicit user permission grant, and is foreground-only (see `docs/live-gps-tracking.md` §1). |
| Vitest + Testing Library | devDependencies | Test suite | Open source; development-only, never deployed. |
| ESLint | devDependencies | Lint gate | Open source; development-only. |

Consequence: **the software bill for the application tier is zero.**
Scaling the number of users, bookings, or GPS pings does not create
a per-unit charge from any component in this table, because none of
them meters usage.

## 2. Free under a usage policy: OpenStreetMap tiles

The Live Operations map displays OpenStreetMap's standard tile
layer. The tile URL and attribution live in exactly one place
(`src/lib/maps/config.ts`):

- Tile endpoint: `https://tile.openstreetmap.org/{z}/{x}/{y}.png`
- Attribution rendered on the map at all times: "© OpenStreetMap
  contributors"

Position, stated precisely:

- **No per-request API fees** apply to this use: OSM's public tiles
  are free **under the OSM tile usage policy** for low-volume use
  such as this pilot.
- The obligations that come with that are real and are treated as
  part of the design, not fine print: attribution always visible;
  **no bulk downloading**, no prefetching, no offline caching of
  tiles (the browser's normal HTTP cache honouring OSM's caching
  headers is the only caching); valid HTTP identification per the
  policy; no heavy or systematic use.
- **Self-hosting tiles is the scale path.** If usage grows beyond a
  low-volume pilot, production must move to self-hosted tiles
  (rendering OSM data on company infrastructure — the data and the
  rendering stack are open) or a contracted tile provider. That
  evaluation is a deployment decision with a trigger point, recorded
  as an open decision in `docs/deployment-guide.md` (Production
  Readiness Checklist). The public service is never silently scaled
  up.
- There are **no road routes and no ETAs** in the product, so no
  routing/geocoding API (and no routing API fees) are involved at
  all. The only line the map draws is a labelled straight-line
  connector, computed locally.

## 3. What needs existing infrastructure (not free software — a place to run it)

These are not stack licences and this document invents no prices
for them. They are the preconditions any deployment of this system
needs, listed so the "free stack" claim is never misread as "free
to operate with nothing":

| Need | How BLA meets it today | Notes |
|---|---|---|
| **A host** to run the Next.js app | Deployment target per `docs/deployment-guide.md` §2 (hosted platform or self-hosted Node behind a reverse proxy) | The app itself is portable: the same build runs on either. Hosting capacity beyond free/staging tiers, if ever needed, is an infrastructure decision for Meena — not a stack fee. |
| **A PostgreSQL database** | The **existing Supabase project** already used by the business; the new schema lives in its dedicated `app` schema beside the untouched legacy `public` schema | No new database product is introduced. Prisma connects via the pooler URL at runtime (`DATABASE_URL`) and a direct/session connection for migrations (`DIRECT_URL`) — variable *names* only; see the deployment guide. |
| **A domain + TLS (HTTPS)** | Production domain pointed at the deployment at cutover (`docs/deployment-guide.md` §6) | **Hard requirement, not a nicety:** browser Geolocation refuses to run on insecure origins, so GPS tracking and the driver panel only work over HTTPS. The Secure session-cookie prefix also depends on the canonical `AUTH_URL` being the HTTPS URL. |
| **A scheduler** for maintenance jobs | An external cron/scheduler invoking the app's scripts on schedule (see `docs/deployment-guide.md`, Production Readiness Checklist) | Two tracking jobs: hourly abandoned-session expiry and daily ping prune (`expireAbandonedTrackingSessions` / `pruneExpiredLocationPings` in `src/server/services/tracking.ts`, run via `scripts/tracking-maintenance.ts`), plus the daily operations summary (`scripts/daily-ops-summary.ts`). No paid queue or scheduler product is used. |
| **Backups** | `pg_dump`-based routine in `docs/backup-and-recovery.md` | Uses PostgreSQL's own tooling (free); storage for the dumps is infrastructure. |

## 4. Optional providers — the app runs fully without them

`.env.example` names optional integration variables (names only):
Cloudinary (`CLOUDINARY_*`), MapTiler (`MAPTILER_API_KEY`),
OpenRouteService (`OPENROUTESERVICE_API_KEY`), EmailJS
(`EMAILJS_*`), TextLocal (`TEXTLOCAL_*`), and Supabase client keys
(`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`).
None of them is on the critical path of the built V2 system:

- Maps in the built product are Leaflet + OSM (§2), not MapTiler.
- Notifications are **in-app first** and fully functional with no
  provider; EMAIL/SMS rows honestly record `NOT_SENT_NO_PROVIDER`
  until a provider is connected (see `docs/known-limitations.md`).
- POD evidence is currently a hash-bound reference string precisely
  because no object-storage provider has been chosen (open decision
  M-10, `docs/known-limitations.md`).

Connecting any of these later is a configuration + decision step,
never a rewrite — and any that carries fees needs Meena's approval
first, per the deployment guide.

## 5. What "free" does not cover

- Staff time, devices (drivers' phones), connectivity, and the
  legal review of GPS collection (Nepal Privacy Act 2075 — a
  production gate, `docs/gps-privacy-and-retention.md` §6).
- Real-device verification of GPS behaviour (checklist in
  `docs/known-limitations.md`) — free to perform, not yet performed.
- Any future scale step that outgrows §2's tile policy or §3's
  current hosting/database arrangements. Each such step is recorded
  as an explicit open decision rather than absorbed silently.
