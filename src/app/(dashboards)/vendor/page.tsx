import Link from "next/link";

import { requireActor } from "@/lib/auth/permissions";
import { getVendor } from "@/server/services/vendors";
import { listBookings } from "@/server/services/bookings";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { StatusBadge, formatDateTime } from "@/components/bookings/ui";

/**
 * Vendor home: the vendor's own organisation status and their own
 * bookings only — every read is force-scoped to actor.vendorId by the
 * services (docs/role-permission-matrix.md §5.4).
 */
export default async function Page() {
  const actor = await requireActor();
  if (!actor.vendorId) {
    return (
      <div className="grid gap-5">
        <h1 className="text-[20px] font-bold text-ink">Vendor dashboard</h1>
        <div className="rounded-lg border border-line bg-surface p-5 text-[13px] text-ink">
          Your account is not linked to a vendor organisation yet. Ask an administrator to invite
          you into your vendor — bookings and packages appear here once you are linked.
        </div>
      </div>
    );
  }
  const vendor = await getVendor(actor, actor.vendorId);
  const { bookings, meta } = await listBookings(actor, { page: 1, pageSize: 5 });
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-bold text-ink">{vendor.businessName}</h1>
          <p className="flex items-center gap-2 text-[13px] text-faint">
            Verification <StatusBadge status={vendor.verificationStatus} />
            <span>· signed in as {actor.vendorRole ?? "vendor user"}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/vendor/profile" className={subtleButtonClass}>
            Organisation profile
          </Link>
          {vendor.verificationStatus === "APPROVED" ? (
            <Link href="/vendor/bookings/new" className={subtleButtonClass}>
              New booking
            </Link>
          ) : null}
        </div>
      </div>
      {vendor.verificationStatus !== "APPROVED" ? (
        <div className="rounded-lg border border-line bg-orangebg p-4 text-[13px] text-ink">
          Your vendor is not approved for booking yet (status: {vendor.verificationStatus}).
          Bookings open as soon as an administrator approves the verification.
        </div>
      ) : null}
      <SectionCard
        title="Recent bookings"
        action={
          <Link href="/vendor/bookings" className={subtleButtonClass}>
            All bookings ({meta.total})
          </Link>
        }
      >
        <div className="grid gap-2">
          {bookings.map((booking) => (
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
          {bookings.length === 0 ? (
            <p className="text-[13px] text-faint">
              No bookings yet — create your first booking to get tracking IDs.
            </p>
          ) : null}
        </div>
      </SectionCard>
    </div>
  );
}
