import type { ReactNode } from "react";
import Link from "next/link";

import type { StaffWorkConsoleData } from "@/server/services/home-dashboards";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { PriorityBadge, StatusBadge } from "@/components/ui/StatusBadge";
import { ToneIcon } from "@/components/ui/ToneIcon";
import { EmptyState } from "@/components/ui/states";
import { NavIcon } from "@/components/layout/icons";
import type { NavIconName } from "@/lib/navigation/registry";
import { formatDateTime } from "@/components/bookings/ui";
import { humaniseStatusValue } from "@/lib/status/labels";

/**
 * Warehouse Staff work console — presentational view (V3 Step 5,
 * brief §8). Pure rendering of `StaffWorkConsoleData` plus the
 * caller's permission flags; the async container
 * (`StaffWorkConsole`) owns the reads. NO FINANCE: the read model
 * carries no money fields and this view renders no currency.
 *
 * Scan-action → route mapping (verified against the staff tree —
 * there is no standalone scan page; receiving, scanning and
 * inspection all live in the Operations flow, whose page title is
 * "Receiving, inspection & sorting" and whose receiving form is
 * "Receive a parcel (scan or type the tracking ID)"):
 * - Receive Package → /staff/operations (the receiving form)
 * - Scan Package    → /staff/operations (the same scan-or-type form —
 *                     labelled honestly below as the scan entry point
 *                     of that flow, not a separate scan screen)
 * - Inspect Package → /staff/operations (the inspection queue with
 *                     start/record-inspection actions lives there)
 * - Report an Issue → /staff/incidents (the existing incidents queue)
 */

export const STAFF_HOME_ROUTES = {
  tasks: "/staff/tasks",
  taskDetail: (id: string) => `/staff/tasks/${id}`,
  operations: "/staff/operations",
  arrivals: "/staff/arrivals",
  inventory: "/staff/inventory",
  deliveries: "/staff/deliveries",
  handovers: "/staff/handovers",
  incidents: "/staff/incidents",
} as const;

export interface StaffHomeAction {
  key: string;
  label: string;
  hint: string;
  href: string;
  icon: NavIconName;
  primary?: boolean;
}

/** The big floor actions, in floor order. `show` is resolved by the
 *  container from the actor's real permissions. */
export function staffHomeActions(flags: {
  canReceive: boolean;
  canInspect: boolean;
  canReportIssue: boolean;
}): StaffHomeAction[] {
  const actions: (StaffHomeAction & { show: boolean })[] = [
    {
      key: "receive",
      label: "Receive Package",
      hint: "Receiving desk — scan or type the tracking ID",
      href: STAFF_HOME_ROUTES.operations,
      icon: "inbox",
      primary: true,
      show: flags.canReceive,
    },
    {
      key: "scan",
      label: "Scan Package",
      hint: "Same receiving flow — the scan field is the first step",
      href: STAFF_HOME_ROUTES.operations,
      icon: "scan",
      primary: true,
      show: flags.canReceive,
    },
    {
      key: "inspect",
      label: "Inspect Package",
      hint: "Inspection queue — start or record an inspection",
      href: STAFF_HOME_ROUTES.operations,
      icon: "package",
      primary: true,
      show: flags.canInspect,
    },
    {
      key: "report",
      label: "Report an Issue",
      hint: "Damaged, missing or problem packages",
      href: STAFF_HOME_ROUTES.incidents,
      icon: "alert",
      show: flags.canReportIssue,
    },
  ];
  return actions.filter((a) => a.show);
}

const ACTION_BASE =
  "flex min-h-[48px] items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors";
const ACTION_PRIMARY =
  "bg-primary text-white hover:bg-primary-dark";
const ACTION_SECONDARY =
  "border border-border-control bg-card text-ink hover:bg-surface-2";

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

const SECTION_LINK =
  "text-[13px] font-semibold text-primary hover:text-primary-dark";

