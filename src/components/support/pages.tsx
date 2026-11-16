import Link from "next/link";

import type { ActorContext } from "@/lib/auth/actor";
import { formatDateTime, StatusBadge } from "@/components/bookings/ui";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { getSupportHome, SUPPORT_TICKET_ATTENTION_HOURS } from "@/server/services/support-home";

/**
 * Support home (V2 Phase 6, audit defect H-2 — replaces the Phase-1
 * placeholder). Universal pattern: needs attention → metrics →
 * current operations (queues by state) → recent activity → quick
 * actions. Every figure comes from getSupportHome; Support can
 * investigate from here but no custody or payment action is linked.
 */

function PageHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">{eyebrow}</div>
      <h1 className="mt-0.5 text-[22px] font-bold text-ink">{title}</h1>
    </div>
  );
}

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-line bg-page px-4 py-3">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">{label}</dt>
      <dd className="tnum mt-1 text-[15px] font-semibold text-ink">{value}</dd>
      {sub ? <dd className="text-[12px] text-slate2">{sub}</dd> : null}
    </div>
  );
}

export async function SupportHomePage({ actor }: { actor: ActorContext }) {
  const home = await getSupportHome(actor);
  const attention = home.attention;
  const nothingWaiting =
    attention.unassignedTickets === 0 &&
    attention.breachingTickets === 0 &&
    attention.unresolvedHighSeverityIncidents === 0 &&
    attention.overdueDeliveries === 0;
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader eyebrow="Support" title="Support dashboard" />
        <div className="flex flex-wrap gap-2">
          <Link href="/support/tickets" className={subtleButtonClass}>
            Tickets inbox →
          </Link>
          <Link href="/support/incidents" className={subtleButtonClass}>
            Incidents queue →
          </Link>
          <Link href="/support/tasks" className={subtleButtonClass}>
            Tasks →
          </Link>
          <Link href="/track" className={subtleButtonClass}>
            Track a package →
          </Link>
        </div>
      </div>

      <SectionCard title="Needs attention">
        {nothingWaiting ? (
          <p className="text-[13px] text-slate2">
            Nothing needs attention right now. Unassigned tickets, ageing tickets, high-severity
            incidents and overdue deliveries appear here as they arise.
          </p>
        ) : (
          <div className="grid gap-2">
            {attention.unassignedTickets > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-amberbg px-3 py-2 text-[13px]">
                <span className="text-ink">
                  {attention.unassignedTickets} open ticket(s) are unassigned.
                </span>
                <Link href="/support/tickets" className="font-semibold text-brand">
                  Assign →
                </Link>
              </div>
            ) : null}
            {attention.breachingTickets > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-redbg px-3 py-2 text-[13px]">
                <span className="text-ink">
                  {attention.breachingTickets} open ticket(s) are older than{" "}
                  {SUPPORT_TICKET_ATTENTION_HOURS}h — work the oldest first below.
                </span>
                <Link href="/support/tickets" className="font-semibold text-brand">
                  Tickets →
                </Link>
              </div>
            ) : null}
            {attention.unresolvedHighSeverityIncidents > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-redbg px-3 py-2 text-[13px]">
                <span className="text-ink">
                  {attention.unresolvedHighSeverityIncidents} unresolved high-severity incident(s)
                  in the support scope.
                </span>
                <Link href="/support/incidents" className="font-semibold text-brand">
                  Incidents →
                </Link>
              </div>
            ) : null}
            {attention.overdueDeliveries > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
                <span className="text-ink">
                  {attention.overdueDeliveries} package(s) are past their expected delivery date
                  and not yet delivered.
                </span>
                <Link href="/support/tickets" className="font-semibold text-brand">
                  Investigate via tickets →
                </Link>
              </div>
            ) : null}
          </div>
        )}
        {home.oldestOpenTickets.length > 0 ? (
          <div className="mt-4">
            <h3 className="mb-2 text-[13px] font-semibold text-ink">Oldest open tickets</h3>
            <div className="grid gap-2">
              {home.oldestOpenTickets.map((ticket) => (
                <div
                  key={ticket.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
                >
                  <span className="text-ink">
                    {ticket.ticketNumber} · {ticket.subject}
                    <span className="text-slate2">
                      {" "}
                      · raised {formatDateTime(ticket.createdAt)} ·{" "}
                      {ticket.assignedToId ? "assigned" : "unassigned"}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={ticket.status} />
                    <Link href={`/support/tickets/${ticket.id}`} className="font-semibold text-brand">
                      Open →
                    </Link>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {home.overdueDeliveryItems.length > 0 ? (
          <div className="mt-4">
            <h3 className="mb-2 text-[13px] font-semibold text-ink">Overdue deliveries (oldest expected first)</h3>
            <div className="grid gap-2">
              {home.overdueDeliveryItems.map((item) => (
                <div
                  key={item.packageId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
                >
                  <span className="font-mono text-ink">{item.trackingId}</span>
                  <span className="text-slate2">
                    expected {formatDateTime(item.expectedDeliveryAt)} · delivery {item.deliveryStatus} ·
                    operational {item.operationalStatus}
                  </span>
                  <Link
                    href={`/track/${encodeURIComponent(item.trackingId)}`}
                    className="font-semibold text-brand"
                  >
                    Track →
                  </Link>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </SectionCard>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Open tickets" value={String(home.metrics.openTickets)} />
        <StatTile label="Open incidents" value={String(home.metrics.openIncidents)} sub="Support scope" />
        <StatTile label="Tickets resolved today" value={String(home.metrics.resolvedToday)} />
        <StatTile label="Overdue deliveries" value={String(home.metrics.overdueDeliveries)} />
      </dl>

      <SectionCard title="Current operations — ticket queues">
        <div className="grid gap-2 text-[13px]">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
            <span className="text-ink">Open</span>
            <span className="tnum font-semibold text-ink">{home.queues.open}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
            <span className="text-ink">In progress</span>
            <span className="tnum font-semibold text-ink">{home.queues.inProgress}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
            <span className="text-ink">Awaiting customer</span>
            <span className="tnum font-semibold text-ink">{home.queues.awaitingCustomer}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
            <span className="text-ink">Escalated</span>
            <span className="tnum font-semibold text-ink">{home.queues.escalated}</span>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
            <span className="text-ink">Resolved today</span>
            <span className="tnum font-semibold text-ink">{home.queues.resolvedToday}</span>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Recent activity">
        {home.recentTickets.length === 0 && home.recentIncidents.length === 0 ? (
          <p className="text-[13px] text-slate2">No ticket updates or incident activity yet.</p>
        ) : (
          <div className="grid gap-4">
            {home.recentTickets.length > 0 ? (
              <div className="grid gap-2">
                {home.recentTickets.map((ticket) => (
                  <div
                    key={ticket.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
                  >
                    <span className="text-ink">
                      {ticket.ticketNumber} · {ticket.subject}
                      <span className="text-slate2"> · updated {formatDateTime(ticket.updatedAt)}</span>
                    </span>
                    <StatusBadge status={ticket.status} />
                  </div>
                ))}
              </div>
            ) : null}
            {home.recentIncidents.length > 0 ? (
              <div className="grid gap-2">
                {home.recentIncidents.map((incident) => (
                  <div
                    key={incident.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
                  >
                    <span className="text-ink">
                      {incident.incidentNumber} · {incident.category}
                      <span className="text-slate2"> · updated {formatDateTime(incident.updatedAt)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusBadge status={incident.severity} />
                      <StatusBadge status={incident.status} />
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </SectionCard>

      <SectionCard title="Quick actions">
        <div className="flex flex-wrap gap-2">
          <Link href="/support/tickets" className={subtleButtonClass}>
            Tickets inbox →
          </Link>
          <Link href="/support/incidents" className={subtleButtonClass}>
            Incidents queue →
          </Link>
          <Link href="/support/tasks" className={subtleButtonClass}>
            Tasks →
          </Link>
          <Link href="/track" className={subtleButtonClass}>
            Look up a package →
          </Link>
        </div>
      </SectionCard>
    </div>
  );
}
