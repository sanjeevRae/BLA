import type { ReactNode } from "react";
import Link from "next/link";

import type { SupportConsoleData } from "@/server/services/support-home";
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
 * Support home (V3 Step 8) — the support console rebuilt on the
 * Step 3 primitives and the Step 8 read model (`getSupportConsole`).
 * Presentational only: the page resolves the actor and hands this
 * view the model. Support is case management: tickets, incidents
 * and the actor's own tasks.
 *
 * Honest-mapping notes:
 * - MONEY BOUNDARY (hard): this surface renders NO finance figure
 *   of any kind — the model carries none and nothing is derived
 *   here.
 * - The 48h figure is the home's attention threshold
 *   (SUPPORT_TICKET_ATTENTION_HOURS), labelled exactly that way —
 *   never an SLA promise; there is no SLA contract in the schema.
 * - Drill-throughs are BARE links: the tickets inbox reads no
 *   filter params, so no card or banner fabricates a query string.
 * - "Create ticket" links to /support/tickets: the RaiseTicketForm
 *   lives on the inbox page — there is no separate create route.
 * - Knowledge / FAQs: no route exists in the app, so no link is
 *   offered (recorded in the Step 8 report).
 * - Ages and due labels are real arithmetic on the model's
 *   timestamps (see formatAge below), never stored strings.
 */

const PRIMARY_LINK =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[14px] font-[550] text-white hover:bg-primary-dark";
const SECONDARY_LINK =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-border-control bg-card px-4 py-2.5 text-[14px] font-[550] text-ink hover:bg-surface-2";

/**
 * Real age arithmetic on an ISO timestamp: whole days + hours once
 * a day has passed ("3d 4h"), whole hours inside a day ("5h"),
 * minutes inside an hour ("12m"). Future timestamps clamp to "0m".
 */
