import { requireActor } from "@/lib/auth/permissions";
import { AdjustmentsPage } from "@/components/finance/pages";

export default async function Page() {
  const actor = await requireActor();
  return <AdjustmentsPage actor={actor} />;
}
