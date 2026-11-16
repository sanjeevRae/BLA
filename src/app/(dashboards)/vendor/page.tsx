import Link from "next/link";

import { requireActor } from "@/lib/auth/permissions";
import type { ActorContext } from "@/lib/auth/actor";
import { getVendor } from "@/server/services/vendors";
import { getVendorReport } from "@/server/services/reports";
import { listBookings } from "@/server/services/bookings";
import { listPackages } from "@/server/services/packages";
import { listReturns } from "@/server/services/returns";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { StatusBadge as SharedStatusBadge } from "@/components/ui/StatusBadge";
import { formatDateTime, formatPaisa, StatusBadge } from "@/components/bookings/ui";

/**
 * Vendor home (V2 Phase 6, spec §7): the universal dashboard pattern —
 * what needs attention → what is happening now → metrics → what
 * recently changed → what to do next. Every figure is org-scoped by
 * the services: the vendor report resolves to actor.vendorId, and the
 * booking / package / return reads are force-scoped to the same
 * organisation inside their queries (cross-vendor reads are 404 +
 * audit). Nothing here is computed from another vendor's data.
 *
 * Metric sources:
 *  - Bookings / Delivered / Returns (last 30 days), COD payable and
 *    Outstanding: getVendorReport's own-vendor row (delivered counts
 *    live ProofOfDelivery rows in the period; COD payable is the
 *    vendor-payable ledger balance; outstanding is open-invoice
 *    totals minus derived paid components).
 *  - Pending pickup / In transit: current package counts from
 *    listPackages operational-status buckets (see below).
 */

function StatTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-line bg-page px-4 py-3">
      <dt className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">{label}</dt>
      <dd className="tnum mt-1 text-[15px] font-semibold text-ink">{value}</dd>
      {sub ? <dd className="text-[12px] text-slate2">{sub}</dd> : null}
    </div>
  );
}

/** Current package count for a set of operational statuses, summed
 *  from the scoped list's totals (pageSize 1 — only the count is read). */
async function packageCount(actor: ActorContext, statuses: string[]): Promise<number> {
  const parts = await Promise.all(
    statuses.map(
      async (status) => (await listPackages(actor, { status, page: 1, pageSize: 1 })).meta.total,
    ),
  );
  return parts.reduce((sum, n) => sum + n, 0);
}

const PENDING_PICKUP_STATUSES = ["BOOKED", "PICKUP_ASSIGNED", "PICKUP_IN_PROGRESS"];
const IN_TRANSIT_STATUSES = ["DISPATCHED", "IN_TRANSIT"];

