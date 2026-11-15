import { requireActor } from "@/lib/auth/permissions";
import { DriverSelfReportsPage, filtersFromSearchParams } from "@/components/reports/pages";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requireActor();
  const filters = filtersFromSearchParams(await searchParams);
  return (
    <DriverSelfReportsPage
      actor={actor}
      basePath="/transport-driver"
      filters={filters}
      showCod={false}
    />
  );
}
