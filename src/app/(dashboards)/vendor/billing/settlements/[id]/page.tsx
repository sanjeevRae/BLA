import { requireActor } from "@/lib/auth/permissions";
import { SettlementDetailPage } from "@/components/finance/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <SettlementDetailPage actor={actor} settlementId={id} basePath="/vendor/billing" />;
}