function relativeFromNow(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDateTime(iso);
}

export function StaffWorkConsoleView({
  data,
  actorName,
  actions,
}: {
  data: StaffWorkConsoleData;
  actorName: string;
  actions: StaffHomeAction[];
}) {
  const { totals } = data;
  const warehouseLine =
    data.warehouses.length > 0
      ? data.warehouses.map((w) => `${w.name} (${w.code})`).join(", ")
      : null;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Warehouse Staff · Work Console"
        title="My work"
        description={
          warehouseLine
            ? `Welcome, ${actorName} — ${warehouseLine}. Your assigned tasks first, then the queues at your warehouse(s).`
            : `Welcome, ${actorName}. Your assigned tasks are below.`
        }
      />

      {/* Big floor actions — ≥48px touch targets (DS §9 field rules). */}
      {actions.length > 0 ? (
        <div
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
          data-testid="staff-home-actions"
        >
          {actions.map((action) => (
            <Link
              key={action.key}
              href={action.href}
              className={`${ACTION_BASE} ${action.primary ? ACTION_PRIMARY : ACTION_SECONDARY}`}
            >
              <span
                aria-hidden="true"
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  action.primary ? "bg-white/15 text-white" : "bg-primary-light text-primary-dark"
                }`}
              >
                <NavIcon name={action.icon} />
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] font-semibold leading-tight">
                  {action.label}
                </span>
                <span
                  className={`mt-0.5 block text-[12.5px] leading-snug ${
                    action.primary ? "text-white/85" : "text-ink-2"
                  }`}
                >
                  {action.hint}
                </span>
              </span>
            </Link>
          ))}
        </div>
      ) : null}

      {/* 1 — Assigned tasks LEAD the console, in the task service's
          own order (next task first); never re-sorted here. */}
      <Section
        title={`My tasks (${data.myTasksTotal})`}
        action={
          data.myTasksTotal > data.myTasks.length ? (
            <Link href={STAFF_HOME_ROUTES.tasks} className={SECTION_LINK}>
              View all {data.myTasksTotal} tasks →
            </Link>
          ) : (
            <Link href={STAFF_HOME_ROUTES.tasks} className={SECTION_LINK}>
              Open task board →
            </Link>
          )
        }
      >
        {data.myOverdueTasks > 0 ? (
          <p className="mb-3 flex items-center gap-2 rounded-lg bg-dangerbg px-3 py-2 text-[13.5px] font-semibold text-danger">
            <ToneIcon tone="danger" />
            {data.myOverdueTasks} of your task(s) are overdue — they lead the list below.
          </p>
        ) : null}
        {data.myTasks.length === 0 ? (
          <EmptyState
            title="No tasks assigned to you"
            description="Tasks assigned to you appear here, next task first. The warehouse queues below still show work waiting at your warehouse(s)."
          />
        ) : (
          <ol className="divide-y divide-border" data-testid="staff-task-queue">
            {data.myTasks.map((task, index) => (
              <li key={task.id}>
                <Link
                  href={STAFF_HOME_ROUTES.taskDetail(task.id)}
                  className="flex min-h-[48px] flex-wrap items-center gap-x-3 gap-y-1 py-2.5 hover:bg-surface-2"
                >
                  <span className="w-14 shrink-0 text-[12.5px] font-semibold uppercase tracking-wide text-ink-2">
                    {index === 0 ? "Next up" : `Task ${index + 1}`}
                  </span>
                  <span className="min-w-0 flex-1 break-words text-[14px] font-medium text-ink">
                    {task.title}
                  </span>
                  <PriorityBadge priority={task.priority} />
                  <StatusBadge domain="generic" status={task.status} />
                  <span
                    className={`shrink-0 text-[12.5px] ${
                      task.overdue ? "font-semibold text-danger" : "text-ink-2"
                    }`}
                  >
                    {task.dueAt ? `Due ${formatDateTime(task.dueAt)}` : "No due date"}
                    {task.overdue ? " · Overdue" : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {!data.hasWarehouse ? (
        <section className="rounded-lg border border-border bg-card p-5">
          <h2 className="text-[15px] font-semibold text-ink">No warehouse assigned</h2>
          <p className="mt-2 max-w-[640px] text-[13.5px] leading-relaxed text-ink-2">
            Your account has no active warehouse membership, so there are no warehouse
            queues to show. Ask an Admin to assign you to a warehouse — queue access
            begins with the membership, and ends the moment it is removed. Your tasks
            above still show.
          </p>
        </section>
      ) : (
        <>
          {/* 3 — Work summary. Only "Received today" is a real
              today-scoped read (warehouse-home aggregate); the rest
              are LIVE queue totals, labelled as current queues —
              never as "today". */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
            {data.receivedToday !== null ? (
              <StatCard
                label="Received Today"
                value={data.receivedToday.toLocaleString("en-IN")}
                context="Packages received at your warehouse(s) today"
                icon={<NavIcon name="inbox" />}
                tint="success"
                href={STAFF_HOME_ROUTES.operations}
              />
            ) : null}
            <StatCard
              label="Awaiting Inspection"
              value={totals.awaitingInspection.toLocaleString("en-IN")}
              context="Current queue — received, not yet inspected"
              icon={<NavIcon name="package" />}
              tint="warning"
              href={STAFF_HOME_ROUTES.operations}
            />
            <StatCard
              label="In Inspection"
              value={totals.inInspection.toLocaleString("en-IN")}
              context="Current queue — record result / put away"
              icon={<NavIcon name="scan" />}
              tint="info"
              href={STAFF_HOME_ROUTES.operations}
            />
            <StatCard
              label="Dispatch Prep"
              value={totals.dispatchPrep.toLocaleString("en-IN")}
              context="Current queue — sorted / ready for dispatch"
              icon={<NavIcon name="boxes" />}
              tint="brand"
              href={STAFF_HOME_ROUTES.deliveries}
            />
            <StatCard
              label="Arrivals to Receive"
              value={totals.arrivalsInbound.toLocaleString("en-IN")}
              context="Current queue — transfers arriving at your warehouse(s)"
              icon={<NavIcon name="truck" />}
              tint="info"
              href={STAFF_HOME_ROUTES.arrivals}
            />
          </div>

          {(totals.damagedPackages > 0 || totals.pendingHandovers > 0) ? (
            <p className="text-[13.5px] text-ink-2">
              Also needs attention:{" "}
              <strong className="font-semibold tabular-nums text-ink">
                {totals.damagedPackages}
              </strong>{" "}
              damaged package(s) in stock ·{" "}
              <strong className="font-semibold tabular-nums text-ink">
                {totals.pendingHandovers}
              </strong>{" "}
              handover(s) pending confirmation.{" "}
              <Link href={STAFF_HOME_ROUTES.handovers} className={SECTION_LINK}>
                Open handovers →
              </Link>
            </p>
          ) : null}

          {/* 4 + 5 — Per-warehouse queues: arrivals to process and
              packages requiring action, each row linking to the
              queue page that works it. */}
          <Section title="Packages requiring action — by warehouse">
            <ul className="divide-y divide-border">
              {data.perWarehouse.map((row) => (
                <li key={row.warehouseId} className="py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[14px] font-semibold text-ink">
                      {row.warehouseName}
                    </span>
                    <span className="font-mono text-[12.5px] font-semibold text-ink-2">
                      {row.warehouseCode}
                    </span>
                    <span className="text-[12.5px] text-ink-2">
                      {row.openPackages} package(s) in stock
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Link
                      href={STAFF_HOME_ROUTES.arrivals}
                      className="inline-flex min-h-[48px] items-center gap-2 rounded-lg border border-border-control bg-card px-3 py-2 text-[13px] font-medium text-ink hover:bg-surface-2"
                    >
                      Arrivals to process
                      <strong className="tabular-nums">{row.arrivalsInbound}</strong>
                    </Link>
                    <Link
                      href={STAFF_HOME_ROUTES.operations}
                      className="inline-flex min-h-[48px] items-center gap-2 rounded-lg border border-border-control bg-card px-3 py-2 text-[13px] font-medium text-ink hover:bg-surface-2"
                    >
                      Awaiting inspection
                      <strong className="tabular-nums">{row.awaitingInspection}</strong>
                    </Link>
                    <Link
                      href={STAFF_HOME_ROUTES.operations}
                      className="inline-flex min-h-[48px] items-center gap-2 rounded-lg border border-border-control bg-card px-3 py-2 text-[13px] font-medium text-ink hover:bg-surface-2"
                    >
                      In inspection
                      <strong className="tabular-nums">{row.inInspection}</strong>
                    </Link>
                    <Link
                      href={STAFF_HOME_ROUTES.operations}
                      className="inline-flex min-h-[48px] items-center gap-2 rounded-lg border border-border-control bg-card px-3 py-2 text-[13px] font-medium text-ink hover:bg-surface-2"
                    >
                      Dispatch prep
                      <strong className="tabular-nums">{row.dispatchPrep}</strong>
                    </Link>
                    <Link
                      href={STAFF_HOME_ROUTES.inventory}
                      className="inline-flex min-h-[48px] items-center gap-2 rounded-lg border border-border-control bg-card px-3 py-2 text-[13px] font-medium text-ink hover:bg-surface-2"
                    >
                      Inventory
                      <strong className="tabular-nums">{row.openPackages}</strong>
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </Section>

          {/* 5 (cont.) — the two headline work queues as cards:
              transfer arrivals to process + delivery batches to
              prepare (dispatch-prep packages feed those batches). */}
          <div className="grid gap-4 md:grid-cols-2">
            <Section
              title="Transfer arrivals to process"
              action={
                <Link href={STAFF_HOME_ROUTES.arrivals} className={SECTION_LINK}>
                  Open arrivals →
                </Link>
              }
            >
              <p className="text-[14px] text-ink">
                <strong className="text-[20px] font-semibold tabular-nums">
                  {totals.arrivalsInbound}
                </strong>{" "}
                transfer(s) in the receiving window at your warehouse(s) — receive and
                reconcile them from the arrivals queue.
              </p>
            </Section>
            <Section
              title="Delivery batches to prepare"
              action={
                <Link href={STAFF_HOME_ROUTES.deliveries} className={SECTION_LINK}>
                  Open deliveries →
                </Link>
              }
            >
              <p className="text-[14px] text-ink">
                <strong className="text-[20px] font-semibold tabular-nums">
                  {totals.dispatchPrep}
                </strong>{" "}
                package(s) sorted or ready for dispatch — finish dispatch prep in
                operations, then build the delivery batches.
              </p>
            </Section>
          </div>

          {/* 6 — Recent activity: the warehouse-scoped movement feed
              (member warehouses only, no finance fields). */}
          <Section title="Recent activity at your warehouse(s)">
            {data.recentActivity.length === 0 ? (
              <p className="text-[13.5px] text-ink-2">
                No package movements recorded yet at your warehouse(s).
              </p>
            ) : (
              <ul className="divide-y divide-border" data-testid="staff-recent-activity">
                {data.recentActivity.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <span className="font-mono text-[12.5px] font-semibold text-ink">
                      {item.trackingId}
                    </span>
                    <span className="min-w-0 flex-1 text-[13.5px] text-ink">
                      {humaniseStatusValue(item.type)}
                      <span className="text-ink-2">
                        {" "}
                        · {item.warehouseCode} · by {item.actorName}
                      </span>
                    </span>
                    <span className="shrink-0 text-[12.5px] text-ink-2">
                      {relativeFromNow(item.createdAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
