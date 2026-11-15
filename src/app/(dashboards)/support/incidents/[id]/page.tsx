import { requireActor } from "@/lib/auth/permissions";
import { IncidentDetailPage } from "@/components/operations/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <IncidentDetailPage actor={actor} basePath="/support" id={id} />;
}
