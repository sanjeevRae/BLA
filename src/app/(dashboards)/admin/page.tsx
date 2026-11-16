import { requireActor } from "@/lib/auth/permissions";
import { AdminOpsHome } from "@/components/dashboards/AdminOpsHome";

/**
 * Admin home (V2 Phase 6 slice B): the operations-focused home of
 * spec §7/§10.5 — needs attention, key metrics, current operations,
 * the live-operations summary card, recent activity and quick
 * actions, all computed by the home-dashboards service from the
 * permission-enforcing operational services. The 30-day
 * OverviewPanel this page used to mirror from the Super Admin home
 * now lives only on /admin/reports, where it belongs.
 */
export default async function Page() {
  const actor = await requireActor();
  return <AdminOpsHome actor={actor} />;
}
