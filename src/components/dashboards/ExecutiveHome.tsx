import type { ReactNode } from "react";
import Link from "next/link";

import type { ActorContext } from "@/lib/auth/actor";
import { hasPermission } from "@/lib/auth/permissions";
import { getExecutiveHome } from "@/server/services/home-dashboards";
import { getLiveOpsMapProps } from "@/components/live-operations/pages";
import { LiveOpsPreview } from "@/components/live-operations/LiveOpsPreview";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { TrendIndicator } from "@/components/ui/TrendIndicator";
import { BarChart, LineChart, DistributionBar } from "@/components/ui/charts";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ToneIcon } from "@/components/ui/ToneIcon";
import { NavIcon } from "@/components/layout/icons";
import type { NavIconName } from "@/lib/navigation/registry";
import { formatDateTime, formatPaisa } from "@/components/bookings/ui";
import { humaniseStatusValue, statusLabel } from "@/lib/status/labels";
import { statusTone } from "@/lib/status/status-tones";

/**
 * Executive home (V3 Step 4, brief §6) — the shared Admin / Super
 * Admin overview built on the Step 3 primitives and the Step 4 read
 * model (`getExecutiveHome`). One KPI row, the Live Operations map
 * preview, shipment analytics from the 30-day report series, a
 * needs-attention queue, the audit-backed activity feed and the
 * quick-actions row.
 *
 * Honest-mapping notes (design system §6, approved by Meena):
 * - "Create Transfer" and "Receive Package" have NO route in the
 *   Admin/SA trees (they live in the warehouse tree) — omitted here,
 *   not faked.
 * - Package-state KPIs drill to the Reports view: its `status`
 *   filter is applied as an operational-status filter by the report
 *   service. The bookings list's own `status` filter is the ORDER
 *   status, so it is used only for the Total Bookings card.
 * - Multi-status buckets (At Warehouses, In Transit) link to the
 *   Reports overview, where the status distribution lives — no
 *   fabricated filter is invented for them.
 */

const PRIMARY_LINK =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[14px] font-[550] text-white hover:bg-primary-dark";
const SECONDARY_LINK =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-border-control bg-card px-4 py-2.5 text-[14px] font-[550] text-ink hover:bg-surface-2";

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

function relativeFromNow(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDateTime(iso);
}

function shortDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

const ATTENTION_TONES: Record<string, "danger" | "warning"> = {
  missing: "danger",
  transferDiscrepancies: "warning",
  delayed: "warning",
  damaged: "danger",
  codMismatches: "danger",
};

