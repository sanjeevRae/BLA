// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { cleanup, render, screen, within } from "@testing-library/react";

import {
  StaffWorkConsoleView,
  staffHomeActions,
} from "@/components/staff-home/StaffWorkConsoleView";
import type { StaffWorkConsoleData } from "@/server/services/home-dashboards";

/**
 * Step 5 (V3) — Staff work console view: the task queue renders in
 * the order the read model carries (the task service's order — the
 * view must NOT re-sort), overdue work is flagged, the floor actions
 * are ≥48px links into the real staff flows, queue cards are labelled
 * as current queues (never "today"), and no currency renders.
 */

afterEach(() => {
  cleanup();
});

const ALL_ACTIONS = staffHomeActions({
  canReceive: true,
  canInspect: true,
  canReportIssue: true,
});

function fixtureData(overrides: Partial<StaffWorkConsoleData> = {}): StaffWorkConsoleData {
  return {
    hasWarehouse: true,
    warehouses: [{ id: "wh-ktm", code: "KTM-TEST", name: "Kathmandu Central" }],
    // Deliberately NOT in due-date order (the later-due task first):
    // the view renders the model's order verbatim, so this fixture
    // order is what must appear on screen.
    myTasks: [
      {
        id: "task-later",
        title: "Later task — due tomorrow",
        status: "ASSIGNED",
        priority: "NORMAL",
        dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        overdue: false,
      },
      {
        id: "task-overdue",
        title: "Overdue task — sort the cage",
        status: "IN_PROGRESS",
        priority: "HIGH",
        dueAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        overdue: true,
      },
    ],
    myTasksTotal: 7,
    myOverdueTasks: 1,
    perWarehouse: [
      {
        warehouseId: "wh-ktm",
        warehouseCode: "KTM-TEST",
        warehouseName: "Kathmandu Central",
        awaitingInspection: 2,
        inInspection: 1,
        dispatchPrep: 3,
        arrivalsInbound: 1,
        openPackages: 6,
        damagedPackages: 1,
        pendingHandovers: 0,
      },
    ],
    totals: {
      awaitingInspection: 2,
      inInspection: 1,
      dispatchPrep: 3,
      arrivalsInbound: 1,
      openPackages: 6,
      damagedPackages: 1,
      pendingHandovers: 0,
    },
    receivedToday: 4,
    recentActivity: [
      {
        id: "wh-ktm:m1",
        type: "RECEIVING",
        trackingId: "BLA-TEST-1",
        actorName: "S5 staff-ktm",
        warehouseCode: "KTM-TEST",
        createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      },
    ],
    ...overrides,
  };
}

describe("StaffWorkConsoleView — task queue", () => {
  it("renders tasks in the read model's order, first task marked Next up", () => {
    render(
      <StaffWorkConsoleView data={fixtureData()} actorName="Test Staff" actions={ALL_ACTIONS} />,
    );
    const queue = screen.getByTestId("staff-task-queue");
    const rows = within(queue).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Later task — due tomorrow");
    expect(rows[0].textContent).toContain("Next up");
    expect(rows[1].textContent).toContain("Overdue task — sort the cage");
    // Each task links to its detail page.
    expect(
      within(queue).getByRole("link", { name: /Later task/ }).getAttribute("href"),
    ).toBe("/staff/tasks/task-later");
    expect(
      within(queue).getByRole("link", { name: /Overdue task/ }).getAttribute("href"),
    ).toBe("/staff/tasks/task-overdue");
  });

  it("flags overdue work in the banner and on the row", () => {
    render(
      <StaffWorkConsoleView data={fixtureData()} actorName="Test Staff" actions={ALL_ACTIONS} />,
    );
    expect(screen.getByText(/1 of your task\(s\) are overdue/)).toBeTruthy();
    const queue = screen.getByTestId("staff-task-queue");
    const rows = within(queue).getAllByRole("listitem");
    expect(rows[1].textContent).toContain("Overdue");
    expect(rows[0].textContent).not.toContain("Overdue");
  });

  it("links View all to the task board when the list is truncated at 5", () => {
    render(
      <StaffWorkConsoleView data={fixtureData()} actorName="Test Staff" actions={ALL_ACTIONS} />,
    );
    const viewAll = screen.getByRole("link", { name: /View all 7 tasks/ });
    expect(viewAll.getAttribute("href")).toBe("/staff/tasks");
    expect(screen.getByText("My tasks (7)")).toBeTruthy();
  });
});

