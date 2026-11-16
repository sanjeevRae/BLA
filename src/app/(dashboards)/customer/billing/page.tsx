import { requireActor } from "@/lib/auth/permissions";
import { CustomerBillingPage } from "@/components/customers/self-service-pages";

export default async function Page() {
  const actor = await requireActor();
  return <CustomerBillingPage actor={actor} />;
}
