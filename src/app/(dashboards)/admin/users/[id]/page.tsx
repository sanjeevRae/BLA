import { requireActor } from "@/lib/auth/permissions";
import { UserDetailPage } from "@/components/admin-identity/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <UserDetailPage actor={actor} basePath="/admin" userId={id} />;
}
