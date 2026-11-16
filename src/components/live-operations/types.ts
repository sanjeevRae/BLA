/**
 * Client-side view types for the Live Operations board (V2 Phase 5).
 * These mirror the GET /api/live-operations payload exactly — see
 * docs/live-gps-tracking.md §3. `codCollectedPaisa` is OPTIONAL by
 * design: the server omits the key entirely unless the actor may
 * read COD, so the UI must treat absence as "do not mention COD",
 * never as zero.
 */

export type FreshnessState = "FRESH" | "DELAYED" | "STALE" | "OFFLINE";
export type TrackingType = "LINEHAUL" | "PICKUP" | "DELIVERY";

export interface LiveWarehouseRef {
  warehouseId: string;
  code: string;
  name: string;
}

export interface LiveLocation {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  lastRecordedAt: string;
  lastReceivedAt: string;
}

export interface LiveOperationItem {
  trackingSessionId: string;
  driverId: string;
  driverName: string;
  trackingType: TrackingType;
  sessionStatus: string;
  tripId: string | null;
  tripNumber: string | null;
  transferId: string | null;
  deliveryBatchId: string | null;
  batchKind: string | null;
  batchDate: string | null;
  origin: LiveWarehouseRef;
  destination: LiveWarehouseRef | null;
  vehicleRegistration: string | null;
  packageCount: number;
  deliveredCount: number | null;
  remainingCount: number | null;
  codCollectedPaisa?: string;
  location: LiveLocation | null;
  freshnessState: FreshnessState;
}

export interface LiveOperationPackage {
  packageId: string;
  trackingId: string;
  packageStatus: string;
  itemStatus?: string;
  assignmentStatus?: string;
}

export interface LiveOperationDetail extends LiveOperationItem {
  packages: LiveOperationPackage[];
}

export interface LiveOperationsListResponse {
  items: LiveOperationItem[];
  total: number;
  generatedAt: string;
  latestReceivedAt: string | null;
}

export interface WarehouseOption {
  id: string;
  code: string;
  name: string;
}

/** Coordinates for one warehouse, resolved server-side from its
 *  PRIMARY WarehouseAddress (the Warehouse model itself carries no
 *  coordinates). Warehouses without a geocoded primary address are
 *  simply absent from this map — never guessed. */
export interface WarehouseCoords {
  latitude: number;
  longitude: number;
  code: string;
  name: string;
}

export type WarehouseCoordsMap = Record<string, WarehouseCoords>;
