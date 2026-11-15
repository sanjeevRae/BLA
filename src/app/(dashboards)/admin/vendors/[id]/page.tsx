import { requireActor } from "@/lib/auth/permissions";
import { VendorDetailPage } from "@/components/vendors/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <VendorDetailPage actor={actor} basePath="/admin" vendorId={id} />;
}
