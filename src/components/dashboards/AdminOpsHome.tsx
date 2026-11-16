import Link from "next/link";

import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { getAdminHome } from "@/server/services/home-dashboards";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/states";

/**
 * Admin operations home (V2 Phase 6 slice B, spec §7 Admin + §10.5):
 * needs attention → key metrics → current operations → live-operations
 * summary → recent activity → quick actions. Every figure comes from
 * getAdminHome, which composes the permission-enforcing services —
 * this component does no arithmetic beyond display formatting.
 *
 * Live-map preview decision: a SUMMARY CARD, not an embedded
 * LiveOperationsBoard. The Phase 5 board is a full-viewport polling
 * surface (45–60s poll, map island); embedding it here would double
 * polling, break the §10.4 home pattern, and duplicate the Live
 * Operations page. The card summarises one scoped listLiveOperations
 * read and links to /admin/live-operations. Freshness is honest:
 * stale/offline are never styled as live and every named movement
 * shows its last-update time.
 */

function fmtTime(iso: string | null): string {
  if (!iso) return "No report yet";
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Kathmandu",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

function MetricStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
        {label}
      </dt>
      <dd className="tnum mt-1 text-[20px] font-bold leading-tight text-ink">{value}</dd>
      {sub ? <dd className="mt-0.5 text-[12px] text-slate2">{sub}</dd> : null}
    </div>
  );
}

const FRESHNESS_CLASSES: Record<string, string> = {
  FRESH: "bg-greenbg text-greendeep",
  DELAYED: "bg-amberbg text-amberdeep",
  STALE: "bg-redbg text-reddeep",
  OFFLINE: "bg-cream text-slate2",
};

