import type { ReactNode } from "react";
import Link from "next/link";

import type { VendorHomeData } from "@/server/services/home-dashboards";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { ToneIcon } from "@/components/ui/ToneIcon";
import { EmptyState } from "@/components/ui/states";
import { NavIcon } from "@/components/layout/icons";
import type { NavIconName } from "@/lib/navigation/registry";
import { formatDateTime, formatPaisa } from "@/components/bookings/ui";
import { humaniseStatusValue } from "@/lib/status/labels";

/**
 * Vendor home (V3 Step 7) — the vendor portal overview rebuilt on
 * the Step 3 primitives and the Step 7 read model (`getVendorHome`).
 * Presentational only: the page resolves the actor, handles the
 * unlinked case, and hands this view the model. Every figure is the
 * vendor's own (the model composes force-scoped reads only).
 *
 * Honest-mapping notes:
 * - Drill-throughs carry NO filter query: the vendor bookings list
 *   reads page/search/status, and its `status` filters ORDER status
 *   (SUBMITTED / CONFIRMED / CANCELLED) — not the package
 *   operational statuses behind the Pending pickup / In transit /
 *   Delivered cards — so those cards link the bare bookings list,
 *   where the packages live, instead of faking a filter.
 * - Returns has NO card link: the vendor tree has no returns
 *   route (returns surface on this home and inside booking detail).
 * - The COD figure is the vendor-payable LEDGER balance from the
 *   report row — labelled exactly that, never as money collected.
 * - Outstanding invoices sit in the Billing section, not the KPI
 *   row: the brief's row is the six cards below, and the report row
 *   carries no open-invoice count to pair with the amount.
 * - "Create support ticket" is real: /vendor/tickets renders the
 *   RaiseTicketForm for non-staff actors (a vendor holds no
 *   support.ticket.manage), so the link lands on a working form.
 * - "Download report" is real: it points at the vendor report's
 *   own CSV export (/api/reports/vendors/export — the same export
 *   the reports page's Export CSV button uses) for the model's
 *   exact range.
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

/** "2026-10-09" → "9 Oct" (the report range is a pair of ISO dates). */
function shortDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function AttentionCountRow({
  label,
  count,
  href,
  tone,
}: {
  label: string;
  count: number;
  href?: string;
  tone: "danger" | "warning";
}) {
  const inner = (
    <>
      <ToneIcon tone={tone} className="h-[16px] w-[16px] shrink-0" />
      <span className="min-w-0 flex-1 text-[13.5px] text-ink">{label}</span>
      <span className="text-[14px] font-semibold tabular-nums text-ink">{count}</span>
    </>
  );
  if (href) {
    return (
      <Link href={href} className="flex items-center gap-3 py-2.5 hover:bg-surface-2">
        {inner}
      </Link>
    );
  }
  return <div className="flex items-center gap-3 py-2.5">{inner}</div>;
}

