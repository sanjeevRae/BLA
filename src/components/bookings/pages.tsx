import Link from "next/link";

import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { getBooking, listBookings } from "@/server/services/bookings";
import { listShippingServices } from "@/server/services/pricing";
import { listVendors, listVendorAddresses } from "@/server/services/vendors";
import { listWarehouseDirectory } from "@/server/services/warehouses";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { StatusBadge, formatDateTime, formatPaisa } from "@/components/bookings/ui";
import { FilterBar, FilterChip, FilterClearAll } from "@/components/ui/FilterBar";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/states";
import {
  TABLE_CLASS,
  TD_CLASS,
  TD_ID_CLASS,
  TD_NUMERIC_CLASS,
  THEAD_ROW_CLASS,
  TH_CLASS,
  TH_NUMERIC_CLASS,
  TR_CLASS,
} from "@/components/ui/table-chrome";
import { DensityScope } from "@/components/ui/TableDensity";
import { ORDER_APPROVAL_STATUSES, ORDER_STATUSES } from "@/lib/bookings/domain";
import { statusLabel } from "@/lib/status/labels";
import {
  BookingApprovalControls,
  BookingCancelControl,
  BookingCreateForm,
  BookingUpdateForm,
} from "@/components/bookings/forms";
import { PackageLabelCard } from "@/components/packages/label";
import { PackageSummaryCard } from "@/components/packages/PackageSummaryCard";

/** DS §7.3 link-button classes (same classes the dashboards' primary
 *  Link buttons use): one primary action per view, secondary beside it. */
const primaryLinkClass =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-[14px] font-[550] text-white hover:bg-primary-dark";
const secondaryLinkClass =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-lg border border-border-control bg-card px-4 py-2.5 text-[14px] font-[550] text-ink hover:bg-surface-2";
/** TD_CLASS with the meta ink (timestamps, DS §3) swapped in. */
const tdMetaClass = "px-3 py-2 text-table text-ink-2";

/** Booking pages shared across the dashboard groups (basePath picks
 *  the route prefix). All reads go through BookingService, which
 *  force-scopes per actor: vendor = own, warehouse = routed, customer
 *  = addressed/sent, company readers = all. */

