import { requireActor } from "@/lib/auth/permissions";
import { ExecutiveHome } from "@/components/dashboards/ExecutiveHome";

/**
 * Admin home (V3 Step 4, brief §6): the executive overview — six
 * KPIs, the Live Operations map preview, shipment analytics, needs
 * attention, recent activity and quick actions — computed by
 * `getExecutiveHome` from the permission-enforcing services. The
 * V2-era AdminOpsHome was replaced by the shared ExecutiveHome; the
 * 30-day OverviewPanel lives on /admin/reports.
 */
export default async function Page() {
  const actor = await requireActor();
  return <ExecutiveHome actor={actor} basePath="/admin" variant="admin" />;
}
