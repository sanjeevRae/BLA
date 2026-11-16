import { requireActor } from "@/lib/auth/permissions";
import { LiveOperationsPage } from "@/components/live-operations/pages";

export default async function Page() {
  const actor = await requireActor();
  return <LiveOperationsPage actor={actor} basePath="/admin" />;
}
