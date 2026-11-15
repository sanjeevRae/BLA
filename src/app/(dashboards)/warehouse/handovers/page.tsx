import { requireActor } from "@/lib/auth/permissions";
import { HandoversPage } from "@/components/warehouse-ops/pages";

export default async function Page() {
  const actor = await requireActor();
  return <HandoversPage actor={actor} roleLabel="Warehouse Admin" />;
}
