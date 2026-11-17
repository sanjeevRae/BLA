import { describe, expect, it, vi } from "vitest";

// `server-only` throws outside a React Server Component environment;
// the service under test is server-only code, so stub the marker.
vi.mock("server-only", () => ({}));

import {
  AT_WAREHOUSE_STATUSES,
  IN_TRANSIT_STATUSES,
  bucketPackageStates,
  dayDelta,
  mapAuditActivity,
  summarizeLiveOperations,
  weeklyDeliveredSeries,
} from "@/server/services/home-dashboards";
import type { AuditLogView } from "@/server/services/audit-log";
import type { LiveOperationItem } from "@/server/services/live-operations";

/**
 * V3 Step 4 — pure helpers behind the executive (Admin / Super Admin)
 * home: package-state buckets, weekly rollup, day deltas, the audit
 * activity projection, and the live-operations summary extension.
 * No database: every function here is a pure aggregation.
 */

describe("bucketPackageStates", () => {
  it("exposes the exact bucket status sets from the spec", () => {
    expect(AT_WAREHOUSE_STATUSES).toEqual([
      "RECEIVED_AT_ORIGIN",
      "INSPECTION_PENDING",
      "PROCESSING",
      "SORTED",
      "READY_FOR_DISPATCH",
      "TRANSFER_ASSIGNED",
      "ARRIVED_AT_DESTINATION",
      "RECEIVING_INSPECTION",
      "RECEIVED_AT_DESTINATION",
      "READY_FOR_DELIVERY",
    ]);
    expect(IN_TRANSIT_STATUSES).toEqual(["DISPATCHED", "IN_TRANSIT"]);
  });

  it("buckets mixed statuses, counting unknown/other statuses in total only", () => {
    const buckets = bucketPackageStates([
      { status: "RECEIVED_AT_ORIGIN", count: 2 },
      { status: "PROCESSING", count: 1 },
      { status: "READY_FOR_DELIVERY", count: 4 },
      { status: "DISPATCHED", count: 1 },
      { status: "IN_TRANSIT", count: 3 },
      { status: "OUT_FOR_DELIVERY", count: 2 },
      { status: "DELIVERED", count: 5 },
      { status: "BOOKED", count: 1 },
      { status: "PICKUP_ASSIGNED", count: 1 },
      { status: "PICKUP_IN_PROGRESS", count: 1 },
      { status: "DELIVERY_ASSIGNED", count: 2 },
      { status: "CANCELLED", count: 1 },
      // In no named bucket — total only.
      { status: "DRAFT", count: 4 },
      { status: "DELIVERY_ATTEMPTED", count: 1 },
      { status: "SOME_FUTURE_STATUS", count: 2 },
    ]);
    expect(buckets).toEqual({
      atWarehouses: 7,
      inTransit: 4,
      outForDelivery: 2,
      delivered: 5,
      awaitingPickup: 3,
      assignedToRiders: 2,
      cancelled: 1,
      total: 31,
    });
  });

  it("returns all zeros for an empty snapshot", () => {
    expect(bucketPackageStates([])).toEqual({
      atWarehouses: 0,
      inTransit: 0,
      outForDelivery: 0,
      delivered: 0,
      awaitingPickup: 0,
      assignedToRiders: 0,
      cancelled: 0,
      total: 0,
    });
  });
});

describe("weeklyDeliveredSeries", () => {
  it("groups by Monday-start weeks across a month boundary", () => {
    // 2026-10-26 is a Monday; 2026-11-01 is the Sunday of that same
    // week; 2026-11-02 starts the next week.
    const weekly = weeklyDeliveredSeries([
      { date: "2026-10-29", bookings: 1, delivered: 0 },
      { date: "2026-10-31", bookings: 2, delivered: 1 },
      { date: "2026-11-01", bookings: 4, delivered: 2 },
      { date: "2026-11-02", bookings: 8, delivered: 3 },
      { date: "2026-11-04", bookings: 16, delivered: 5 },
    ]);
    expect(weekly).toEqual([
      { label: "26 Oct", bookings: 7, delivered: 3 },
      { label: "2 Nov", bookings: 24, delivered: 8 },
    ]);
  });

  it("labels a single mid-week day with its Monday and keeps ascending order", () => {
    const weekly = weeklyDeliveredSeries([
      { date: "2026-11-18", bookings: 3, delivered: 1 }, // Wednesday of Mon 16 Nov
      { date: "2026-11-10", bookings: 1, delivered: 1 }, // Tuesday of Mon 9 Nov
    ]);
    expect(weekly).toEqual([
      { label: "9 Nov", bookings: 1, delivered: 1 },
      { label: "16 Nov", bookings: 3, delivered: 1 },
    ]);
  });

  it("returns an empty series for empty input", () => {
    expect(weeklyDeliveredSeries([])).toEqual([]);
  });
});

