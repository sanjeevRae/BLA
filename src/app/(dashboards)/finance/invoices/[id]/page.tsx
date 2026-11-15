import { requireActor } from "@/lib/auth/permissions";
import { InvoiceDetailPage } from "@/components/finance/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <InvoiceDetailPage actor={actor} invoiceId={id} backHref="/finance/invoices" />;
}
