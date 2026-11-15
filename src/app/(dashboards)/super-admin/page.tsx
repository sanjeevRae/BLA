import Link from "next/link";

import { requireActor } from "@/lib/auth/permissions";
import { DashboardHome } from "@/components/dashboards/DashboardHome";

export default async function Page() {
  const actor = await requireActor();
  return (
    <div className="flex flex-col gap-4">
      <DashboardHome actor={actor} roleLabel="Super Admin" />
      <div className="rounded-lg border border-line bg-surface p-5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Modules
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            href="/super-admin/warehouses"
            className="rounded-md border border-line bg-page px-3 py-2 text-[13px] font-semibold text-ink"
          >
            Warehouses →
          </Link>
        </div>
      </div>
    </div>
  );
}
