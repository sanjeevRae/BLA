import { requireActor } from "@/lib/auth/permissions";
import { SuppliesPage } from "@/components/warehouse-ops/pages";

export default async function Page() {
  const actor = await requireActor();
  return <SuppliesPage actor={actor} roleLabel="Warehouse Admin" />;
}
