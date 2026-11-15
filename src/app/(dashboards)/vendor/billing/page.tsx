import { requireActor } from "@/lib/auth/permissions";
import { VendorBillingPage } from "@/components/finance/pages";

export default async function Page() {
  const actor = await requireActor();
  return <VendorBillingPage actor={actor} />;
}
