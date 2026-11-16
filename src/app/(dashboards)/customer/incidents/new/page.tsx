import { requireActor } from "@/lib/auth/permissions";
import { CustomerIncidentNewPage } from "@/components/customers/self-service-pages";

export default async function Page() {
  const actor = await requireActor();
  return <CustomerIncidentNewPage actor={actor} />;
}
