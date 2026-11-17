// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { cleanup, render, screen, within } from "@testing-library/react";

import { CustomerHomeView } from "@/components/customers/CustomerHomeView";
import type { CustomerHomeData } from "@/server/services/home-dashboards";
import { formatDateTime } from "@/components/bookings/ui";

/**
 * Step 7 (V3) — Customer home view: pure rendering of the
 * `getCustomerHome` read model (the async container is not under
 * test here; the model's own integration suite covers the reads).
 * The assertions pin the brief §12 honesty rules: expected
 * delivery only when the data carries it, one operational badge
 * per package (no multi-domain stack, nothing more precise than
 * city/district + warehouse label), the first-run empty state
 * instead of zero cards, and the attempted-delivery attention
 * row with its ticket link.
 */

afterEach(() => {
  cleanup();
});

const EXPECTED_AT = "2026-11-20T00:00:00.000Z";
const UPDATED_AT = "2026-11-17T06:00:00.000Z";

function fixtureData(overrides: Partial<CustomerHomeData> = {}): CustomerHomeData {
  return {
    metrics: { total: 3, inTransit: 1, outForDelivery: 1, delivered: 1, returned: 1 },
    attention: {
      deliveryAttempted: 0,
      openTickets: 0,
      unpaidInvoices: 0,
      unpaidTotalPaisa: "0",
    },
    attemptedShipments: [],
    currentShipments: [
      {
        trackingId: "BLA-TEST-100",
        description: "Books box",
        operationalStatus: "IN_TRANSIT",
        deliveryCity: "Kathmandu",
        deliveryDistrict: "Kathmandu",
        expectedDeliveryAt: EXPECTED_AT,
        currentLocationLabel: "Kathmandu Central, Kathmandu",
        lastUpdateAt: UPDATED_AT,
      },
    ],
    recentDeliveries: [
      {
        trackingId: "BLA-TEST-090",
        description: "Shoes parcel",
        deliveryCity: "Pokhara",
        deliveryDistrict: "Kaski",
        lastUpdateAt: UPDATED_AT,
      },
    ],
    recentNotifications: [
      {
        id: "note-1",
        title: "Package update",
        body: "Your package is on its way.",
        createdAt: UPDATED_AT,
      },
    ],
    ...overrides,
  };
}

describe("CustomerHomeView — expected delivery honesty", () => {
  it("renders the expected-delivery element when expectedDeliveryAt is set", () => {
    render(<CustomerHomeView data={fixtureData()} />);
    expect(screen.getByText(`Expected delivery ${formatDateTime(EXPECTED_AT)}`)).toBeTruthy();
  });

  it("omits the expected-delivery element entirely when it is null", () => {
    const data = fixtureData({
      currentShipments: [
        {
          trackingId: "BLA-TEST-101",
          description: "Documents envelope",
          operationalStatus: "OUT_FOR_DELIVERY",
          deliveryCity: "Lalitpur",
          deliveryDistrict: "Lalitpur",
          expectedDeliveryAt: null,
          currentLocationLabel: null,
          lastUpdateAt: UPDATED_AT,
        },
      ],
    });
    const { container } = render(<CustomerHomeView data={data} />);
    expect(container.textContent).not.toContain("Expected delivery");
    expect(container.textContent).not.toMatch(/expected soon/i);
    // The rest of the card still renders.
    expect(screen.getByText("BLA-TEST-101")).toBeTruthy();
    expect(screen.getByText(`Last updated ${formatDateTime(UPDATED_AT)}`)).toBeTruthy();
  });
});

describe("CustomerHomeView — single badge, nothing extra leaks", () => {
  it("serialised output has no multi-domain badge stack and no precise-location or handler strings", () => {
    const { container } = render(<CustomerHomeView data={fixtureData()} />);
    const serialised = `${container.innerHTML}\n${container.textContent ?? ""}`;
    // The old five-domain stack's domain labels must not appear.
    expect(serialised).not.toContain("Condition");
    expect(serialised).not.toContain("Payment");
    expect(serialised).not.toContain("Exception");
    // Nothing more precise than the model's text labels.
    expect(serialised).not.toMatch(/latitude|longitude|coordinate/i);
    expect(serialised).not.toMatch(/driver/i);
    // The one badge that does render is the operational status,
    // and the warehouse label renders as text. (Scoped to the
    // current-shipments section: "In transit" is also a StatCard
    // label on this page.)
    const current = screen.getByText("Current shipments").closest("section");
    expect(within(current as HTMLElement).getByText("In transit")).toBeTruthy();
    expect(screen.getByText("At Kathmandu Central, Kathmandu")).toBeTruthy();
    // Recent deliveries are labelled by last update, never as a
    // proven delivery instant.
    expect(screen.getByText(`Last update ${formatDateTime(UPDATED_AT)}`)).toBeTruthy();
  });

  it("omits the Recent activity section entirely when notifications are null", () => {
    render(<CustomerHomeView data={fixtureData({ recentNotifications: null })} />);
    expect(screen.queryByText("Recent activity")).toBeNull();
  });
});

describe("CustomerHomeView — first-run empty state", () => {
  it("renders the empty state and quick actions, not stat cards, when total is zero", () => {
    const data = fixtureData({
      metrics: { total: 0, inTransit: 0, outForDelivery: 0, delivered: 0, returned: 0 },
      currentShipments: [],
      recentDeliveries: [],
      recentNotifications: null,
    });
    render(<CustomerHomeView data={data} />);
    expect(screen.getByText("No packages yet")).toBeTruthy();
    expect(screen.queryByText("Total shipments")).toBeNull();
    expect(screen.queryByText("Support cases")).toBeNull();
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.queryByText("Current shipments")).toBeNull();
    // The empty state's action and the quick actions still render.
    const trackLinks = screen.getAllByRole("link", { name: "Track a package" });
    expect(trackLinks.length).toBeGreaterThan(0);
    expect(trackLinks[0].getAttribute("href")).toBe("/track");
    expect(screen.getByRole("link", { name: "My profile" }).getAttribute("href")).toBe(
      "/customer/profile",
    );
  });
});

describe("CustomerHomeView — needs attention", () => {
  it("renders an attempted shipment with its tracking link and raise-a-ticket link", () => {
    const data = fixtureData({
      attention: {
        deliveryAttempted: 1,
        openTickets: 0,
        unpaidInvoices: 0,
        unpaidTotalPaisa: "0",
      },
      attemptedShipments: [
        {
          id: "pkg-attempted",
          trackingId: "BLA-TEST-200",
          description: "Fragile parcel",
          operationalStatus: "DELIVERY_ATTEMPTED",
          deliveryStatus: "ATTEMPTED",
          deliveryCity: "Bhaktapur",
          deliveryDistrict: "Bhaktapur",
          createdAt: UPDATED_AT,
        },
      ],
    });
    render(<CustomerHomeView data={data} />);
    const attention = screen.getByText("Needs attention").closest("section");
    expect(attention).not.toBeNull();
    const scope = within(attention as HTMLElement);
    expect(scope.getByText(/did not complete/)).toBeTruthy();
    expect(scope.getByRole("link", { name: "BLA-TEST-200" }).getAttribute("href")).toBe(
      "/track/BLA-TEST-200",
    );
    expect(
      scope.getByRole("link", { name: /raise a support ticket/i }).getAttribute("href"),
    ).toBe("/customer/tickets");
  });
});
