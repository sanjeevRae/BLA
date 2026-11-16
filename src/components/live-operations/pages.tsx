import type { ActorContext } from "@/lib/auth/actor";
import { getRequestedWarehouseScope } from "@/lib/navigation/scope";
import { listWarehouses } from "@/server/services/warehouses";
import { LiveOperationsBoard } from "@/components/live-operations/LiveOperationsBoard";
import type {
  WarehouseCoordsMap,
  WarehouseOption,
} from "@/components/live-operations/types";

/**
 * Live Operations page (V2 Phase 5) — shared by the admin,
 * super-admin and warehouse dashboards. Server half: resolves the
 * actor's warehouse options + coordinates and the requested-scope
 * cookie, then hands serializable props to the client board.
 *
 * Warehouse coordinates: the Warehouse model itself carries NO
 * latitude/longitude. Coordinates live on WarehouseAddress
 * (PRIMARY address, Decimal lat/lng) and are exposed by the
 * warehouse service's view (`address.latitude/longitude`). Only
 * warehouses with a geocoded primary address get a marker —
 * coordinates are never invented or approximated.
 *
 * Scope: global actors (warehouse.read_all) get every warehouse as
 * an option; scoped actors get their memberships — listWarehouses
 * applies that scoping inside its own query, and the live-operations
 * API re-intersects any requested warehouseId with the actor's
 * authority on every fetch, so these options are display only.
 */
export async function LiveOperationsPage({
  actor,
  basePath,
}: {
  actor: ActorContext;
  basePath: string;
}) {
  const { items } = await listWarehouses(actor, { pageSize: 100 });

  const warehouseOptions: WarehouseOption[] = items.map((warehouse) => ({
    id: warehouse.id,
    code: warehouse.code,
    name: warehouse.name,
  }));

  const warehouseCoords: WarehouseCoordsMap = {};
  for (const warehouse of items) {
    const latitude = warehouse.address?.latitude
      ? Number(warehouse.address.latitude)
      : null;
    const longitude = warehouse.address?.longitude
      ? Number(warehouse.address.longitude)
      : null;
    if (
      latitude !== null &&
      longitude !== null &&
      Number.isFinite(latitude) &&
      Number.isFinite(longitude)
    ) {
      warehouseCoords[warehouse.id] = {
        latitude,
        longitude,
        code: warehouse.code,
        name: warehouse.name,
      };
    }
  }

  const requestedScope = await getRequestedWarehouseScope();

  return (
    <LiveOperationsBoard
      basePath={basePath}
      permissions={[...actor.permissions]}
      warehouseOptions={warehouseOptions}
      warehouseCoords={warehouseCoords}
      initialWarehouseId={requestedScope}
    />
  );
}
