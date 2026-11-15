import { requireActor } from "@/lib/auth/permissions";
import { TransferDetailPage } from "@/components/transfers/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <TransferDetailPage actor={actor} basePath="/warehouse" transferId={id} />;
}
