import { requireActor } from "@/lib/auth/permissions";
import { CustomerInvoiceDetailPage } from "@/components/customers/self-service-pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <CustomerInvoiceDetailPage actor={actor} id={id} />;
}
