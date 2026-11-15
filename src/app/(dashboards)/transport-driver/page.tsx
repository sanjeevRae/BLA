import { requireActor } from "@/lib/auth/permissions";
import { DriverDashboardPage } from "@/components/transfers/pages";

export default async function Page() {
  const actor = await requireActor();
  return <DriverDashboardPage actor={actor} />;
}
