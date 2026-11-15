import { requireActor } from "@/lib/auth/permissions";
import { RemittanceDetailPage } from "@/components/finance/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <RemittanceDetailPage actor={actor} remittanceId={id} backHref="/finance/remittances" />;
}
