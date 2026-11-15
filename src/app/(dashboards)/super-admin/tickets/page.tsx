import { requireActor } from "@/lib/auth/permissions";
import { TicketsInboxPage } from "@/components/operations/pages";

export default async function Page() {
  const actor = await requireActor();
  return <TicketsInboxPage actor={actor} basePath="/super-admin" />;
}
