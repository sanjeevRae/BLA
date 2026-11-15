import { requireActor } from "@/lib/auth/permissions";
import { AdminReportsPage, filtersFromSearchParams } from "@/components/reports/pages";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActor();
  const filters = filtersFromSearchParams(await searchParams);
  return <AdminReportsPage actor={actor} basePath="/super-admin" filters={filters} />;
}
