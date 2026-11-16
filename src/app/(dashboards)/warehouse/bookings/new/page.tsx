import { requireActor } from "@/lib/auth/permissions";
import { BookingCreatePage } from "@/components/bookings/pages";

/**
 * Warehouse Admin booking creation (audit M-5): mirrors the Admin
 * create page. WA holds booking.create; the shared BookingCreatePage
 * limits the drop-off warehouse choices to the actor's memberships
 * for warehouse-scoped actors, and createBooking enforces the same
 * origin scope server-side for WAREHOUSE_DROPOFF (audited denial for
 * an out-of-scope origin warehouse).
 */
export default async function Page() {
  const actor = await requireActor();
  return <BookingCreatePage actor={actor} basePath="/warehouse" />;
}
