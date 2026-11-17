import { requireActor } from "@/lib/auth/permissions";
import { ExecutiveHome } from "@/components/dashboards/ExecutiveHome";

/**
 * Super Admin home (V3 Step 4, brief §6): the same executive
 * overview as Admin, keeping its global character — the V2 30-day
 * overview figures are folded into the §6 structure (one KPI row,
 * plus the Money strip) instead of the old wall of bare-number
 * cards and zero-bar panels. Users & Roles, Settings and Audit Logs
 * stay reachable from the sidebar and the quick-actions row. Full
 * filters live under Reports.
 */
export default async function Page() {
  const actor = await requireActor();
  return (
    <ExecutiveHome actor={actor} basePath="/super-admin" variant="super-admin" />
  );
}