export async function ExecutiveHome({
  actor,
  basePath,
  variant,
}: {
  actor: ActorContext;
  basePath: string;
  variant: "admin" | "super-admin";
}) {
  const [data, mapProps] = await Promise.all([
    getExecutiveHome(actor, basePath),
    getLiveOpsMapProps(actor),
  ]);
  const { kpis, analytics, attention, activity, ops, money } = data;
  const buckets = kpis.buckets;

  const deliveredLast30 = analytics.dailySeries.reduce(
    (sum, d) => sum + d.delivered,
    0,
  );
  const readyCount = analytics.distribution
    .filter(
      (r) => r.status === "READY_FOR_DISPATCH" || r.status === "READY_FOR_DELIVERY",
    )
    .reduce((sum, r) => sum + r.count, 0);

  const distributionSegments = [...analytics.distribution]
    .sort((a, b) => b.count - a.count)
    .map((r) => ({
      label: statusLabel("operational", r.status),
      value: r.count,
      tone: statusTone("operational", r.status),
    }));

  const can = (perm: string) => hasPermission(actor, perm as never);

  const quickActions: { label: string; href: string; icon: NavIconName; show: boolean }[] = [
    { label: "Create Booking", href: `${basePath}/bookings/new`, icon: "package", show: can("booking.create") },
    { label: "Add Customer", href: `${basePath}/customers/new`, icon: "user", show: can("customer.create") },
    { label: "Register Vendor", href: `${basePath}/vendors/new`, icon: "store", show: can("vendor.create") },
    { label: "Add Warehouse", href: `${basePath}/warehouses/new`, icon: "warehouse", show: can("warehouse.create") },
    { label: "Create Task", href: `${basePath}/tasks`, icon: "tasks", show: can("task.create") },
    { label: "Assign Driver", href: `${basePath}/drivers`, icon: "truck", show: can("driver.assign") },
    { label: "Users & Roles", href: `${basePath}/users`, icon: "users", show: can("user.manage") },
    { label: "Audit Logs", href: `${basePath}/audit`, icon: "file", show: can("audit.read") },
    ...(variant === "super-admin"
      ? [{ label: "Settings", href: `${basePath}/settings`, icon: "sliders" as NavIconName, show: can("settings.manage") }]
      : []),
  ];

  const attentionRows: { key: string; label: string; count: number; href: string; tone: "danger" | "warning" }[] = [
    ...(attention.groups ?? [])
      .filter((g) => g.count > 0)
      .map((g) => ({
        key: g.key,
        label: g.label,
        count: g.count,
        href: `${basePath}/incidents`,
        tone: ATTENTION_TONES[g.key] ?? "warning",
      })),
    ...(attention.codAwaitingVerification > 0
      ? [{
          key: "cod-awaiting",
          label: "COD remittances awaiting verification",
          count: attention.codAwaitingVerification,
          href: `${basePath}/settlements`,
          tone: "warning" as const,
        }]
      : []),
    ...(attention.overdueTasks > 0
      ? [{
          key: "overdue-tasks",
          label: "Overdue tasks",
          count: attention.overdueTasks,
          href: `${basePath}/tasks`,
          tone: "warning" as const,
        }]
      : []),
    ...(attention.failedDeliveriesToday > 0
      ? [{
          key: "failed-today",
          label: "Failed deliveries today",
          count: attention.failedDeliveriesToday,
          href: `${basePath}/incidents`,
          tone: "danger" as const,
        }]
      : []),
  ];
  const nothingNeedsAttention =
    attention.allClear && attentionRows.length === 0;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Overview"
        description="Monitor shipments, warehouse operations, transport activity and delivery performance."
        actions={
          <>
            {can("booking.create") ? (
              <Link href={`${basePath}/bookings/new`} className={PRIMARY_LINK}>
                Create Booking
              </Link>
            ) : null}
            {can("vendor.create") ? (
              <Link href={`${basePath}/vendors/new`} className={SECONDARY_LINK}>
                Add Vendor
              </Link>
            ) : null}
            {can("driver.assign") ? (
              <Link href={`${basePath}/drivers`} className={SECONDARY_LINK}>
                Assign Driver
              </Link>
            ) : null}
          </>
        }
      />

      {/* Six KPIs — one row, brief §6B */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatCard
          label="Total Bookings"
          value={kpis.totalBookings.toLocaleString("en-IN")}
          context={
            kpis.totalPackages !== null
              ? `${kpis.totalPackages.toLocaleString("en-IN")} packages · ${kpis.bookingsLast30Days} booked in the last 30 days`
              : `${kpis.bookingsLast30Days} booked in the last 30 days`
          }
          icon={<NavIcon name="package" />}
          tint="brand"
          href={`${basePath}/bookings`}
          trend={
            kpis.bookingsDelta ? (
              <TrendIndicator
                delta={kpis.bookingsDelta.today - kpis.bookingsDelta.yesterday}
                goodDirection="up"
                label="bookings today vs yesterday"
              />
            ) : undefined
          }
        />
        <StatCard
          label="At Warehouses"
          value={buckets.atWarehouses.toLocaleString("en-IN")}
          context={`Of which ${readyCount} ready for dispatch or delivery`}
          icon={<NavIcon name="warehouse" />}
          tint="info"
          href={`${basePath}/reports`}
        />
        <StatCard
          label="In Transit"
          value={buckets.inTransit.toLocaleString("en-IN")}
          context={`${ops.activeTransfers} active transfers`}
          icon={<NavIcon name="truck" />}
          tint="info"
          href={`${basePath}/reports`}
        />
        <StatCard
          label="Out for Delivery"
          value={buckets.outForDelivery.toLocaleString("en-IN")}
          context={`${buckets.assignedToRiders} more assigned to riders`}
          icon={<NavIcon name="hand" />}
          tint="warning"
          href={`${basePath}/reports?status=OUT_FOR_DELIVERY`}
        />
        <StatCard
          label="Delivered"
          value={buckets.delivered.toLocaleString("en-IN")}
          context={`All time · ${deliveredLast30} in the last 30 days`}
          icon={<NavIcon name="inbox" />}
          tint="success"
          href={`${basePath}/reports?status=DELIVERED`}
          trend={
            kpis.deliveredDelta ? (
              <TrendIndicator
                delta={kpis.deliveredDelta.today - kpis.deliveredDelta.yesterday}
                goodDirection="up"
                label="delivered today vs yesterday"
              />
            ) : undefined
          }
        />
        <StatCard
          label="Open Exceptions"
          value={kpis.openExceptions.toLocaleString("en-IN")}
          context={
            kpis.openExceptions === 0
              ? "All clear"
              : `${attention.bySeverity.CRITICAL} critical · ${attention.bySeverity.HIGH} high`
          }
          icon={<NavIcon name="alert" />}
          tint="danger"
          href={`${basePath}/incidents`}
        />
      </div>

      {/* Live Operations preview (brief §6C) */}
      <Section
        title="Live Operations"
        action={
          <Link
            href={`${basePath}/live-operations`}
            className="text-[13px] font-semibold text-primary hover:text-primary-dark"
          >
            View All Live Operations →
          </Link>
        }
      >
        <LiveOpsPreview
          basePath={basePath}
          warehouseCoords={mapProps.warehouseCoords}
          initialWarehouseId={mapProps.initialWarehouseId}
        />
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 border-t border-border pt-3 text-[12.5px] text-ink-2">
          <span>
            Active transfers{" "}
            <strong className="font-semibold text-ink">{ops.activeTransfers}</strong>
          </span>
          <span>
            Drivers on duty{" "}
            <strong className="font-semibold text-ink">{ops.activeDrivers}</strong>
          </span>
          <span>
            Delivery success (30 days){" "}
            <strong className="font-semibold text-ink">
              {ops.deliverySuccessPercent === null
                ? "—"
                : `${ops.deliverySuccessPercent}%`}
            </strong>
          </span>
          <span>
            COD waiting with riders{" "}
            <strong className="font-semibold text-ink">{ops.pendingCod}</strong>
          </span>
        </div>
      </Section>

      {/* Shipment analytics (brief §6D) */}
      <Section
        title="Shipment Analytics"
        action={
          <span className="text-[12.5px] text-ink-2">Last 30 days · Asia/Kathmandu</span>
        }
      >
        <div className="grid gap-6 xl:grid-cols-2">
          <div>
            <h3 className="mb-2 text-[13px] font-semibold text-ink">Daily bookings</h3>
            <BarChart
              data={analytics.dailySeries.map((d) => ({
                label: shortDate(d.date),
                value: d.bookings,
              }))}
              ariaLabel="Bookings per day over the last 30 days"
              valueLabel="bookings"
            />
          </div>
          <div>
            <h3 className="mb-2 text-[13px] font-semibold text-ink">Deliveries per day</h3>
            <LineChart
              data={analytics.dailySeries.map((d) => ({
                label: shortDate(d.date),
                value: d.delivered,
              }))}
              ariaLabel="Deliveries per day over the last 30 days"
              valueLabel="deliveries"
            />
          </div>
          <div>
            <h3 className="mb-2 text-[13px] font-semibold text-ink">
              Shipment status distribution
            </h3>
            <DistributionBar
              segments={distributionSegments}
              ariaLabel="Current packages by operational status"
            />
          </div>
          <div>
            <h3 className="mb-2 text-[13px] font-semibold text-ink">
              Weekly delivery performance
            </h3>
            <BarChart
              data={analytics.weekly.map((w) => ({
                label: `Week of ${w.label}`,
                value: w.delivered,
              }))}
              ariaLabel="Deliveries per week over the last 30 days"
              valueLabel="deliveries"
            />
          </div>
        </div>
      </Section>

      {/* Super Admin money summary — the V2 overview figures, folded
          into the §6 structure (not a second KPI row). */}
      {variant === "super-admin" && money ? (
        <Section
          title="Money — Last 30 Days"
          action={
            <Link
              href={`${basePath}/reports`}
              className="text-[13px] font-semibold text-primary hover:text-primary-dark"
            >
              Full reports →
            </Link>
          }
        >
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            {[
              { label: "Invoiced", value: formatPaisa(money.invoicedPaisa), context: `${money.invoicedCount} invoices` },
              { label: "Outstanding", value: formatPaisa(money.outstandingPaisa), context: `${money.openInvoices} open invoices` },
              { label: "COD collected", value: formatPaisa(money.codCollectedPaisa), context: "Last 30 days" },
              { label: "COD with riders", value: formatPaisa(money.codWithRidersPaisa), context: "Not yet remitted" },
              { label: "On-time delivery", value: money.onTimePercent === null ? "—" : `${money.onTimePercent}%`, context: "Of delivered packages" },
              { label: "Return rate", value: money.returnRatePercent === null ? "—" : `${money.returnRatePercent}%`, context: "Returns created" },
            ].map((m) => (
              <div key={m.label}>
                <dt className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-2">
                  {m.label}
                </dt>
                <dd className="mt-1 text-[20px] font-semibold tabular-nums text-ink">
                  {m.value}
                </dd>
                <dd className="text-[12.5px] text-ink-2">{m.context}</dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-2">
        {/* Needs attention (brief §6E) */}
        <Section
          title="Needs Attention"
          action={
            <Link
              href={`${basePath}/incidents`}
              className="text-[13px] font-semibold text-primary hover:text-primary-dark"
            >
              All exceptions →
            </Link>
          }
        >
          {nothingNeedsAttention ? (
            <div className="flex items-center gap-3 rounded-lg bg-successbg px-4 py-3">
              <ToneIcon tone="success" className="h-[18px] w-[18px] text-success" />
              <p className="text-[13.5px] font-medium text-ink">
                All clear — no open exceptions, overdue tasks or COD issues.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {attentionRows.length > 0 ? (
                <ul className="divide-y divide-border">
                  {attentionRows.map((row) => (
                    <li key={row.key}>
                      <Link
                        href={row.href}
                        className="flex items-center gap-3 py-2.5 hover:bg-surface-2"
                      >
                        <ToneIcon tone={row.tone} className="h-[16px] w-[16px] shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                          {row.label}
                        </span>
                        <span className="text-[14px] font-semibold tabular-nums text-ink">
                          {row.count}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : null}
              {attention.topOpenIncidents.length > 0 ? (
                <div>
                  <h3 className="mb-1 text-[12.5px] font-semibold uppercase tracking-wide text-ink-2">
                    Latest open exceptions
                  </h3>
                  <ul className="divide-y divide-border">
                    {attention.topOpenIncidents.map((inc) => (
                      <li key={inc.id}>
                        <Link
                          href={`${basePath}/incidents/${inc.id}`}
                          className="flex flex-wrap items-center gap-2 py-2.5 hover:bg-surface-2"
                        >
                          <span className="font-mono text-[12.5px] font-semibold text-ink">
                            {inc.incidentNumber}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                            {humaniseStatusValue(inc.category)}
                          </span>
                          <StatusBadge domain="exception" status={inc.severity} density="compact" />
                          <span className="text-[12.5px] text-ink-2">
                            {relativeFromNow(inc.createdAt)}
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {attention.topOverdueTasks.length > 0 ? (
                <div>
                  <h3 className="mb-1 text-[12.5px] font-semibold uppercase tracking-wide text-ink-2">
                    Overdue tasks
                  </h3>
                  <ul className="divide-y divide-border">
                    {attention.topOverdueTasks.map((task) => (
                      <li key={task.id}>
                        <Link
                          href={`${basePath}/tasks/${task.id}`}
                          className="flex flex-wrap items-center gap-2 py-2.5 hover:bg-surface-2"
                        >
                          <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                            {task.title}
                          </span>
                          <span className="text-[12.5px] text-ink-2">
                            {task.assigneeName ?? "Unassigned"}
                          </span>
                          <span className="text-[12.5px] font-medium text-danger">
                            Due {task.dueAt ? formatDateTime(task.dueAt) : "—"}
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

        {/* Recent activity (brief §6F) */}
        <Section title="Recent Activity">
          {activity.length === 0 ? (
            <p className="text-[13.5px] text-ink-2">
              No operational activity recorded yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {activity.map((item) => {
                const inner = (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] text-ink">
                        {item.label}
                      </span>
                      <span className="block text-[12.5px] text-ink-2">
                        {item.actorName ?? "System"}
                      </span>
                    </span>
                    <span className="shrink-0 text-[12.5px] text-ink-2">
                      {relativeFromNow(item.createdAt)}
                    </span>
                  </>
                );
                return (
                  <li key={item.id}>
                    {item.href ? (
                      <Link href={item.href} className="flex items-center gap-3 py-2.5 hover:bg-surface-2">
                        {inner}
                      </Link>
                    ) : (
                      <div className="flex items-center gap-3 py-2.5">{inner}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      </div>

      {/* Quick actions (brief §6G — only actions with real routes) */}
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
