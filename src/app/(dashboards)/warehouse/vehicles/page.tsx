import { requireActor } from "@/lib/auth/permissions";
import { VehiclesPage } from "@/components/fleet/pages";

/**
 * Warehouse Admin fleet surface (audit M-4): the shared VehiclesPage
 * with the WA actor. Vehicles are fleet data with no per-warehouse
 * scope by confirmed design (audit L-1 — listVehicles unchanged).
 * WA does NOT hold vehicle.manage, so the component's hasPermission
 * gate hides every vehicle-management control (create, status,
 * documents, maintenance) for WA; what remains is the read list WA
 * needs for crew assignment (vehicle.assign, held).
 */
export default async function Page() {
  const actor = await requireActor();
  return <VehiclesPage actor={actor} />;
}
