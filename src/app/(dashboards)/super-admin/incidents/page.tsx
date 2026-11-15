import { requireActor } from "@/lib/auth/permissions";
import { IncidentsQueuePage } from "@/components/operations/pages";

export default async function Page() {
  const actor = await requireActor();
  return <IncidentsQueuePage actor={actor} basePath="/super-admin" />;
}
