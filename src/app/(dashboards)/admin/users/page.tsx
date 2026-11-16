import { requireActor } from "@/lib/auth/permissions";
import { UsersListPage } from "@/components/admin-identity/pages";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; role?: string; status?: string; page?: string }>;
}) {
  const actor = await requireActor();
  const query = await searchParams;
  return <UsersListPage actor={actor} basePath="/admin" query={query} />;
}