export function formatAge(iso: string, now: Date = new Date()): string {
  const elapsedMs = now.getTime() - new Date(iso).getTime();
  const totalMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

/** "2026-11-17" → "17 Nov 2026" (the model's Kathmandu today). */
function longDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
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

function AttentionBanner({
  count,
  text,
  href,
  linkLabel,
  tone,
}: {
  count: number;
  text: string;
  href: string;
  linkLabel: string;
  tone: "danger" | "warning";
}) {
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-lg px-4 py-3 ${
        tone === "danger" ? "bg-dangerbg" : "bg-warningbg"
      }`}
    >
      <ToneIcon tone={tone} className="h-[18px] w-[18px] shrink-0" />
      <p className="min-w-0 flex-1 text-[13.5px] text-ink">
        <span className="font-semibold tabular-nums">{count}</span> {text}
      </p>
      <Link
        href={href}
        className="text-[13px] font-semibold text-primary hover:text-primary-dark"
      >
        {linkLabel} →
      </Link>
    </div>
  );
}

export function SupportHomeView({ data }: { data: SupportConsoleData }) {
  const { attention, queues } = data;
  const hasAttention =
    attention.unassignedTickets > 0 ||
    attention.breachingTickets > 0 ||
    attention.unresolvedHighSeverityIncidents > 0 ||
    attention.overdueDeliveries > 0;

  const queueBreakdown = `${queues.open} open · ${queues.inProgress} in progress · ${queues.awaitingCustomer} awaiting customer · ${queues.escalated} escalated`;

  const quickActions: { label: string; href: string; icon: NavIconName; show: boolean }[] = [
    { label: "View tickets", href: "/support/tickets", icon: "ticket", show: data.can.viewTickets },
    // The RaiseTicketForm lives on the inbox page — no create route.
    { label: "Create ticket", href: "/support/tickets", icon: "inbox", show: data.can.viewTickets },
    { label: "Incidents", href: "/support/incidents", icon: "alert", show: data.can.incidents },
    { label: "Tasks", href: "/support/tasks", icon: "tasks", show: data.can.tasks },
    { label: "Track a package", href: "/track", icon: "map", show: true },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Support"
        title="Support dashboard"
        description={`Case management — tickets, incidents and your tasks · ${longDate(data.today)} (Kathmandu)`}
        actions={
          <>
            {data.can.viewTickets ? (
              <Link href="/support/tickets" className={PRIMARY_LINK}>
                Tickets inbox
              </Link>
            ) : null}
            <Link href="/track" className={SECONDARY_LINK}>
              Track a package
            </Link>
          </>
        }
      />

      {/* Needs attention — leads the body (DS exception-first);
          unassigned tickets lead the section. */}
      <Section title="Needs Attention">
        {!hasAttention ? (
          <div className="flex items-center gap-3 rounded-lg bg-successbg px-4 py-3">
            <ToneIcon tone="success" className="h-[18px] w-[18px] text-success" />
            <p className="text-[13.5px] font-medium text-ink">
              Nothing needs your attention right now — no unassigned tickets, no tickets
              past the 48h attention threshold, no unresolved high-severity incidents and
              no overdue deliveries.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {attention.unassignedTickets > 0 ? (
              <AttentionBanner
                count={attention.unassignedTickets}
                text="open tickets are unassigned — assign them so every case has an owner."
                href="/support/tickets"
                linkLabel="Tickets inbox"
                tone="warning"
              />
            ) : null}
            {attention.breachingTickets > 0 ? (
              <AttentionBanner
                count={attention.breachingTickets}
                text="open tickets have been open longer than 48h — work the oldest first. 48h is this dashboard's attention threshold."
                href="/support/tickets"
                linkLabel="Oldest tickets below"
                tone="danger"
              />
            ) : null}
            {attention.unresolvedHighSeverityIncidents > 0 ? (
              <AttentionBanner
                count={attention.unresolvedHighSeverityIncidents}
                text="unresolved high-severity incidents are open in the support scope."
                href="/support/incidents"
                linkLabel="Incidents"
                tone="danger"
              />
            ) : null}
            {attention.overdueDeliveries > 0 ? (
              <AttentionBanner
                count={attention.overdueDeliveries}
                text="packages are past their expected delivery date and not yet delivered."
                href="/support/tickets"
                linkLabel="Investigate via tickets"
                tone="warning"
              />
            ) : null}
          </div>
        )}

        {data.oldestOpenTickets.length > 0 ? (
          <div className="mt-5">
            <h3 className="mb-2 text-[13px] font-semibold text-ink">Oldest open tickets</h3>
            <ul className="divide-y divide-border">
              {data.oldestOpenTickets.map((ticket) => (
                <li key={ticket.id}>
                  <Link
                    href={`/support/tickets/${ticket.id}`}
                    className="flex flex-wrap items-center gap-2 py-2.5 hover:bg-surface-2"
                  >
                    <span className="font-mono text-[12.5px] font-semibold whitespace-nowrap text-primary">
                      {ticket.ticketNumber}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                      {ticket.subject}
                    </span>
                    <span className="text-[12.5px] whitespace-nowrap text-ink-2">
                      {ticket.assignedToId ? "Assigned" : "Unassigned"} · {formatAge(ticket.createdAt)} old
                    </span>
                    <PriorityBadge priority={ticket.priority} />
                    <StatusBadge domain="generic" status={ticket.status} density="compact" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {data.overdueDeliveryItems.length > 0 ? (
          <div className="mt-5">
            <h3 className="mb-2 text-[13px] font-semibold text-ink">
              Overdue deliveries (oldest expected first)
            </h3>
            <ul className="divide-y divide-border">
              {data.overdueDeliveryItems.map((item) => (
                <li key={item.packageId}>
                  <Link
                    href={`/track/${item.trackingId}`}
                    className="flex flex-wrap items-center gap-2 py-2.5 hover:bg-surface-2"
                  >
                    <span className="font-mono text-[12.5px] font-semibold whitespace-nowrap text-primary">
                      {item.trackingId}
                    </span>
                    <span className="min-w-0 flex-1 text-[13.5px] text-ink-2">
                      Expected {formatDateTime(item.expectedDeliveryAt)}
                    </span>
                    <StatusBadge domain="delivery" status={item.deliveryStatus} density="compact" />
                    <StatusBadge domain="operational" status={item.operationalStatus} density="compact" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      {/* KPI row — the brief's six cards, bare drill-throughs only. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatCard
          label="Open tickets"
          value={queues.totalOpen.toLocaleString("en-IN")}
          context={queueBreakdown}
          icon={<NavIcon name="ticket" />}
          tint="brand"
          href="/support/tickets"
        />
        <StatCard
          label="Unassigned"
          value={attention.unassignedTickets.toLocaleString("en-IN")}
          context="Open tickets with no owner"
          icon={<NavIcon name="inbox" />}
          tint="warning"
          href="/support/tickets"
        />
        <StatCard
          label="High priority open"
          value={data.highPriorityOpen.toLocaleString("en-IN")}
          context="HIGH + URGENT"
          icon={<NavIcon name="alert" />}
          tint={data.highPriorityOpen > 0 ? "danger" : "neutral"}
          href="/support/tickets"
        />
        <StatCard
          label="Incidents open"
          value={data.openIncidents.toLocaleString("en-IN")}
          context="Support scope"
          icon={<NavIcon name="alert" />}
          tint="info"
          href="/support/incidents"
        />
        <StatCard
          label="My tickets"
          value={data.myTicketsOpen.toLocaleString("en-IN")}
          context="Open tickets assigned to you"
          icon={<NavIcon name="user" />}
          tint="brand"
          href="/support/tickets"
        />
        <StatCard
          label="Tasks due"
          value={data.tasksDue.toLocaleString("en-IN")}
          context={
            data.tasksOverdue > 0
              ? `Due by end of today · ${data.tasksOverdue} overdue`
              : "Due by end of today"
          }
          icon={<NavIcon name="tasks" />}
          tint={data.tasksOverdue > 0 ? "danger" : "brand"}
          href="/support/tasks"
        />
      </div>

      {/* Ticket queue — the §14 case table. Unassigned rows are
          warning-tinted and carry an explicit Unassigned marker. */}
      <Section
        title="Ticket Queue"
        action={
          <Link
            href="/support/tickets"
            className="text-[13px] font-semibold text-primary hover:text-primary-dark"
          >
            All tickets →
          </Link>
        }
      >
        <dl className="mb-4 flex flex-wrap gap-x-6 gap-y-2">
          {(
            [
              ["Open", queues.open],
              ["In progress", queues.inProgress],
              ["Awaiting customer", queues.awaitingCustomer],
              ["Escalated", queues.escalated],
              ["Resolved today", queues.resolvedToday],
            ] as const
          ).map(([label, count]) => (
            <div key={label} className="flex items-baseline gap-1.5">
              <dt className="text-[12.5px] font-semibold text-ink-2">{label}</dt>
              <dd className="text-[14px] font-semibold tabular-nums text-ink">{count}</dd>
            </div>
          ))}
        </dl>
        {data.queueTickets.length === 0 ? (
          <EmptyState
            title="No open tickets"
            description="The queue is clear — new tickets will appear here as they are raised."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {["Ticket", "Subject", "Requester", "Priority", "Status", "Age", "Assigned"].map(
                    (header) => (
                      <th
                        key={header}
                        scope="col"
                        className="bg-surface-2 px-3 py-2 text-left text-[12px] font-semibold uppercase tracking-wide text-ink-2"
                      >
                        {header}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {data.queueTickets.map((ticket) => {
                  const unassigned = ticket.assignedToId === null;
                  return (
                    <tr
                      key={ticket.id}
                      data-unassigned={unassigned ? "true" : undefined}
                      className={`h-11 border-t border-border hover:bg-surface-2 ${
                        unassigned ? "bg-warningbg" : ""
                      }`}
                    >
                      <td className="px-3 py-2 text-table">
                        <Link
                          href={`/support/tickets/${ticket.id}`}
                          className="font-mono font-semibold whitespace-nowrap text-primary hover:text-primary-dark"
                        >
                          {ticket.ticketNumber}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-table text-ink">{ticket.subject}</td>
                      <td className="px-3 py-2 text-table text-ink">
                        {ticket.raiserName ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-table">
                        <PriorityBadge priority={ticket.priority} />
                      </td>
                      <td className="px-3 py-2 text-table">
                        <StatusBadge domain="generic" status={ticket.status} density="compact" />
                      </td>
                      <td className="px-3 py-2 text-table whitespace-nowrap tabular-nums text-ink-2">
                        {formatAge(ticket.createdAt)}
                      </td>
                      <td className="px-3 py-2 text-table">
                        {unassigned ? (
                          <span className="inline-flex items-center gap-1.5 font-[550] text-warning">
                            <ToneIcon tone="warning" />
                            Unassigned
                          </span>
                        ) : (
                          <span className="text-ink">{ticket.assigneeName ?? "—"}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="grid gap-5 xl:grid-cols-2">
        {/* Incidents summary — recent rows plus the open count. */}
        <Section
          title="Incidents"
          action={
            <Link
              href="/support/incidents"
              className="text-[13px] font-semibold text-primary hover:text-primary-dark"
            >
              {data.openIncidents} open →
            </Link>
          }
        >
          {data.recentIncidents.length === 0 ? (
            <p className="text-[13.5px] text-ink-2">
              No incidents in the support scope yet.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {data.recentIncidents.map((incident) => (
                <li key={incident.id}>
                  <Link
                    href={`/support/incidents/${incident.id}`}
                    className="flex flex-wrap items-center gap-2 py-2.5 hover:bg-surface-2"
                  >
                    <span className="font-mono text-[12.5px] font-semibold text-primary">
                      {incident.incidentNumber}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                      {humaniseStatusValue(incident.category)}
                    </span>
                    <span className="text-[12.5px] whitespace-nowrap text-ink-2">
                      {formatDateTime(incident.updatedAt)}
                    </span>
                    <StatusBadge domain="generic" status={incident.severity} density="compact" />
                    <StatusBadge domain="generic" status={incident.status} density="compact" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* My tasks — the actor's own open work, due soonest first. */}
        <Section
          title="My Tasks"
          action={
            <Link
              href="/support/tasks"
              className="text-[13px] font-semibold text-primary hover:text-primary-dark"
            >
              All tasks →
            </Link>
          }
        >
          {data.myTasks.length === 0 ? (
            <EmptyState
              title="No open tasks"
              description="Tasks assigned to you will appear here, due soonest first."
            />
          ) : (
            <ul className="divide-y divide-border">
              {data.myTasks.map((task) => (
                <li key={task.id}>
                  <Link
                    href={`/support/tasks/${task.id}`}
                    className="flex flex-wrap items-center gap-2 py-2.5 hover:bg-surface-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                      {task.title}
                    </span>
                    {task.overdue ? (
                      <span className="inline-flex items-center gap-1.5 font-[550] text-danger">
                        <ToneIcon tone="danger" />
                        Overdue
                      </span>
                    ) : (
                      <span className="text-[12.5px] whitespace-nowrap text-ink-2">
                        {task.dueAt ? `Due ${formatDateTime(task.dueAt)}` : "No due date"}
                      </span>
                    )}
                    <PriorityBadge priority={task.priority} />
                    <StatusBadge domain="generic" status={task.status} density="compact" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {/* Quick actions — only actions with real routes/forms.
          Knowledge / FAQs has no route and is omitted entirely. */}
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
