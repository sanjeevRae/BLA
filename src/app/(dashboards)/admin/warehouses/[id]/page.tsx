import { requireActor } from "@/lib/auth/permissions";
import { WarehouseDetailPage } from "@/components/warehouses/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <WarehouseDetailPage actor={actor} basePath="/admin" warehouseId={id} />;
}
