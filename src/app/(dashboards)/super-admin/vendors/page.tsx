import { requireActor } from "@/lib/auth/permissions";
import { VendorsListPage } from "@/components/vendors/pages";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; search?: string; status?: string }>;
}) {
  const actor = await requireActor();
  const params = await searchParams;
  return (
    <VendorsListPage
      actor={actor}
      basePath="/super-admin"
      page={Number(params.page ?? 1) || 1}
      search={params.search}
      status={params.status}
    />
  );
}
