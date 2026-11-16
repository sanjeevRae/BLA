/**
 * The package lifecycle state machine (docs/package-lifecycle.md §3–§4;
 * docs/database-schema.md §5). The transition table is an explicit
 * allow-list of (from, to, triggering operation, required permission):
 * anything not listed is rejected. The PackageLifecycleService is the
 * only code allowed to write `Package.operationalStatus`.
 */

export const OPERATIONAL_STATUSES = [
  "DRAFT",
  "BOOKED",
  "PICKUP_ASSIGNED",
  "PICKUP_IN_PROGRESS",
  "PICKED_UP",
  "RECEIVED_AT_ORIGIN",
  "INSPECTION_PENDING",
  "PROCESSING",
  "SORTED",
  "READY_FOR_DISPATCH",
  "TRANSFER_ASSIGNED",
  "DISPATCHED",
  "IN_TRANSIT",
  "ARRIVED_AT_DESTINATION",
  "RECEIVING_INSPECTION",
  "RECEIVED_AT_DESTINATION",
  "READY_FOR_DELIVERY",
  "DELIVERY_ASSIGNED",
  "OUT_FOR_DELIVERY",
  "DELIVERY_ATTEMPTED",
  "DELIVERED",
  "CANCELLED",
] as const;
export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];

export interface PackageTransition {
  from: OperationalStatus;
  to: OperationalStatus;
  /** The real-world operation that causes this move (never a raw
   *  "set status" — `package.change_status` is granted to no role). */
  operation: string;
  /** Permission the acting user must hold for the operation. */
  permission: string;
}

const T = (
  from: OperationalStatus,
  to: OperationalStatus,
  operation: string,
  permission: string,
): PackageTransition => ({ from, to, operation, permission });

export const PACKAGE_TRANSITIONS: readonly PackageTransition[] = [
  // Booking stage (Phase 3)
  T("DRAFT", "BOOKED", "submit_booking", "booking.create"),
  T("DRAFT", "CANCELLED", "cancel_booking", "booking.cancel"),
  T("BOOKED", "CANCELLED", "cancel_booking", "booking.cancel"),
  T("PICKUP_ASSIGNED", "CANCELLED", "cancel_booking", "booking.cancel"),
  // Pickup (Phase 6 operations drive these)
  T("BOOKED", "PICKUP_ASSIGNED", "assign_pickup", "pickup.assign"),
  T("PICKUP_ASSIGNED", "PICKUP_IN_PROGRESS", "pickup_started", "pickup.confirm"),
  T("PICKUP_IN_PROGRESS", "PICKED_UP", "confirm_pickup", "pickup.confirm"),
  // Origin warehouse (Phase 4)
  T("PICKED_UP", "RECEIVED_AT_ORIGIN", "receive_at_origin", "package.receive"),
  // Counter drop-off (lifecycle doc rule T1): a vendor/staff drop-off at
  // the origin warehouse counter is received by WA/WS scan without a
  // prior pickup leg — the receiving scan IS the intake event.
  T("BOOKED", "RECEIVED_AT_ORIGIN", "receive_at_origin", "package.receive"),
  T("RECEIVED_AT_ORIGIN", "INSPECTION_PENDING", "move_to_inspection", "package.inspect"),
  T("INSPECTION_PENDING", "PROCESSING", "start_inspection", "package.inspect"),
  T("PROCESSING", "SORTED", "complete_sorting", "package.sort"),
  T("SORTED", "READY_FOR_DISPATCH", "mark_ready_for_dispatch", "package.sort"),
  // Transfer leg (Phase 5)
  T("READY_FOR_DISPATCH", "TRANSFER_ASSIGNED", "add_to_transfer", "transfer.prepare"),
  // Pre-dispatch release (Phase 5): a manifested package removed from
  // its transfer — or released by a transfer cancellation — returns to
  // origin stock. The parcel never left origin custody, so this is a
  // defined release path (rule T10), not a backwards edit; it exists
  // only before dispatch (no edge out of DISPATCHED and beyond).
  T("TRANSFER_ASSIGNED", "READY_FOR_DISPATCH", "remove_from_transfer", "transfer.prepare"),
  T("TRANSFER_ASSIGNED", "DISPATCHED", "dispatch_transfer", "transfer.dispatch"),
  T("DISPATCHED", "IN_TRANSIT", "trip_departed", "trip.update_progress"),
  T("IN_TRANSIT", "ARRIVED_AT_DESTINATION", "trip_arrived", "trip.update_progress"),
  T("ARRIVED_AT_DESTINATION", "RECEIVING_INSPECTION", "destination_receiving_scan", "transfer.receive"),
  T("RECEIVING_INSPECTION", "RECEIVED_AT_DESTINATION", "destination_receiving_complete", "transfer.receive"),
  // Last-mile shortcut for same-warehouse shipments (lifecycle doc §3):
  // local deliveries legitimately skip the transfer block.
  T("READY_FOR_DISPATCH", "READY_FOR_DELIVERY", "local_ready_for_delivery", "delivery.assign"),
  T("RECEIVED_AT_DESTINATION", "READY_FOR_DELIVERY", "ready_for_delivery", "delivery.assign"),
  // Delivery (Phase 6)
  T("READY_FOR_DELIVERY", "DELIVERY_ASSIGNED", "assign_delivery", "delivery.assign"),
  T("DELIVERY_ASSIGNED", "OUT_FOR_DELIVERY", "out_for_delivery", "delivery.confirm"),
  T("OUT_FOR_DELIVERY", "DELIVERY_ATTEMPTED", "record_delivery_attempt", "delivery.attempt.record"),
  T("DELIVERY_ATTEMPTED", "OUT_FOR_DELIVERY", "reattempt_delivery", "delivery.confirm"),
  T("OUT_FOR_DELIVERY", "DELIVERED", "confirm_delivery", "delivery.confirm"),
  T("DELIVERY_ATTEMPTED", "DELIVERED", "confirm_delivery", "delivery.confirm"),
  // Pre-pickup release (Phase 6): an assignment cancelled before the
  // rider takes custody — or superseded by a dispatcher release —
  // returns the parcel to the delivery pool. The parcel never left
  // warehouse custody, so this is a defined release path (rule T10),
  // not a backwards edit; it exists only before OUT_FOR_DELIVERY.
  T("DELIVERY_ASSIGNED", "READY_FOR_DELIVERY", "release_delivery_assignment", "delivery.assign"),
  // Warehouse return scan (Phase 6, delivery-workflow.md §8 close-out):
  // an undelivered parcel is scanned back into the destination
  // warehouse at the end of the rider's run — inventory reopens and
  // custody returns to the warehouse. From OUT_FOR_DELIVERY when no
  // attempt was recorded, from DELIVERY_ATTEMPTED after failed
  // attempts. Redelivery re-enters via a fresh assignment.
  T("OUT_FOR_DELIVERY", "READY_FOR_DELIVERY", "delivery_return_scan", "package.receive"),
  T("DELIVERY_ATTEMPTED", "READY_FOR_DELIVERY", "delivery_return_scan", "package.receive"),
  // Cross-warehouse return travel (Phase 7, return-workflow §3
  // steps 4–6): a return received back into the delivery warehouse
  // (READY_FOR_DELIVERY after the scan-back) that must travel to
  // its return warehouse is readied for dispatch so it can join a
  // normal transfer as a manifested return package. The manifest
  // then takes it TRANSFER_ASSIGNED like any other parcel.
  T("READY_FOR_DELIVERY", "READY_FOR_DISPATCH", "return_ready_for_dispatch", "transfer.prepare"),
];

