import { requireActor } from "@/lib/auth/permissions";
import { CustomerProfilePage } from "@/components/customers/self-service-pages";

export default async function Page() {
  const actor = await requireActor();
  return <CustomerProfilePage actor={actor} />;
}
