import Link from "next/link";

import { requireActor } from "@/lib/auth/permissions";
import { OverviewPanel } from "@/components/reports/pages";

/**
 * Admin / Operations overview dashboard (spec Part 4.2): the live
 * operational and financial picture for the last 30 days, computed by
 * the ReportingService from the real records — the same figures the
 * reports page and the API return. Full filters live under Reports.
 */
export default async function Page() {
  const actor = await requireActor();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-bold text-ink">Operations overview</h1>
          <p className="text-[13px] text-faint">
            Welcome, {actor.fullName} — live figures for the last 30 days.
          </p>
        </div>
        <Link
          href="/admin/reports"
          className="rounded-md bg-brand px-3 py-2 text-[13px] font-semibold text-white"
        >
          Full reports →
        </Link>
      </div>
      <OverviewPanel actor={actor} filters={{}} />
      <div className="rounded-lg border border-line bg-surface p-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Modules
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href="/admin/reports"
            className="rounded-md border border-line bg-page px-3 py-2 text-[13px] font-semibold text-ink"
          >
            Reports →
          </Link>
          <Link
            href="/admin/warehouses"
            className="rounded-md border border-line bg-page px-3 py-2 text-[13px] font-semibold text-ink"
          >
            Warehouses →
          </Link>
          <Link
            href="/admin/vehicles"
            className="rounded-md border border-line bg-page px-3 py-2 text-[13px] font-semibold text-ink"
          >
            Vehicles →
          </Link>
          <Link
            href="/admin/drivers"
            className="rounded-md border border-line bg-page px-3 py-2 text-[13px] font-semibold text-ink"
          >
            Drivers →
          </Link>
        </div>
      </div>
    </div>
  );
}
