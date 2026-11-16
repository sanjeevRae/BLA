import { requireActor } from "@/lib/auth/permissions";
import { AuditPage } from "@/components/admin-identity/pages";

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    actor?: string;
    action?: string;
    entityType?: string;
    outcome?: string;
    from?: string;
    to?: string;
    page?: string;
  }>;
}) {
  const actor = await requireActor();
  const query = await searchParams;
  return <AuditPage actor={actor} basePath="/admin" query={query} />;
}
