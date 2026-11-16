import Link from "next/link";

import { hasPermission, requireActor } from "@/lib/auth/permissions";
import { listShippingServices } from "@/server/services/pricing";
import { listVendorAddresses } from "@/server/services/vendors";
import { listWarehouseDirectory } from "@/server/services/warehouses";
import { SectionCard } from "@/components/warehouses/ui";
import { BulkBookingCreateForm } from "@/components/bookings/bulk-forms";

/**
 * Phase 7 vendor bulk booking: up to 50 bookings in one submission,
 * created all-or-nothing by createBulkBookings (via
 * createBulkBookingsAction). Data fetching mirrors BookingCreatePage's
 * vendor branch: full warehouse directory for vendor actors, the
 * vendor's own PICKUP addresses for rider pickup rows.
 */
export default async function Page() {
  const actor = await requireActor();
  const [directory, services] = await Promise.all([
    listWarehouseDirectory(),
    listShippingServices(),
  ]);
  const warehouses =
    actor.warehouseIds.length > 0 &&
    !hasPermission(actor, "warehouse.read_all") &&
    !hasPermission(actor, "booking.read_all")
      ? directory.filter((w) => actor.warehouseIds.includes(w.id))
      : directory;
  const addresses = actor.vendorId ? await listVendorAddresses(actor, actor.vendorId) : [];
  return (
    <div className="grid gap-5">
      <div>
        <Link href="/vendor/bookings" className="text-[12px] font-semibold text-brand">
          ← All bookings
        </Link>
        <h1 className="mt-1 text-[20px] font-bold text-ink">Bulk booking</h1>
        <p className="text-[13px] text-faint">
          Book many deliveries at once — one row per booking, submitted together.
        </p>
      </div>
      <SectionCard title="Bulk booking details">
        <BulkBookingCreateForm
          basePath="/vendor"
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
