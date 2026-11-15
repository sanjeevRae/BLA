import { requireActor } from "@/lib/auth/permissions";
import { OperationsPage } from "@/components/warehouse-ops/pages";

export default async function Page() {
  const actor = await requireActor();
  return <OperationsPage actor={actor} roleLabel="Warehouse Staff" />;
}
