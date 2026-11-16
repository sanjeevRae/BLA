import Link from "next/link";

import { requireActor } from "@/lib/auth/permissions";
import { hasPermission } from "@/lib/auth/actor";
import {
  getWarehouse,
  listMembers,
  listWarehouses,
  listZones,
} from "@/server/services/warehouses";
import { getWarehouseHomeSummary } from "@/server/services/warehouse-home";
import { MembersPanel } from "@/components/warehouses/MembersPanel";
import { WarehouseInfoCard } from "@/components/warehouses/pages";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { ZonesPanel } from "@/components/warehouses/ZonesPanel";
import { WarehouseBookingsPanel } from "@/components/bookings/pages";
import { WarehouseOpsHomePanel } from "@/components/warehouse-ops/pages";
import { TransfersHomePanel } from "@/components/transfers/pages";
import { DeliveriesHomePanel } from "@/components/deliveries/pages";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/states";

/**
 * Warehouse Admin dashboard (V2 Phase 6, spec §7 + §10.6 universal
 * home pattern): needs attention → current operations (4–6 metrics)
 * → quick actions → recent activity, all single-warehouse scoped via
 * getWarehouseHomeSummary, then the warehouse's own administration
 * (info / members / zones) and the detailed module panels. There is
 * no path from here to another warehouse's numbers.
 */

