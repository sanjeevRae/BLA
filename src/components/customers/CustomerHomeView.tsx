import type { ReactNode } from "react";
import Link from "next/link";

import type { CustomerHomeData } from "@/server/services/home-dashboards";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ToneIcon } from "@/components/ui/ToneIcon";
import { EmptyState } from "@/components/ui/states";
import { NavIcon } from "@/components/layout/icons";
import { formatDateTime, formatPaisa } from "@/components/bookings/ui";

/**
 * Customer home — presentational view (V3 Step 7, brief §12).
 * Pure rendering of `CustomerHomeData` (the `getCustomerHome`
 * read model); the async container (`CustomerHomePage` in
 * self-service-pages.tsx) owns the reads and the unlinked-account
 * branch, and passes the full package list in as `allPackages`.
 *
 * PRESENTATION DECISION (recorded for Step 7): each package on
 * this customer surface carries ONE shared StatusBadge — the
 * operational status, with its friendly label. The multi-domain
 * badge stack the previous home rendered on every row does NOT
 * carry over to this surface: a customer needs the one status
 * that says where their parcel is, not the internal breakdown.
 *
 * Honesty rules held here:
 * - "Expected delivery" renders ONLY when the shipment's stored
 *   estimate is present; when it is null the element is omitted
 *   entirely — never a placeholder, never a computed date.
 * - No PackageTimeline is rendered on these cards: the read
 *   model carries no recorded events, so there is nothing honest
 *   to draw. Each card links to the public tracking page, which
 *   shows the full recorded timeline.
 * - Current location is the warehouse name + city text label the
 *   model carries — text only, nothing more precise.
 * - Recent deliveries label their timestamp "Last update": the
 *   model exposes the package's last-update instant, not a
 *   proof-of-delivery instant, so nothing here claims otherwise.
 *   Their badge is the operational DELIVERED status because the
 *   model's recent-deliveries read is the delivered-only list.
 */

const PRIMARY_LINK =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[14px] font-[550] text-white hover:bg-primary-dark";
const SECONDARY_LINK =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-border-control bg-card px-4 py-2.5 text-[14px] font-[550] text-ink hover:bg-surface-2";
const SECTION_LINK =
  "text-[13px] font-semibold text-primary hover:text-primary-dark";

const HOME_DESCRIPTION =
  "Track packages addressed to you, see what needs your attention, and find your recent deliveries.";

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

function QuickActions() {
  return (
    <Section title="Quick actions">
      <div className="flex flex-wrap gap-2">
        <Link href="/track" className={PRIMARY_LINK}>
          Track a package
        </Link>
        <Link href="/customer/tickets" className={SECONDARY_LINK}>
          Raise a ticket
        </Link>
        <Link href="/customer/incidents/new" className={SECONDARY_LINK}>
          Report an incident
        </Link>
        <Link href="/customer/billing" className={SECONDARY_LINK}>
          View invoices
        </Link>
        <Link href="/customer/profile" className={SECONDARY_LINK}>
          My profile
        </Link>
      </div>
    </Section>
  );
}

