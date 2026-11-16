import { requireActor } from "@/lib/auth/permissions";
import { CustomerIncidentsPage } from "@/components/customers/self-service-pages";

export default async function Page() {
  const actor = await requireActor();
  return <CustomerIncidentsPage actor={actor} />;
}
