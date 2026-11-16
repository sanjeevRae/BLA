import "server-only";

import {
  expireAbandonedTrackingSessions,
  loadTrackingConfig,
  pruneExpiredLocationPings,
} from "@/server/services/tracking";

/**
 * Tracking maintenance runner (Phase 8) — the importable core of
 * scripts/tracking-maintenance.ts. Runs the two Phase 3 sweeps in
 * order (abandoned-session expiry, then ping-retention prune) and
 * reports COUNTS ONLY: no coordinates, no driver identities, ever.
 *
 * Idempotent: both sweeps only touch rows that still match their
 * criteria, so an immediate second run changes nothing and reports
 * zeroes. With `dryRun: true` the sweeps run in their dry-run mode
 * and the counts describe what WOULD change; nothing is written.
 */

export interface TrackingMaintenanceOptions {
  dryRun?: boolean;
  /** Clock for both sweeps (defaults to the moment of the run). */
  now?: Date;
}

export interface TrackingMaintenanceResult {
  dryRun: boolean;
  /** Sessions ended — or, in dry-run mode, sessions that would end. */
  sessionsEnded: number;
  /** Pings deleted — or, in dry-run mode, pings that would be deleted. */
  pingsDeleted: number;
  /** Config values the sweeps ran with (from loadTrackingConfig). */
  retentionDays: number;
  abandonedSessionMinutes: number;
  durationMs: number;
}

export async function runTrackingMaintenance(
  opts: TrackingMaintenanceOptions = {},
): Promise<TrackingMaintenanceResult> {
  const dryRun = opts.dryRun ?? false;
  const now = opts.now ?? new Date();
  const startedAt = Date.now();

  const config = await loadTrackingConfig();
  const sessionsEnded = await expireAbandonedTrackingSessions(now, { dryRun });
  const { deleted: pingsDeleted } = await pruneExpiredLocationPings(now, { dryRun });

  return {
    dryRun,
    sessionsEnded,
    pingsDeleted,
    retentionDays: config.retentionDays,
    abandonedSessionMinutes: config.abandonedSessionMinutes,
    durationMs: Date.now() - startedAt,
  };
}
