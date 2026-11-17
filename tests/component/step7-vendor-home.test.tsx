// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { cleanup, render, screen } from "@testing-library/react";

import { VendorHomeView } from "@/components/vendor-home/VendorHomeView";
import type { VendorHomeData } from "@/server/services/home-dashboards";

/**
 * Step 7 (V3) — Vendor home view: the needs-attention section leads
 * with an honest all-clear when the vendor is approved and every
 * attention count is zero, and renders each real attention item
 * (with its count and drill link) when the model carries one. The
 * COD card is the payable ledger balance, labelled exactly that.
 */

afterEach(() => {
  cleanup();
});

function fixtureData(overrides: Partial<VendorHomeData> = {}): VendorHomeData {
  return {
    vendor: {
      id: "vendor-1",
      businessName: "Himalaya Traders",
      verificationStatus: "APPROVED",
      isActive: true,
      warehouses: [{ warehouseId: "wh-1", warehouseCode: "KTM-01", kind: "ORIGIN", isActive: true }],
    },
    metrics: {
      range: { from: "2026-10-09", to: "2026-11-07" },
      bookings: 12,
      delivered: 9,
      returnsCreated: 1,
      pendingPickup: 3,
      inTransit: 4,
      outForDelivery: 2,
      deliveryAttempted: 0,
      codPayablePaisa: "150050",
      outstandingPaisa: "20000",
    },
    attention: {
      deliveryAttempted: 0,
      returnsAwaiting: 0,
      openIncidents: 0,
      openTickets: 0,
    },
    recentShipments: [],
    attentionShipments: [],
    recentBookings: [],
    recentReturns: [],
    ...overrides,
  };
}

describe("Step 7 VendorHomeView — needs attention", () => {
  it("renders the all-clear state when approved and every count is zero", () => {
    render(<VendorHomeView data={fixtureData()} vendorRole="owner" />);
    expect(screen.getByText(/Nothing needs your attention right now/)).toBeTruthy();
    expect(screen.queryByText(/Open incidents on your packages/)).toBeNull();
    expect(screen.queryByText(/Open support tickets/)).toBeNull();
    expect(screen.queryByText(/not approved for booking yet/)).toBeNull();
  });

  it("renders each attention item with its count and drill link", () => {
    const data = fixtureData({
      attention: {
        deliveryAttempted: 2,
        returnsAwaiting: 1,
        openIncidents: 3,
        openTickets: 1,
      },
      attentionShipments: [
        {
          id: "pkg-1",
          trackingId: "BLA-1001",
          orderId: "order-1",
          recipientName: "Asha Sharma",
          deliveryCity: "Pokhara",
          deliveryDistrict: "Kaski",
          operationalStatus: "DELIVERY_ATTEMPTED",
          deliveryStatus: "ATTEMPTED",
          codAmountPaisa: "50000",
          createdAt: "2026-11-07T10:00:00.000Z",
        },
      ],
    });
    render(<VendorHomeView data={data} vendorRole="owner" />);

    expect(screen.queryByText(/Nothing needs your attention right now/)).toBeNull();
    expect(screen.getByText(/had a delivery attempt that did not complete/)).toBeTruthy();
    // The attempted shipment row drills into its booking detail.
    const shipmentLink = screen.getByRole("link", { name: /BLA-1001/ });
    expect(shipmentLink.getAttribute("href")).toBe("/vendor/bookings/order-1");
    expect(screen.getByText(/Returns awaiting action/)).toBeTruthy();
    const incidentLink = screen.getByRole("link", { name: /Open incidents on your packages/ });
    expect(incidentLink.getAttribute("href")).toBe("/vendor/incidents");
    const ticketLink = screen.getByRole("link", { name: /Open support tickets/ });
    expect(ticketLink.getAttribute("href")).toBe("/vendor/tickets");
  });

  it("shows the not-approved banner and hides Create booking until approval", () => {
    const data = fixtureData();
    data.vendor = { ...data.vendor, verificationStatus: "PENDING" };
    render(<VendorHomeView data={data} vendorRole={null} />);
    expect(screen.getByText(/not approved for booking yet/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Create booking" })).toBeNull();
    // Bulk booking stays available (header + quick actions), per the brief.
    expect(screen.getAllByRole("link", { name: "Bulk booking" }).length).toBeGreaterThan(0);
  });
});

describe("Step 7 VendorHomeView — header and KPI honesty", () => {
  it("labels the COD card as the payable ledger balance and shows the warehouses", () => {
    render(<VendorHomeView data={fixtureData()} vendorRole="owner" />);
    expect(screen.getAllByText("COD payable to you").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Vendor-payable ledger balance").length).toBeGreaterThan(0);
    expect(screen.getByText(/KTM-01/)).toBeTruthy();
    expect(screen.queryByText(/No warehouse assigned yet/)).toBeNull();
  });

  it("says so when no warehouse is assigned", () => {
    const data = fixtureData();
    data.vendor = { ...data.vendor, warehouses: [] };
    render(<VendorHomeView data={data} vendorRole="owner" />);
    expect(screen.getByText(/No warehouse assigned yet/)).toBeTruthy();
  });
});
