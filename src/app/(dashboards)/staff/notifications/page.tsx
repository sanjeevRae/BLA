import { requireActor } from "@/lib/auth/permissions";
import { NotificationsPage } from "@/components/operations/pages";

export default async function Page() {
  const actor = await requireActor();
  return <NotificationsPage actor={actor} />;
}
