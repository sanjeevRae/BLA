import { requireActor } from "@/lib/auth/permissions";
import { DriverDetailPage } from "@/components/fleet/pages";

/**
 * Warehouse Admin driver detail (Phase 7): the shared
 * DriverDetailPage with the WA actor — getDriverProfile scopes the
 * read to drivers homed at the actor's warehouses or currently
 * working out of them (active trip origin / active batch), and the
 * GPS section renders only under operations.live_view.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;
  return <DriverDetailPage actor={actor} basePath="/warehouse" driverId={id} />;
}
