import { requireActor } from "@/lib/auth/permissions";
import { DriversPage } from "@/components/fleet/pages";

export default async function Page() {
  const actor = await requireActor();
  return <DriversPage actor={actor} />;
}
