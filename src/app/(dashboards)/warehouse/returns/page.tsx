import { requireActor } from "@/lib/auth/permissions";
import { ReturnsListPage } from "@/components/deliveries/pages";

export default async function Page() {
  const actor = await requireActor();
  return <ReturnsListPage actor={actor} basePath="/warehouse" />;
}
