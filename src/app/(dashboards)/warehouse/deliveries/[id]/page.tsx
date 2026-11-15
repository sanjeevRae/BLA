import { requireActor } from "@/lib/auth/permissions";
import { DeliveryBatchDetailPage } from "@/components/deliveries/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <DeliveryBatchDetailPage actor={actor} basePath="/warehouse" batchId={id} />;
}
