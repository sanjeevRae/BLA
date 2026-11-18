// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, render, screen } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Step 6 (V3) — Line-haul driver field home. The page is an async
 * server component: the read model (`getLinehaulFieldHome`) and the
 * raw action views (`getMyActiveTrip` / `getTransfer`, which feed
 * TripActions with their existing props) are mocked, and the flow
 * forms are inert stubs — the wiring under test is the home's own
 * rendering: recorded milestones only, plus the trip's dispatch-set
 * expected arrival shown labelled on the trip card (2026-11-18 spec
 * change — planned times still never render), the current trip
 * leading, and the sections below filling the page when there is no
 * active trip (audit offender #3).
 */

const mocks = vi.hoisted(() => ({
  getLinehaulFieldHome: vi.fn(),
  getMyActiveTrip: vi.fn(),
  getTransfer: vi.fn(),
}));

vi.mock("@/server/services/home-dashboards", () => ({
  getLinehaulFieldHome: mocks.getLinehaulFieldHome,
}));

vi.mock("@/server/services/trips", () => ({
  getMyActiveTrip: mocks.getMyActiveTrip,
}));

vi.mock("@/server/services/transfers", () => ({
  getTransfer: mocks.getTransfer,
}));

vi.mock("@/components/transfers/forms", () => ({
  LoadScanForm: ({ transferId }: { transferId: string }) => (
    <div data-testid="load-scan-form">load-scan:{transferId}</div>
  ),
  TripProgressForms: ({ tripId, status }: { tripId: string; status: string }) => (
    <div data-testid="trip-progress-forms">
      progress:{tripId}:{status}
    </div>
  ),
}));

vi.mock("@/components/operations/forms", () => ({
  DriverTripIncidentForm: ({
    tripId,
    packages,
  }: {
    tripId: string;
    packages: { packageId: string; trackingId: string }[];
  }) => (
    <div data-testid="incident-form">
      incident:{tripId}:{packages.map((p) => p.trackingId).join(",")}
    </div>
  ),
}));

import { LinehaulHomePage } from "@/components/trips/linehaul-home";
import type { ActorContext } from "@/lib/auth/actor";
import type { LinehaulFieldHomeData } from "@/server/services/home-dashboards";
import type { TripView } from "@/server/services/trips";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTransfer.mockResolvedValue(null);
});

const DEPARTED_AT = "2026-11-17T08:30:00.000Z";
const STOP_PASSED_AT = "2026-11-17T10:15:00.000Z";
const EXPECTED_ARRIVAL_AT = "2026-11-17T15:30:00.000Z";

/** Mirror of the Kathmandu formatDateTime helper the card uses for
 *  the expected-arrival value (admin-identity/ui). */
