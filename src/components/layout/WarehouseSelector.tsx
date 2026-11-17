"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { setWarehouseScopeAction } from "@/server/actions/shell";
import { NavIcon } from "@/components/layout/icons";

export interface WarehouseOption {
  id: string;
  code: string;
  name: string;
}

/**
 * Warehouse context for the top bar (V2 Phase 1). The selection is a
 * requested scope persisted by a server action after validating it
 * against the actor's own memberships — it steers display defaults
 * only; services keep authorising server-side. A single-warehouse
 * user without global read sees a static label, not a control.
 */
export function WarehouseSelector({
  warehouses,
  selectedId,
  canSelectAll,
}: {
  warehouses: WarehouseOption[];
  selectedId: string | null;
  canSelectAll: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (warehouses.length === 0) return null;

  if (warehouses.length === 1 && !canSelectAll) {
    const only = warehouses[0];
    return (
      <span className="hidden h-11 items-center gap-2 rounded-md border border-line bg-page px-3 text-[13px] font-medium text-ink sm:flex">
        <NavIcon name="warehouse" className="h-[18px] w-[18px] text-ink-2" />
        <span className="max-w-[180px] truncate">
          {only.name} <span className="text-ink-2">({only.code})</span>
        </span>
      </span>
    );
  }

  return (
    <label className="hidden h-11 items-center gap-2 rounded-md border border-line bg-page px-3 sm:flex">
      <NavIcon name="warehouse" className="h-[18px] w-[18px] shrink-0 text-ink-2" />
      <span className="sr-only">Warehouse context</span>
      <select
        aria-label="Warehouse context"
        className="h-full max-w-[190px] bg-transparent text-[13px] font-medium text-ink outline-none disabled:opacity-60"
        value={selectedId ?? ""}
        disabled={pending}
        onChange={(event) => {
          const value = event.target.value || null;
          startTransition(async () => {
            await setWarehouseScopeAction(value);
            router.refresh();
          });
        }}
      >
        {canSelectAll ? <option value="">All warehouses</option> : null}
        {warehouses.map((warehouse) => (
          <option key={warehouse.id} value={warehouse.id}>
            {warehouse.name} ({warehouse.code})
          </option>
        ))}
      </select>
    </label>
  );
}
