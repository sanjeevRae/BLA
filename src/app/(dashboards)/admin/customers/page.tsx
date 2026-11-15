import { requireActor } from "@/lib/auth/permissions";
import { CustomersListPage } from "@/components/customers/pages";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; search?: string }>;
}) {
  const actor = await requireActor();
  const params = await searchParams;
  return (
    <CustomersListPage
      actor={actor}
      basePath="/admin"
      page={Number(params.page ?? 1) || 1}
      search={params.search}
    />
  );
}