export function CustomerHomeView({
  data,
  allPackages,
}: {
  data: CustomerHomeData;
  /** The full own-packages list (CustomerPackageList, rendered by
   *  the container) — the model caps its own lists at 5, so the
   *  complete list with its "Showing X of Y" count lives here. */
  allPackages?: ReactNode;
}) {
  const { metrics, attention } = data;
  const hasAttention =
    attention.deliveryAttempted > 0 || attention.openTickets > 0 || attention.unpaidInvoices > 0;

  // First-run / empty state (named audit defect for this portal):
  // a customer with no packages at all gets the empty state and
  // the quick actions — not a wall of zero cards.
  if (metrics.total === 0) {
    return (
      <div className="flex flex-col gap-5">
        <PageHeader title="My packages" description={HOME_DESCRIPTION} />
        <EmptyState
          title="No packages yet"
          description="When a sender books a delivery to your phone number, it appears here — you can also track any parcel publicly from the tracking page."
          action={
            <Link href="/track" className={PRIMARY_LINK}>
              Track a package
            </Link>
          }
        />
        <QuickActions />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="My packages" description={HOME_DESCRIPTION} />

      {/* 1 — Needs attention leads (exception-first, DS §1). */}
      <Section title="Needs attention">
        <div className="grid gap-2">
          {data.attemptedShipments.map((pkg) => (
            <p
              key={pkg.id}
              className="flex items-start gap-2 rounded-lg bg-warningbg px-3 py-2 text-[13.5px] text-ink"
            >
              <ToneIcon tone="warning" className="mt-0.5 h-[16px] w-[16px] shrink-0 text-warning" />
              <span>
                A delivery attempt for{" "}
                <Link
                  href={`/track/${pkg.trackingId}`}
                  className="whitespace-nowrap font-mono font-semibold text-primary hover:text-primary-dark"
                >
                  {pkg.trackingId}
                </Link>{" "}
                did not complete. Check the tracking page for the next step, or{" "}
                <Link href="/customer/tickets" className="font-semibold text-primary hover:text-primary-dark">
                  raise a support ticket
                </Link>
                .
              </span>
            </p>
          ))}
          {attention.openTickets > 0 ? (
            <p className="flex items-start gap-2 rounded-lg bg-warningbg px-3 py-2 text-[13.5px] text-ink">
              <ToneIcon tone="warning" className="mt-0.5 h-[16px] w-[16px] shrink-0 text-warning" />
              <span>
                You have {attention.openTickets} open support ticket
                {attention.openTickets === 1 ? "" : "s"}.{" "}
                <Link href="/customer/tickets" className="font-semibold text-primary hover:text-primary-dark">
                  View tickets
                </Link>
              </span>
            </p>
          ) : null}
          {attention.unpaidInvoices > 0 ? (
            <p className="flex items-start gap-2 rounded-lg bg-warningbg px-3 py-2 text-[13.5px] text-ink">
              <ToneIcon tone="warning" className="mt-0.5 h-[16px] w-[16px] shrink-0 text-warning" />
              <span>
                {attention.unpaidInvoices} invoice{attention.unpaidInvoices === 1 ? " is" : "s are"}{" "}
                unpaid —{" "}
                <span className="font-semibold tabular-nums">
                  {formatPaisa(attention.unpaidTotalPaisa)}
                </span>{" "}
                outstanding.{" "}
                <Link href="/customer/billing" className="font-semibold text-primary hover:text-primary-dark">
                  View invoices
                </Link>
              </span>
            </p>
          ) : null}
          {!hasAttention ? (
            <p className="flex items-center gap-2 rounded-lg bg-successbg px-3 py-2 text-[13.5px] font-medium text-ink">
              <ToneIcon tone="success" className="h-[16px] w-[16px] shrink-0 text-success" />
              Nothing needs your attention right now — no failed delivery attempts, open tickets,
              or unpaid invoices.
            </p>
          ) : null}
        </div>
      </Section>

      {/* 2 — Summary. Only Support cases drills through: it has a
          real destination (the customer's own ticket list). The
          package counts live on this home itself, so those cards
          stay non-link rather than faking a filter. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatCard
          label="Total shipments"
          value={metrics.total.toLocaleString("en-IN")}
          context="Addressed to you"
          icon={<NavIcon name="package" />}
          tint="brand"
        />
        <StatCard
          label="In transit"
          value={metrics.inTransit.toLocaleString("en-IN")}
          context={`${metrics.outForDelivery} out for delivery`}
          icon={<NavIcon name="truck" />}
          tint="info"
        />
        <StatCard
          label="Out for delivery"
          value={metrics.outForDelivery.toLocaleString("en-IN")}
          context="On the final leg to you"
          icon={<NavIcon name="hand" />}
          tint="warning"
        />
        <StatCard
          label="Delivered"
          value={metrics.delivered.toLocaleString("en-IN")}
          context="All time"
          icon={<NavIcon name="inbox" />}
          tint="success"
        />
        <StatCard
          label="Returns"
          value={metrics.returned.toLocaleString("en-IN")}
          context="Returns requested on your packages"
          icon={<NavIcon name="undo" />}
          tint="neutral"
        />
        <StatCard
          label="Support cases"
          value={attention.openTickets.toLocaleString("en-IN")}
          context="Open tickets"
          icon={<NavIcon name="ticket" />}
          tint={attention.openTickets > 0 ? "warning" : "neutral"}
          href="/customer/tickets"
        />
      </div>

      {/* 3 — Current shipments (brief §12 cards, single badge). */}
      <Section title="Current shipments">
        {data.currentShipments.length === 0 ? (
          <p className="text-[13.5px] text-ink-2">
            No packages are on their way right now. Packages addressed to you appear here as
            they move.
          </p>
        ) : (
          <div className="grid gap-3">
            {data.currentShipments.map((shipment) => (
              <article
                key={shipment.trackingId}
                className="rounded-lg border border-border p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    href={`/track/${shipment.trackingId}`}
                    className="whitespace-nowrap font-mono text-[13.5px] font-semibold text-primary hover:text-primary-dark"
                  >
                    {shipment.trackingId}
                  </Link>
                  <StatusBadge domain="operational" status={shipment.operationalStatus} />
                </div>
                <p className="mt-2 text-[14px] font-medium text-ink">{shipment.description}</p>
                <p className="mt-1 text-[13px] text-ink-2">
                  To {shipment.deliveryCity}, {shipment.deliveryDistrict}
                </p>
                <div className="mt-2 grid gap-1 text-[12.5px] text-ink-2">
                  {shipment.currentLocationLabel ? (
                    <p>At {shipment.currentLocationLabel}</p>
                  ) : null}
                  {shipment.expectedDeliveryAt ? (
                    <p className="font-medium text-ink">
                      Expected delivery {formatDateTime(shipment.expectedDeliveryAt)}
                    </p>
                  ) : null}
                  <p>Last updated {formatDateTime(shipment.lastUpdateAt)}</p>
                </div>
                <p className="mt-3">
                  <Link href={`/track/${shipment.trackingId}`} className={SECTION_LINK}>
                    See the full timeline on the tracking page →
                  </Link>
                </p>
              </article>
            ))}
          </div>
        )}
      </Section>

      {/* 4 — Recent deliveries. */}
      <Section title="Recent deliveries">
        {data.recentDeliveries.length === 0 ? (
          <p className="text-[13.5px] text-ink-2">No deliveries yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.recentDeliveries.map((delivery) => (
              <li
                key={delivery.trackingId}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5"
              >
                <Link
                  href={`/track/${delivery.trackingId}`}
                  className="whitespace-nowrap font-mono text-[12.5px] font-semibold text-primary hover:text-primary-dark"
                >
                  {delivery.trackingId}
                </Link>
                <span className="min-w-0 flex-1 text-[13.5px] text-ink">
                  {delivery.description}
                  <span className="text-ink-2">
                    {" "}
                    · {delivery.deliveryCity}, {delivery.deliveryDistrict}
                  </span>
                </span>
                <StatusBadge domain="operational" status="DELIVERED" />
                <span className="shrink-0 text-[12.5px] text-ink-2">
                  Last update {formatDateTime(delivery.lastUpdateAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* 5 — Recent activity: omitted entirely when the
          notification read failed (the model's null tolerance). */}
      {data.recentNotifications !== null ? (
        <Section title="Recent activity">
          {data.recentNotifications.length === 0 ? (
            <p className="text-[13.5px] text-ink-2">
              No recent notifications. Updates about your packages will appear here.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {data.recentNotifications.map((note) => (
                <li
                  key={note.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5"
                >
                  <span className="min-w-0 text-[13.5px] text-ink">
                    <span className="font-semibold">{note.title}</span> — {note.body}
                  </span>
                  <span className="shrink-0 text-[12.5px] text-ink-2">
                    {formatDateTime(note.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {/* 6 — All my packages: the full list, kept from the
          container (the model's own lists are capped at 5). */}
      {allPackages ? <Section title="All my packages">{allPackages}</Section> : null}

      {/* 7 — Quick actions. */}
      <QuickActions />
    </div>
  );
}