describe("StaffWorkConsoleView — floor actions", () => {
  it("renders Receive / Scan / Inspect / Report as ≥48px links into real flows", () => {
    render(
      <StaffWorkConsoleView data={fixtureData()} actorName="Test Staff" actions={ALL_ACTIONS} />,
    );
    const strip = screen.getByTestId("staff-home-actions");
    const receive = within(strip).getByRole("link", { name: /Receive Package/ });
    const scan = within(strip).getByRole("link", { name: /Scan Package/ });
    const inspect = within(strip).getByRole("link", { name: /Inspect Package/ });
    const report = within(strip).getByRole("link", { name: /Report an Issue/ });
    // Receiving, scanning and inspection all live in the Operations
    // flow (no standalone scan page exists) — the labels say so.
    expect(receive.getAttribute("href")).toBe("/staff/operations");
    expect(scan.getAttribute("href")).toBe("/staff/operations");
    expect(inspect.getAttribute("href")).toBe("/staff/operations");
    expect(report.getAttribute("href")).toBe("/staff/incidents");
    for (const link of [receive, scan, inspect, report]) {
      expect(link.className).toContain("min-h-[48px]");
    }
    expect(scan.textContent).toContain("Same receiving flow");
  });

  it("hides actions the actor's permissions do not grant", () => {
    render(
      <StaffWorkConsoleView
        data={fixtureData()}
        actorName="Test Staff"
        actions={staffHomeActions({
          canReceive: false,
          canInspect: true,
          canReportIssue: false,
        })}
      />,
    );
    expect(screen.queryByRole("link", { name: /Receive Package/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Report an Issue/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Inspect Package/ })).toBeTruthy();
  });
});

describe("StaffWorkConsoleView — summary honesty and no finance", () => {
  it("labels queue cards as current queues and only Received as today", () => {
    const { container } = render(
      <StaffWorkConsoleView data={fixtureData()} actorName="Test Staff" actions={ALL_ACTIONS} />,
    );
    expect(screen.getByText("Received Today")).toBeTruthy();
    expect(screen.getByText("Awaiting Inspection")).toBeTruthy();
    expect(screen.getByText(/Current queue — received, not yet inspected/)).toBeTruthy();
    expect(screen.getByText("Dispatch Prep")).toBeTruthy();
    expect(screen.getByText("Arrivals to Receive")).toBeTruthy();
    // Nothing else may claim to be a "today" figure.
    expect(container.textContent?.match(/today/gi)).toHaveLength(2); // card label + its context line
    expect(screen.queryByText(/Inspected Today|Packed Today|Transferred Today/)).toBeNull();
  });

  it("renders no currency or finance vocabulary anywhere", () => {
    const { container } = render(
      <StaffWorkConsoleView data={fixtureData()} actorName="Test Staff" actions={ALL_ACTIONS} />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/NPR|paisa|COD|Rs\.|revenue|payable/i);
    expect(text).not.toContain("₨");
  });

  it("omits the Received Today card when the read model has no today figure", () => {
    render(
      <StaffWorkConsoleView
        data={fixtureData({ receivedToday: null })}
        actorName="Test Staff"
        actions={ALL_ACTIONS}
      />,
    );
    expect(screen.queryByText("Received Today")).toBeNull();
    expect(screen.getByText("Awaiting Inspection")).toBeTruthy();
  });
});

describe("StaffWorkConsoleView — per-warehouse queues and activity", () => {
  it("shows the member warehouse's queue breakdown with queue links", () => {
    render(
      <StaffWorkConsoleView data={fixtureData()} actorName="Test Staff" actions={ALL_ACTIONS} />,
    );
    expect(screen.getByText("Kathmandu Central")).toBeTruthy();
    expect(screen.getByText("KTM-TEST")).toBeTruthy();
    const arrivals = screen.getByRole("link", { name: /Arrivals to process/ });
    expect(arrivals.getAttribute("href")).toBe("/staff/arrivals");
    expect(arrivals.className).toContain("min-h-[48px]");
    const inventory = screen.getByRole("link", { name: /Inventory/ });
    expect(inventory.getAttribute("href")).toBe("/staff/inventory");
    expect(screen.getByText("Transfer arrivals to process")).toBeTruthy();
    expect(screen.getByText("Delivery batches to prepare")).toBeTruthy();
    const deliveries = screen.getByRole("link", { name: /Open deliveries/ });
    expect(deliveries.getAttribute("href")).toBe("/staff/deliveries");
  });

  it("renders the warehouse-scoped movement feed", () => {
    render(
      <StaffWorkConsoleView data={fixtureData()} actorName="Test Staff" actions={ALL_ACTIONS} />,
    );
    const feed = screen.getByTestId("staff-recent-activity");
    expect(feed.textContent).toContain("BLA-TEST-1");
    expect(feed.textContent).toContain("Receiving");
    expect(feed.textContent).toContain("KTM-TEST");
  });
});

describe("StaffWorkConsoleView — no-warehouse state", () => {
  it("keeps tasks visible and explains the missing queues", () => {
    render(
      <StaffWorkConsoleView
        data={fixtureData({
          hasWarehouse: false,
          warehouses: [],
          perWarehouse: [],
          totals: {
            awaitingInspection: 0,
            inInspection: 0,
            dispatchPrep: 0,
            arrivalsInbound: 0,
            openPackages: 0,
            damagedPackages: 0,
            pendingHandovers: 0,
          },
          receivedToday: null,
          recentActivity: [],
        })}
        actorName="Test Staff"
        actions={ALL_ACTIONS}
      />,
    );
    expect(screen.getByText("No warehouse assigned")).toBeTruthy();
    expect(screen.getByText(/Later task — due tomorrow/)).toBeTruthy();
    expect(screen.queryByText("Awaiting Inspection")).toBeNull();
    expect(screen.queryByText("Packages requiring action — by warehouse")).toBeNull();
  });
});
