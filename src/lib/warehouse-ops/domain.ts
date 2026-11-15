/**
 * Phase 4 warehouse-operations vocabulary (docs/database-schema.md §6,
 * docs/inventory-and-custody.md). Statuses/conditions are stored as
 * strings and enforced by CHECK constraints in the Phase 4 hardening
 * migration; these constants are the single code-side source.
 */

// -- Inventory (parcel) ------------------------------------------------------

export const INVENTORY_RELEASE_REASONS = [
  "DISPATCH",
  "DELIVERY_HANDOUT",
  "TRANSFER",
  "RETURN",
  "CORRECTION",
] as const;
export type InventoryReleaseReason = (typeof INVENTORY_RELEASE_REASONS)[number];

export const INVENTORY_MOVEMENT_TYPES = [
  "RECEIVING",
  "PUT_AWAY",
  "INTERNAL_MOVE",
  "PICKING",
  "DISPATCH",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "RETURN_RECEIVING",
  "DAMAGE_QUARANTINE",
  "CORRECTION",
] as const;
export type InventoryMovementType = (typeof INVENTORY_MOVEMENT_TYPES)[number];

// -- Custody -----------------------------------------------------------------

export const CUSTODIAN_TYPES = [
  "WAREHOUSE",
  "USER",
  "RECIPIENT",
  "RETURN_TEAM",
] as const;
export type CustodianType = (typeof CUSTODIAN_TYPES)[number];

export const HANDOVER_BATCH_STATUSES = [
  "PENDING",
  "PARTIALLY_CONFIRMED",
  "CONFIRMED",
  "DISPUTED",
] as const;
export type HandoverBatchStatus = (typeof HANDOVER_BATCH_STATUSES)[number];

export const HANDOVER_LINE_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "MISSING",
  "DAMAGED",
] as const;
export type HandoverLineStatus = (typeof HANDOVER_LINE_STATUSES)[number];

// -- Supplies (strictly separate from parcels) -------------------------------

export const STOCK_UNITS = ["PCS", "ROLL", "KG"] as const;
export type StockUnit = (typeof STOCK_UNITS)[number];

export const STOCK_MOVEMENT_TYPES = [
  "PURCHASE",
  "ISSUE",
  "RETURN",
  "ADJUSTMENT",
  "DAMAGE_WRITE_OFF",
] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

// -- Capacity (docs/warehouse-workflow.md §4) --------------------------------

/**
 * Capacity is always computed from open InventoryRecords, never a
 * stored counter. 85% = warning, 95% = critical (block non-essential
 * intake), 100% = full (block receiving without an explicit override).
 */
export type CapacityLevel = "OK" | "WARNING" | "CRITICAL" | "FULL";

export interface CapacitySnapshot {
  capacity: number;
  occupancy: number;
  percent: number;
  level: CapacityLevel;
}

export function capacitySnapshot(
  capacity: number,
  occupancy: number,
): CapacitySnapshot {
  const percent = capacity > 0 ? Math.floor((occupancy * 100) / capacity) : 100;
  const level: CapacityLevel =
    percent >= 100 ? "FULL" : percent >= 95 ? "CRITICAL" : percent >= 85 ? "WARNING" : "OK";
  return { capacity, occupancy, percent, level };
}
