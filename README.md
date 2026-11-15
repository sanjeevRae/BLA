# BLA — Delivery Operations Platform

One application: a Next.js (App Router) + TypeScript rebuild of the BLA
delivery operations platform — warehouses, bookings, transfers, riders,
COD finance, incidents, support and reports — with a single login page
for all ten roles and a public package-tracking page.

This application replaces the retired stack (FastAPI backend, Vite admin
dashboard, and the static customer-tracking / driver / vendor pages).
The pre-rebuild repository state is preserved under the git tag
`pre-rebuild-checkpoint`.

## Stack

- **Next.js 16 (App Router) + React 19 + TypeScript** — UI, Server
  Actions and Route Handlers in one app.
- **PostgreSQL via Prisma** (single ORM) — the app schema lives in the
  dedicated `app` schema of the Supabase project.
- **Auth.js database sessions** — one login page, server-side RBAC with
  warehouse/vendor/driver scoping, append-only audit log.
- Money is integer paisa (BigInt) end to end; package status changes go
  only through the package lifecycle service.

## Layout

| Path | Contents |
|---|---|
| `src/app/` | Routes: `(public)` login/tracking, role dashboard groups, `api/` handlers |
| `src/server/services/` | Domain services (the only writers of business state) |
| `src/server/actions/` | Server Action wrappers (auth gate → service → result) |
| `src/lib/` | Pure domain logic, permission catalog, auth helpers |
| `prisma/` | Schema, migrations, seed |
| `tests/` | Vitest unit + integration suites (integration runs on a local `bla_test` database) |
| `docs/` | The 24 design documents (architecture, security, workflows, deployment…) |

## Develop

```bash
npm install
cp .env.example .env.local   # fill in local values; never commit .env.local
npx prisma migrate dev       # apply migrations to the local dev database
npm run db:seed              # roles/permissions catalog + local fixtures
npm run dev
```

## Verify

```bash
npx tsc --noEmit
npm run lint
npm test          # unit + integration (needs the local bla_test database)
npm run build
```

## Deploy

See `docs/deployment-guide.md` (hosting, environment variables, migration
procedure) and `docs/backup-and-recovery.md`. Production hard gates from
the security reviews — session idle timeouts and TOTP MFA for privileged
roles — are implemented and configured via `SystemSetting` rows
(docs/security-architecture.md §2).
