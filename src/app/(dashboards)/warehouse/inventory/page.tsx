import { requireActor } from "@/lib/auth/permissions";
import { InventoryPage } from "@/components/warehouse-ops/pages";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ search?: string }>;
}) {
  const actor = await requireActor();
  const params = await searchParams;
  return <InventoryPage actor={actor} roleLabel="Warehouse Admin" search={params.search} />;
}
