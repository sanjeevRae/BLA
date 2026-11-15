import { requireActor } from "@/lib/auth/permissions";
import { DashboardHome } from "@/components/dashboards/DashboardHome";
import { WarehouseBookingsPanel } from "@/components/bookings/pages";
import { WarehouseOpsHomePanel } from "@/components/warehouse-ops/pages";

/**
 * Warehouse Staff home: identity summary plus the bookings/packages
 * routed through the staff member's own warehouse(s) — force-scoped
 * inside BookingService; nothing from other warehouses can appear.
 */
export default async function Page() {
  const actor = await requireActor();
  return (
    <div className="grid gap-5">
      <DashboardHome actor={actor} roleLabel="Warehouse Staff" />
      <WarehouseOpsHomePanel actor={actor} basePath="/staff" />
      <WarehouseBookingsPanel actor={actor} basePath="/staff" />
    </div>
  );
}
