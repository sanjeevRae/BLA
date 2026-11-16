# BLA — Backup and Recovery

**The rule, without exception:**

> **Never run a production migration without a verified backup first.**
> "Verified" means the dump completed without error, the file is non-empty,
> and a test restore of that dump has succeeded at least once for the
> current backup format. A backup that has never been restored is a hope,
> not a backup.

## 1. What gets backed up

| Asset | Method | When |
|---|---|---|
| **Live Supabase PostgreSQL database** (all schemas the app uses, including the legacy tables until they are retired) | Full `pg_dump` (custom format, `--format=custom`) using the direct connection string | Before **every** migration; before data migration at cutover; on the regular schedule in §2 |
| **Application code** | Git — every phase ends with a commit and a tag; the pre-rebuild state is frozen as tag `pre-rebuild-checkpoint` | Continuous (pushed to GitHub) |
| **Migration files** | Committed in the repo with the code (`prisma/migrations/`) | With every schema change |
| **Environment configuration** | Variable **names** documented in `docs/deployment-guide.md` §3; values live in the hosting dashboard and Meena's password store — never in git | On change |
| **Evidence references** (delivery proofs, incident evidence) | There is **no file-storage provider in V2**: evidence is stored as reference strings in the database, hash-bound to exactly one package since V2 Phase 7 (see `docs/known-limitations.md` M-10). The database backup therefore covers evidence completely. If Meena later chooses a storage provider (open decision M-10), this row must be revisited — the files themselves would then need their own export | With the database |

Seed/demo data is explicitly **not** a backup concern — it can be recreated
from the seed scripts. Real master data (warehouses, users, drivers,
vehicles, vendors, customers) and all operational/financial records are.

## 2. Schedule and retention

- **Before every production migration:** a fresh full dump, taken
  immediately before the migration runs (not "last night's"). Kept until the
  phase that introduced the migration is closed and the next phase's backup
  exists.
- **Daily:** automated full dump of the live database once the new system is
  in production (scheduled job on the hosting/CI platform; until automation
  is in place, a manual dump is part of the end-of-day routine in
  `docs/operations-manual.md`).
- **Weekly:** one dump per week retained as the weekly restore point.
- **Retention:** daily dumps 14 days · weekly dumps 8 weeks · pre-migration
  dumps for the life of the phase + 30 days · the cutover dump (taken
  immediately before data migration) retained permanently with the project
  records.
- **Storage:** dumps live **outside** the database's own platform account
  where practical (a separate storage location), named
  `bla-db-YYYYMMDD-HHmm-<context>.dump` (context: `premigration-phaseN`,
  `daily`, `cutover`, …), with the git tag/commit they correspond to noted
  alongside.

## 3. Restore procedure

1. **Stop writes** — put the application into maintenance mode or pause the
   deployment so no new data lands during the restore.
2. **Preserve the current state** — take a dump of the database *as it is
   now* (even if broken) before overwriting anything; a failed restore must
   never destroy the evidence or the only copy of newer data.
3. **Restore** — `pg_restore` the chosen backup into the target database
   (a fresh database/schema first when restoring into Supabase, to avoid
   half-merged state).
4. **Verify** — row counts on core tables (users, warehouses, orders,
   packages, ledger transactions) match the backup's manifest; application
   health checks pass; one admin login and one tracking lookup succeed;
   financial totals (ledger sums) match the pre-incident figures.
5. **Resume** — lift maintenance mode, announce the restore point (date/time
   of the backup now live) to all admins, and record the incident and the
   data-loss window in an incident record.

## 3a. Rehearsed procedure — executed and verified 2026-11-16 (V2 Phase 8)

The dump/restore cycle below was run end to end against the local
development database (`bla_dev`, PostgreSQL 16, schema `app`) during V2
Phase 8. These are the exact commands (credentials supplied through the
environment, never written into the command line history as literals —
`PGPASSWORD`/`PGUSER`/`PGHOST` exported from the local env file):

```bash
# 1. Dump the application schema (schema + data)
pg_dump -n app -d bla_dev -f bla_dev_app_rehearsal.sql        # 816,017 bytes

# 2. Create a scratch database owned by the application role
#    (the application role itself has no CREATEDB privilege — a
#    superuser creates the scratch database, as here, or the dump is
#    restored into an existing empty database)
sudo -u postgres createdb -O "$PGUSER" bla_restore_check

# 3. Restore
psql -q -d bla_restore_check -f bla_dev_app_rehearsal.sql     # exit 0, 0 errors
```

