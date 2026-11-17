// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, render, screen } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Step 6 (V3) — Rider field home job cards. The async server
 * component is rendered with the read model mocked
 * (`getRiderFieldHome`): the wiring under test is the field
 * rendering — COD due shown only when money is actually due, the
 * call action dialling the recipient's number, jobs in model order,
 * and the "Next stop" tag (plus the incident form) on the next job
 * only.
 */

const mocks = vi.hoisted(() => ({
  getRiderFieldHome: vi.fn(),
}));

vi.mock("@/server/services/home-dashboards", () => ({
  getRiderFieldHome: mocks.getRiderFieldHome,
}));

vi.mock("@/components/operations/forms", () => ({
  DriverAssignmentIncidentForm: ({
    assignmentId,
    packageId,
  }: {
    assignmentId: string;
    packageId: string;
  }) => (
    <div data-testid="incident-form">
      incident:{assignmentId}:{packageId}
    </div>
  ),
}));

import { RiderFieldHome } from "@/components/deliveries/rider-field-home";
import type { ActorContext } from "@/lib/auth/actor";
import type { RiderFieldHomeData } from "@/server/services/home-dashboards";

afterEach(() => cleanup());

const actor = {
  userId: "rider-user-1",
  email: "rider@bla.test",
  fullName: "Fixture Rider",
  status: "ACTIVE",
  mustChangePassword: false,
  roles: ["RIDER"],
  primaryRole: "RIDER",
  permissions: new Set(["incident.report"]),
  warehouseIds: [],
  membershipRoles: [],
  vendorId: null,
  vendorRole: null,
  driverId: "driver-1",
  customerId: null,
  landingPath: "/rider",
} as unknown as ActorContext;

function job(overrides: Partial<RiderFieldHomeData["batches"][number]["jobs"][number]>) {
  return {
    assignmentId: "asg-x",
    batchId: "batch-1",
    packageId: "pkg-x",
    trackingId: "BLA-S6-X",
    status: "IN_PROGRESS",
    packageStatus: "OUT_FOR_DELIVERY",
    recipientName: "Recipient X",
    recipientPhone: "9779800000000",
    recipientAltPhone: null,
    address: "1 Fixture Street",
    landmark: null,
    city: "Kathmandu",
    district: "Kathmandu",
    codDuePaisa: "0",
    codCollectedPaisa: null,
    codStatus: null,
    deliveryInstructions: null,
    failedAttempts: 0,
    isNext: false,
    ...overrides,
  };
}

function fixtureModel(): RiderFieldHomeData {
  return {
    date: "2026-11-17",
    riderName: "Fixture Rider",
    summary: { assigned: 3, delivered: 1, remaining: 2, failed: 0 },
    failedAttempts: [],
    batches: [
      {
        id: "batch-1",
        warehouseCode: "KTM-S6",
        status: "IN_PROGRESS",
        kind: "DELIVERY",
        batchDate: "2026-11-17",
        counts: {
          total: 3,
          pending: 1,
          inProgress: 1,
          completed: 1,
          failed: 0,
          cancelled: 0,
          reassigned: 0,
        },
        jobs: [
          job({
            assignmentId: "asg-next",
            packageId: "pkg-next",
            trackingId: "BLA-S6-NEXT",
            recipientName: "Next Recipient",
            recipientPhone: "977 9800 000001",
            codDuePaisa: "150000",
            isNext: true,
          }),
          job({
            assignmentId: "asg-free",
            packageId: "pkg-free",
            trackingId: "BLA-S6-FREE",
            recipientName: "Free Recipient",
            recipientPhone: "9779800000002",
            status: "PENDING",
            codDuePaisa: "0",
          }),
          job({
            assignmentId: "asg-done",
            packageId: "pkg-done",
            trackingId: "BLA-S6-DONE",
            recipientName: "Done Recipient",
            recipientPhone: "9779800000003",
            status: "COMPLETED",
            packageStatus: "DELIVERED",
            codDuePaisa: "50000",
            codCollectedPaisa: "50000",
            codStatus: "MATCHED",
          }),
        ],
      },
    ],
    currentBatchId: "batch-1",
    cod: {
      expectedPaisa: "200000",
      collectedPaisa: "50000",
      remainingPaisa: "150000",
      awaitingRemittancePaisa: "50000",
      verifiedRemittedPaisa: "0",
    },
    custody: [],
    tasks: [],
    openTaskCount: 0,
  };
}

beforeEach(() => {
  mocks.getRiderFieldHome.mockReset();
  mocks.getRiderFieldHome.mockResolvedValue(fixtureModel());
});

async function renderHome() {
  const jsx = await RiderFieldHome({ actor });
  return render(jsx);
}

describe("RiderFieldHome — job cards", () => {
  it("renders jobs in the model's order", async () => {
    await renderHome();
    const cards = screen.getAllByTestId("rider-job-card");
    expect(cards).toHaveLength(3);
    expect(cards[0].textContent).toContain("BLA-S6-NEXT");
    expect(cards[1].textContent).toContain("BLA-S6-FREE");
    expect(cards[2].textContent).toContain("BLA-S6-DONE");
  });

  it("shows the COD due amount on a due job and collected on a delivered job", async () => {
    await renderHome();
    const cards = screen.getAllByTestId("rider-job-card");
    expect(cards[0].textContent).toContain("COD due");
    expect(cards[0].textContent).toContain("NPR 1,500.00");
    expect(cards[2].textContent).toContain("Collected NPR 500.00");
  });

  it("shows no COD figures on a zero-COD job", async () => {
    await renderHome();
    const cards = screen.getAllByTestId("rider-job-card");
    expect(cards[1].textContent).not.toContain("COD due");
    expect(cards[1].textContent).not.toContain("Collected");
    expect(cards[1].textContent).not.toContain("NPR");
  });

  it("dials the recipient: tel: href with spaces stripped", async () => {
    await renderHome();
    const call = screen.getByRole("link", { name: /Call 977 9800 000001/ });
    expect(call.getAttribute("href")).toBe("tel:9779800000001");
    expect(call.className).toContain("min-h-[48px]");
  });

  it("tags only the next job and embeds the incident form under it", async () => {
    await renderHome();
    expect(screen.getAllByText("Next stop")).toHaveLength(1);
    const cards = screen.getAllByTestId("rider-job-card");
    expect(cards[0].textContent).toContain("Next stop");
    expect(cards[1].textContent).not.toContain("Next stop");
    const form = screen.getByTestId("incident-form");
    expect(form.textContent).toContain("incident:asg-next:pkg-next");
    expect(cards[0].contains(form)).toBe(true);
  });

  it("links onward to the batch, COD and reports surfaces", async () => {
    await renderHome();
    expect(
      screen.getByRole("link", { name: "Continue delivery" }).getAttribute("href"),
    ).toBe("/rider/batches/batch-1");
    expect(screen.getByRole("link", { name: "View COD →" }).getAttribute("href")).toBe(
      "/rider/cod",
    );
    expect(
      screen.getByRole("link", { name: /Delivery history/ }).getAttribute("href"),
    ).toBe("/rider/reports");
  });
});
