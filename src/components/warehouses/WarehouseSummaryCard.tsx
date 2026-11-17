import type { WarehouseView } from "@/server/services/warehouses";
import { DAY_NAMES, SectionCard, WarehouseStatusBadge, formatMinutes } from "./ui";

/**
 * WarehouseSummaryCard (V3 Step 9, DS §10) — the warehouse detail
 * summary card, moved out of warehouses/pages.tsx (it previously
 * lived there as `WarehouseInfoCard`; pages.tsx re-exports it under
 * both names). Same props and same rows as before — every field is
 * one the WarehouseView already exposes on this internal surface,
 * including the address coordinates row. Only DS token names changed
 * in the move (border-line → border-border, text-slate2 → text-ink-2).
 */

export const WAREHOUSE_TYPE_LABELS: Record<string, string> = {
  MAIN: "Main warehouse",
  REGIONAL: "Regional warehouse",
  LOCAL_HUB: "Local delivery hub",
  COLLECTION_CENTER: "Collection center",
  RETURN_CENTER: "Return processing center",
};

export function WarehouseSummaryCard({ warehouse }: { warehouse: WarehouseView }) {
  const rows: Array<[string, string]> = [
    ["Code", warehouse.code],
    ["Type", WAREHOUSE_TYPE_LABELS[warehouse.type] ?? warehouse.type],
    ["District", warehouse.district],
    ["City", warehouse.city],
    ["Province", warehouse.province],
    ["Address", [warehouse.address?.addressLine1, warehouse.address?.addressLine2].filter(Boolean).join(", ") || "—"],
    ["Postal code", warehouse.address?.postalCode ?? "—"],
    [
      "Coordinates",
      warehouse.address?.latitude && warehouse.address?.longitude
        ? `${warehouse.address.latitude}, ${warehouse.address.longitude}`
        : "—",
    ],
    ["Contact number", warehouse.contactPhone ?? "—"],
    ["Email", warehouse.email ?? "—"],
    [
      "Capacity",
      warehouse.capacityPackages != null ? `${warehouse.capacityPackages} packages` : "Not configured",
    ],
  ];
  return (
    <SectionCard
      title="Warehouse details"
      action={<WarehouseStatusBadge status={warehouse.status} />}
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 border-b border-border py-1.5 last:border-0">
            <dt className="text-[12px] font-medium text-ink-2">{label}</dt>
            <dd className="text-right text-[13px] font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-2">
          Operating hours
        </div>
        <div className="flex flex-wrap gap-1.5">
          {warehouse.hours.map((h) => (
            <span
              key={h.dayOfWeek}
              className="rounded-md border border-border px-2 py-1 text-[11px] text-ink-2"
            >
              <span className="font-semibold text-ink">{DAY_NAMES[h.dayOfWeek]}</span>{" "}
              {h.isClosed ? "Closed" : `${formatMinutes(h.opensAt)}–${formatMinutes(h.closesAt)}`}
            </span>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}