export async function BookingsListPage({
  actor,
  basePath,
  page,
  search,
  status,
  approvalStatus,
  title = "Bookings",
}: {
  actor: ActorContext;
  basePath: string;
  page: number;
  search?: string;
  status?: string;
  approvalStatus?: string;
  title?: string;
}) {
  const { bookings, meta } = await listBookings(actor, {
    page,
    pageSize: 20,
    search,
    status,
    approvalStatus,
  });
  const canCreate = actor.permissions.has("booking.create");
  // Filter chips (DS §7.7) link to this same path with one honoured
  // param changed; the other honoured params (search included) are
  // preserved exactly as the service composes them (AND). Values are
  // the service's own vocabularies from the domain module.
  const filterHref = (patch: { status?: string; approvalStatus?: string }) => {
    const params = new URLSearchParams();
    const nextStatus = patch.status !== undefined ? patch.status : status;
    const nextApproval =
      patch.approvalStatus !== undefined ? patch.approvalStatus : approvalStatus;
    if (nextStatus) params.set("status", nextStatus);
    if (nextApproval) params.set("approvalStatus", nextApproval);
    if (search) params.set("search", search);
    const query = params.toString();
    return query ? `${basePath}/bookings?${query}` : `${basePath}/bookings`;
  };
  const anyFilterActive = Boolean(status || approvalStatus);
  return (
    <div className="grid gap-5">
      <PageHeader
        title={title}
        description={`${meta.total} bookings`}
        actions={
          canCreate ? (
            <>
              {basePath === "/vendor" ? (
                <Link href={`${basePath}/bookings/bulk`} className={secondaryLinkClass}>
                  Bulk booking
                </Link>
              ) : null}
              <Link href={`${basePath}/bookings/new`} className={primaryLinkClass}>
                New booking
              </Link>
            </>
          ) : undefined
        }
      />
      <FilterBar ariaLabel="Booking status filters">
        {ORDER_STATUSES.map((value) => (
          <FilterChip
            key={value}
            href={filterHref({ status: value })}
            active={status === value}
          >
            {statusLabel("generic", value)}
          </FilterChip>
        ))}
        {anyFilterActive ? <FilterClearAll href={`${basePath}/bookings`} /> : null}
      </FilterBar>
      <FilterBar ariaLabel="Booking approval filters">
        {ORDER_APPROVAL_STATUSES.map((value) => (
          <FilterChip
            key={value}
            href={filterHref({ approvalStatus: value })}
            active={approvalStatus === value}
          >
            {statusLabel("generic", value)}
          </FilterChip>
        ))}
      </FilterBar>
      {bookings.length === 0 ? (
        <EmptyState title="No bookings found." />
      ) : (
        <DensityScope showToggle>
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className={TABLE_CLASS}>
              <thead>
                <tr className={THEAD_ROW_CLASS}>
                  <th className={`${TH_CLASS} text-left`}>Order</th>
                  <th className={`${TH_CLASS} text-left`}>Sender</th>
                  <th className={`${TH_CLASS} text-left`}>Destination</th>
                  <th className={`${TH_CLASS} text-left`}>Route</th>
                  <th className={TH_NUMERIC_CLASS}>Parcels</th>
                  <th className={TH_NUMERIC_CLASS}>COD</th>
                  <th className={`${TH_CLASS} text-left`}>Status</th>
                  <th className={`${TH_CLASS} text-left`}>Booked</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((booking) => (
                  <tr key={booking.id} className={TR_CLASS}>
                    <td className={TD_ID_CLASS}>
                      <Link
                        href={`${basePath}/bookings/${booking.id}`}
                        className="font-semibold text-primary"
                      >
                        {booking.orderNumber}
                      </Link>
                      {booking.approvalStatus === "PENDING" ? (
                        <span className="ml-2">
                          <StatusBadge status="PENDING" />
                        </span>
                      ) : null}
                    </td>
                    <td className={TD_CLASS}>{booking.vendorName ?? booking.senderName}</td>
                    <td className={TD_CLASS}>{booking.destinationDistrict}</td>
                    <td className={TD_CLASS}>{booking.routeKind ? statusLabel("generic", booking.routeKind) : "—"}</td>
                    <td className={TD_NUMERIC_CLASS}>{booking.packageCount}</td>
                    <td className={TD_NUMERIC_CLASS}>{formatPaisa(booking.codAmountPaisa)}</td>
                    <td className={TD_CLASS}>
                      <StatusBadge status={booking.status} />
                    </td>
                    <td className={tdMetaClass}>{formatDateTime(booking.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DensityScope>
      )}
      {meta.totalPages > 1 ? (
        <div className="flex gap-2">
          {page > 1 ? (
            <Link href={`${basePath}/bookings?page=${page - 1}`} className={subtleButtonClass}>
              Previous
            </Link>
          ) : null}
          {page < meta.totalPages ? (
            <Link href={`${basePath}/bookings?page=${page + 1}`} className={subtleButtonClass}>
              Next
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export async function BookingDetailPage({
  actor,
  basePath,
  orderId,
  publicBaseUrl,
}: {
  actor: ActorContext;
  basePath: string;
  orderId: string;
  publicBaseUrl: string;
}) {
  const booking = await getBooking(actor, orderId);
  const canApprove = actor.permissions.has("booking.approve") && booking.approvalStatus === "PENDING";
  const canCancel =
    actor.permissions.has("booking.cancel") && booking.status !== "CANCELLED";
  const packages = booking.shipments.flatMap((s) => s.packages);
  const canUpdate =
    actor.permissions.has("booking.update") &&
    packages.every((p) => ["DRAFT", "BOOKED", "PICKUP_ASSIGNED"].includes(p.operationalStatus));

  return (
    <div className="grid gap-5">
      <div>
        <Link href={`${basePath}/bookings`} className="text-[12px] font-semibold text-primary">
          ← All bookings
        </Link>
        <PageHeader
          className="mt-1"
          title={booking.orderNumber}
          description={
            <>
              Sender: {booking.vendorName ?? booking.senderName} ({booking.senderPhone}) ·
              Destination: {booking.destinationDistrict} · Booked{" "}
              {formatDateTime(booking.createdAt)}
              {booking.cancelReason ? ` · Cancelled: ${booking.cancelReason}` : ""}
            </>
          }
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <StatusBadge status={booking.status} />
          <StatusBadge status={booking.approvalStatus} />
        </div>
      </div>

      {canApprove ? (
        <SectionCard title="Approval queue">
          <BookingApprovalControls booking={booking} />
        </SectionCard>
      ) : null}

      <SectionCard title="Shipments & packages">
        <div className="grid gap-4">
          {booking.shipments.map((shipment) => (
            <div key={shipment.id} className="rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-3 text-[13px] text-ink">
                <strong>{shipment.shipmentNumber}</strong>
                <StatusBadge status={shipment.routeKind} />
                <StatusBadge status={shipment.status} />
                <span>Shipping {formatPaisa(shipment.shippingChargePaisa)}</span>
                <span>COD {formatPaisa(shipment.codAmountPaisa)}</span>
              </div>
              <div className="mt-3 grid gap-3">
                {shipment.packages.map((pkg) => (
                  <PackageSummaryCard key={pkg.id} pkg={pkg} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      {canUpdate ? (
        <SectionCard title="Corrections (before pickup)">
          <BookingUpdateForm booking={booking} />
        </SectionCard>
      ) : null}

      {canCancel ? (
        <SectionCard title="Cancel booking">
          <p className="mb-3 text-[13px] text-ink-2">
            Cancellation is only possible before pickup is in progress.
          </p>
          <BookingCancelControl booking={booking} />
        </SectionCard>
      ) : null}

      <SectionCard title="Labels">
        <div className="flex max-w-full flex-wrap gap-4 overflow-x-auto pb-1">
          {packages.map((pkg) => (
            <PackageLabelCard key={pkg.id} actor={actor} packageId={pkg.id} baseUrl={publicBaseUrl} />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}

export async function BookingCreatePage({
  actor,
  basePath,
}: {
  actor: ActorContext;
  basePath: string;
}) {
  const [directory, services] = await Promise.all([
    listWarehouseDirectory(),
    listShippingServices(),
  ]);
  // Warehouse-scoped actors (Warehouse Admin, audit M-5): the
  // drop-off choices are limited to the actor's own memberships in
  // the UI. Unscoped readers (Admin/SA) and vendor actors (no
  // warehouse memberships; drop-off is a customer choice for them)
  // keep the full directory. createBooking enforces the same origin
  // scope server-side for WAREHOUSE_DROPOFF regardless of the UI.
  const warehouses =
    actor.warehouseIds.length > 0 &&
    !hasPermission(actor, "warehouse.read_all") &&
    !hasPermission(actor, "booking.read_all")
      ? directory.filter((w) => actor.warehouseIds.includes(w.id))
      : directory;
  if (actor.vendorId) {
    const addresses = await listVendorAddresses(actor, actor.vendorId);
    return (
      <div className="grid gap-5">
        <PageHeader title="New booking" />
        <SectionCard title="Booking details">
          <BookingCreateForm
            mode="vendor"
            basePath={basePath}
            warehouses={warehouses}
            services={services}
            vendorAddresses={addresses
              .filter((a) => a.kind === "PICKUP")
              .map((a) => ({
                id: a.id,
                addressLine1: a.addressLine1,
                city: a.city,
                district: a.district,
                isApproved: a.isApproved,
              }))}
          />
        </SectionCard>
      </div>
    );
  }
  // listVendors requires vendor.read_all / vendor.manage (or a
  // vendor link). Warehouse Admins hold neither — they create
  // walk-in bookings only — so the vendor picker is offered only to
  // actors the service would actually serve; calling it for WA
  // would throw an audited denial and break the page.
  const canListVendors =
    hasPermission(actor, "vendor.read_all") || hasPermission(actor, "vendor.manage");
  const { vendors } = canListVendors
    ? await listVendors(actor, { status: "APPROVED", page: 1, pageSize: 100 })
    : { vendors: [] as Awaited<ReturnType<typeof listVendors>>["vendors"] };
  return (
    <div className="grid gap-5">
      <PageHeader title="New booking" />
      <SectionCard title="Booking details">
        <BookingCreateForm
          mode="staff"
          basePath={basePath}
          warehouses={warehouses}
          services={services}
          vendors={vendors.map((v) => ({ id: v.id, businessName: v.businessName }))}
        />
      </SectionCard>
    </div>
  );
}

/** Compact routed-bookings panel for the warehouse / staff dashboards:
 *  only bookings routed through the actor's own warehouses appear
 *  (service force-scoping). */
export async function WarehouseBookingsPanel({ actor, basePath }: { actor: ActorContext; basePath: string }) {
  const { bookings } = await listBookings(actor, { page: 1, pageSize: 8 });
  return (
    <SectionCard
      title="Routed bookings"
      action={
        <Link href={`${basePath}/bookings`} className={subtleButtonClass}>
          View all
        </Link>
      }
    >
      <div className="grid gap-2">
        {bookings.map((booking) => (
          <div
            key={booking.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-[13px]"
          >
            <Link href={`${basePath}/bookings/${booking.id}`} className="font-semibold text-primary">
              {booking.orderNumber}
            </Link>
            <span className="text-ink">
              {booking.vendorName ?? booking.senderName} → {booking.destinationDistrict} ·{" "}
              {booking.packageCount} parcel{booking.packageCount === 1 ? "" : "s"}
            </span>
            <StatusBadge status={booking.status} />
          </div>
        ))}
        {bookings.length === 0 ? (
          <p className="text-[13px] text-ink-2">No bookings routed through your warehouse yet.</p>
        ) : null}
      </div>
    </SectionCard>
  );
}
