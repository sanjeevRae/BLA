import { requireActor } from "@/lib/auth/permissions";
import { BookingsListPage } from "@/components/bookings/pages";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; search?: string; status?: string }>;
}) {
  const actor = await requireActor();
  const params = await searchParams;
  return (
    <BookingsListPage
      actor={actor}
      basePath="/vendor"
      page={Number(params.page ?? 1) || 1}
      search={params.search}
      status={params.status}
      title="My bookings"
    />
  );
}
