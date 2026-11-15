import { requireActor } from "@/lib/auth/permissions";
import { DashboardHome } from "@/components/dashboards/DashboardHome";

export default async function Page() {
  const actor = await requireActor();
  return <DashboardHome actor={actor} roleLabel="Super Admin" />;
}