function FreshnessPill({ state }: { state: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${
        FRESHNESS_CLASSES[state] ?? FRESHNESS_CLASSES.OFFLINE
      }`}
    >
      {state.charAt(0) + state.slice(1).toLowerCase()}
    </span>
  );
}

const TYPE_LABELS: Record<string, string> = {
  LINEHAUL: "Transfer",
  PICKUP: "Pickup",
  DELIVERY: "Delivery",
};

export async function AdminOpsHome({ actor }: { actor: ActorContext }) {
  const home = await getAdminHome(actor);
  const { metrics, needsAttention, currentOps, live } = home;

  const quickActions: { href: string; label: string; show: boolean }[] = [
    { href: "/admin/bookings/new", label: "New booking", show: hasPermission(actor, "booking.create") },
    { href: "/admin/live-operations", label: "Live Operations", show: hasPermission(actor, "operations.live_view") },
    { href: "/admin/incidents", label: "Incidents", show: hasPermission(actor, "incident.manage") || hasPermission(actor, "incident.resolve") },
    { href: "/admin/tasks", label: "Tasks", show: hasPermission(actor, "task.create") || hasPermission(actor, "task.assign") || hasPermission(actor, "task.update_own") },
    { href: "/admin/warehouses", label: "Warehouses", show: hasPermission(actor, "warehouse.read_all") },
    { href: "/admin/drivers", label: "Drivers", show: hasPermission(actor, "driver.manage") || hasPermission(actor, "driver.assign") },
    { href: "/admin/reports", label: "Full reports", show: hasPermission(actor, "report.read_all") },
  ];

  const attentionCount =
    needsAttention.openIncidents +
    needsAttention.codDiscrepancies +
    needsAttention.codAwaitingVerification +
    needsAttention.overdueTasks +
    needsAttention.failedDeliveriesToday;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Admin · Operations
        </div>
        <h1 className="mt-0.5 text-[22px] font-bold text-ink">Operations overview</h1>
        <p className="mt-1 text-[13px] text-slate2">
          Welcome, {actor.fullName} — today is {home.today} (Asia/Kathmandu). Figures are
          computed live from operational records.
        </p>
      </div>

      {/* 1 — Needs attention */}
      <SectionCard
        title="Needs attention"
        action={
          <Link href="/admin/incidents" className={subtleButtonClass}>
            Open incidents →
          </Link>
        }
      >
        {attentionCount === 0 ? (
          <EmptyState
            title="Nothing needs attention"
            description="No open incidents, COD alerts, overdue tasks or failed deliveries right now."
          />
        ) : (
          <div className="grid gap-4">
            <div className="flex flex-wrap gap-2 text-[13px]">
              <span className="rounded-md border border-line bg-page px-3 py-2">
                <strong className="tnum text-ink">{needsAttention.openIncidents}</strong>{" "}
                open incident(s) —{" "}
                <span className="tnum">{needsAttention.incidentsBySeverity.CRITICAL} critical</span>
                {" · "}
                <span className="tnum">{needsAttention.incidentsBySeverity.HIGH} high</span>
                {" · "}
                <span className="tnum">{needsAttention.incidentsBySeverity.MEDIUM} medium</span>
                {" · "}
                <span className="tnum">{needsAttention.incidentsBySeverity.LOW} low</span>
              </span>
              <span className="rounded-md border border-line bg-page px-3 py-2">
                <strong className="tnum text-ink">{needsAttention.codAwaitingVerification}</strong>{" "}
                COD remittance(s) awaiting verification
                {needsAttention.codDiscrepancies > 0 ? (
                  <>
                    {" · "}
                    <strong className="tnum text-reddeep">
                      {needsAttention.codDiscrepancies} in discrepancy
                    </strong>
                  </>
                ) : null}
              </span>
              <span className="rounded-md border border-line bg-page px-3 py-2">
                <strong className="tnum text-ink">{needsAttention.overdueTasks}</strong>{" "}
                overdue task(s)
              </span>
              <span className="rounded-md border border-line bg-page px-3 py-2">
                <strong className="tnum text-ink">{needsAttention.failedDeliveriesToday}</strong>{" "}
                failed delivery attempt(s) today
              </span>
            </div>

            {needsAttention.topOpenIncidents.length > 0 ? (
              <div className="grid gap-2">
                <h3 className="text-[13px] font-semibold text-ink">Open incidents</h3>
                {needsAttention.topOpenIncidents.map((incident) => (
                  <div
                    key={incident.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
                  >
                    <Link
                      href={`/admin/incidents/${incident.id}`}
                      className="font-mono font-semibold text-brand"
                    >
                      {incident.incidentNumber}
                    </Link>
                    <span className="text-ink">
                      {incident.category.replaceAll("_", " ")} — {incident.description.slice(0, 80)}
                    </span>
                    <StatusBadge domain="generic" status={incident.severity} />
                    <StatusBadge domain="generic" status={incident.status} />
                    <span className="text-slate2">{fmtTime(incident.createdAt)}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {needsAttention.topOverdueTasks.length > 0 ? (
              <div className="grid gap-2">
                <h3 className="text-[13px] font-semibold text-ink">Overdue tasks</h3>
                {needsAttention.topOverdueTasks.map((task) => (
                  <div
                    key={task.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
                  >
                    <Link href={`/admin/tasks/${task.id}`} className="font-semibold text-brand">
                      {task.title}
                    </Link>
                    <span className="text-slate2">
                      {task.assigneeName ?? "Unassigned"} · due {fmtTime(task.dueAt)}
                    </span>
                    <StatusBadge domain="generic" status={task.priority} />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </SectionCard>

      {/* 2 — Key metrics (6 max, §10) */}
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <MetricStat label="Bookings today" value={String(metrics.bookingsToday)} />
        <MetricStat
          label="Delivery success today"
          value={fmtPercent(metrics.deliverySuccessPercent)}
          sub="delivered ÷ attempted + delivered"
        />
        <MetricStat label="Active transfers" value={String(metrics.activeTransfers)} />
        <MetricStat label="Active drivers" value={String(metrics.activeDrivers)} sub="on assignment now" />
        <MetricStat label="Open incidents" value={String(metrics.openIncidents)} />
        <MetricStat label="Pending COD" value={String(metrics.pendingCod)} sub="remittances to verify" />
      </dl>

      {/* 3 — Current operations */}
      <SectionCard title="Current operations">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-[13px] md:grid-cols-4">
          <div>
            <dt className="text-slate2">Bookings today</dt>
            <dd className="tnum mt-0.5 text-[15px] font-semibold text-ink">{currentOps.bookingsToday}</dd>
          </div>
          <div>
            <dt className="text-slate2">Delivered today</dt>
            <dd className="tnum mt-0.5 text-[15px] font-semibold text-ink">{currentOps.deliveredToday}</dd>
          </div>
          <div>
            <dt className="text-slate2">Awaiting pickup</dt>
            <dd className="tnum mt-0.5 text-[15px] font-semibold text-ink">{currentOps.awaitingPickup}</dd>
          </div>
          <div>
            <dt className="text-slate2">Active drivers</dt>
            <dd className="tnum mt-0.5 text-[15px] font-semibold text-ink">{currentOps.activeDrivers}</dd>
          </div>
          <div>
            <dt className="text-slate2">Outgoing transfers</dt>
            <dd className="tnum mt-0.5 text-[15px] font-semibold text-ink">
              {currentOps.outgoingTransfers}
            </dd>
          </div>
          <div>
            <dt className="text-slate2">Incoming transfers</dt>
            <dd className="tnum mt-0.5 text-[15px] font-semibold text-ink">
              {currentOps.incomingTransfers}
            </dd>
          </div>
          <div>
            <dt className="text-slate2">Transfers preparing</dt>
            <dd className="tnum mt-0.5 text-[15px] font-semibold text-ink">
              {currentOps.preparingTransfers}
            </dd>
          </div>
          <div>
            <dt className="text-slate2">Failed attempts today</dt>
            <dd className="tnum mt-0.5 text-[15px] font-semibold text-ink">
              {needsAttention.failedDeliveriesToday}
            </dd>
          </div>
        </dl>
      </SectionCard>

      {/* 4 — Live operations summary card (see header note) */}
      {live ? (
        <SectionCard
          title="Live operations"
          action={
            <Link href="/admin/live-operations" className={subtleButtonClass}>
              Open live map →
            </Link>
          }
        >
          {live.activeMovements === 0 ? (
            <EmptyState
              title="No active movements"
              description="No driver is being tracked right now. Active transfers, pickups and deliveries appear here while tracking is on."
              action={
                <Link href="/admin/live-operations" className={subtleButtonClass}>
                  Open Live Operations →
                </Link>
              }
            />
          ) : (
            <div className="grid gap-3">
              <p className="text-[13px] text-slate2">
                <strong className="tnum text-ink">{live.activeMovements}</strong> active
                movement(s): <span className="tnum">{live.byType.transfers}</span> transfer(s) ·{" "}
                <span className="tnum">{live.byType.pickups}</span> pickup(s) ·{" "}
                <span className="tnum">{live.byType.deliveries}</span> delivery run(s). Freshness:{" "}
                <span className="tnum">{live.byFreshness.fresh}</span> fresh ·{" "}
                <span className="tnum">{live.byFreshness.delayed}</span> delayed ·{" "}
                <span className="tnum">{live.byFreshness.stale}</span> stale ·{" "}
                <span className="tnum">{live.byFreshness.offline}</span> offline. Snapshot at{" "}
                {fmtTime(live.generatedAt)}.
              </p>
              {live.stalest.length > 0 ? (
                <div className="grid gap-2">
                  <h3 className="text-[13px] font-semibold text-ink">
                    Least-recent updates
                  </h3>
                  {live.stalest.map((movement) => (
                    <div
                      key={movement.trackingSessionId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
                    >
                      <span className="font-semibold text-ink">{movement.driverName}</span>
                      <span className="text-slate2">
                        {TYPE_LABELS[movement.trackingType] ?? movement.trackingType} ·{" "}
                        {movement.originCode}
                        {movement.destinationCode ? ` → ${movement.destinationCode}` : ""}
                      </span>
                      <FreshnessPill state={movement.freshnessState} />
                      <span className="text-slate2">
                        Last update {fmtTime(movement.lastReceivedAt)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </SectionCard>
      ) : null}

      {/* 5 — Recent activity */}
      <SectionCard title="Recent activity">
        {home.recentActivity.incidents.length === 0 &&
        home.recentActivity.transfers.length === 0 ? (
          <EmptyState
            title="No recent activity"
            description="Recent incidents and transfers will appear here as operations run."
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="grid content-start gap-2">
              <h3 className="text-[13px] font-semibold text-ink">Latest incidents</h3>
              {home.recentActivity.incidents.length === 0 ? (
                <p className="text-[13px] text-slate2">No incidents recorded.</p>
              ) : (
                home.recentActivity.incidents.map((incident) => (
                  <div
                    key={incident.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
                  >
                    <Link
                      href={`/admin/incidents/${incident.id}`}
                      className="font-mono font-semibold text-brand"
                    >
                      {incident.incidentNumber}
                    </Link>
                    <span className="text-slate2">{incident.category.replaceAll("_", " ")}</span>
                    <StatusBadge domain="generic" status={incident.status} />
                    <span className="text-slate2">{fmtTime(incident.createdAt)}</span>
                  </div>
                ))
              )}
            </div>
            <div className="grid content-start gap-2">
              <h3 className="text-[13px] font-semibold text-ink">Latest transfers</h3>
              {home.recentActivity.transfers.length === 0 ? (
                <p className="text-[13px] text-slate2">No transfers recorded.</p>
              ) : (
                home.recentActivity.transfers.map((transfer) => (
                  <div
                    key={transfer.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
                  >
                    <span className="font-mono font-semibold text-ink">
                      {transfer.transferNumber}
                    </span>
                    <span className="text-slate2">
                      {transfer.originWarehouseCode} → {transfer.destinationWarehouseCode}
                    </span>
                    <StatusBadge domain="generic" status={transfer.status} />
                    <span className="text-slate2">{fmtTime(transfer.createdAt)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </SectionCard>

      {/* 6 — Quick actions (existing routes only, permission-filtered) */}
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
