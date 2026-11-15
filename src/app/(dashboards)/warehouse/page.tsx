import { requireActor } from "@/lib/auth/permissions";
import { hasPermission } from "@/lib/auth/actor";
import {
  getWarehouse,
  listMembers,
  listWarehouses,
  listZones,
} from "@/server/services/warehouses";
import { MembersPanel } from "@/components/warehouses/MembersPanel";
import { WarehouseInfoCard } from "@/components/warehouses/pages";
import { SectionCard } from "@/components/warehouses/ui";
import { ZonesPanel } from "@/components/warehouses/ZonesPanel";
import { WarehouseBookingsPanel } from "@/components/bookings/pages";
import { WarehouseOpsHomePanel } from "@/components/warehouse-ops/pages";
import { TransfersHomePanel } from "@/components/transfers/pages";
import { DeliveriesHomePanel } from "@/components/deliveries/pages";

/**
 * Warehouse Admin dashboard: the actor's OWN warehouse(s) only — real
 * data from the database, scoped by their active memberships inside the
 * service queries. There is no path from here to another warehouse.
 */
export default async function Page() {
  const actor = await requireActor();
  const { items } = await listWarehouses(actor, { pageSize: 100 });

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-line bg-surface p-6">
        <h1 className="text-[22px] font-bold text-ink">No warehouse assigned</h1>
        <p className="mt-2 max-w-[640px] text-[13px] leading-relaxed text-slate2">
          Your account has no active warehouse membership. Ask an Admin to assign you to a
          warehouse — access begins with the membership, and ends the moment it is removed.
        </p>
      </div>
    );
  }

  const details = await Promise.all(
    items.map(async (summary) => {
      const [warehouse, members, zones] = await Promise.all([
        getWarehouse(actor, summary.id),
        listMembers(actor, summary.id),
        listZones(actor, summary.id),
      ]);
      return { warehouse, members, zones };
    }),
  );
  const canAssign = hasPermission(actor, "warehouse.assign_staff");
  const canManageLocations = hasPermission(actor, "warehouse.manage_locations");

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Warehouse Admin
        </div>
        <h1 className="mt-0.5 text-[22px] font-bold text-ink">
          {details.length === 1
            ? `${details[0].warehouse.name} (${details[0].warehouse.code})`
            : `Your warehouses (${details.length})`}
        </h1>
      </div>

      {details.map(({ warehouse, members, zones }) => (
        <div key={warehouse.id} className="flex flex-col gap-4">
          {details.length > 1 && (
            <h2 className="text-[15px] font-bold text-ink">
              {warehouse.name}{" "}
              <span className="font-mono text-[12px] font-semibold text-slate2">
                {warehouse.code}
              </span>
            </h2>
          )}
          <WarehouseInfoCard warehouse={warehouse} />
          {warehouse.status !== "ACTIVE" && (
            <SectionCard title="Status">
              <p className="text-[13px] text-slate2">
                This warehouse is <strong className="text-ink">{warehouse.status.toLowerCase()}</strong>.
                Operational changes are read-only until an Admin reactivates it.
              </p>
            </SectionCard>
          )}
          <MembersPanel
            warehouseId={warehouse.id}
            members={members}
            canAssign={canAssign}
            canSuspend={false}
            assignableRoles={["WAREHOUSE_STAFF"]}
          />
          <ZonesPanel
            warehouseId={warehouse.id}
            zones={zones}
            canManage={canManageLocations}
          />
        </div>
      ))}

      <WarehouseOpsHomePanel actor={actor} basePath="/warehouse" />
      <TransfersHomePanel actor={actor} basePath="/warehouse" />
      <DeliveriesHomePanel actor={actor} basePath="/warehouse" />
      <WarehouseBookingsPanel actor={actor} basePath="/warehouse" />
      <SectionCard title="Reports">
        <p className="text-[13px] text-slate2">
          Receiving, dispatch, inventory ageing, capacity and driver performance for your
          warehouses — computed from live operational records.
        </p>
        <div className="mt-3">
          <a
            href="/warehouse/reports"
            className="rounded-md border border-line bg-page px-3 py-1.5 text-[12px] font-semibold text-ink"
          >
            Warehouse reports →
          </a>
        </div>
      </SectionCard>
    </div>
  );
}
