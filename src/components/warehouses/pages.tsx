import Link from "next/link";
import { notFound } from "next/navigation";

import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { NotFoundError } from "@/lib/errors";
import {
  getWarehouse,
  listMembers,
  listWarehouses,
  listZones,
  type WarehouseView,
} from "@/server/services/warehouses";
import { InviteUserForm } from "./InviteUserForm";
import { MembersPanel } from "./MembersPanel";
import { StatusActions } from "./StatusActions";
import { WarehouseForm } from "./WarehouseForm";
import { ZonesPanel } from "./ZonesPanel";
import { DAY_NAMES, SectionCard, WarehouseStatusBadge, formatMinutes } from "./ui";

const TYPE_LABELS: Record<string, string> = {
  MAIN: "Main warehouse",
  REGIONAL: "Regional warehouse",
  LOCAL_HUB: "Local delivery hub",
  COLLECTION_CENTER: "Collection center",
  RETURN_CENTER: "Return processing center",
};

export async function WarehousesListPage({
  actor,
  basePath,
  page,
}: {
  actor: ActorContext;
  basePath: string;
  page: number;
}) {
  const result = await listWarehouses(actor, { page, pageSize: 20 });
  const canCreate = hasPermission(actor, "warehouse.create");
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
            Operations
          </div>
          <h1 className="mt-0.5 text-[22px] font-bold text-ink">Warehouses</h1>
          <p className="text-[13px] text-slate2">
            {result.total} warehouse{result.total === 1 ? "" : "s"} · page {result.page} of{" "}
            {result.totalPages}
          </p>
        </div>
        {canCreate && (
          <Link
            href={`${basePath}/warehouses/new`}
            className="rounded-md bg-brand px-3 py-2 text-[13px] font-semibold text-white"
          >
            New warehouse
          </Link>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="border-b border-line bg-page text-[11px] uppercase tracking-[0.14em] text-slate2">
              <th className="px-4 py-2.5 font-semibold">Code</th>
              <th className="px-4 py-2.5 font-semibold">Name</th>
              <th className="px-4 py-2.5 font-semibold">Type</th>
              <th className="px-4 py-2.5 font-semibold">City · District</th>
              <th className="px-4 py-2.5 font-semibold">Members</th>
              <th className="px-4 py-2.5 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((warehouse) => (
              <tr key={warehouse.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2.5 font-mono text-[12px] font-semibold">
                  <Link href={`${basePath}/warehouses/${warehouse.id}`} className="text-brand">
                    {warehouse.code}
                  </Link>
                </td>
                <td className="px-4 py-2.5 font-medium text-ink">{warehouse.name}</td>
                <td className="px-4 py-2.5 text-slate2">{TYPE_LABELS[warehouse.type] ?? warehouse.type}</td>
                <td className="px-4 py-2.5 text-slate2">
                  {warehouse.city} · {warehouse.district}
                </td>
                <td className="tnum px-4 py-2.5 text-slate2">{warehouse.memberCount}</td>
                <td className="px-4 py-2.5">
                  <WarehouseStatusBadge status={warehouse.status} />
                </td>
              </tr>
            ))}
            {result.items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate2">
                  No warehouses yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {result.totalPages > 1 && (
        <div className="flex gap-2">
          {result.page > 1 && (
            <Link
              href={`${basePath}/warehouses?page=${result.page - 1}`}
              className="rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink"
            >
              Previous
            </Link>
          )}
          {result.page < result.totalPages && (
            <Link
              href={`${basePath}/warehouses?page=${result.page + 1}`}
              className="rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink"
            >
              Next
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

export function WarehouseInfoCard({ warehouse }: { warehouse: WarehouseView }) {
  const rows: Array<[string, string]> = [
    ["Code", warehouse.code],
    ["Type", TYPE_LABELS[warehouse.type] ?? warehouse.type],
    ["District", warehouse.district],
    ["City", warehouse.city],
    ["Province", warehouse.province],
    ["Address", [warehouse.address?.addressLine1, warehouse.address?.addressLine2].filter(Boolean).join(", ") || "—"],
    ["Postal code", warehouse.address?.postalCode ?? "—"],
    [
      "Coordinates",
      warehouse.address?.latitude && warehouse.address?.longitude
        ? `${warehouse.address.latitude}, ${warehouse.address.longitude}`
        : "—",
    ],
    ["Contact number", warehouse.contactPhone ?? "—"],
    ["Email", warehouse.email ?? "—"],
    [
      "Capacity",
      warehouse.capacityPackages != null ? `${warehouse.capacityPackages} packages` : "Not configured",
    ],
  ];
  return (
    <SectionCard
      title="Warehouse details"
      action={<WarehouseStatusBadge status={warehouse.status} />}
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 border-b border-line py-1.5 last:border-0">
            <dt className="text-[12px] font-medium text-slate2">{label}</dt>
            <dd className="text-right text-[13px] font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Operating hours
        </div>
        <div className="flex flex-wrap gap-1.5">
          {warehouse.hours.map((h) => (
            <span
              key={h.dayOfWeek}
              className="rounded-md border border-line px-2 py-1 text-[11px] text-slate2"
            >
              <span className="font-semibold text-ink">{DAY_NAMES[h.dayOfWeek]}</span>{" "}
              {h.isClosed ? "Closed" : `${formatMinutes(h.opensAt)}–${formatMinutes(h.closesAt)}`}
            </span>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

export async function WarehouseDetailPage({
  actor,
  basePath,
  warehouseId,
}: {
  actor: ActorContext;
  basePath: string;
  warehouseId: string;
}) {
  let warehouse: WarehouseView;
  try {
    warehouse = await getWarehouse(actor, warehouseId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const [members, zones] = await Promise.all([
    listMembers(actor, warehouseId),
    listZones(actor, warehouseId),
  ]);
  const unscoped = hasPermission(actor, "warehouse.read_all");
  const canEdit = hasPermission(actor, "warehouse.update");
  const canAssign = hasPermission(actor, "warehouse.assign_staff");
  const canManageLocations = hasPermission(actor, "warehouse.manage_locations");
  const canSuspend = hasPermission(actor, "user.manage");
  const canInvite = hasPermission(actor, "user.invite");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Link href={`${basePath}/warehouses`} className="text-[12px] font-semibold text-brand">
          ← All warehouses
        </Link>
        <h1 className="mt-1 text-[22px] font-bold text-ink">
          {warehouse.name}{" "}
          <span className="font-mono text-[14px] font-semibold text-slate2">{warehouse.code}</span>
        </h1>
      </div>

      <WarehouseInfoCard warehouse={warehouse} />

      {unscoped && (
        <SectionCard title="Status">
          <StatusActions warehouseId={warehouse.id} status={warehouse.status} />
          <p className="mt-2 text-[12px] text-faint">
            Activation requires an assigned Warehouse Admin. Warehouses are deactivated, never
            deleted.
          </p>
        </SectionCard>
      )}

      {canEdit && (
        <SectionCard title="Edit warehouse">
          <WarehouseForm basePath={basePath} warehouse={warehouse} />
        </SectionCard>
      )}

      <MembersPanel
        warehouseId={warehouse.id}
        members={members}
        canAssign={canAssign}
        canSuspend={canSuspend}
        assignableRoles={unscoped ? ["WAREHOUSE_ADMIN", "WAREHOUSE_STAFF"] : ["WAREHOUSE_STAFF"]}
      />

      {canInvite && <InviteUserForm warehouseId={warehouse.id} />}

      <ZonesPanel warehouseId={warehouse.id} zones={zones} canManage={canManageLocations} />
    </div>
  );
}
