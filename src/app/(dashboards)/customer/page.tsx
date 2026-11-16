import { requireActor } from "@/lib/auth/permissions";
import { CustomerHomePage } from "@/components/customers/self-service-pages";

export default async function Page() {
  const actor = await requireActor();
  return <CustomerHomePage actor={actor} />;
}
