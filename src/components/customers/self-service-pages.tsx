import Link from "next/link";

import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { StatusBadge as SharedStatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "@/components/ui/states";
import { formatDateTime, formatPaisa } from "@/components/bookings/ui";
import { listPackages } from "@/server/services/packages";
import type { PackageView } from "@/server/services/package-lifecycle";
import { listBookings } from "@/server/services/bookings";
import { listTickets } from "@/server/services/support-tickets";
import { getInvoice, listInvoices } from "@/server/services/invoices";
import { listIncidents } from "@/server/services/incidents";
import { listMyNotifications } from "@/server/services/notifications";
import { getOwnCustomerProfile } from "@/server/services/customers";
import {
  ChangePasswordForm,
  CustomerIncidentForm,
  type IncidentLinkOption,
} from "@/components/customers/self-service-forms";

/**
 * Customer self-service screens (V2 Phase 6, audit M-3): home,
 * billing, incidents and profile. Every read is own-data only because
 * the services force-scope to the actor: packages to
 * recipientCustomerId = actor.customerId, bookings to sender-or-
 * recipient, invoices to Invoice.customerId = actor.customerId,
 * incidents to the customer's own packages / orders / reports, tickets
 * to customerId, notifications to the actor's user id. Cross-customer
 * reads are denied (and audited) inside those services.
 */

function PageHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
        {eyebrow}
      </div>
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

function NotLinkedNotice() {
  return (
    <div className="rounded-lg border border-line bg-surface p-5 text-[13px] text-ink">
      Your account is not linked to a customer record yet. When a sender books a delivery to your
      phone number, your packages appear here — you can also track any parcel publicly from the
      tracking page.
    </div>
  );
}

/** One package row with the five status domains shown separately,
 *  each with its domain label (ui-ux-guidelines §6). */
function PackageRow({ pkg }: { pkg: PackageView }) {
  return (
    <div className="grid gap-2 rounded-md border border-line px-3 py-2 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={`/track/${pkg.trackingId}`} className="font-mono font-semibold text-brand">
          {pkg.trackingId}
        </Link>
        <span className="text-ink">
          {pkg.description} → {pkg.deliveryCity}, {pkg.deliveryDistrict} ·{" "}
          {formatDateTime(pkg.createdAt)}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex items-center gap-1">
          <span className="text-[11px] text-slate2">Operational</span>
          <SharedStatusBadge domain="operational" status={pkg.operationalStatus} />
        </span>
        <span className="flex items-center gap-1">
          <span className="text-[11px] text-slate2">Condition</span>
          <SharedStatusBadge domain="condition" status={pkg.condition} />
        </span>
        <span className="flex items-center gap-1">
          <span className="text-[11px] text-slate2">Payment</span>
          <SharedStatusBadge domain="payment" status={pkg.paymentStatus} />
        </span>
        <span className="flex items-center gap-1">
          <span className="text-[11px] text-slate2">Delivery</span>
          <SharedStatusBadge domain="delivery" status={pkg.deliveryStatus} />
        </span>
        <span className="flex items-center gap-1">
          <span className="text-[11px] text-slate2">Exception</span>
          <SharedStatusBadge domain="exception" status={pkg.exceptionStatus} />
        </span>
      </div>
    </div>
  );
}

async function packageTotal(actor: ActorContext, status?: string): Promise<number> {
  const { meta } = await listPackages(actor, { status, page: 1, pageSize: 1 });
  return meta.total;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export async function CustomerHomePage({ actor }: { actor: ActorContext }) {
  if (!actor.customerId) {
    return (
      <div className="grid gap-5">
        <PageHeader eyebrow="Customer" title="My packages" />
        <NotLinkedNotice />
      </div>
    );
  }

  const [
    totalPackages,
    inTransitCount,
    outForDeliveryCount,
    deliveredCount,
    attemptedList,
    currentList,
    openTickets,
    invoices,
    notifications,
  ] = await Promise.all([
    packageTotal(actor),
    packageTotal(actor, "IN_TRANSIT"),
    packageTotal(actor, "OUT_FOR_DELIVERY"),
    packageTotal(actor, "DELIVERED"),
    listPackages(actor, { status: "DELIVERY_ATTEMPTED", page: 1, pageSize: 5 }),
    listPackages(actor, { status: "OUT_FOR_DELIVERY", page: 1, pageSize: 5 }),
    listTickets(actor, { openOnly: true, page: 1, pageSize: 1 }),
    listInvoices(actor, { page: 1, pageSize: 100 }),
    listMyNotifications(actor, { page: 1, pageSize: 5 }).catch(() => null),
  ]);
  const unpaid = invoices.items.filter(
    (invoice) => invoice.status !== "CANCELLED" && invoice.outstandingPaisa !== "0",
  );
  const unpaidTotal = unpaid.reduce((sum, invoice) => sum + BigInt(invoice.outstandingPaisa), BigInt(0));
  const attemptedCount = attemptedList.meta.total;
  const hasAttention = attemptedCount > 0 || openTickets.meta.total > 0 || unpaid.length > 0;

  return (
    <div className="grid gap-5">
      <PageHeader eyebrow="Customer" title="My packages" />

      {/* 1 — What needs attention */}
      <SectionCard title="Needs attention">
        <div className="grid gap-2">
          {attemptedList.packages.map((pkg) => (
            <p
              key={pkg.id}
              className="rounded-md border border-line bg-redbg px-3 py-2 text-[13px] text-reddeep"
            >
              A delivery attempt for{" "}
              <Link href={`/track/${pkg.trackingId}`} className="font-mono font-semibold underline">
                {pkg.trackingId}
              </Link>{" "}
              did not complete. Check the tracking page for the next step, or{" "}
              <Link href="/customer/tickets" className="font-semibold underline">
                raise a support ticket
              </Link>
              .
            </p>
          ))}
          {openTickets.meta.total > 0 ? (
            <p className="rounded-md border border-line bg-amberbg px-3 py-2 text-[13px] text-amberdeep">
              You have {openTickets.meta.total} open support ticket
              {openTickets.meta.total === 1 ? "" : "s"}.{" "}
              <Link href="/customer/tickets" className="font-semibold underline">
                View tickets
              </Link>
            </p>
          ) : null}
          {unpaid.length > 0 ? (
            <p className="rounded-md border border-line bg-amberbg px-3 py-2 text-[13px] text-amberdeep">
              {unpaid.length} invoice{unpaid.length === 1 ? " is" : "s are"} unpaid —{" "}
              <span className="tnum font-semibold">{formatPaisa(unpaidTotal)}</span> outstanding.{" "}
              <Link href="/customer/billing" className="font-semibold underline">
                View invoices
              </Link>
            </p>
          ) : null}
          {!hasAttention ? (
            <p className="text-[13px] text-slate2">
              Nothing needs your attention right now — no failed delivery attempts, open tickets,
              or unpaid invoices.
            </p>
          ) : null}
        </div>
      </SectionCard>

      {/* 2 — Metrics */}
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Total packages" value={String(totalPackages)} sub="Addressed to you" />
        <StatTile
          label="In transit"
          value={String(inTransitCount + outForDeliveryCount)}
          sub={`${outForDeliveryCount} out for delivery`}
        />
        <StatTile label="Delivered" value={String(deliveredCount)} />
        <StatTile label="Open tickets" value={String(openTickets.meta.total)} />
      </dl>

      {/* 3 — What is happening now */}
      <SectionCard title="Out for delivery">
        <div className="grid gap-2">
          {currentList.packages.map((pkg) => (
            <PackageRow key={pkg.id} pkg={pkg} />
          ))}
          {currentList.packages.length === 0 ? (
            <p className="text-[13px] text-slate2">
              No packages are out for delivery right now. Packages on their way appear here as
              they move.
            </p>
          ) : null}
        </div>
      </SectionCard>

      {/* 4 — What recently changed */}
      <SectionCard title="Recent activity">
        <div className="grid gap-2">
          {(notifications?.items ?? []).map((note) => (
            <div
              key={note.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
            >
              <span className="text-ink">
                <span className="font-semibold">{note.title}</span> — {note.body}
              </span>
              <span className="text-slate2">{formatDateTime(note.createdAt)}</span>
            </div>
          ))}
          {(notifications?.items ?? []).length === 0 ? (
            <p className="text-[13px] text-slate2">
              No recent notifications. Updates about your packages will appear here.
            </p>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard title="All my packages">
        <CustomerPackageList actor={actor} />
      </SectionCard>

      {/* 5 — What to do next */}
      <SectionCard title="Quick actions">
        <div className="flex flex-wrap gap-2">
          <Link href="/track" className={subtleButtonClass}>
            Track a package
          </Link>
          <Link href="/customer/tickets" className={subtleButtonClass}>
            Raise a ticket
          </Link>
          <Link href="/customer/incidents/new" className={subtleButtonClass}>
            Report an incident
          </Link>
          <Link href="/customer/billing" className={subtleButtonClass}>
            View invoices
          </Link>
          <Link href="/customer/profile" className={subtleButtonClass}>
            My profile
          </Link>
        </div>
      </SectionCard>
    </div>
  );
}

async function CustomerPackageList({ actor }: { actor: ActorContext }) {
  const { packages, meta } = await listPackages(actor, { page: 1, pageSize: 20 });
  if (packages.length === 0) {
    return (
      <EmptyState
        title="No packages yet"
        description="When a sender books a delivery to your phone number, it appears here — you can also track any parcel publicly from the tracking page."
        action={
          <Link href="/track" className={subtleButtonClass}>
            Track a package
          </Link>
        }
      />
    );
  }
  return (
    <div className="grid gap-2">
      {packages.map((pkg) => (
        <PackageRow key={pkg.id} pkg={pkg} />
      ))}
      <p className="text-[12px] text-slate2">
        Showing {packages.length} of {meta.total} package{meta.total === 1 ? "" : "s"}.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Billing (read-only — customers never pay through this UI)
// ---------------------------------------------------------------------------

export async function CustomerBillingPage({ actor }: { actor: ActorContext }) {
  // Guard BEFORE the service call: an actor with no customer link is
  // unscoped in listInvoices (that is the finance read), so an
  // unlinked customer account must never reach it from here.
  if (!actor.customerId) {
    return (
      <div className="grid gap-5">
        <PageHeader eyebrow="Customer" title="My invoices" />
        <NotLinkedNotice />
      </div>
    );
  }
  const { items, meta } = await listInvoices(actor, { page: 1, pageSize: 50 });
  return (
    <div className="grid gap-5">
      <PageHeader eyebrow="Customer" title="My invoices" />
      <p className="text-[13px] text-slate2">
        Invoices billed to your customer account. This page is read-only — if an amount looks
        wrong, raise a payment dispute from{" "}
        <Link href="/customer/incidents/new" className="font-semibold text-brand">
          Report an incident
        </Link>
        .
      </p>
      {items.length === 0 ? (
        <EmptyState
          title="No invoices yet"
          description="Invoices for deliveries billed to your account appear here."
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-surface">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wide text-slate2">
                <th className="px-3 py-2">Invoice</th>
                <th className="px-3 py-2">Issued</th>
                <th className="px-3 py-2">Due</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2 text-right">Paid</th>
                <th className="px-3 py-2 text-right">Outstanding</th>
                <th className="px-3 py-2">Payment status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((invoice) => (
                <tr key={invoice.id} className="border-b border-line/60">
                  <td className="px-3 py-2">
                    <Link
                      href={`/customer/billing/${invoice.id}`}
                      className="font-mono font-semibold text-brand"
                    >
                      {invoice.invoiceNumber}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{formatDateTime(invoice.issuedAt)}</td>
                  <td className="px-3 py-2">{invoice.dueAt ? formatDateTime(invoice.dueAt) : "—"}</td>
                  <td className="tnum px-3 py-2 text-right">{formatPaisa(invoice.totalPaisa)}</td>
                  <td className="tnum px-3 py-2 text-right">{formatPaisa(invoice.paidPaisa)}</td>
                  <td className="tnum px-3 py-2 text-right">{formatPaisa(invoice.outstandingPaisa)}</td>
                  <td className="px-3 py-2">
                    <SharedStatusBadge domain="generic" status={invoice.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {meta.total > items.length ? (
        <p className="text-[12px] text-slate2">
          Showing {items.length} of {meta.total} invoices.
        </p>
      ) : null}
    </div>
  );
}

export async function CustomerInvoiceDetailPage({
  actor,
  id,
}: {
  actor: ActorContext;
  id: string;
}) {
  if (!actor.customerId) {
    return (
      <div className="grid gap-5">
        <PageHeader eyebrow="Customer" title="Invoice" />
        <NotLinkedNotice />
      </div>
    );
  }
  const invoice = await getInvoice(actor, id);
  return (
    <div className="grid gap-5">
      <div>
        <Link href="/customer/billing" className="text-[12px] font-semibold text-brand">
          ← All my invoices
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-[22px] font-bold text-ink">{invoice.invoiceNumber}</h1>
          <SharedStatusBadge domain="generic" status={invoice.status} />
        </div>
        <p className="text-[13px] text-slate2">
          Issued {formatDateTime(invoice.issuedAt)}
          {invoice.dueAt ? ` · due ${formatDateTime(invoice.dueAt)}` : ""}
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="Total" value={formatPaisa(invoice.totalPaisa)} />
        <StatTile
          label="Paid"
          value={formatPaisa(invoice.paidPaisa)}
          sub={`settlements ${formatPaisa(invoice.settlementCoveragePaisa)} · credits ${formatPaisa(invoice.adjustmentCreditsPaisa)}`}
        />
        <StatTile label="Outstanding" value={formatPaisa(invoice.outstandingPaisa)} />
      </dl>

      <SectionCard title="Charges">
        <div className="grid gap-2">
          {invoice.lines.map((line) => (
            <div
              key={line.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
            >
              <span className="text-ink">{line.description}</span>
              <span className="tnum font-medium text-ink">{formatPaisa(line.amountPaisa)}</span>
            </div>
          ))}
          {invoice.lines.length === 0 ? (
            <p className="text-[13px] text-slate2">No charge lines on this invoice.</p>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard title="Payments">
        <div className="grid gap-2">
          {invoice.payments.map((payment) => (
            <div
              key={payment.paymentId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
            >
              <span className="text-ink">
                <span className="tnum font-medium">{formatPaisa(payment.amountPaisa)}</span> ·{" "}
                {payment.method}
                {payment.transactionRef ? ` · ref ${payment.transactionRef}` : ""}
              </span>
              <span className="flex items-center gap-2">
                <span className="text-slate2">
                  {payment.paidAt ? formatDateTime(payment.paidAt) : ""}
                </span>
                <SharedStatusBadge domain="generic" status={payment.status} />
              </span>
            </div>
          ))}
          {invoice.payments.length === 0 ? (
            <p className="text-[13px] text-slate2">No payments recorded against this invoice yet.</p>
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

const INCIDENT_CATEGORY_LABELS: Record<string, string> = {
  PAYMENT_DISPUTE: "Payment dispute",
};

export async function CustomerIncidentsPage({ actor }: { actor: ActorContext }) {
  const { items } = await listIncidents(actor, { page: 1, pageSize: 50 });
  const canReport =
    hasPermission(actor, "incident.report") || hasPermission(actor, "payment.dispute.raise");
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHeader eyebrow="Customer" title="My incidents" />
        {canReport ? (
          <Link href="/customer/incidents/new" className={subtleButtonClass}>
            Report an incident
          </Link>
        ) : null}
      </div>
      <p className="text-[13px] text-slate2">
        Problems you have reported about your packages and orders, including payment disputes.
        Support and finance work from these reports — you will see the status here as it changes.
      </p>
      {items.length === 0 ? (
        <EmptyState
          title="No incidents reported"
          description="If a delivery goes wrong or a payment looks incorrect, report it here and the team will investigate."
          action={
            canReport ? (
              <Link href="/customer/incidents/new" className={subtleButtonClass}>
                Report an incident
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-line bg-surface">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wide text-slate2">
                <th className="px-3 py-2">Number</th>
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Severity</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Package</th>
                <th className="px-3 py-2">Raised</th>
              </tr>
            </thead>
            <tbody>
              {items.map((incident) => (
                <tr key={incident.id} className="border-b border-line/60">
                  <td className="px-3 py-2 font-mono">{incident.incidentNumber}</td>
                  <td className="px-3 py-2">
                    {INCIDENT_CATEGORY_LABELS[incident.category] ??
                      incident.category.replaceAll("_", " ")}
                  </td>
                  <td className="px-3 py-2">
                    <SharedStatusBadge domain="generic" status={incident.severity} />
                  </td>
                  <td className="px-3 py-2">
                    <SharedStatusBadge domain="generic" status={incident.status} />
                  </td>
                  <td className="px-3 py-2 font-mono">{incident.packageTrackingId ?? "—"}</td>
                  <td className="px-3 py-2">{formatDateTime(incident.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export async function CustomerIncidentNewPage({ actor }: { actor: ActorContext }) {
  const canReport = hasPermission(actor, "incident.report");
  const canDispute = hasPermission(actor, "payment.dispute.raise");
  const [packages, bookings] = actor.customerId
    ? await Promise.all([
        listPackages(actor, { page: 1, pageSize: 50 }),
        listBookings(actor, { page: 1, pageSize: 50 }),
      ])
    : [{ packages: [] }, { bookings: [] }];
  const packageOptions: IncidentLinkOption[] = packages.packages.map((pkg) => ({
    value: `package:${pkg.id}`,
    label: `Package ${pkg.trackingId} — ${pkg.description}`,
  }));
  const orderOptions: IncidentLinkOption[] = bookings.bookings.map((booking) => ({
    value: `order:${booking.id}`,
    label: `Order ${booking.orderNumber} — to ${booking.destinationDistrict}`,
  }));
  return (
    <div className="grid gap-5">
      <div>
        <Link href="/customer/incidents" className="text-[12px] font-semibold text-brand">
          ← My incidents
        </Link>
        <div className="mt-1">
          <PageHeader eyebrow="Customer" title="Report an incident" />
        </div>
      </div>
      <SectionCard title="Tell us what happened">
        <CustomerIncidentForm
          canReport={canReport}
          canDispute={canDispute}
          packageOptions={packageOptions}
          orderOptions={orderOptions}
        />
      </SectionCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function CustomerProfilePage({ actor }: { actor: ActorContext }) {
  const profile = actor.customerId
    ? await getOwnCustomerProfile(actor).catch(() => null)
    : null;
  return (
    <div className="grid gap-5">
      <PageHeader eyebrow="Customer" title="My profile" />
      <SectionCard title="Account">
        <dl className="grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-2">
          <div>
            <dt className="text-slate2">Name</dt>
            <dd className="font-medium text-ink">{actor.fullName}</dd>
          </div>
          <div>
            <dt className="text-slate2">Email</dt>
            <dd className="font-medium text-ink">{actor.email}</dd>
          </div>
          <div>
            <dt className="text-slate2">Role</dt>
            <dd className="font-medium text-ink">{actor.primaryRole ?? "CUSTOMER"}</dd>
          </div>
          <div>
            <dt className="text-slate2">Account status</dt>
            <dd>
              <SharedStatusBadge domain="generic" status={actor.status} />
            </dd>
          </div>
        </dl>
      </SectionCard>

      <SectionCard title="Linked customer record">
        {profile ? (
          <dl className="grid grid-cols-1 gap-3 text-[13px] sm:grid-cols-2">
            <div>
              <dt className="text-slate2">Customer name</dt>
              <dd className="font-medium text-ink">{profile.fullName}</dd>
            </div>
            <div>
              <dt className="text-slate2">Phone</dt>
              <dd className="font-medium text-ink">{profile.phone}</dd>
            </div>
            <div>
              <dt className="text-slate2">Email on record</dt>
              <dd className="font-medium text-ink">{profile.email ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate2">Customer since</dt>
              <dd className="font-medium text-ink">{formatDateTime(profile.createdAt)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-[13px] text-slate2">
            Your account is not linked to a customer record yet. The link is created when a
            delivery is booked to your phone number; contact support if your packages are not
            showing.
          </p>
        )}
      </SectionCard>

      <SectionCard title="Change password">
        <ChangePasswordForm />
      </SectionCard>
    </div>
  );
}
