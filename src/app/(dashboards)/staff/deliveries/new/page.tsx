import { requireActor } from "@/lib/auth/permissions";
import { CreateBatchPage } from "@/components/deliveries/pages";

export default async function Page() {
  const actor = await requireActor();
  return <CreateBatchPage actor={actor} basePath="/staff" />;
}
