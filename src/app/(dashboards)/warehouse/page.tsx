import { requireActor } from "@/lib/auth/permissions";
import { hasPermission } from "@/lib/auth/actor";
import { getRequestedWarehouseScope } from "@/lib/navigation/scope";
import {
  getWarehouse,
  listMembers,
  listWarehouses,
  listZones,
} from "@/server/services/warehouses";
import {
  getWarehouseConsole,
  getWarehouseHomeSummary,
} from "@/server/services/warehouse-home";
import { MembersPanel } from "@/components/warehouses/MembersPanel";
import { WarehouseInfoCard } from "@/components/warehouses/pages";
import { SectionCard } from "@/components/warehouses/ui";
import { ZonesPanel } from "@/components/warehouses/ZonesPanel";
import { WarehouseBookingsPanel } from "@/components/bookings/pages";
import { WarehouseOpsHomePanel } from "@/components/warehouse-ops/pages";
import { TransfersHomePanel } from "@/components/transfers/pages";
import { DeliveriesHomePanel } from "@/components/deliveries/pages";
import {
  WarehouseConsole,
  type WarehouseConsoleAttention,
} from "@/components/warehouse-home/WarehouseConsole";

/**
 * Warehouse Admin home (V3 Step 5, brief §7): the console on top —
 * PageHeader with the scoped warehouse context, needs attention,
 * KPI StatCards, today's operations, incoming/outgoing transfers,
 * packages awaiting action, warehouse tasks and recent activity,
 * all read through getWarehouseConsole over the actor's member
 * warehouses narrowed by the requested scope (the shell selector's
 * cookie, re-validated against the membership list exactly as the
 * shell does — it narrows, never widens). Below the console, the
 * warehouse's own administration (info / members / zones) and the
 * detailed module panels are kept from the previous home. There is
 * no path from here to another warehouse's numbers.
 */

function formatTodayLong(today: string): string {
  const d = new Date(`${today}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return today;
  return d.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

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

  // Requested scope: the shell selector's stored choice, validated
  // against the membership list (same rule as DashboardShell). A
  // valid single-warehouse choice narrows the console to it; any
  // other value leaves the console on all member warehouses.
  const requestedScope = await getRequestedWarehouseScope();
  const scopedWarehouse =
    requestedScope && items.some((w) => w.id === requestedScope)
      ? items.find((w) => w.id === requestedScope)!
      : null;
  const scopeWarehouses = scopedWarehouse ? [scopedWarehouse] : items;

  const details = await Promise.all(
    items.map(async (summary) => {
      const [warehouse, members, zones, home] = await Promise.all([
        getWarehouse(actor, summary.id),
        listMembers(actor, summary.id),
        listZones(actor, summary.id),
        getWarehouseHomeSummary(actor, summary.id),
      ]);
      return { warehouse, members, zones, home };
    }),
  );
  const canAssign = hasPermission(actor, "warehouse.assign_staff");
  const canManageLocations = hasPermission(actor, "warehouse.manage_locations");

  const consoleData = await getWarehouseConsole(
    actor,
    scopeWarehouses.map((w) => w.id),
  );

  // Needs-attention lists, merged from the scoped warehouses' home
  // summaries (the console's counts come from the same summaries).
  const scopeIds = new Set(scopeWarehouses.map((w) => w.id));
  const scopedDetails = details.filter((d) => scopeIds.has(d.warehouse.id));
  const attention: WarehouseConsoleAttention = {
    incidents: scopedDetails.flatMap((d) =>
      d.home.needsAttention.incidents.map((i) => ({
        ...i,
        warehouseCode: d.warehouse.code,
      })),
    ),
    discrepancies: scopedDetails.flatMap((d) =>
      d.home.needsAttention.discrepancies.map((x) => ({
        ...x,
        warehouseCode: d.warehouse.code,
      })),
    ),
    discrepancyTransfers: scopedDetails.reduce(
      (n, d) => n + d.home.needsAttention.discrepancyTransfers,
      0,
    ),
    discrepancyItems: scopedDetails.reduce(
      (n, d) => n + d.home.needsAttention.discrepancyItems,
      0,
    ),
    overdueTasks: scopedDetails.flatMap((d) =>
      d.home.needsAttention.overdueTaskList.map((t) => ({
        ...t,
        warehouseCode: d.warehouse.code,
      })),
    ),
  };

  const scopedDetail = scopedWarehouse
    ? details.find((d) => d.warehouse.id === scopedWarehouse.id)
    : undefined;
  const consoleTitle = scopedDetail
    ? `${scopedDetail.warehouse.name} (${scopedDetail.warehouse.code})`
    : "All my warehouses";
  const consoleSubtitle = scopedDetail
    ? `${scopedDetail.warehouse.city}, ${scopedDetail.warehouse.district} · ${formatTodayLong(consoleData.today)} · Asia/Kathmandu`
    : `${items.length} warehouses · ${formatTodayLong(consoleData.today)} · Asia/Kathmandu`;

  return (
    <div className="flex flex-col gap-5">
      <WarehouseConsole
        actor={actor}
        data={consoleData}
        title={consoleTitle}
        subtitle={consoleSubtitle}
        scopeWarehouseId={scopedWarehouse?.id ?? null}
        attention={attention}
      />

      {/* Warehouse administration (kept from the previous home) */}
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