describe("dayDelta", () => {
  const series = [
    { date: "2026-10-31", bookings: 5, delivered: 2 },
    { date: "2026-11-01", bookings: 9, delivered: 4 },
    { date: "2026-11-02", bookings: 1, delivered: 0 },
  ];

  it("reads today and yesterday (across a month boundary)", () => {
    expect(dayDelta(series, "2026-11-01")).toEqual({
      bookings: { today: 9, yesterday: 5 },
      delivered: { today: 4, yesterday: 2 },
    });
    expect(dayDelta(series, "2026-11-02")).toEqual({
      bookings: { today: 1, yesterday: 9 },
      delivered: { today: 0, yesterday: 4 },
    });
  });

  it("is null when today's row is absent", () => {
    expect(dayDelta(series, "2026-11-03")).toEqual({
      bookings: null,
      delivered: null,
    });
  });

  it("is null when yesterday's row is absent even if today exists", () => {
    expect(dayDelta(series, "2026-10-31")).toEqual({
      bookings: null,
      delivered: null,
    });
    expect(dayDelta([], "2026-11-01")).toEqual({
      bookings: null,
      delivered: null,
    });
  });
});

// ---------------------------------------------------------------------------
// mapAuditActivity
// ---------------------------------------------------------------------------

function auditRow(overrides: Partial<AuditLogView> = {}): AuditLogView {
  return {
    id: "row-1",
    actorId: "user-1",
    actorName: "Ada Admin",
    actorEmail: "ada@test.local",
    actorRole: "ADMIN",
    action: "booking.create",
    entityType: "Order",
    entityId: "order-1",
    warehouseId: null,
    before: null,
    after: null,
    outcome: "recorded",
    createdAt: "2026-11-17T04:00:00.000Z",
    ...overrides,
  };
}

