import { requireActor } from "@/lib/auth/permissions";
import { WarehouseReportsPage, filtersFromSearchParams } from "@/components/reports/pages";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActor();
  const filters = filtersFromSearchParams(await searchParams);
  return <WarehouseReportsPage actor={actor} basePath="/warehouse" filters={filters} />;
}
