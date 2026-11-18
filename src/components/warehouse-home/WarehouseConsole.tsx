import type { ReactNode } from "react";
import Link from "next/link";

import type { ActorContext } from "@/lib/auth/actor";
import { hasPermission } from "@/lib/auth/permissions";
import type {
  WarehouseConsoleData,
  WarehouseConsoleTransferRow,
  WarehouseHomeSummary,
} from "@/server/services/warehouse-home";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { PriorityBadge, StatusBadge } from "@/components/ui/StatusBadge";
import { ToneIcon } from "@/components/ui/ToneIcon";
import { NavIcon } from "@/components/layout/icons";
import type { NavIconName } from "@/lib/navigation/registry";
import { formatDateTime } from "@/components/bookings/ui";
import { humaniseStatusValue } from "@/lib/status/labels";

/**
 * Warehouse Admin console (V3 Step 5, brief §7) — built on the
 * Step 3/4 primitives and the Step 5 read model
 * (`getWarehouseConsole`). Everything is scoped to the actor's
 * member warehouses, narrowed by the requested scope the page
 * resolved; there is no path from here to another warehouse's
 * numbers.
 *
 * Honest-mapping notes:
 * - "Create Return" is OMITTED: returns are initiated per package
 *   from booking/package detail (InitiateReturnForm,
 *   package.return_initiate) — /warehouse/returns is a list with no
 *   create flow, so a create button there would be a placeholder.
 * - Today's operations shows only the stages the daily report
 *   actually counts (received / dispatched / delivered). Inspected,
 *   packed and loaded have no timestamped warehouse-scoped read —
 *   inspections live in audit events, packing is not a lifecycle
 *   stage, and transfer loading has no loaded-at timestamp — so
 *   those stages are omitted, never estimated.
 * - Drill-throughs use only parameters the target page reads:
 *   /warehouse/reports reads from/to/warehouseId filter params;
 *   /warehouse/transfers/new reads `origin`; the operations,
 *   inventory, transfers, arrivals, deliveries, incidents and tasks
 *   pages read no filter params, so their links carry none.
 */

const PRIMARY_LINK =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[14px] font-[550] text-white hover:bg-primary-dark";
const SECONDARY_LINK =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-border-control bg-card px-4 py-2.5 text-[14px] font-[550] text-ink hover:bg-surface-2";