function fmtDateTimeKt(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    timeZone: "Asia/Kathmandu",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Mirror of the component's fmtDate so time assertions track the
 *  host timezone instead of hardcoding one. */
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function actorWith(permissions: string[]): ActorContext {
  return {
    userId: "user-driver-1",
    email: "driver@bla.test",
    fullName: "Hari Bahadur",
    status: "ACTIVE",
    mustChangePassword: false,
    roles: ["LINEHAUL_DRIVER"],
    primaryRole: "LINEHAUL_DRIVER",
    permissions: new Set(permissions),
    warehouseIds: [],
    membershipRoles: [],
    vendorId: null,
    vendorRole: null,
    driverId: "driver-1",
    customerId: null,
    landingPath: "/transport-driver",
  } as ActorContext;
}

function activeFixture(
  overrides: Partial<LinehaulFieldHomeData> = {},
): LinehaulFieldHomeData {
  return {
    driverName: "Hari Bahadur",
    profile: {
      homeWarehouseCode: "KTM-01",
      licenseNumber: "LIC-123",
      licenseExpiry: "2027-01-01",
      licenseExpired: false,
      employmentStatus: "ACTIVE",
      availabilityStatus: "ON_TRIP",
    },
    activeTrip: {
      id: "trip-1",
      transferId: "transfer-1",
      tripNumber: "TRP-001",
      transferNumber: "TRF-001",
      status: "IN_TRANSIT",
      originWarehouseCode: "KTM-01",
      destinationWarehouseCode: "PKR-01",
      vehicleRegistration: "BA 1 KHA 1234",
      manifestCode: "MAN-001",
      loadedCount: 3,
      expectedCount: 3,
      departedAt: DEPARTED_AT,
      arrivedAt: null,
      expectedArrivalAt: EXPECTED_ARRIVAL_AT,
      loadByStatus: [{ status: "LOADED", count: 3 }],
      packages: [
        {
          packageId: "pkg-1",
          trackingId: "BLA-1001",
          itemStatus: "LOADED",
          packageStatus: "IN_TRANSIT",
        },
      ],
      stops: [
        {
          id: "stop-1",
          sequence: 1,
          label: "Mugling",
          passedAt: STOP_PASSED_AT,
          recordedByName: "Hari Bahadur",
          notes: null,
        },
      ],
    },
    destination: {
      name: "Pokhara Hub",
      code: "PKR-01",
      city: "Pokhara",
      district: "Kaski",
      addressLine1: "Lakeside Road",
      addressLine2: null,
      contactPhone: "+977-61-123456",
    },
    tasks: [
      {
        id: "task-1",
        title: "Submit fuel receipts",
        status: "ASSIGNED",
        priority: "HIGH",
        dueAt: "2026-11-18T10:00:00.000Z",
        overdue: false,
      },
    ],
    openTaskCount: 1,
    recentTrips: [
      {
        id: "trip-0",
        tripNumber: "TRP-000",
        originWarehouseCode: "PKR-01",
        destinationWarehouseCode: "KTM-01",
        status: "COMPLETED",
        packageCount: 5,
        departedAt: "2026-11-15T07:00:00.000Z",
        arrivedAt: "2026-11-15T13:00:00.000Z",
      },
    ],
    recentActivity: [{ at: DEPARTED_AT, label: "Trip departed" }],
    ...overrides,
  };
}

function rawTripFixture(): TripView {
  return {
    id: "trip-1",
    tripNumber: "TRP-001",
    status: "IN_TRANSIT",
    transferId: "transfer-1",
    transferNumber: "TRF-001",
    originWarehouseId: "wh-ktm",
    originWarehouseCode: "KTM-01",
    destinationWarehouseId: "wh-pkr",
    destinationWarehouseCode: "PKR-01",
    driverId: "driver-1",
    driverName: "Hari Bahadur",
    driverUserId: "user-driver-1",
    vehicleId: "veh-1",
    vehicleRegistration: "BA 1 KHA 1234",
    plannedDepartureAt: null,
    actualDepartureAt: DEPARTED_AT,
    expectedArrivalAt: null,
    actualArrivalAt: null,
    packageCount: 3,
    packages: [
      {
        packageId: "pkg-1",
        trackingId: "BLA-1001",
        packageStatus: "IN_TRANSIT",
        itemStatus: "LOADED",
      },
    ],
    stops: [],
    createdAt: "2026-11-17T06:00:00.000Z",
  };
}

async function renderHome(data: LinehaulFieldHomeData, actor: ActorContext) {
  mocks.getLinehaulFieldHome.mockResolvedValue(data);
  const jsx = await LinehaulHomePage({ actor });
  return render(jsx);
}

describe("LinehaulHomePage — active trip", () => {
  it("leads with the route, trip numbers, load count and recorded milestones", async () => {
    mocks.getMyActiveTrip.mockResolvedValue(rawTripFixture());
    const { container } = await renderHome(
      activeFixture(),
      actorWith(["incident.report"]),
    );

    expect(screen.getByText("Welcome, Hari Bahadur")).toBeTruthy();
    expect(container.textContent).toContain("KTM-01 → PKR-01");
    expect(container.textContent).toContain("TRP-001");
    expect(container.textContent).toContain("TRF-001");
    expect(container.textContent).toContain("MAN-001");
    // Packages loaded: "{loadedCount} / {expectedCount}".
    expect(container.textContent).toContain("3 / 3");
    // Milestones: loaded line, departed with the recorded time, the
    // passed checkpoint, and an honest not-arrived state.
    const milestones = screen.getByTestId("trip-milestones");
    expect(milestones.textContent).toContain("Loaded 3 of 3 packages");
    expect(milestones.textContent).toContain("Departed");
    expect(milestones.textContent).toContain(fmtDate(DEPARTED_AT));
    expect(milestones.textContent).toContain("Checkpoint · Mugling");
    expect(milestones.textContent).toContain(fmtDate(STOP_PASSED_AT));
    expect(milestones.textContent).toContain("Arrived at PKR-01");
    expect(milestones.textContent).toContain("Not arrived yet");
    // Load summary + package rows.
    expect(container.textContent).toContain("3 package(s)");
    expect(container.textContent).toContain("BLA-1001");
    // Destination warehouse card with a ≥48px tel: link.
    expect(screen.getByText("Pokhara Hub")).toBeTruthy();
    const call = screen.getByRole("link", { name: /Call \+977-61-123456/ });
    expect(call.getAttribute("href")).toBe("tel:+977-61-123456");
    expect(call.className).toContain("min-h-[48px]");
    // TripActions wiring preserved: the raw IN_TRANSIT trip renders
    // the trip-progress forms stub; the incident form is gated on
    // incident.report and fed the model's packages.
    expect(screen.getByTestId("trip-progress-forms").textContent).toContain(
      "progress:trip-1:IN_TRANSIT",
    );
    expect(screen.getByTestId("incident-form").textContent).toContain(
      "incident:trip-1:BLA-1001",
    );
  });

  it("shows the dispatch-set expected arrival on the trip card", async () => {
    mocks.getMyActiveTrip.mockResolvedValue(rawTripFixture());
    const { container } = await renderHome(
      activeFixture(),
      actorWith(["incident.report"]),
    );
    // Labelled row: the label carries the dispatch qualifier and
    // the value is the stored time in Kathmandu formatting.
    expect(container.textContent).toContain("Expected arrival · set by dispatch");
    expect(container.textContent).toContain(fmtDateTimeKt(EXPECTED_ARRIVAL_AT));
    // Planned times still never render.
    expect(container.innerHTML).not.toContain("Planned departure");
    expect(container.innerHTML).not.toContain("plannedDeparture");
  });

  it("renders no expected-arrival row when dispatch set none", async () => {
    mocks.getMyActiveTrip.mockResolvedValue(rawTripFixture());
    const data = activeFixture();
    data.activeTrip = { ...data.activeTrip!, expectedArrivalAt: null };
    const { container } = await renderHome(data, actorWith(["incident.report"]));
    const html = container.innerHTML;
    // Row entirely absent — no placeholder, no "not set" text.
    expect(html).not.toContain("Expected arrival");
    expect(html).not.toContain("expectedArrival");
    expect(container.textContent).not.toContain("Not set");
  });

  it("hides the incident form without incident.report", async () => {
    mocks.getMyActiveTrip.mockResolvedValue(rawTripFixture());
    await renderHome(activeFixture(), actorWith([]));
    expect(screen.queryByTestId("incident-form")).toBeNull();
    expect(screen.getByTestId("trip-progress-forms")).toBeTruthy();
  });
});

describe("LinehaulHomePage — no active trip", () => {
  it("shows the honest empty state and still fills the page", async () => {
    mocks.getMyActiveTrip.mockResolvedValue(null);
    const data = activeFixture({
      activeTrip: null,
      destination: null,
      tasks: [],
      openTaskCount: 0,
      recentActivity: [],
    });
    const { container } = await renderHome(data, actorWith(["incident.report"]));

    expect(
      screen.getByText(/You have no active trip right now/),
    ).toBeTruthy();
    // No void: recent trips and the driver profile still render.
    expect(container.textContent).toContain("TRP-000");
    expect(container.textContent).not.toContain("No completed trips yet.");
    expect(container.textContent).toContain("LIC-123");
    expect(container.textContent).toContain("KTM-01");
    // No destination card and no actions without a trip.
    expect(screen.queryByText("Destination warehouse")).toBeNull();
    expect(screen.queryByTestId("trip-progress-forms")).toBeNull();
    expect(screen.queryByTestId("incident-form")).toBeNull();
  });
});

describe("LinehaulHomePage — tasks section gating", () => {
  it("renders My tasks with rows into the task detail when open tasks exist", async () => {
    mocks.getMyActiveTrip.mockResolvedValue(rawTripFixture());
    await renderHome(activeFixture(), actorWith(["incident.report"]));
    expect(screen.getByText("My tasks")).toBeTruthy();
    const row = screen.getByRole("link", { name: /Submit fuel receipts/ });
    expect(row.getAttribute("href")).toBe("/transport-driver/tasks/task-1");
    expect(row.className).toContain("min-h-[48px]");
    const all = screen.getByRole("link", { name: /All my tasks/ });
    expect(all.getAttribute("href")).toBe("/transport-driver/tasks");
  });

  it("omits the tasks section entirely when openTaskCount is 0", async () => {
    mocks.getMyActiveTrip.mockResolvedValue(rawTripFixture());
    await renderHome(
      activeFixture({ tasks: [], openTaskCount: 0 }),
      actorWith(["incident.report"]),
    );
    expect(screen.queryByText("My tasks")).toBeNull();
    expect(screen.queryByRole("link", { name: /All my tasks/ })).toBeNull();
  });
});
