import Link from "next/link";

import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { getBooking, listBookings } from "@/server/services/bookings";
import { listShippingServices } from "@/server/services/pricing";
import { listVendors, listVendorAddresses } from "@/server/services/vendors";
import { listWarehouseDirectory } from "@/server/services/warehouses";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { StatusBadge, formatDateTime, formatPaisa } from "@/components/bookings/ui";
import { StatusBadge as DomainStatusBadge } from "@/components/ui/StatusBadge";
import {
  BookingApprovalControls,
  BookingCancelControl,
  BookingCreateForm,
  BookingUpdateForm,
} from "@/components/bookings/forms";
import { PackageLabelCard } from "@/components/packages/label";

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
  return (
    <div className="grid gap-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-bold text-ink">{title}</h1>
          <p className="text-[13px] text-faint">{meta.total} bookings</p>
        </div>
        {canCreate ? (
          <div className="flex gap-2">
            {basePath === "/vendor" ? (
              <Link href={`${basePath}/bookings/bulk`} className={subtleButtonClass}>
                Bulk booking
              </Link>
            ) : null}
            <Link href={`${basePath}/bookings/new`} className={subtleButtonClass}>
              New booking
            </Link>
          </div>
        ) : null}
      </div>
      <SectionCard title="Bookings">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-[0.14em] text-slate2">
                <th className="py-2 pr-3">Order</th>
                <th className="py-2 pr-3">Sender</th>
                <th className="py-2 pr-3">Destination</th>
                <th className="py-2 pr-3">Route</th>
                <th className="py-2 pr-3">Parcels</th>
                <th className="py-2 pr-3">COD</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2">Booked</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((booking) => (
                <tr key={booking.id} className="border-b border-line/60">
                  <td className="py-2 pr-3">
                    <Link href={`${basePath}/bookings/${booking.id}`} className="font-semibold text-brand">
                      {booking.orderNumber}
                    </Link>
                    {booking.approvalStatus === "PENDING" ? (
                      <span className="ml-2">
                        <StatusBadge status="PENDING" />
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 text-ink">{booking.vendorName ?? booking.senderName}</td>
                  <td className="py-2 pr-3 text-ink">{booking.destinationDistrict}</td>
                  <td className="py-2 pr-3 text-ink">{booking.routeKind ?? "—"}</td>
                  <td className="py-2 pr-3 text-ink">{booking.packageCount}</td>
                  <td className="py-2 pr-3 text-ink">{formatPaisa(booking.codAmountPaisa)}</td>
                  <td className="py-2 pr-3">
                    <StatusBadge status={booking.status} />
                  </td>
                  <td className="py-2 text-faint">{formatDateTime(booking.createdAt)}</td>
                </tr>
              ))}
              {bookings.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-4 text-faint">
                    No bookings found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {meta.totalPages > 1 ? (
          <div className="mt-3 flex gap-2">
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
      </SectionCard>
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
        <Link href={`${basePath}/bookings`} className="text-[12px] font-semibold text-brand">
          ← All bookings
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <h1 className="text-[20px] font-bold text-ink">{booking.orderNumber}</h1>
          <StatusBadge status={booking.status} />
          <StatusBadge status={booking.approvalStatus} />
        </div>
        <p className="text-[13px] text-faint">
          Sender: {booking.vendorName ?? booking.senderName} ({booking.senderPhone}) · Destination:{" "}
          {booking.destinationDistrict} · Booked {formatDateTime(booking.createdAt)}
          {booking.cancelReason ? ` · Cancelled: ${booking.cancelReason}` : ""}
        </p>
      </div>

      {canApprove ? (
        <SectionCard title="Approval queue">
          <BookingApprovalControls booking={booking} />
        </SectionCard>
      ) : null}

      <SectionCard title="Shipments & packages">
        <div className="grid gap-4">
          {booking.shipments.map((shipment) => (
            <div key={shipment.id} className="rounded-md border border-line p-3">
              <div className="flex flex-wrap items-center gap-3 text-[13px] text-ink">
                <strong>{shipment.shipmentNumber}</strong>
                <StatusBadge status={shipment.routeKind} />
                <StatusBadge status={shipment.status} />
                <span>Shipping {formatPaisa(shipment.shippingChargePaisa)}</span>
                <span>COD {formatPaisa(shipment.codAmountPaisa)}</span>
              </div>
              <table className="mt-3 w-full text-left text-[13px]">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase tracking-[0.14em] text-slate2">
                    <th className="py-1 pr-3">Tracking ID</th>
                    <th className="py-1 pr-3">Recipient</th>
                    <th className="py-1 pr-3">Contents</th>
                    <th className="py-1 pr-3">Weight</th>
                    <th className="py-1 pr-3">COD</th>
                    <th className="py-1">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {shipment.packages.map((pkg) => (
                    <tr key={pkg.id} className="border-b border-line/60">
                      <td className="py-1 pr-3 font-mono text-[12px] text-ink">{pkg.trackingId}</td>
                      <td className="py-1 pr-3 text-ink">
                        {pkg.recipientName} — {pkg.deliveryCity}, {pkg.deliveryDistrict}
                      </td>
                      <td className="py-1 pr-3 text-ink">{pkg.description}</td>
                      <td className="py-1 pr-3 text-ink">{pkg.billableWeightKg ?? pkg.declaredWeightKg} kg</td>
                      <td className="py-1 pr-3 text-ink">{formatPaisa(pkg.codAmountPaisa)}</td>
                      <td className="py-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="inline-flex items-center gap-1">
                            <span className="text-[10px] uppercase text-faint">Operational</span>
                            <DomainStatusBadge domain="operational" status={pkg.operationalStatus} />
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <span className="text-[10px] uppercase text-faint">Condition</span>
                            <DomainStatusBadge domain="condition" status={pkg.condition} />
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <span className="text-[10px] uppercase text-faint">Payment</span>
                            <DomainStatusBadge domain="payment" status={pkg.paymentStatus} />
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <span className="text-[10px] uppercase text-faint">Delivery</span>
                            <DomainStatusBadge domain="delivery" status={pkg.deliveryStatus} />
                          </span>
                          {pkg.exceptionStatus !== "NONE" ? (
                            <span className="inline-flex items-center gap-1">
                              <span className="text-[10px] uppercase text-faint">Exception</span>
                              <DomainStatusBadge domain="exception" status={pkg.exceptionStatus} />
                            </span>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
          <p className="mb-3 text-[13px] text-slate2">
            Cancellation is only possible before pickup is in progress.
          </p>
          <BookingCancelControl booking={booking} />
        </SectionCard>
      ) : null}

      <SectionCard title="Labels">
        <div className="flex flex-wrap gap-4">
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
        <h1 className="text-[20px] font-bold text-ink">New booking</h1>
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
      <h1 className="text-[20px] font-bold text-ink">New booking</h1>
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
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-[13px]"
          >
            <Link href={`${basePath}/bookings/${booking.id}`} className="font-semibold text-brand">
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
          <p className="text-[13px] text-faint">No bookings routed through your warehouse yet.</p>
        ) : null}
      </div>
    </SectionCard>
  );
}