export interface WarehouseConsoleAttention {
  incidents: (WarehouseHomeSummary["needsAttention"]["incidents"][number] & {
    warehouseCode: string;
  })[];
  discrepancies: (WarehouseHomeSummary["needsAttention"]["discrepancies"][number] & {
    warehouseCode: string;
  })[];
  discrepancyTransfers: number;
  discrepancyItems: number;
  overdueTasks: (WarehouseHomeSummary["needsAttention"]["overdueTaskList"][number] & {
    warehouseCode: string;
  })[];
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function TransferTable({
  rows,
  direction,
}: {
  rows: WarehouseConsoleTransferRow[];
  direction: "incoming" | "outgoing";
}) {
  if (rows.length === 0) {
    return (
      <p className="text-[13.5px] text-ink-2">
        {direction === "incoming"
          ? "No open transfers are headed to this scope right now."
          : "No open transfers are leaving this scope right now."}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {[
              "Transfer",
              direction === "incoming" ? "From" : "To",
              "Packages",
              "Driver",
              "Status",
              direction === "incoming" ? "Arrival" : "Departure",
            ].map((header) => (
              <th
                key={header}
                scope="col"
                className="bg-surface-2 px-3 py-2 text-left text-[12px] font-semibold uppercase tracking-wide text-ink-2"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="h-11 border-t border-border hover:bg-surface-2">
              <td className="px-3 py-2 text-table">
                <Link
                  href={`/warehouse/transfers/${row.id}`}
                  className="font-mono font-semibold whitespace-nowrap text-primary hover:text-primary-dark"
                >
                  {row.transferNumber}
                </Link>
              </td>
              <td className="px-3 py-2 text-table text-ink">
                {row.otherWarehouseName}{" "}
                <span className="font-mono text-[12.5px] text-ink-2">
                  {row.otherWarehouseCode}
                </span>
              </td>
              <td className="px-3 py-2 text-table whitespace-nowrap tabular-nums text-ink">
                {row.receivedPackages} / {row.expectedPackages} received
              </td>
              <td className="px-3 py-2 text-table text-ink">
                {row.driverName ?? <span className="text-ink-2">Not assigned</span>}
              </td>
              <td className="px-3 py-2 text-table">
                <StatusBadge domain="generic" status={row.status} density="compact" />
              </td>
              <td className="px-3 py-2 text-table whitespace-nowrap text-ink-2">
                {direction === "incoming"
                  ? row.arrivedAt
                    ? `Arrived ${formatDateTime(row.arrivedAt)}`
                    : row.expectedArrivalAt
                      ? `Expected ${formatDateTime(row.expectedArrivalAt)}`
                      : row.dispatchedAt
                        ? `Dispatched ${formatDateTime(row.dispatchedAt)}`
                        : `Created ${formatDateTime(row.createdAt)}`
                  : row.dispatchedAt
                    ? formatDateTime(row.dispatchedAt)
                    : `Created ${formatDateTime(row.createdAt)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function WarehouseConsole({
  actor,
  data,
  title,
  subtitle,
  scopeWarehouseId,
  attention,
}: {
  actor: ActorContext;
  data: WarehouseConsoleData;
  title: string;
  subtitle: string;
  /** The single scoped warehouse when the scope narrowed to one —
   *  used for the transfer origin + reports warehouse filter. */
  scopeWarehouseId: string | null;
  attention: WarehouseConsoleAttention;
}) {
  const can = (perm: string) => hasPermission(actor, perm as never);
  const { kpis, todaysOps } = data;

  const reportsHref = `/warehouse/reports?from=${data.today}&to=${data.today}${
    scopeWarehouseId ? `&warehouseId=${scopeWarehouseId}` : ""
  }`;
  const createTransferHref = scopeWarehouseId
    ? `/warehouse/transfers/new?origin=${scopeWarehouseId}`
    : "/warehouse/transfers/new";

  const hasAttention =
    attention.incidents.length > 0 ||
    attention.discrepancyTransfers > 0 ||
    attention.overdueTasks.length > 0;

  const quickActions: { label: string; href: string; icon: NavIconName; show: boolean }[] = [
    { label: "Receive Package", href: "/warehouse/operations", icon: "scan", show: can("package.receive") },
    { label: "Create Transfer", href: createTransferHref, icon: "swap", show: can("transfer.create") },
    { label: "Assign Delivery", href: "/warehouse/deliveries/new", icon: "truck", show: can("delivery.assign") },
    { label: "Report Incident", href: "/warehouse/incidents", icon: "alert", show: can("incident.report") },
    { label: "Create Task", href: "/warehouse/tasks", icon: "tasks", show: can("task.create") },
  ];

  const awaitingGroups: {
    label: string;
    count: number | null;
    hint: string;
    href: string;
    show: boolean;
  }[] = [
    {
      label: "Awaiting inspection",
      count: data.awaitingAction.inspection,
      hint: "Receiving & inspection queue",
      href: "/warehouse/operations",
      show: can("inventory.read_warehouse") || can("inventory.read_all"),
    },
    {
      label: "Ready for dispatch",
      count: data.awaitingAction.dispatch,
      hint: "Sorting & dispatch preparation",
      href: "/warehouse/operations",
      show: can("inventory.read_warehouse") || can("inventory.read_all"),
    },
    {
      label: "Awaiting delivery assignment",
      count: data.awaitingAction.deliveryAssignment,
      hint: "Ready packages not yet on a rider's batch",
      href: can("delivery.assign") ? "/warehouse/deliveries/new" : "/warehouse/deliveries",
      show: can("delivery.assign") || can("delivery.read_assigned"),
    },
    {
      label: "Failed delivery attempts today",
      count: data.awaitingAction.failedToday,
      hint: "Attempts recorded today that did not deliver",
      href: "/warehouse/deliveries",
      show: can("delivery.assign") || can("delivery.read_assigned"),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Warehouse Admin"
        title={title}
        description={subtitle}
        actions={
          <>
            {can("package.receive") ? (
              <Link href="/warehouse/operations" className={PRIMARY_LINK}>
                Receive Package
              </Link>
            ) : null}
            {can("transfer.create") ? (
              <Link href={createTransferHref} className={SECONDARY_LINK}>
                Create Transfer
              </Link>
            ) : null}
            {can("delivery.assign") ? (
              <Link href="/warehouse/deliveries/new" className={SECONDARY_LINK}>
                Assign Delivery
              </Link>
            ) : null}
          </>
        }
      />

      {/* Needs attention — incidents, transfer discrepancies, overdue
          tasks, merged from the per-warehouse home summaries. */}
      <Section title="Needs Attention">
        {!hasAttention ? (
          <div className="flex items-center gap-3 rounded-lg bg-successbg px-4 py-3">
            <ToneIcon tone="success" className="h-[18px] w-[18px] text-success" />
            <p className="text-[13.5px] font-medium text-ink">
              All clear — no open incidents, transfer discrepancies or overdue tasks in
              this scope.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {attention.incidents.length > 0 ? (
              <div>
                <h3 className="mb-1 text-[12.5px] font-semibold uppercase tracking-wide text-ink-2">
                  Open incidents ({kpis.openIncidents})
                </h3>
                <ul className="divide-y divide-border">
                  {attention.incidents.map((i) => (
                    <li key={i.id}>
                      <Link
                        href={`/warehouse/incidents/${i.id}`}
                        className="flex flex-wrap items-center gap-2 py-2.5 hover:bg-surface-2"
                      >
                        <span className="font-mono text-[12.5px] font-semibold text-ink">
                          {i.incidentNumber}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                          {humaniseStatusValue(i.category)}
                        </span>
                        <span className="font-mono text-[12.5px] text-ink-2">
                          {i.warehouseCode}
                        </span>
                        <PriorityBadge priority={i.severity} />
                        <StatusBadge domain="generic" status={i.status} density="compact" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {attention.discrepancyTransfers > 0 ? (
              <div>
                <h3 className="mb-1 text-[12.5px] font-semibold uppercase tracking-wide text-ink-2">
                  Transfer discrepancies ({attention.discrepancyTransfers} transfers ·{" "}
                  {attention.discrepancyItems} missing/damaged items)
                </h3>
                <ul className="divide-y divide-border">
                  {attention.discrepancies.map((d) => (
                    <li key={d.id}>
                      <Link
                        href={`/warehouse/transfers/${d.id}`}
                        className="flex flex-wrap items-center gap-2 py-2.5 hover:bg-surface-2"
                      >
                        <span className="font-mono text-[12.5px] font-semibold text-ink">
                          {d.transferNumber}
                        </span>
                        <StatusBadge domain="generic" status={d.status} density="compact" />
                        <span className="text-[13px] text-ink-2">
                          {d.missingCount} missing · {d.damagedCount} damaged ·{" "}
                          {d.totalItems} item(s)
                        </span>
                        <span className="font-mono text-[12.5px] text-ink-2">
                          {d.warehouseCode}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {attention.overdueTasks.length > 0 ? (
              <div>
                <h3 className="mb-1 text-[12.5px] font-semibold uppercase tracking-wide text-ink-2">
                  Overdue tasks ({kpis.overdueTasks})
                </h3>
                <ul className="divide-y divide-border">
                  {attention.overdueTasks.map((t) => (
                    <li key={t.id}>
                      <Link
                        href={`/warehouse/tasks/${t.id}`}
                        className="flex flex-wrap items-center gap-2 py-2.5 hover:bg-surface-2"
                      >
                        <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                          {t.title}
                        </span>
                        <PriorityBadge priority={t.priority} />
                        <span className="text-[12.5px] text-ink-2">
                          {t.assigneeName ?? "Unassigned"}
                          {t.dueAt ? ` · due ${formatDateTime(t.dueAt)}` : ""}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </Section>

      {/* KPI row — every figure from the scoped read model. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
        <StatCard
          label="Received Today"
          value={kpis.receivedToday.toLocaleString("en-IN")}
          context="Packages received into stock today"
          icon={<NavIcon name="inbox" />}
          tint="brand"
          href={can("report.read_warehouse") || can("report.read_all") ? reportsHref : undefined}
        />
        <StatCard
          label="Waiting for Inspection"
          value={kpis.awaitingInspection.toLocaleString("en-IN")}
          context="Received, not yet inspected"
          icon={<NavIcon name="scan" />}
          tint="warning"
          href="/warehouse/operations"
        />
        <StatCard
          label="Ready for Dispatch"
          value={kpis.readyForDispatch.toLocaleString("en-IN")}
          context="Inspected and cleared for dispatch"
          icon={<NavIcon name="package" />}
          tint="info"
          href="/warehouse/operations"
        />
        <StatCard
          label="Outgoing Transfers"
          value={kpis.outgoingTransfers.toLocaleString("en-IN")}
          context="Open transfers leaving this scope"
          icon={<NavIcon name="swap" />}
          tint="info"
          href={can("transfer.read_warehouse") || can("transfer.read_all") ? "/warehouse/transfers" : undefined}
        />
        <StatCard
          label="Incoming Transfers"
          value={kpis.incomingTransfers.toLocaleString("en-IN")}
          context="Dispatched, in transit or arrived here"
          icon={<NavIcon name="truck" />}
          tint="info"
          href={can("transfer.read_warehouse") || can("transfer.read_all") ? "/warehouse/arrivals" : undefined}
        />
        <StatCard
          label="Pending Deliveries"
          value={kpis.pendingDeliveries.toLocaleString("en-IN")}
          context={`${kpis.deliveriesAssignedToday} assigned today · ${kpis.deliveriesDeliveredToday} delivered`}
          icon={<NavIcon name="hand" />}
          tint="warning"
          href="/warehouse/deliveries"
        />
        {kpis.failedDeliveriesToday !== null ? (
          <StatCard
            label="Failed Deliveries"
            value={kpis.failedDeliveriesToday.toLocaleString("en-IN")}
            context="Failed attempts recorded today"
            icon={<NavIcon name="undo" />}
            tint="danger"
            href="/warehouse/deliveries"
          />
        ) : null}
        <StatCard
          label="Inventory Items"
          value={kpis.inventoryItems.toLocaleString("en-IN")}
          context="Packages currently in stock"
          icon={<NavIcon name="boxes" />}
          tint="brand"
          href="/warehouse/inventory"
        />
        <StatCard
          label="Open Incidents"
          value={kpis.openIncidents.toLocaleString("en-IN")}
          context={kpis.openIncidents === 0 ? "All clear" : "Reported and not yet resolved"}
          icon={<NavIcon name="alert" />}
          tint="danger"
          href="/warehouse/incidents"
        />
        <StatCard
          label="Tasks Due Today"
          value={kpis.tasksDueToday.toLocaleString("en-IN")}
          context={`${kpis.overdueTasks} overdue · ${kpis.availableRiders} riders available`}
          icon={<NavIcon name="tasks" />}
          tint="warning"
          href="/warehouse/tasks"
        />
      </div>

      {/* Today's operations — daily-report stages only. */}
      {todaysOps ? (
        <Section
          title="Today's Operations"
          action={
            <span className="text-[12.5px] text-ink-2">
              {data.today} · Asia/Kathmandu
            </span>
          }
        >
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {[
              { label: "Received", value: todaysOps.received, context: "Packages into stock" },
              {
                label: "Dispatched",
                value: todaysOps.dispatchedPackages,
                context: `On ${todaysOps.transfersDispatched} transfer(s)`,
              },
              { label: "Delivered", value: todaysOps.delivered, context: "Proofs of delivery recorded" },
              {
                label: "Failed attempts",
                value: todaysOps.failedAttempts,
                context: "Attempts that did not deliver",
              },
            ].map((stage) => (
              <div key={stage.label}>
                <dt className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-2">
                  {stage.label}
                </dt>
                <dd className="mt-1 text-[24px] font-semibold tabular-nums text-ink">
                  {stage.value.toLocaleString("en-IN")}
                </dd>
                <dd className="text-[12.5px] text-ink-2">{stage.context}</dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}

      {/* Transfers in and out of this scope. */}
      <div className="grid gap-5 xl:grid-cols-2">
        <Section
          title="Incoming Transfers"
          action={
            <Link
              href="/warehouse/arrivals"
              className="text-[13px] font-semibold text-primary hover:text-primary-dark"
            >
              Arrivals →
            </Link>
          }
        >
          <TransferTable rows={data.transfers.incoming} direction="incoming" />
        </Section>
        <Section
          title="Outgoing Transfers"
          action={
            <Link
              href="/warehouse/transfers"
              className="text-[13px] font-semibold text-primary hover:text-primary-dark"
            >
              All transfers →
            </Link>
          }
        >
          <TransferTable rows={data.transfers.outgoing} direction="outgoing" />
        </Section>
      </div>

      {/* Packages awaiting action, grouped by the queue that clears
          each group. */}
      <Section title="Packages Awaiting Action">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {awaitingGroups
            .filter((g) => g.show && g.count !== null)
            .map((g) => (
              <Link
                key={g.label}
                href={g.href}
                className="block rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-primary"
              >
                <span className="block text-[12.5px] font-semibold uppercase tracking-wide text-ink-2">
                  {g.label}
                </span>
                <span className="mt-1 block text-[24px] font-semibold tabular-nums text-ink">
                  {g.count!.toLocaleString("en-IN")}
                </span>
                <span className="mt-0.5 block text-[12.5px] text-ink-2">{g.hint}</span>
              </Link>
            ))}
        </div>
      </Section>

      <div className="grid gap-5 xl:grid-cols-2">
        {/* Warehouse task list — overdue and due today. */}
        <Section
          title="Warehouse Tasks"
          action={
            <Link
              href="/warehouse/tasks"
              className="text-[13px] font-semibold text-primary hover:text-primary-dark"
            >
              Task board →
            </Link>
          }
        >
          {data.tasks.length === 0 ? (
            <p className="text-[13.5px] text-ink-2">
              No overdue or due-today tasks at this scope&apos;s warehouses.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {data.tasks.map((t) => (
                <li key={t.id}>
                  <Link
                    href={`/warehouse/tasks/${t.id}`}
                    className="flex flex-wrap items-center gap-2 py-2.5 hover:bg-surface-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                      {t.title}
                    </span>
                    <PriorityBadge priority={t.priority} />
                    <StatusBadge domain="generic" status={t.status} density="compact" />
                    <span
                      className={`text-[12.5px] ${t.overdue ? "font-medium text-danger" : "text-ink-2"}`}
                    >
                      {t.dueAt
                        ? t.overdue
                          ? `Overdue · due ${formatDateTime(t.dueAt)}`
                          : `Due today · ${formatDateTime(t.dueAt)}`
                        : "No due date"}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Recent warehouse activity — the scoped inventory-movement
            feed from the home summaries. */}
        <Section title="Recent Activity">
          {data.recentMovements.length === 0 ? (
            <p className="text-[13.5px] text-ink-2">
              No inventory movements recorded in this scope yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {data.recentMovements.map((m) => (
                <li key={`${m.warehouseCode}-${m.id}`} className="py-2.5">
                  <div className="flex items-center gap-3">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-ink">
                        {humaniseStatusValue(m.type)}{" "}
                        <span className="font-mono text-[12.5px]">{m.trackingId}</span>
                      </span>
                      <span className="block text-[12.5px] text-ink-2">
                        {m.actorName} · {m.warehouseCode}
                      </span>
                    </span>
                    <span className="shrink-0 text-[12.5px] text-ink-2">
                      {formatDateTime(m.createdAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {/* Quick actions (brief §7 — only actions with real routes). */}
      <Section title="Quick Actions">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
          {quickActions
            .filter((a) => a.show)
            .map((a) => (
              <Link
                key={a.label}
                href={a.href}
                className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-[13.5px] font-medium text-ink hover:border-primary hover:bg-surface-2"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-light text-primary-dark">
                  <NavIcon name={a.icon} />
                </span>
                {a.label}
              </Link>
            ))}
        </div>
      </Section>
    </div>
  );
}
