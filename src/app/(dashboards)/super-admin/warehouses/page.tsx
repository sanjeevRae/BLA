import { requireActor } from "@/lib/auth/permissions";
import { WarehousesListPage } from "@/components/warehouses/pages";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const actor = await requireActor();
  const { page } = await searchParams;
  return (
    <WarehousesListPage actor={actor} basePath="/super-admin" page={Number(page ?? 1) || 1} />
  );
}