export default async function Page() {
  const actor = await requireActor();
  if (!actor.vendorId) {
    return (
      <div className="grid gap-5">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">Vendor</div>
          <h1 className="mt-0.5 text-[22px] font-bold text-ink">Vendor dashboard</h1>
        </div>
        <div className="rounded-lg border border-line bg-surface p-5 text-[13px] text-ink">
          Your account is not linked to a vendor organisation yet. Ask an administrator to invite
          you into your vendor — bookings and packages appear here once you are linked.
        </div>
      </div>
    );
  }

  const vendor = await getVendor(actor, actor.vendorId);
  const report = await getVendorReport(actor, {});
  const row = report.rows[0];
  const [
    recentBookings,
    pendingPickup,
    inTransit,
    outForDelivery,
    attempted,
    returnsAwaiting,
    recentReturns,
    inTransitPackages,
  ] = await Promise.all([
    listBookings(actor, { page: 1, pageSize: 5 }),
    packageCount(actor, PENDING_PICKUP_STATUSES),
    packageCount(actor, IN_TRANSIT_STATUSES),
    packageCount(actor, ["OUT_FOR_DELIVERY"]),
    packageCount(actor, ["DELIVERY_ATTEMPTED"]),
    listReturns(actor, { status: "REQUESTED", page: 1, pageSize: 1 }),
    listReturns(actor, { page: 1, pageSize: 5 }),
    listPackages(actor, { status: "IN_TRANSIT", page: 1, pageSize: 5 }),
  ]);

  const approved = vendor.verificationStatus === "APPROVED";
  const hasAttention = !approved || attempted > 0 || returnsAwaiting.meta.total > 0;

  return (
    <div className="grid gap-5">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">Vendor</div>
        <h1 className="mt-0.5 text-[22px] font-bold text-ink">{vendor.businessName}</h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-slate2">
          Verification <SharedStatusBadge domain="generic" status={vendor.verificationStatus} />
          <span>· signed in as {actor.vendorRole ?? "vendor user"}</span>
        </p>
      </div>

      {/* 1 — What needs attention */}
      <SectionCard title="Needs attention">
        <div className="grid gap-2">
          {!approved ? (
            <p className="rounded-md border border-line bg-amberbg px-3 py-2 text-[13px] text-amberdeep">
              Your vendor is not approved for booking yet (status: {vendor.verificationStatus}).
              Bookings open as soon as an administrator approves the verification. There is
              nothing you need to do here — approval happens on the administrator side.
            </p>
          ) : null}
          {attempted > 0 ? (
            <p className="rounded-md border border-line bg-redbg px-3 py-2 text-[13px] text-reddeep">
              {attempted} package{attempted === 1 ? " has" : "s have"} had a delivery attempt that
              did not complete.{" "}
              <Link href="/vendor/bookings" className="font-semibold underline">
                Review your bookings
              </Link>{" "}
              to follow up with the recipients.
            </p>
          ) : null}
          {returnsAwaiting.meta.total > 0 ? (
            <p className="rounded-md border border-line bg-amberbg px-3 py-2 text-[13px] text-amberdeep">
              {returnsAwaiting.meta.total} return{returnsAwaiting.meta.total === 1 ? " is" : "s are"}{" "}
              awaiting action (requested, not yet approved or collected). They appear in your
              recent returns below.
            </p>
          ) : null}
          {!hasAttention ? (
            <p className="text-[13px] text-slate2">
              Nothing needs your attention right now — no failed delivery attempts and no returns
              waiting on you.
            </p>
          ) : null}
        </div>
      </SectionCard>

      {/* 2 — Metrics (report period + current package buckets) */}
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile
          label="Bookings"
          value={String(row?.bookings ?? 0)}
          sub={`Last 30 days (${report.range.from} – ${report.range.to})`}
        />
        <StatTile label="Pending pickup" value={String(pendingPickup)} sub="Booked, not yet picked up" />
        <StatTile label="In transit" value={String(inTransit)} sub="Dispatched between warehouses" />
        <StatTile
          label="Delivered"
          value={String(row?.delivered ?? 0)}
          sub={`Last 30 days · ${row?.returnsCreated ?? 0} return${(row?.returnsCreated ?? 0) === 1 ? "" : "s"} created`}
        />
        <StatTile
          label="COD payable to you"
          value={formatPaisa(row?.payableBalancePaisa ?? "0")}
          sub="Vendor-payable ledger balance"
        />
        <StatTile
          label="Outstanding invoices"
          value={formatPaisa(row?.outstandingPaisa ?? "0")}
          sub="Open invoices minus payments and coverage"
        />
      </dl>

      {/* 3 — What is happening now */}
      <SectionCard
        title="Current operations"
        action={
          <Link href="/vendor/bookings" className={subtleButtonClass}>
            All bookings ({recentBookings.meta.total})
          </Link>
        }
      >
        <div className="grid gap-2 text-[13px] text-ink">
          <p>
            <span className="tnum font-semibold">{outForDelivery}</span> package
            {outForDelivery === 1 ? " is" : "s are"} out for delivery now;{" "}
            <span className="tnum font-semibold">{inTransit}</span> in transit between warehouses;{" "}
            <span className="tnum font-semibold">{pendingPickup}</span> waiting for pickup.
          </p>
          {inTransitPackages.packages.map((pkg) => (
            <div
              key={pkg.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2"
            >
              <Link href={`/track/${pkg.trackingId}`} className="font-mono font-semibold text-brand">
                {pkg.trackingId}
              </Link>
              <span>
                {pkg.description} → {pkg.deliveryCity}, {pkg.deliveryDistrict}
              </span>
              <span className="flex items-center gap-1">
                <span className="text-[11px] text-slate2">Operational</span>
                <SharedStatusBadge domain="operational" status={pkg.operationalStatus} />
                <span className="text-[11px] text-slate2">Delivery</span>
                <SharedStatusBadge domain="delivery" status={pkg.deliveryStatus} />
              </span>
            </div>
          ))}
          {inTransitPackages.packages.length === 0 ? (
            <p className="text-slate2">No packages are in transit right now.</p>
          ) : null}
        </div>
      </SectionCard>

      {/* 4 — What recently changed */}
      <SectionCard title="Recent bookings">
        <div className="grid gap-2">
          {recentBookings.bookings.map((booking) => (
            <div
              key={booking.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
            >
              <Link href={`/vendor/bookings/${booking.id}`} className="font-semibold text-brand">
                {booking.orderNumber}
              </Link>
              <span className="text-ink">
                → {booking.destinationDistrict} · {booking.packageCount} parcel
                {booking.packageCount === 1 ? "" : "s"} · {formatDateTime(booking.createdAt)}
              </span>
              <StatusBadge status={booking.approvalStatus === "PENDING" ? "PENDING" : booking.status} />
            </div>
          ))}
          {recentBookings.bookings.length === 0 ? (
            <p className="text-[13px] text-slate2">
              No bookings yet — create your first booking to get tracking IDs.
            </p>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard title="Recent returns">
        <div className="grid gap-2">
          {recentReturns.items.map((ret) => (
            <div
              key={ret.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
            >
              <span className="font-mono font-semibold text-ink">{ret.returnNumber}</span>
              <span className="text-ink">
                {ret.trackingId} · {ret.reason.replaceAll("_", " ")} ·{" "}
                {formatDateTime(ret.createdAt)}
              </span>
              <SharedStatusBadge domain="generic" status={ret.status} />
            </div>
          ))}
          {recentReturns.items.length === 0 ? (
            <p className="text-[13px] text-slate2">No returns yet.</p>
          ) : null}
        </div>
      </SectionCard>

      {/* 5 — What to do next (existing routes only) */}
      <SectionCard title="Quick actions">
        <div className="flex flex-wrap gap-2">
          {approved ? (
            <Link href="/vendor/bookings/new" className={subtleButtonClass}>
              New booking
            </Link>
          ) : null}
          <Link href="/track" className={subtleButtonClass}>
            Track a package
          </Link>
          <Link href="/vendor/profile" className={subtleButtonClass}>
            Pickup addresses
          </Link>
          <Link href="/vendor/billing" className={subtleButtonClass}>
            Invoices
          </Link>
          <Link href="/vendor/billing" className={subtleButtonClass}>
            Settlements
          </Link>
          <Link href="/vendor/reports" className={subtleButtonClass}>
            Reports
          </Link>
        </div>
      </SectionCard>
    </div>
  );
}
