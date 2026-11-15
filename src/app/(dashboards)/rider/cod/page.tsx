import { requireActor } from "@/lib/auth/permissions";
import { RiderCodPage } from "@/components/finance/pages";

export default async function Page() {
  const actor = await requireActor();
  return <RiderCodPage actor={actor} />;
}
