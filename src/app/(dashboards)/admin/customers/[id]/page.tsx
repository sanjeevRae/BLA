import { requireActor } from "@/lib/auth/permissions";
import { CustomerDetailPage } from "@/components/customers/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <CustomerDetailPage actor={actor} basePath="/admin" customerId={id} />;
}
