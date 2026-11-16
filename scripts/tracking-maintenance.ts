/**
 * Tracking maintenance — the production entry point for the Phase 3
 * GPS sweeps (src/server/services/tracking.ts): expire abandoned
 * tracking sessions, then prune location pings past the retention
 * window (config via loadTrackingConfig: retentionDays default 30,
 * abandonedSessionMinutes default 120, overridable through the
 * `tracking.config` SystemSetting row).
 *
 * The work itself lives in the importable
 * runTrackingMaintenance() (src/server/services/tracking-maintenance.ts);
 * this script is only env bootstrap + CLI + logging.
 *
 * Run it from cron / a scheduled job, e.g.:
 *   30 2 * * *  cd /srv/bla && npx tsx --tsconfig scripts/tsconfig.json scripts/tracking-maintenance.ts
 * (The --tsconfig flag is required: it maps the `server-only`
 * marker to scripts/server-only-stub.ts for standalone runs.)
 *
 * Flags:
 *   --dry-run   report what WOULD change, write nothing
 *
 * Output is COUNTS ONLY — sessions ended, pings deleted, the config
 * values used, and the run duration. Never coordinates, never
 * driver identities. Idempotent: a second immediate run changes
 * nothing. Exits non-zero on error.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { prisma } from "@/lib/db/prisma";
import { runTrackingMaintenance } from "@/server/services/tracking-maintenance";

// ---------------------------------------------------------------------------
// Env bootstrap (same hand-rolled loader the other scripts and the
// integration suites use: DATABASE_URL comes from the process env in
// production, or from .env.local for a local run).
// ---------------------------------------------------------------------------
function loadEnvFile(path: string): void {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2]!.trim().replace(/^["']|["']$/g, "");
    }
  }
}
loadEnvFile(join(__dirname, "..", ".env.local"));
loadEnvFile(join(__dirname, "..", ".env"));

async function main(): Promise<void> {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const result = await runTrackingMaintenance({ dryRun });
  const mode = result.dryRun ? " (dry-run)" : "";
  console.log(
    `Tracking maintenance${mode}: retentionDays=${result.retentionDays} abandonedSessionMinutes=${result.abandonedSessionMinutes}`,
  );
  console.log(
    result.dryRun
      ? `Sessions that would be ended: ${result.sessionsEnded}`
      : `Sessions ended: ${result.sessionsEnded}`,
  );
  console.log(
    result.dryRun
      ? `Pings that would be deleted: ${result.pingsDeleted}`
      : `Pings deleted: ${result.pingsDeleted}`,
  );
  console.log(`Duration: ${result.durationMs}ms`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
