import { requireActor } from "@/lib/auth/permissions";
import { StaffMyWorkHome } from "@/components/dashboards/StaffMyWorkHome";
import { WarehouseBookingsPanel } from "@/components/bookings/pages";
import { TransfersHomePanel } from "@/components/transfers/pages";
import { DeliveriesHomePanel } from "@/components/deliveries/pages";

/**
 * Warehouse Staff home (V2 Phase 6 slice D): "My Work" leads — the
 * staff member's assigned tasks and their warehouses' queue counts
 * (StaffMyWorkHome, replacing the Phase-1 placeholder identity card
 * that used to lead this page). The open-transfer, delivery-batch and
 * routed-booking panels remain below it as before; the old
 * WarehouseOpsHomePanel summary is superseded by the My Work queue
 * counts, which are computed from the same warehouse-ops summaries.
 */
export default async function Page() {
  const actor = await requireActor();
  return (
    <div className="grid gap-5">
      <StaffMyWorkHome actor={actor} />
      <TransfersHomePanel actor={actor} basePath="/staff" />
      <DeliveriesHomePanel actor={actor} basePath="/staff" />
      <WarehouseBookingsPanel actor={actor} basePath="/staff" />
    </div>
  );
}