export function VendorHomeView({
  data,
  vendorRole,
}: {
  data: VendorHomeData;
  /** The actor's vendor role label (page passes actor.vendorRole). */
  vendorRole: string | null;
}) {
  const { vendor, metrics, attention } = data;
  const approved = vendor.verificationStatus === "APPROVED";
  const rangeWords = `Last 30 days · ${shortDate(metrics.range.from)} – ${shortDate(metrics.range.to)}`;
  const hasAttention =
    !approved ||
    attention.deliveryAttempted > 0 ||
    attention.returnsAwaiting > 0 ||
    attention.openIncidents > 0 ||
    attention.openTickets > 0;

  const quickActions: { label: string; href: string; icon: NavIconName; show: boolean }[] = [
    { label: "Create booking", href: "/vendor/bookings/new", icon: "package", show: approved },
    { label: "Bulk booking", href: "/vendor/bookings/bulk", icon: "boxes", show: true },
    { label: "View packages", href: "/vendor/bookings", icon: "inbox", show: true },
    { label: "View invoices", href: "/vendor/billing", icon: "wallet", show: true },
    { label: "Create support ticket", href: "/vendor/tickets", icon: "ticket", show: true },
    { label: "Track package", href: "/track", icon: "map", show: true },
    { label: "Pickup addresses", href: "/vendor/profile", icon: "user", show: true },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        eyebrow="Vendor"
        title={vendor.businessName}
        description={
          <>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span>Verification</span>
              <StatusBadge domain="generic" status={vendor.verificationStatus} />
              <span aria-hidden="true">·</span>
              <span>Account</span>
              <StatusBadge domain="generic" status={vendor.isActive ? "ACTIVE" : "INACTIVE"} />
              <span aria-hidden="true">·</span>
              <span>signed in as {vendorRole ?? "vendor user"}</span>
            </span>
            <span className="mt-1 block">
              {vendor.warehouses.length > 0 ? (
                <>
                  Assigned warehouses:{" "}
                  {vendor.warehouses.map((w, i) => (
                    <span key={w.warehouseId}>
                      {i > 0 ? " · " : null}
                      <span className="font-mono">{w.warehouseCode}</span> (
                      {humaniseStatusValue(w.kind)}
                      {w.isActive ? "" : ", inactive"})
                    </span>
                  ))}
                </>
              ) : (
                "No warehouse assigned yet"
              )}
            </span>
          </>
        }
        actions={
          <>
            {approved ? (
              <Link href="/vendor/bookings/new" className={PRIMARY_LINK}>
                Create booking
              </Link>
            ) : null}
            <Link href="/vendor/bookings/bulk" className={SECONDARY_LINK}>
              Bulk booking
            </Link>
          </>
        }
      />

      {/* Needs attention — leads the body (DS exception-first). */}
      <Section title="Needs Attention">
        {!hasAttention ? (
          <div className="flex items-center gap-3 rounded-lg bg-successbg px-4 py-3">
            <ToneIcon tone="success" className="h-[18px] w-[18px] text-success" />
            <p className="text-[13.5px] font-medium text-ink">
              Nothing needs your attention right now — no failed delivery attempts, no
              returns waiting on you, and no open incidents or support tickets.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {!approved ? (
              <p className="rounded-lg bg-warningbg px-4 py-3 text-[13.5px] text-warning">
                Your vendor is not approved for booking yet (status:{" "}
                {vendor.verificationStatus}). Bookings open as soon as an administrator
                approves the verification. There is nothing you need to do here —
                approval happens on the administrator side.
              </p>
            ) : null}
            {attention.deliveryAttempted > 0 ? (
              <div>
                <p className="text-[13.5px] text-ink">
                  <span className="font-semibold tabular-nums">
                    {attention.deliveryAttempted}
                  </span>{" "}
                  package{attention.deliveryAttempted === 1 ? " has" : "s have"} had a
                  delivery attempt that did not complete. Review the shipments below to
                  follow up with the recipients.
                </p>
                <ul className="mt-1 divide-y divide-border">
                  {data.attentionShipments.map((row) => (
                    <li key={row.id}>
                      <Link
                        href={`/vendor/bookings/${row.orderId}`}
                        className="flex flex-wrap items-center gap-2 py-2.5 hover:bg-surface-2"
                      >
                        <span className="font-mono text-[12.5px] font-semibold whitespace-nowrap text-primary">
                          {row.trackingId}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                          {row.recipientName} → {row.deliveryCity}, {row.deliveryDistrict}
                        </span>
                        <StatusBadge
                          domain="operational"
                          status={row.operationalStatus}
                          density="compact"
                        />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ul className="divide-y divide-border">
              {attention.returnsAwaiting > 0 ? (
                <li>
                  <AttentionCountRow
                    label="Returns awaiting action (requested, not yet approved or collected) — they appear in your recent returns below"
                    count={attention.returnsAwaiting}
                    tone="warning"
                  />
                </li>
              ) : null}
              {attention.openIncidents > 0 ? (
                <li>
                  <AttentionCountRow
                    label="Open incidents on your packages"
                    count={attention.openIncidents}
                    href="/vendor/incidents"
                    tone="danger"
                  />
                </li>
              ) : null}
              {attention.openTickets > 0 ? (
                <li>
                  <AttentionCountRow
                    label="Open support tickets"
                    count={attention.openTickets}
                    href="/vendor/tickets"
                    tone="warning"
                  />
                </li>
              ) : null}
            </ul>
          </div>
        )}
      </Section>

      {/* KPI row — the brief's six cards. Windowed figures carry the
          report range in words; current buckets say so. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
        <StatCard
          label="Bookings"
          value={metrics.bookings.toLocaleString("en-IN")}
          context={rangeWords}
          icon={<NavIcon name="package" />}
          tint="brand"
          href="/vendor/bookings"
        />
        <StatCard
          label="Pending pickup"
          value={metrics.pendingPickup.toLocaleString("en-IN")}
          context="Booked, not yet picked up"
          icon={<NavIcon name="inbox" />}
          tint="warning"
          href="/vendor/bookings"
        />
        <StatCard
          label="In transit"
          value={metrics.inTransit.toLocaleString("en-IN")}
          context={`Dispatched between warehouses · ${metrics.outForDelivery} out for delivery`}
          icon={<NavIcon name="truck" />}
          tint="info"
          href="/vendor/bookings"
        />
        <StatCard
          label="Delivered"
          value={metrics.delivered.toLocaleString("en-IN")}
          context={`${rangeWords} · ${metrics.returnsCreated} return${metrics.returnsCreated === 1 ? "" : "s"} created`}
          icon={<NavIcon name="hand" />}
          tint="success"
          href="/vendor/bookings"
        />
        <StatCard
          label="Returns"
          value={metrics.returnsCreated.toLocaleString("en-IN")}
          context={rangeWords}
          icon={<NavIcon name="undo" />}
          tint="neutral"
        />
        <StatCard
          label="COD payable to you"
          value={formatPaisa(metrics.codPayablePaisa)}
          context="Vendor-payable ledger balance"
          icon={<NavIcon name="coins" />}
          tint="success"
          href="/vendor/billing"
        />
      </div>

      {/* Recent shipments — the vendor's newest packages. */}
      <Section
        title="Recent Shipments"
        action={
          <Link
            href="/vendor/bookings"
            className="text-[13px] font-semibold text-primary hover:text-primary-dark"
          >
            All bookings →
          </Link>
        }
      >
        {data.recentShipments.length === 0 ? (
          <p className="text-[13.5px] text-ink-2">
            No shipments yet — your packages will appear here once you create a booking.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  {["Tracking ID", "Recipient", "Destination", "Status"].map((header) => (
                    <th
                      key={header}
                      scope="col"
                      className="bg-surface-2 px-3 py-2 text-left text-[12px] font-semibold uppercase tracking-wide text-ink-2"
                    >
                      {header}
                    </th>
                  ))}
                  <th
                    scope="col"
                    className="bg-surface-2 px-3 py-2 text-right text-[12px] font-semibold uppercase tracking-wide text-ink-2"
                  >
                    COD
                  </th>
                  <th
                    scope="col"
                    className="bg-surface-2 px-3 py-2 text-left text-[12px] font-semibold uppercase tracking-wide text-ink-2"
                  >
                    Date
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.recentShipments.map((row) => (
                  <tr key={row.id} className="h-11 border-t border-border hover:bg-surface-2">
                    <td className="px-3 py-2 text-table">
                      <Link
                        href={`/vendor/bookings/${row.orderId}`}
                        className="font-mono font-semibold whitespace-nowrap text-primary hover:text-primary-dark"
                      >
                        {row.trackingId}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-table text-ink">{row.recipientName}</td>
                    <td className="px-3 py-2 text-table text-ink">
                      {row.deliveryCity}, {row.deliveryDistrict}
                    </td>
                    <td className="px-3 py-2 text-table">
                      <StatusBadge
                        domain="operational"
                        status={row.operationalStatus}
                        density="compact"
                      />
                    </td>
                    <td className="px-3 py-2 text-table text-right whitespace-nowrap tabular-nums text-ink">
                      {formatPaisa(row.codAmountPaisa)}
                    </td>
                    <td className="px-3 py-2 text-table whitespace-nowrap text-ink-2">
                      {formatDateTime(row.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="grid gap-5 xl:grid-cols-2">
        {/* Recent bookings — approval PENDING keeps its special
            rendering (the badge shows the approval state, exactly as
            the previous page did). */}
        <Section title="Recent Bookings">
          {data.recentBookings.length === 0 ? (
            <EmptyState
              title="No bookings yet"
              description="Create your first booking to get tracking IDs for your packages."
              action={
                approved ? (
                  <Link href="/vendor/bookings/new" className={PRIMARY_LINK}>
                    Create booking
                  </Link>
                ) : undefined
              }
            />
          ) : (
            <ul className="divide-y divide-border">
              {data.recentBookings.map((booking) => (
                <li key={booking.id}>
                  <Link
                    href={`/vendor/bookings/${booking.id}`}
                    className="flex flex-wrap items-center gap-2 py-2.5 hover:bg-surface-2"
                  >
                    <span className="font-mono text-[12.5px] font-semibold text-primary">
                      {booking.orderNumber}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                      → {booking.destinationDistrict} · {booking.packageCount} parcel
                      {booking.packageCount === 1 ? "" : "s"} ·{" "}
                      {formatDateTime(booking.createdAt)}
                    </span>
                    <StatusBadge
                      domain="generic"
                      status={
                        booking.approvalStatus === "PENDING" ? "PENDING" : booking.status
                      }
                      density="compact"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Section>

        {/* Recent returns. */}
        <Section title="Recent Returns">
          {data.recentReturns.length === 0 ? (
            <p className="text-[13.5px] text-ink-2">No returns yet.</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.recentReturns.map((ret) => (
                <li key={ret.id} className="flex flex-wrap items-center gap-2 py-2.5">
                  <span className="font-mono text-[12.5px] font-semibold text-ink">
                    {ret.returnNumber}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink">
                    <span className="font-mono text-[12.5px]">{ret.trackingId}</span> ·{" "}
                    {humaniseStatusValue(ret.reason)} · {formatDateTime(ret.createdAt)}
                  </span>
                  <StatusBadge domain="generic" status={ret.status} density="compact" />
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {/* Billing — outstanding invoices live here, outside the KPI
          row (see the header note). */}
      <Section
        title="Billing"
        action={
          <Link
            href="/vendor/billing"
            className="text-[13px] font-semibold text-primary hover:text-primary-dark"
          >
            Invoices &amp; settlements →
          </Link>
        }
      >
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div>
            <dt className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-2">
              Outstanding invoices
            </dt>
            <dd className="mt-1 text-[20px] font-semibold tabular-nums text-ink">
              {formatPaisa(metrics.outstandingPaisa)}
            </dd>
            <dd className="text-[12.5px] text-ink-2">
              Open invoices minus payments and coverage
            </dd>
          </div>
          <div>
            <dt className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-2">
              COD payable to you
            </dt>
            <dd className="mt-1 text-[20px] font-semibold tabular-nums text-ink">
              {formatPaisa(metrics.codPayablePaisa)}
            </dd>
            <dd className="text-[12.5px] text-ink-2">Vendor-payable ledger balance</dd>
          </div>
        </dl>
      </Section>

      {/* Quick actions — only actions with real routes/forms. */}
      <Section title="Quick Actions">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
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
          <a
            href={`/api/reports/vendors/export?from=${metrics.range.from}&to=${metrics.range.to}`}
            className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-[13.5px] font-medium text-ink hover:border-primary hover:bg-surface-2"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-light text-primary-dark">
              <NavIcon name="chart" />
            </span>
            Download report
          </a>
        </div>
      </Section>
    </div>
  );
}
