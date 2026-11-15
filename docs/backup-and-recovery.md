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
| **Uploaded files** (delivery proofs, vendor documents, incident evidence) | Stored in private object storage (Cloudinary); the database backup covers their references/metadata. A periodic export of the storage folders is taken at cutover and monthly thereafter | Monthly |

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
| **RTO (max downtime to restore service)** | **4 hours** for a full database restore during working hours | Single-database restore + verification (§3); the old system remains a live fallback until cutover completes (see deployment guide §6), which makes effective RTO during the rebuild much lower |

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
