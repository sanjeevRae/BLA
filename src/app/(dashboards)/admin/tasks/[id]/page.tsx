import { requireActor } from "@/lib/auth/permissions";
import { TaskDetailPage } from "@/components/operations/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <TaskDetailPage actor={actor} basePath="/admin" id={id} />;
}
