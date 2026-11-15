/**
 * Warehouse code vocabularies and the hierarchical storage-location code
 * builder (docs/warehouse-workflow.md §2–§3, docs/database-schema.md §2).
 * Pure helpers — unit-tested without a database.
 */

export const WAREHOUSE_TYPES = [
  "MAIN",
  "REGIONAL",
  "LOCAL_HUB",
  "COLLECTION_CENTER",
  "RETURN_CENTER",
] as const;
export type WarehouseType = (typeof WAREHOUSE_TYPES)[number];

export const WAREHOUSE_STATUSES = ["ACTIVE", "INACTIVE", "ARCHIVED"] as const;
export type WarehouseStatus = (typeof WAREHOUSE_STATUSES)[number];

export const ZONE_KINDS = [
  "RECEIVING",
  "INSPECTION",
  "SORTING",
  "STORAGE",
  "DISPATCH",
  "DAMAGED",
  "RETURNS",
] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];

export const ADDRESS_KINDS = ["PRIMARY", "GATE", "BILLING"] as const;

/** WH-<CITY>-<NN>, e.g. WH-KTM-01. Unique and immutable once created. */
export const WAREHOUSE_CODE_PATTERN = /^WH-[A-Z]{3}-\d{2}$/;

/** The seven standard zones created by template at warehouse setup. */
export const STANDARD_ZONES: ReadonlyArray<{
  code: string;
  name: string;
  kind: ZoneKind;
}> = [
  { code: "ZONE-REC", name: "Receiving", kind: "RECEIVING" },
  { code: "ZONE-INS", name: "Inspection", kind: "INSPECTION" },
  { code: "ZONE-SRT", name: "Sorting", kind: "SORTING" },
  { code: "ZONE-STO", name: "Storage", kind: "STORAGE" },
  { code: "ZONE-DSP", name: "Dispatch", kind: "DISPATCH" },
  { code: "ZONE-DMG", name: "Damaged", kind: "DAMAGED" },
  { code: "ZONE-RET", name: "Returns", kind: "RETURNS" },
];

export function standardZoneCodeForKind(kind: ZoneKind): string {
  const zone = STANDARD_ZONES.find((z) => z.kind === kind);
  if (!zone) throw new Error(`No standard zone for kind ${kind}`);
  return zone.code;
}

const SEGMENT_PATTERN = /^[A-Z0-9][A-Z0-9-]*$/;

/**
 * Normalise one location segment ("3" -> "03", "rack-03" -> "03" when the
 * caller passes a prefixed value). Numeric segments are zero-padded to
 * two digits so codes sort and scan consistently (RACK-03, SHELF-02).
 */
export function normalizeSegment(raw: string, prefix: string): string {
  let value = raw.trim().toUpperCase();
  if (value.startsWith(`${prefix}-`)) value = value.slice(prefix.length + 1);
  if (/^\d+$/.test(value)) value = value.padStart(2, "0");
  if (!SEGMENT_PATTERN.test(value)) {
    throw new Error(`Invalid ${prefix.toLowerCase()} segment: ${raw}`);
  }
  return value;
}

/**
 * Build the canonical scannable full code:
 * WH-KTM-01/ZONE-STO/RACK-03/SHELF-02[/BIN-01]
 */
export function buildStorageFullCode(input: {
  warehouseCode: string;
  zoneCode: string;
  rack: string;
  shelf?: string | null;
  bin?: string | null;
}): string {
  const parts = [
    input.warehouseCode.trim().toUpperCase(),
    input.zoneCode.trim().toUpperCase(),
    `RACK-${normalizeSegment(input.rack, "RACK")}`,
  ];
  if (input.shelf) parts.push(`SHELF-${normalizeSegment(input.shelf, "SHELF")}`);
  if (input.bin) parts.push(`BIN-${normalizeSegment(input.bin, "BIN")}`);
  return parts.join("/");
}

export const STORAGE_FULL_CODE_PATTERN =
  /^WH-[A-Z]{3}-\d{2}\/ZONE-[A-Z0-9-]+\/RACK-[A-Z0-9-]+(\/SHELF-[A-Z0-9-]+)?(\/BIN-[A-Z0-9-]+)?$/;

/** Default operating hours: Sunday–Friday 09:00–18:00, Saturday closed
 *  (Nepal working week). Times are minutes-from-midnight; dayOfWeek 0–6
 *  with 0 = Sunday. */
export function defaultOperatingHours(): Array<{
  dayOfWeek: number;
  opensAt: number | null;
  closesAt: number | null;
  isClosed: boolean;
}> {
  return Array.from({ length: 7 }, (_, dayOfWeek) =>
    dayOfWeek === 6
      ? { dayOfWeek, opensAt: null, closesAt: null, isClosed: true }
      : { dayOfWeek, opensAt: 9 * 60, closesAt: 18 * 60, isClosed: false },
  );
}