Verification of the restored copy, compared against the source:

| Check | Source (`bla_dev`) | Restored (`bla_restore_check`) |
|---|---|---|
| Tables in schema `app` (incl. `_prisma_migrations`) | 85 | 85 |
| `Package` rows | 18 | 18 |
| `Order` rows | 18 | 18 |
| `LedgerTransaction` rows | 6 | 6 |
| Applied migrations (`_prisma_migrations`) | 30 | 30 |
| Journal balance: journalRefs where Σ DEBIT ≠ Σ CREDIT | 0 | 0 |
| Journal-balance constraint trigger present | `LedgerTransaction_journal_balanced` | `LedgerTransaction_journal_balanced` |

The scratch database was dropped after verification. The journal-balance
check is the Phase 2 rule enforced by the deferred constraint trigger:
for every `journalRef`, total DEBIT must equal total CREDIT in
`LedgerTransaction`. Run it after any restore:

```sql
SELECT count(*) FROM (
  SELECT "journalRef" FROM app."LedgerTransaction"
  GROUP BY "journalRef"
  HAVING sum(CASE WHEN direction='DEBIT'  THEN "amountPaisa" ELSE 0 END)
      <> sum(CASE WHEN direction='CREDIT' THEN "amountPaisa" ELSE 0 END)
) x;   -- must be 0
```

Notes from the rehearsal:

- The application database role cannot create databases
  (`permission denied to create database`). Production restore planning
  must assume a superuser/owner action creates the target database —
  on Supabase that means restoring through the dashboard or into a new
  project, not ad-hoc `createdb` with the application role.
- A plain-format dump restored with zero errors, including the deferred
  journal-balance trigger and all Phase 2–7 objects. Custom format
  (`--format=custom` + `pg_restore`) remains the §1 standard for
  production dumps; the plain format was used here so the rehearsal
  output stayed human-inspectable.

## 3b. Production (Supabase) — what is verifiable vs plan-dependent

Stated conservatively; verify in the actual project dashboard rather
than assuming:

- **Dashboard-verifiable:** Dashboard → Database → Backups shows the
  project's scheduled backups and their timestamps, and whether
  point-in-time recovery (PITR) is enabled for the project. Check what
  the project actually shows before relying on any of it.
- **Plan-dependent:** backup retention length, PITR availability and
  its retention window, and physical-backup download options all depend
  on the project's plan/add-ons. None of these are assumed anywhere in
  this document; the RPO in §5 is based on the manual `pg_dump`
  schedule in §2, which works on any plan.
- **Independent of plan:** a manual `pg_dump` over the session-pooler or
  direct connection (with the current database password — Meena reset
  it on 2026-11-16, so obtain the current connection string from him)
  always works and is the pre-migration requirement in §2.

## 4. Restore-test requirement

- A restore from the current backup format must be **test-executed into a
  throwaway database before the first production migration** of the rebuild,
  and re-tested after any change to the backup method.
- Thereafter, a restore test is run **monthly**: latest daily dump →
  scratch database → §3 step 4 verification checks. A failed restore test is
  treated as a severity-1 operational incident: backups are considered
  broken until a test passes again.
- Restore-test results (date, dump used, checks passed) are logged in the
  operations record.

## 5. RPO / RTO

Appropriate for a small logistics operation running on hosted free/low-cost
tiers — honest numbers, not enterprise promises:

| Measure | Target | Basis |
|---|---|---|
| **RPO (max data loss)** | **24 hours** in normal operation (daily dumps); **~0** across a migration (fresh dump taken immediately before) | Daily schedule + pre-migration dumps |
| **RTO (max downtime to restore service)** | **4 hours** for a full database restore during working hours | Single-database restore + verification (§3); the restore mechanics themselves were rehearsed in minutes (§3a) — the 4-hour figure is dominated by detection, decision and write-freeze time, not restore time |

If the business grows to the point where losing a day of operational data
is unacceptable, the upgrade path is Supabase point-in-time recovery (paid
tier) — a cost decision for Meena, flagged here rather than silently
assumed.

## 6. Responsibilities

- **Muse (during the rebuild):** takes and verifies the pre-migration dump
  for every migration it applies (or confirms Meena has taken it, when the
  SQL-editor route is used), runs restore tests, and records results.
- **Meena / Super Admin (in production):** owns the backup storage location
  and credentials, approves any change to this schedule, and is the only
  person who can authorize restoring over live data.
- Nobody — including Super Admin — deletes the last verified backup of any
  restore point that has not been superseded.