describe("mapAuditActivity", () => {
  it("filters out denied, read_, access.denied and non-operational rows", () => {
    const items = mapAuditActivity(
      [
        auditRow({ id: "keep" }),
        auditRow({ id: "denied-outcome", outcome: "denied" }),
        auditRow({ id: "denied-action", action: "access.denied" }),
        auditRow({ id: "read", action: "booking.read_one" }),
        auditRow({ id: "read-all", action: "package.read_all", entityType: "Package" }),
        auditRow({ id: "user-row", action: "user.invited", entityType: "User" }),
        auditRow({ id: "settings-row", action: "settings.update", entityType: "SystemSetting" }),
      ],
      "/admin",
    );
    expect(items.map((i) => i.id)).toEqual(["keep"]);
  });

  it("uses the exact label map for known actions", () => {
    const cases: [string, string, string][] = [
      // [action, entityType, expected label]
      ["booking.create", "Order", "New booking created"],
      ["booking.approve", "Order", "Booking approved"],
      ["booking.cancel", "Order", "Booking cancelled"],
      ["booking.reject", "Order", "Booking rejected"],
      ["booking.update", "Order", "Booking updated"],
      ["transfer.create", "Transfer", "Transfer created"],
      ["transfer.dispatch", "Transfer", "Transfer dispatched"],
      ["transfer.dispatched", "Transfer", "Transfer dispatched"],
      ["transfer.receive", "Transfer", "Transfer received"],
      ["transfer.reconciled", "Transfer", "Transfer reconciled"],
      ["trip.departed", "Trip", "Trip departed"],
      ["trip.arrived", "Trip", "Trip arrived"],
      ["delivery.confirmed", "Package", "Delivery completed"],
      ["delivery.attempt_recorded", "Package", "Delivery attempt recorded"],
      ["delivery.assign", "DeliveryAssignment", "Driver assigned to a delivery"],
      ["driver.assign", "Driver", "Driver assigned"],
      ["package.inspect", "Package", "Package inspected"],
      ["transfer.package_received_scan", "Package", "Package received"],
      ["task.created", "Task", "Task created"],
      ["task.create", "Task", "Task created"],
      ["task.verify", "Task", "Task verified"],
      ["task.status_changed", "Task", "Task updated"],
      ["incident.reported", "Incident", "Incident reported"],
      ["incident.report", "Incident", "Incident reported"],
      ["incident.resolve", "Incident", "Incident resolved"],
    ];
    for (const [action, entityType, label] of cases) {
      const [item] = mapAuditActivity([auditRow({ action, entityType })], "/admin");
      expect(item.label, action).toBe(label);
    }
  });

  it("falls back to a humanised action for unmapped actions", () => {
    const [item] = mapAuditActivity(
      [auditRow({ action: "package.status_changed", entityType: "Package" })],
      "/admin",
    );
    expect(item.label).toBe("Status changed");
    const [other] = mapAuditActivity(
      [auditRow({ action: "warehouse.capacity_updated", entityType: "Warehouse" })],
      "/admin",
    );
    expect(other.label).toBe("Capacity updated");
  });

  it("builds hrefs only for detail-page entity types with an entity id", () => {
    const hrefFor = (entityType: string, entityId: string | null, basePath = "/admin") =>
      mapAuditActivity([auditRow({ entityType, entityId })], basePath)[0].href;
    expect(hrefFor("Order", "o1")).toBe("/admin/bookings/o1");
    expect(hrefFor("Incident", "i1")).toBe("/admin/incidents/i1");
    expect(hrefFor("Task", "t1")).toBe("/admin/tasks/t1");
    expect(hrefFor("Vendor", "v1")).toBe("/admin/vendors/v1");
    expect(hrefFor("Customer", "c1")).toBe("/admin/customers/c1");
    expect(hrefFor("Driver", "d1")).toBe("/admin/drivers/d1");
    expect(hrefFor("Warehouse", "w1")).toBe("/admin/warehouses/w1");
    expect(hrefFor("VendorSettlement", "s1", "/super-admin")).toBe(
      "/super-admin/settlements/s1",
    );
    // Operational types without a detail page stay unlinked.
    expect(hrefFor("Package", "p1")).toBeNull();
    expect(hrefFor("Transfer", "tr1")).toBeNull();
    expect(hrefFor("Trip", "tp1")).toBeNull();
    expect(hrefFor("DeliveryBatch", "b1")).toBeNull();
    expect(hrefFor("ReturnRequest", "r1")).toBeNull();
    // No entity id — no href even for a linked type.
    expect(hrefFor("Order", null)).toBeNull();
  });

  it("passes actor and timestamp through and caps the feed at 8, preserving order", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      auditRow({ id: `row-${i + 1}`, actorName: i === 0 ? "First Actor" : "Ada Admin" }),
    );
    const items = mapAuditActivity(rows, "/admin");
    expect(items).toHaveLength(8);
    expect(items.map((i) => i.id)).toEqual([
      "row-1",
      "row-2",
      "row-3",
      "row-4",
      "row-5",
      "row-6",
      "row-7",
      "row-8",
    ]);
    expect(items[0].actorName).toBe("First Actor");
    expect(items[0].createdAt).toBe("2026-11-17T04:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// summarizeLiveOperations extension
// ---------------------------------------------------------------------------

function liveItem(overrides: Partial<LiveOperationItem> = {}): LiveOperationItem {
  return {
    trackingSessionId: "session-1",
    driverId: "driver-1",
    driverName: "Driver One",
    trackingType: "DELIVERY",
    sessionStatus: "ACTIVE",
    tripId: null,
    tripNumber: null,
    transferId: null,
    deliveryBatchId: null,
    batchKind: null,
    batchDate: null,
    origin: { warehouseId: "w1", code: "WH-A", name: "A" },
    destination: null,
    vehicleRegistration: null,
    packageCount: 0,
    deliveredCount: null,
    remainingCount: null,
    location: null,
    freshnessState: "FRESH",
    ...overrides,
  };
}

describe("summarizeLiveOperations — activeDrivers + delayedMovements", () => {
  it("counts distinct drivers among ACTIVE/PAUSED items only", () => {
    const summary = summarizeLiveOperations(
      [
        liveItem({ trackingSessionId: "s1", driverId: "d1" }),
        liveItem({ trackingSessionId: "s2", driverId: "d1", sessionStatus: "PAUSED" }),
        liveItem({ trackingSessionId: "s3", driverId: "d2", trackingType: "PICKUP" }),
        liveItem({ trackingSessionId: "s4", driverId: "d3", sessionStatus: "ENDED" }),
      ],
      "2026-11-17T04:05:00.000Z",
    );
    expect(summary.activeMovements).toBe(3);
    expect(summary.activeDrivers).toBe(2);
  });

  it("mirrors the delayed freshness count and leaves existing fields unchanged", () => {
    const summary = summarizeLiveOperations(
      [
        liveItem({ trackingSessionId: "s1", freshnessState: "DELAYED" }),
        liveItem({ trackingSessionId: "s2", freshnessState: "DELAYED", driverId: "d2" }),
        liveItem({ trackingSessionId: "s3", freshnessState: "FRESH", driverId: "d3" }),
        liveItem({
          trackingSessionId: "s4",
          freshnessState: "DELAYED",
          sessionStatus: "ENDED",
          driverId: "d4",
        }),
      ],
      "2026-11-17T04:05:00.000Z",
    );
    expect(summary.byFreshness).toEqual({ fresh: 1, delayed: 2, stale: 0, offline: 0 });
    expect(summary.delayedMovements).toBe(2);
    expect(summary.delayedMovements).toBe(summary.byFreshness.delayed);
    expect(summary.byType).toEqual({ transfers: 0, pickups: 0, deliveries: 3 });
    expect(summary.generatedAt).toBe("2026-11-17T04:05:00.000Z");
    expect(summary.activeMovements).toBe(3);
  });

  it("reports zero drivers and zero delayed for no active movements", () => {
    const summary = summarizeLiveOperations([], "2026-11-17T04:05:00.000Z");
    expect(summary.activeDrivers).toBe(0);
    expect(summary.delayedMovements).toBe(0);
    expect(summary.activeMovements).toBe(0);
  });
});