function MetricCard({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
        {label}
      </div>
      <div className="tnum mt-1 text-[22px] font-bold text-ink">{value}</div>
      {hint ? <div className="mt-0.5 text-[12px] text-slate2">{hint}</div> : null}
    </div>
  );
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

  // Quick actions — existing routes only, permission-filtered.
  const quickActions: { label: string; href: string; show: boolean }[] = [
    { label: "Receive & scan", href: "/warehouse/operations", show: hasPermission(actor, "package.receive") },
    { label: "New booking", href: "/warehouse/bookings/new", show: hasPermission(actor, "booking.create") },
    { label: "New transfer", href: "/warehouse/transfers/new", show: hasPermission(actor, "transfer.create") },
    { label: "Arrivals", href: "/warehouse/arrivals", show: hasPermission(actor, "transfer.receive") },
    { label: "Assign rider / new batch", href: "/warehouse/deliveries/new", show: hasPermission(actor, "delivery.assign") },
    { label: "Live operations", href: "/warehouse/live-operations", show: hasPermission(actor, "operations.live_view") },
    { label: "Report discrepancy", href: "/warehouse/incidents", show: hasPermission(actor, "incident.report") },
    { label: "Inventory", href: "/warehouse/inventory", show: hasPermission(actor, "inventory.read_warehouse") },
    { label: "Drivers", href: "/warehouse/drivers", show: hasPermission(actor, "driver.manage") || hasPermission(actor, "driver.assign") },
    { label: "Vehicles", href: "/warehouse/vehicles", show: hasPermission(actor, "vehicle.assign") },
  ];

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

      {details.map(({ warehouse, members, zones, home }) => {
        const attention = home.needsAttention;
        const hasAttention =
          attention.openIncidents > 0 ||
          attention.discrepancyTransfers > 0 ||
          attention.overdueTasks > 0;
        return (
          <div key={warehouse.id} className="flex flex-col gap-4">
            {details.length > 1 && (
              <h2 className="text-[15px] font-bold text-ink">
                {warehouse.name}{" "}
                <span className="font-mono text-[12px] font-semibold text-slate2">
                  {warehouse.code}
                </span>
              </h2>
            )}

            {/* 1 — Needs attention */}
            <SectionCard title="Needs attention">
              {!hasAttention ? (
                <EmptyState
                  title="Nothing needs attention"
                  description="No open incidents, transfer discrepancies or overdue tasks at this warehouse."
                />
              ) : (
                <div className="flex flex-col gap-3">
                  {attention.openIncidents > 0 ? (
                    <div>
                      <p className="text-[13px] font-semibold text-ink">
                        {attention.openIncidents} open incident(s)
                      </p>
                      <div className="mt-1.5 flex flex-col gap-1.5">
                        {attention.incidents.map((i) => (
                          <div
                            key={i.id}
                            className="flex flex-wrap items-center gap-2 text-[13px]"
                          >
                            <Link
                              href={`/warehouse/incidents/${i.id}`}
                              className="font-mono font-semibold text-brand"
                            >
                              {i.incidentNumber}
                            </Link>
                            <span className="text-ink">{i.category.replaceAll("_", " ")}</span>
                            <StatusBadge domain="generic" status={i.severity} />
                            <StatusBadge domain="generic" status={i.status} />
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {attention.discrepancyTransfers > 0 ? (
                    <div>
                      <p className="text-[13px] font-semibold text-ink">
                        {attention.discrepancyTransfers} transfer(s) with discrepancies ·{" "}
                        {attention.discrepancyItems} missing/damaged item(s) awaiting action
                      </p>
                      <div className="mt-1.5 flex flex-col gap-1.5">
                        {attention.discrepancies.map((d) => (
                          <div
                            key={d.id}
                            className="flex flex-wrap items-center gap-2 text-[13px]"
                          >
                            <Link
                              href={`/warehouse/transfers/${d.id}`}
                              className="font-mono font-semibold text-brand"
                            >
                              {d.transferNumber}
                            </Link>
                            <StatusBadge domain="generic" status={d.status} />
                            <span className="text-slate2">
                              {d.missingCount} missing · {d.damagedCount} damaged ·{" "}
                              {d.totalItems} item(s)
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  {attention.overdueTasks > 0 ? (
                    <div>
                      <p className="text-[13px] font-semibold text-ink">
                        {attention.overdueTasks} overdue task(s)
                      </p>
                      <div className="mt-1.5 flex flex-col gap-1.5">
                        {attention.overdueTaskList.map((t) => (
                          <div
                            key={t.id}
                            className="flex flex-wrap items-center gap-2 text-[13px]"
                          >
                            <Link
                              href={`/warehouse/tasks/${t.id}`}
                              className="font-semibold text-brand"
                            >
                              {t.title}
                            </Link>
                            <StatusBadge domain="generic" status={t.priority} />
                            <span className="text-slate2">
                              {t.assigneeName ?? "Unassigned"}
                              {t.dueAt
                                ? ` · due ${new Date(t.dueAt).toLocaleDateString("en-GB")}`
                                : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              )}
            </SectionCard>

            {/* 2 — Current operations: 6 metrics */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <MetricCard label="Received today" value={home.metrics.receivedToday} />
              <MetricCard label="Packages at warehouse" value={home.metrics.packagesAtWarehouse} />
              <MetricCard label="Awaiting inspection" value={home.metrics.awaitingInspection} />
              <MetricCard label="Ready for dispatch" value={home.metrics.readyForDispatch} />
              <MetricCard
                label="Incoming transfers"
                value={home.metrics.incomingTransfers}
                hint={`${home.metrics.outgoingTransfers} outgoing open`}
              />
              <MetricCard label="Available riders" value={home.availableRiders} />
            </div>

            <SectionCard title="Current operations">
              <p className="text-[13px] text-slate2">
                Local deliveries today:{" "}
                <strong className="text-ink">{home.deliveriesToday.assigned} assigned</strong> ·{" "}
                <strong className="text-ink">{home.deliveriesToday.delivered} delivered</strong> ·{" "}
                <strong className="text-ink">{home.deliveriesToday.remaining} remaining</strong>{" "}
                across {home.deliveriesToday.batches} batch(es). Incoming transfers in transit:{" "}
                <strong className="text-ink">{home.metrics.incomingTransfers}</strong> · Outgoing
                open: <strong className="text-ink">{home.metrics.outgoingTransfers}</strong>.
              </p>
            </SectionCard>

            {/* 3 — What to do next */}
            <SectionCard title="Quick actions">
              <div className="flex flex-wrap gap-2">
                {quickActions
                  .filter((a) => a.show)
                  .map((a) => (
                    <Link key={a.href} href={a.href} className={subtleButtonClass}>
                      {a.label}
                    </Link>
                  ))}
              </div>
            </SectionCard>

            {/* 4 — What recently changed */}
            <SectionCard title="Recent activity">
              {home.recentMovements.length === 0 ? (
                <p className="text-[13px] text-slate2">
                  No inventory movements recorded at this warehouse yet.
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {home.recentMovements.map((m) => (
                    <div key={m.id} className="text-[13px] text-slate2">
                      <span className="font-semibold text-ink">
                        {m.type.replaceAll("_", " ")}
                      </span>{" "}
                      <span className="font-mono">{m.trackingId}</span> · {m.actorName} ·{" "}
                      {new Date(m.createdAt).toLocaleString("en-GB")}
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>

            {/* Warehouse administration (kept from the previous home) */}
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
        );
      })}

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
