import { requireActor } from "@/lib/auth/permissions";
import { DeliveriesListPage } from "@/components/deliveries/pages";

export default async function Page() {
  const actor = await requireActor();
  return <DeliveriesListPage actor={actor} basePath="/warehouse" />;
}