export function findTransition(
  from: string,
  to: string,
): PackageTransition | undefined {
  return PACKAGE_TRANSITIONS.find((t) => t.from === from && t.to === to);
}

export function allowedTransitionsFrom(from: string): PackageTransition[] {
  return PACKAGE_TRANSITIONS.filter((t) => t.from === from);
}

/** Statuses from which a booking-stage cancellation is legal (rule T9:
 *  only before physical custody is taken). */
export const CANCELLABLE_STATUSES: readonly string[] = ["DRAFT", "BOOKED", "PICKUP_ASSIGNED"];

/** Statuses in which booking-stage corrections are still legal
 *  (lifecycle doc §5: before pickup). */
export const EDITABLE_STATUSES: readonly string[] = CANCELLABLE_STATUSES;

export const TERMINAL_STATUSES: readonly string[] = ["DELIVERED", "CANCELLED"];

/** Customer-safe public labels for the tracking projection
 *  (lifecycle doc §6: milestone events only, no internal detail). */
export const PUBLIC_STATUS_LABELS: Readonly<Record<string, string>> = {
  DRAFT: "Booking created",
  BOOKED: "Booked",
  PICKUP_ASSIGNED: "Pickup scheduled",
  PICKUP_IN_PROGRESS: "Pickup in progress",
  PICKED_UP: "Picked up",
  RECEIVED_AT_ORIGIN: "Received at origin hub",
  INSPECTION_PENDING: "Inspection pending",
  PROCESSING: "Processing at hub",
  SORTED: "Sorted at hub",
  READY_FOR_DISPATCH: "Ready for dispatch",
  TRANSFER_ASSIGNED: "Assigned to transfer",
  DISPATCHED: "Dispatched",
  IN_TRANSIT: "In transit",
  ARRIVED_AT_DESTINATION: "Arrived at destination hub",
  RECEIVING_INSPECTION: "Receiving inspection",
  RECEIVED_AT_DESTINATION: "Received at destination hub",
  READY_FOR_DELIVERY: "Ready for delivery",
  DELIVERY_ASSIGNED: "Assigned to a delivery rider",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERY_ATTEMPTED: "Delivery attempted",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

export function publicStatusLabel(status: string): string {
  return PUBLIC_STATUS_LABELS[status] ?? "Update recorded";
}
