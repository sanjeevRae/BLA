import { requireActor } from "@/lib/auth/permissions";
import { RiderBatchPage } from "@/components/deliveries/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <RiderBatchPage actor={actor} batchId={id} />;
}
