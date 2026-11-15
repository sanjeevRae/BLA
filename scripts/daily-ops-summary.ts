/**
 * Daily operations summary — the replacement for the retired legacy
 * `daily-report` GitHub Actions workflow (deleted with the old
 * backend in Phase 10 slice 1).
 *
 * Composes the Phase 9 daily report (src/server/services/reports.ts
 * getDailyReport — the same figures the dashboard shows, computed
 * from the real tables) into one IN_APP Notification per ADMIN /
 * SUPER_ADMIN user. Idempotent per day: the dedupe key
 * `ops-daily:<date>:<userId>:IN_APP` makes re-runs no-ops
 * (createNotificationInTx uses skipDuplicates).
 *
 * Run it from cron / a scheduled job once a day, e.g.:
 *   15 18 * * *  cd /srv/bla && npx tsx scripts/daily-ops-summary.ts
 *
 * Flags:
 *   --date YYYY-MM-DD   Kathmandu calendar day to summarise
 *                       (default: today in Asia/Kathmandu)
 *   --dry-run           print the composed summary, write nothing
 *
 * The report is computed as a system actor built from the first
 * ACTIVE SUPER_ADMIN account (the report service is scope-checked;
 * a super admin's company-wide scope is the only correct vantage
 * for a company summary). If no super admin exists yet, the script
 * exits non-zero with that message — it never fabricates figures.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PrismaClient } from "@prisma/client";

import type { ActorContext } from "@/lib/auth/actor";
import {
  ROLE_PERMISSIONS,
  landingPathForRoles,
  primaryRoleFor,
  type RoleCode,
} from "@/lib/permissions/catalog";
import { notifyUsersInTx, userIdsWithRoles } from "@/server/services/notifications";
import { getDailyReport } from "@/server/services/reports";

// ---------------------------------------------------------------------------
// Env bootstrap (same hand-rolled loader the integration suites use:
// DATABASE_URL comes from the process env in production, or from
// .env.local for a local run).
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

const prisma = new PrismaClient();

function kathmanduToday(): string {
  // en-CA yields YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kathmandu" }).format(new Date());
}

function formatNpr(paisa: string): string {
  const value = Number(BigInt(paisa)) / 100;
  return `NPR ${value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function systemActor(): Promise<ActorContext> {
  const sa = await prisma.user.findFirst({
    where: { status: "ACTIVE", roles: { some: { role: { code: "SUPER_ADMIN" } } } },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, fullName: true },
  });
  if (!sa) {
    throw new Error(
      "No ACTIVE SUPER_ADMIN account exists — the daily summary needs one to compute the company-wide report.",
    );
  }
  const roles: RoleCode[] = ["SUPER_ADMIN"];
  return {
    userId: sa.id,
    email: sa.email,
    fullName: sa.fullName,
    status: "ACTIVE",
    mustChangePassword: false,
    mfaEnrolled: true,
    mfaEnrolmentRequired: false,
    mfaPending: false,
    roles,
    primaryRole: primaryRoleFor(roles),
    permissions: new Set(ROLE_PERMISSIONS.SUPER_ADMIN),
    warehouseIds: [],
    membershipRoles: [],
    vendorId: null,
    vendorRole: null,
    driverId: null,
    customerId: null,
    landingPath: landingPathForRoles(roles),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const dateFlag = args.indexOf("--date");
  const date = dateFlag >= 0 ? args[dateFlag + 1]! : kathmanduToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`--date must be YYYY-MM-DD, got: ${date}`);
  }

  const actor = await systemActor();
  const report = await getDailyReport(actor, { from: date, to: date });

  const lines = [
    `Bookings: ${report.bookings}`,
    `Packages received: ${report.packagesReceived}`,
    `Transfers dispatched: ${report.transfersDispatched} (${report.packagesDispatched} packages)`,
    `Delivered: ${report.delivered}`,
    `Failed delivery attempts: ${report.failedAttempts}`,
    `Returns requested: ${report.returnsRequested}`,
    `COD collected: ${formatNpr(report.codCollectedPaisa)}`,
    ...(report.invoicedTotalPaisa !== null
      ? [`Invoiced: ${formatNpr(report.invoicedTotalPaisa)}`]
      : []),
  ];
  const title = `Daily operations — ${date}`;
  const body = lines.join("\n");

  if (dryRun) {
    console.log(`[dry-run] ${title}\n${body}`);
    return;
  }

  const recipients = await userIdsWithRoles(prisma, ["ADMIN", "SUPER_ADMIN"]);
  if (recipients.length === 0) {
    console.log("No ADMIN/SUPER_ADMIN recipients — nothing to send.");
    return;
  }
  const created = await notifyUsersInTx(prisma, recipients, {
    category: "DAILY_OPS_SUMMARY",
    title,
    body,
    entityType: "DailyReport",
    entityId: null,
    payload: { ...report },
    dedupeKey: `ops-daily:${date}`,
    channels: ["IN_APP"],
  });
  console.log(
    `Daily ops summary for ${date}: ${created} notification(s) created for ${recipients.length} admin recipient(s).`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
