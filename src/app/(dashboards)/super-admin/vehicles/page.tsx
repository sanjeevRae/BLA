import { requireActor } from "@/lib/auth/permissions";
import { VehiclesPage } from "@/components/fleet/pages";

export default async function Page() {
  const actor = await requireActor();
  return <VehiclesPage actor={actor} />;
}
