import { requireActor } from "@/lib/auth/permissions";
import { TasksBoardPage } from "@/components/operations/pages";

export default async function Page() {
  const actor = await requireActor();
  return <TasksBoardPage actor={actor} basePath="/rider" queue="mine" />;
}
