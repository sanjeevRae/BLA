import Link from "next/link";

import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { getStaffMyWork } from "@/server/services/home-dashboards";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/states";

/**
 * Warehouse Staff "My Work" home (V2 Phase 6 slice D, spec §7
 * Warehouse Staff): replaces the Phase-1 placeholder identity card as
 * the lead of /staff. Content is the staff member's own work only —
 * tasks assigned to them (listTasks queue="mine") and the physical
 * queues of their membership warehouses (warehouse-ops summaries +
 * scoped transfer reads, composed in getStaffMyWork). A staff user
 * with no membership gets the honest no-warehouse panel, mirroring
 * the warehouse home's pattern.
 */

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Kathmandu",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function QueueStat({
  label,
  value,
  href,
  hint,
}: {
  label: string;
  value: number;
  href: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="rounded-lg border border-line bg-surface px-4 py-3 hover:border-brand"
    >
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
        {label}
      </div>
      <div className="tnum mt-1 text-[20px] font-bold leading-tight text-ink">{value}</div>
      <div className="mt-0.5 text-[12px] text-slate2">{hint}</div>
    </Link>
  );
}

export async function StaffMyWorkHome({ actor }: { actor: ActorContext }) {
  const work = await getStaffMyWork(actor);

  const quickActions: { href: string; label: string; show: boolean }[] = [
    { href: "/staff/operations", label: "Receive & scan", show: hasPermission(actor, "package.receive") },
    { href: "/staff/arrivals", label: "Arrivals", show: hasPermission(actor, "transfer.receive") },
    { href: "/staff/inventory", label: "Inventory", show: hasPermission(actor, "inventory.read_warehouse") },
    { href: "/staff/transfers", label: "Transfers", show: hasPermission(actor, "transfer.read_warehouse") },
    {
      href: "/staff/deliveries",
      label: "Deliveries",
      show:
        hasPermission(actor, "delivery.assign") ||
        hasPermission(actor, "delivery.read_assigned") ||
        hasPermission(actor, "package.receive"),
    },
    { href: "/staff/handovers", label: "Handovers", show: hasPermission(actor, "custody.read") },
    { href: "/staff/tasks", label: "My tasks", show: hasPermission(actor, "task.update_own") },
    { href: "/staff/incidents", label: "Report an issue", show: hasPermission(actor, "incident.report") },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Warehouse Staff · My Work
        </div>
        <h1 className="mt-0.5 text-[22px] font-bold text-ink">My work</h1>
        <p className="mt-1 text-[13px] text-slate2">
          Welcome, {actor.fullName}
          {work.warehouses.length > 0
            ? ` — ${work.warehouses.map((w) => `${w.name} (${w.code})`).join(", ")}.`
            : "."}{" "}
          Your assigned tasks and the queues at your warehouse(s).
        </p>
      </div>

      {/* My tasks first — the work already assigned to this person. */}
      <SectionCard
        title={`My tasks (${work.myTasksTotal})`}
        action={
          <Link href="/staff/tasks" className={subtleButtonClass}>
            Open task board →
          </Link>
        }
      >
        {work.myOverdueTasks > 0 ? (
          <p className="mb-3 rounded-md bg-redbg px-3 py-2 text-[13px] font-semibold text-reddeep">
            {work.myOverdueTasks} of your task(s) are overdue.
          </p>
        ) : null}
        {work.myTasks.length === 0 ? (
          <EmptyState
            title="No tasks assigned to you"
            description="Tasks assigned to you appear here. Warehouse queues below still show work waiting at your warehouse(s)."
          />
        ) : (
          <div className="grid gap-2">
            {work.myTasks.map((task) => (
              <div
                key={task.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
              >
                <Link href={`/staff/tasks/${task.id}`} className="font-semibold text-brand">
                  {task.title}
                </Link>
                <span className="text-slate2">
                  {task.dueAt ? `Due ${fmtTime(task.dueAt)}` : "No due date"}
                  {task.overdue ? (
                    <strong className="text-reddeep"> · Overdue</strong>
                  ) : null}
                </span>
                <StatusBadge domain="generic" status={task.status} />
                <StatusBadge domain="generic" status={task.priority} />
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      {!work.hasWarehouse ? (
        <div className="rounded-lg border border-line bg-surface p-6">
          <h2 className="text-[15px] font-bold text-ink">No warehouse assigned</h2>
          <p className="mt-2 max-w-[640px] text-[13px] leading-relaxed text-slate2">
            Your account has no active warehouse membership, so there are no warehouse
            queues to show. Ask an Admin to assign you to a warehouse — queue access begins
            with the membership, and ends the moment it is removed.
          </p>
        </div>
      ) : (
        <>
          {/* Queue counts — aggregated across the staff member's
              warehouses, each card linking to the queue itself. */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <QueueStat
              label="Arrivals to receive"
              value={work.totals.arrivalsInbound}
              href="/staff/arrivals"
              hint="Transfers arriving at your warehouse(s)"
            />
            <QueueStat
              label="Awaiting inspection"
              value={work.totals.awaitingInspection}
              href="/staff/operations"
              hint="Received, not yet inspected"
            />
            <QueueStat
              label="In inspection"
              value={work.totals.inInspection}
              href="/staff/operations"
              hint="Record result / put away"
            />
            <QueueStat
              label="Dispatch prep"
              value={work.totals.dispatchPrep}
              href="/staff/operations"
              hint="Sorted / ready for dispatch"
            />
          </div>

          {work.totals.damagedPackages > 0 || work.totals.pendingHandovers > 0 ? (
            <p className="text-[13px] text-slate2">
              Also: <strong className="tnum text-ink">{work.totals.damagedPackages}</strong>{" "}
              damaged package(s) in stock ·{" "}
              <strong className="tnum text-ink">{work.totals.pendingHandovers}</strong>{" "}
              handover(s) pending confirmation.
            </p>
          ) : null}

          {work.perWarehouse.length > 1 ? (
            <SectionCard title="By warehouse">
              <div className="grid gap-2">
                {work.perWarehouse.map((row) => (
                  <div
                    key={row.warehouseId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
                  >
                    <span className="font-semibold text-ink">
                      {row.warehouseName}{" "}
                      <span className="font-mono text-[12px] font-semibold text-slate2">
                        {row.warehouseCode}
                      </span>
                    </span>
                    <span className="text-slate2">
                      <span className="tnum">{row.arrivalsInbound}</span> arriving ·{" "}
                      <span className="tnum">{row.awaitingInspection}</span> awaiting
                      inspection · <span className="tnum">{row.inInspection}</span> in
                      inspection · <span className="tnum">{row.dispatchPrep}</span> dispatch
                      prep · <span className="tnum">{row.openPackages}</span> in stock
                    </span>
                  </div>
                ))}
              </div>
            </SectionCard>
          ) : null}
        </>
      )}

      <SectionCard title="Quick actions">
        <div className="flex flex-wrap gap-2">
          {quickActions
            .filter((action) => action.show)
            .map((action) => (
              <Link key={action.href} href={action.href} className={subtleButtonClass}>
                {action.label} →
              </Link>
            ))}
        </div>
      </SectionCard>
    </div>
  );
}
