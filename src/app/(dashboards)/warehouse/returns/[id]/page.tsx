import { requireActor } from "@/lib/auth/permissions";
import { ReturnDetailPage } from "@/components/deliveries/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <ReturnDetailPage actor={actor} basePath="/warehouse" returnId={id} />;
}
