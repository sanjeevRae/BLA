// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { cleanup, render, screen } from "@testing-library/react";

import { TransferSummaryCard } from "@/components/transfers/TransferSummaryCard";
import type { TransferView } from "@/server/services/transfers";

/**
 * V3 Step 9 — TransferSummaryCard (DS §10): an additive summary
 * surface on the transfer detail page, composed ONLY from
 * TransferView fields the detail page already renders. The manifest
 * strip appears only when the transfer is manifested, and the status
 * renders as a friendly label — never the raw SCREAMING_SNAKE enum.
 */

afterEach(() => {
  cleanup();
});

const BASE: TransferView = {
  id: "transfer-1",
  transferNumber: "TR-2026-001",
  status: "IN_TRANSIT",
  originWarehouseId: "wh-origin",
  originWarehouseCode: "KTM",
  originWarehouseName: "Kathmandu Central",
  destinationWarehouseId: "wh-dest",
  destinationWarehouseCode: "PKR",
  destinationWarehouseName: "Pokhara Hub",
  driverId: "driver-1",
  driverName: "Hari Bahadur",
  driverUserId: "user-driver",
  vehicleId: "vehicle-1",
  vehicleRegistration: "BA 2 KHA 4521",
  tripId: null,
  tripNumber: null,
  tripStatus: null,
  dispatchSupervisorName: null,
  createdByName: "Meena Rai",
  approvedByName: "Sita Sharma",
  approvedAt: "2026-11-17T08:00:00.000Z",
  expectedArrivalAt: "2026-11-18T10:30:00.000Z",
  dispatchedAt: "2026-11-17T09:15:00.000Z",
  arrivedAt: null,
  reconciledAt: null,
  closedAt: null,
  instructions: null,
  createdAt: "2026-11-17T07:00:00.000Z",
  items: [],
  manifest: {
    id: "manifest-1",
    manifestCode: "MF-2026-001",
    generatedByName: "Meena Rai",
    generatedAt: "2026-11-17T08:30:00.000Z",
    packageCount: 12,
    totalWeightKg: "34.5",
    totalCodPaisa: "125000",
    sealedAt: "2026-11-17T08:45:00.000Z",
  },
  reconciliation: {
    totalItems: 12,
    loadedCount: 12,
    receivedCount: 0,
    damagedCount: 0,
    missingCount: 0,
    accountedCount: 0,
    unaccountedTrackingIds: [],
  },
};

describe("TransferSummaryCard — manifested transfer", () => {
  it("renders the route line, friendly status, and facts grid", () => {
    const { container } = render(<TransferSummaryCard transfer={BASE} />);

    // Route: transfer number + origin → destination codes and names.
    expect(screen.getByText("TR-2026-001")).toBeTruthy();
    expect(screen.getByText("KTM")).toBeTruthy();
    expect(screen.getByText("PKR")).toBeTruthy();
    expect(screen.getByText(/Kathmandu Central → Pokhara Hub/)).toBeTruthy();

    // Status is the friendly label, never the raw enum.
    expect(screen.getByText("In transit")).toBeTruthy();
    expect(container.textContent).not.toContain("IN_TRANSIT");

    // Facts grid: driver, vehicle, created by, approved by.
    expect(screen.getByText("Hari Bahadur")).toBeTruthy();
    expect(screen.getByText("BA 2 KHA 4521")).toBeTruthy();
    expect(screen.getByText("Meena Rai")).toBeTruthy();
    expect(screen.getByText("Sita Sharma")).toBeTruthy();
    expect(screen.getByText("Driver")).toBeTruthy();
    expect(screen.getByText("Vehicle")).toBeTruthy();
    expect(screen.getByText("Dispatched")).toBeTruthy();
    expect(screen.getByText("Expected arrival")).toBeTruthy();
    expect(screen.getByText("Created by")).toBeTruthy();
    expect(screen.getByText("Approved by")).toBeTruthy();
  });

  it("renders the manifest strip with code, packages, weight, and COD totals", () => {
    render(<TransferSummaryCard transfer={BASE} />);
    expect(screen.getByText("Manifest")).toBeTruthy();
    expect(screen.getByText("MF-2026-001")).toBeTruthy();
    expect(screen.getByText("12 packages")).toBeTruthy();
    expect(screen.getByText("34.5 kg")).toBeTruthy();
    expect(screen.getByText(/NPR 1,250\.00/)).toBeTruthy();
  });
});

describe("TransferSummaryCard — unmanifested transfer", () => {
  it("omits the manifest strip and falls back for unassigned crew", () => {
    const transfer: TransferView = {
      ...BASE,
      status: "DRAFT",
      driverName: null,
      vehicleRegistration: null,
      approvedByName: null,
      dispatchedAt: null,
      manifest: null,
    };
    const { container } = render(<TransferSummaryCard transfer={transfer} />);

    expect(screen.getByText("Draft")).toBeTruthy();
    expect(container.textContent).not.toContain("DRAFT");
    expect(screen.getAllByText("Not assigned")).toHaveLength(2);

    // No manifest strip: no label, no code, no totals.
    expect(screen.queryByText("Manifest")).toBeNull();
    expect(screen.queryByText("MF-2026-001")).toBeNull();
    expect(screen.queryByText("12 packages")).toBeNull();
    expect(screen.queryByText(/NPR 1,250\.00/)).toBeNull();
  });
});
