import { requireActor } from "@/lib/auth/permissions";
import { StaffWorkConsole } from "@/components/staff-home/StaffWorkConsole";

/**
 * Warehouse Staff home (V3 Step 5, brief §8): the work console —
 * assigned tasks lead in the task service's own order, big
 * scan/receive/inspect floor actions (≥48px), the received-today
 * figure plus live queue totals, per-warehouse packages requiring
 * action, transfer arrivals, delivery-batch prep, and the
 * warehouse-scoped movement feed. NO FINANCE anywhere: the read
 * model (`getStaffWorkConsole`) is finance-free by construction.
 *
 * The V2-era StaffMyWorkHome and the open-transfer / delivery-batch
 * / routed-booking panels were replaced on this page; those features
 * live on at their own routes (/staff/transfers, /staff/deliveries,
 * /staff/bookings), which the console links to.
 */
export default async function Page() {
  const actor = await requireActor();
  return <StaffWorkConsole actor={actor} />;
}
