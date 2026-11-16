import { requireActor } from "@/lib/auth/permissions";
import { DriverDetailPage } from "@/components/fleet/pages";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <DriverDetailPage actor={actor} basePath="/super-admin" driverId={id} />;
}
