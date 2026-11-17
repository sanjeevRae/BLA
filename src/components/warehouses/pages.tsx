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
import { PageHeader } from "@/components/ui/PageHeader";
import { DensityScope } from "@/components/ui/TableDensity";
import {
  TABLE_CLASS,
  TD_CLASS,
  TD_ID_CLASS,
  TD_NUMERIC_CLASS,
  THEAD_ROW_CLASS,
  TH_CLASS,
  TH_NUMERIC_CLASS,
  TR_CLASS,
} from "@/components/ui/table-chrome";
import { InviteUserForm } from "./InviteUserForm";
import { MembersPanel } from "./MembersPanel";
import { StatusActions } from "./StatusActions";
import { WarehouseForm } from "./WarehouseForm";
import { ZonesPanel } from "./ZonesPanel";
import { SectionCard, WarehouseStatusBadge } from "./ui";
import {
  WarehouseSummaryCard,
  WAREHOUSE_TYPE_LABELS as TYPE_LABELS,
} from "./WarehouseSummaryCard";

export { WarehouseSummaryCard } from "./WarehouseSummaryCard";
/** Legacy alias — existing imports (e.g. the warehouse dashboard
 *  home) keep compiling untouched. */
export { WarehouseSummaryCard as WarehouseInfoCard } from "./WarehouseSummaryCard";

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
      <PageHeader
        eyebrow="Operations"
        title="Warehouses"
        description={`${result.total} warehouse${result.total === 1 ? "" : "s"} · page ${result.page} of ${result.totalPages}`}
        actions={
          canCreate ? (
            <Link
              href={`${basePath}/warehouses/new`}
              className="rounded-md bg-primary px-3 py-2 text-[13px] font-semibold text-white"
            >
              New warehouse
            </Link>
          ) : undefined
        }
      />

      <DensityScope showToggle>
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className={TABLE_CLASS}>
            <thead>
              <tr className={THEAD_ROW_CLASS}>
                <th className={`${TH_CLASS} text-left`}>Code</th>
                <th className={`${TH_CLASS} text-left`}>Name</th>
                <th className={`${TH_CLASS} text-left`}>Type</th>
                <th className={`${TH_CLASS} text-left`}>City · District</th>
                <th className={TH_NUMERIC_CLASS}>Members</th>
                <th className={`${TH_CLASS} text-left`}>Status</th>
              </tr>
            </thead>
            <tbody>
              {result.items.map((warehouse) => (
                <tr key={warehouse.id} className={TR_CLASS}>
                  <td className={`${TD_ID_CLASS} font-semibold`}>
                    <Link href={`${basePath}/warehouses/${warehouse.id}`} className="text-primary">
                      {warehouse.code}
                    </Link>
                  </td>
                  <td className={`${TD_CLASS} font-medium`}>{warehouse.name}</td>
                  <td className={`${TD_CLASS} text-ink-2`}>{TYPE_LABELS[warehouse.type] ?? warehouse.type}</td>
                  <td className={`${TD_CLASS} text-ink-2`}>
                    {warehouse.city} · {warehouse.district}
                  </td>
                  <td className={`${TD_NUMERIC_CLASS} text-ink-2`}>{warehouse.memberCount}</td>
                  <td className={TD_CLASS}>
                    <WarehouseStatusBadge status={warehouse.status} />
                  </td>
                </tr>
              ))}
              {result.items.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-6 text-center text-ink-2">
                    No warehouses yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </DensityScope>

      {result.totalPages > 1 && (
        <div className="flex gap-2">
          {result.page > 1 && (
            <Link
              href={`${basePath}/warehouses?page=${result.page - 1}`}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink"
            >
              Previous
            </Link>
          )}
          {result.page < result.totalPages && (
            <Link
              href={`${basePath}/warehouses?page=${result.page + 1}`}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink"
            >
              Next
            </Link>
          )}
        </div>
      )}
    </div>
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
        <Link href={`${basePath}/warehouses`} className="text-[12px] font-semibold text-primary">
          ← All warehouses
        </Link>
        <PageHeader
          title={
            <>
              {warehouse.name}{" "}
              <span className="font-mono text-[14px] font-semibold text-ink-2">
                {warehouse.code}
              </span>
            </>
          }
          className="mt-1"
        />
      </div>

      <WarehouseSummaryCard warehouse={warehouse} />

      {unscoped && (
        <SectionCard title="Status">
          <StatusActions warehouseId={warehouse.id} status={warehouse.status} />
          <p className="mt-2 text-[12px] text-ink-2">
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
