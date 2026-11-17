// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { cleanup, render, screen } from "@testing-library/react";

afterEach(() => cleanup());

import { SupportHomeView, formatAge } from "@/components/support-home/SupportHomeView";
import type { SupportConsoleData } from "@/server/services/support-home";

/**
 * V3 Step 8 — SupportHomeView contracts:
 *  - MONEY BOUNDARY on the rendered page: no NPR / Rs. amounts /
 *    paisa wording anywhere in the visible text;
 *  - unassigned queue rows carry the warning highlight + marker;
 *  - PriorityBadge renders for HIGH and URGENT;
 *  - age labels are real arithmetic and appear in the table;
 *  - no raw enum strings and no "SLA" wording as visible text —
 *    the 48h figure is labelled the attention threshold.
 */

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOUR = 60 * 60 * 1000;

const FIXTURE: SupportConsoleData = {
  today: "2026-11-17",
  attention: {
    unassignedTickets: 1,
    breachingTickets: 1,
    unresolvedHighSeverityIncidents: 1,
    overdueDeliveries: 1,
  },
  queues: { open: 2, inProgress: 1, awaitingCustomer: 1, escalated: 0, resolvedToday: 3, totalOpen: 4 },
  openIncidents: 2,
  highPriorityOpen: 2,
  myTicketsOpen: 1,
  oldestOpenTickets: [
    {
      id: "t-old",
      ticketNumber: "TKT-100",
      subject: "Parcel not received",
      status: "OPEN",
      priority: "HIGH",
      assignedToId: null,
      createdAt: iso(3 * 24 * HOUR + 4 * HOUR),
    },
  ],
  overdueDeliveryItems: [
    {
      packageId: "pkg-1",
      trackingId: "BLA-TEST-001",
      deliveryStatus: "NOT_STARTED",
      operationalStatus: "IN_TRANSIT",
      expectedDeliveryAt: iso(2 * 24 * HOUR),
    },
  ],
  queueTickets: [
    {
      id: "t-high",
      ticketNumber: "TKT-101",
      subject: "Damaged parcel arrived",
      raiserName: "Asha Sharma",
      priority: "HIGH",
      status: "AWAITING_CUSTOMER",
      assignedToId: null,
      assigneeName: null,
      createdAt: iso(3 * 24 * HOUR + 4 * HOUR),
    },
    {
      id: "t-urgent",
      ticketNumber: "TKT-102",
      subject: "Delivery address wrong",
      raiserName: null,
      priority: "URGENT",
      status: "IN_PROGRESS",
      assignedToId: "user-1",
      assigneeName: "Bikash Rai",
      createdAt: iso(5 * HOUR),
    },
  ],
  recentTickets: [],
  recentIncidents: [
    {
      id: "inc-1",
      incidentNumber: "INC-200",
      category: "CUSTOMER_COMPLAINT",
      severity: "HIGH",
      status: "INVESTIGATING",
      updatedAt: iso(2 * HOUR),
    },
  ],
  myTasks: [
    {
      id: "task-1",
      title: "Call the recipient back",
      status: "ASSIGNED",
      priority: "HIGH",
      dueAt: iso(26 * HOUR),
      warehouseId: null,
      overdue: true,
    },
  ],
  tasksDue: 1,
  tasksOverdue: 1,
  can: { viewTickets: true, incidents: true, tasks: true },
};

describe("formatAge — real arithmetic", () => {
  const now = new Date(NOW);
  it("formats days+hours, hours and minutes", () => {
    expect(formatAge(iso(3 * 24 * HOUR + 4 * HOUR), now)).toBe("3d 4h");
    expect(formatAge(iso(5 * HOUR), now)).toBe("5h");
    expect(formatAge(iso(12 * 60 * 1000), now)).toBe("12m");
    expect(formatAge(iso(0), now)).toBe("0m");
  });
});

describe("SupportHomeView (Step 8)", () => {
  it("renders no money patterns in the visible text", () => {
    const { container } = render(<SupportHomeView data={FIXTURE} />);
    expect(container.textContent ?? "").not.toMatch(/NPR|Rs\.?\s?\d|paisa/i);
  });

  it("marks unassigned rows with the highlight and the Unassigned marker", () => {
    const { container } = render(<SupportHomeView data={FIXTURE} />);
    const row = screen.getByText("TKT-101").closest("tr");
    expect(row).not.toBeNull();
    expect(row!.getAttribute("data-unassigned")).toBe("true");
    expect(row!.className).toContain("bg-warningbg");
    expect(row!.textContent).toContain("Unassigned");
    const assignedRow = screen.getByText("TKT-102").closest("tr");
    expect(assignedRow!.getAttribute("data-unassigned")).toBeNull();
    expect(assignedRow!.textContent).toContain("Bikash Rai");
    expect(container.textContent).toContain("Unassigned");
  });

  it("renders PriorityBadge for HIGH and URGENT and real age labels", () => {
    const { container } = render(<SupportHomeView data={FIXTURE} />);
    const text = container.textContent ?? "";
    expect(text).toContain("High");
    expect(text).toContain("Urgent");
    expect(text).toContain("3d 4h");
    expect(text).toContain("5h");
  });

  it("shows friendly labels only — no raw enums, no SLA wording", () => {
    const { container } = render(<SupportHomeView data={FIXTURE} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("AWAITING_CUSTOMER");
    expect(text).not.toContain("IN_PROGRESS");
    expect(text).not.toContain("CUSTOMER_COMPLAINT");
    expect(text).not.toContain("NOT_STARTED");
    expect(text).toContain("Awaiting customer");
    expect(text).toContain("In progress");
    expect(text).toContain("Customer complaint");
    expect(text).not.toMatch(/SLA/);
    // The 48h figure is the attention threshold, worded exactly so.
    expect(text).toContain("open longer than 48h — work the oldest first");
    expect(text).toContain("attention threshold");
  });

  it("renders the overdue marker, incident links and bare hrefs only", () => {
    const { container } = render(<SupportHomeView data={FIXTURE} />);
    expect(container.textContent).toContain("Overdue");
    const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.length).toBeGreaterThan(5);
    for (const href of hrefs) {
      expect(href).not.toContain("?");
    }
    expect(hrefs).toContain("/support/tickets/t-high");
    expect(hrefs).toContain("/support/incidents/inc-1");
    expect(hrefs).toContain("/support/tasks/task-1");
    expect(hrefs).toContain("/track/BLA-TEST-001");
    expect(hrefs).toContain("/track");
  });

  it("renders the honest empty state when nothing needs attention", () => {
    const quiet: SupportConsoleData = {
      ...FIXTURE,
      attention: {
        unassignedTickets: 0,
        breachingTickets: 0,
        unresolvedHighSeverityIncidents: 0,
        overdueDeliveries: 0,
      },
      oldestOpenTickets: [],
      overdueDeliveryItems: [],
      queueTickets: [],
      recentIncidents: [],
      myTasks: [],
    };
    const { container } = render(<SupportHomeView data={quiet} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Nothing needs your attention right now");
    expect(text).toContain("No open tickets");
    expect(text).toContain("No open tasks");
  });
});
