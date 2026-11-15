import { requireActor } from "@/lib/auth/permissions";
import { ManifestPrintPage } from "@/components/transfers/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <ManifestPrintPage actor={actor} transferId={id} />;
}
