import { redirect } from "next/navigation";

import { hasPermission, requireActor } from "@/lib/auth/permissions";
import { SectionCard } from "@/components/warehouses/ui";
import { WarehouseForm } from "@/components/warehouses/WarehouseForm";

export default async function Page() {
  const actor = await requireActor();
  if (!hasPermission(actor, "warehouse.create")) redirect("/super-admin");
  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
          Operations
        </div>
        <h1 className="mt-0.5 text-[22px] font-bold text-ink">New warehouse</h1>
        <p className="max-w-[640px] text-[13px] text-slate2">
          A warehouse starts inactive with the seven standard zones. Assign a Warehouse Admin,
          then activate it from its detail page.
        </p>
      </div>
      <SectionCard title="Warehouse details">
        <WarehouseForm basePath="/super-admin" />
      </SectionCard>
    </div>
  );
}
