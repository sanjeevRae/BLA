import { requireActor } from "@/lib/auth/permissions";
import { TransfersListPage } from "@/components/transfers/pages";

export default async function Page() {
  const actor = await requireActor();
  return <TransfersListPage actor={actor} basePath="/staff" />;
}
