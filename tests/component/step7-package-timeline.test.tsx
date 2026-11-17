// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { cleanup, render, screen } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import {
  PackageTimeline,
  publicTrackingToSteps,
  type PackageTimelineStep,
} from "@/components/ui/PackageTimeline";
import { formatDateTime } from "@/components/bookings/ui";

/**
 * V3 Step 7 — PackageTimeline (DS §7.10) and the public-tracking
 * mapping helper. The timeline renders RECORDED events only: the
 * helper never synthesises future steps, a delivered parcel has no
 * "current" step, and a cancelled parcel's last event renders in
 * the Failed tone with no pulse and no aria-current.
 */

afterEach(() => cleanup());

const T1 = "2026-11-15T04:30:00.000Z";
const T2 = "2026-11-16T06:45:00.000Z";
const T3 = "2026-11-17T08:15:00.000Z";

function stepItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll("li"));
}

describe("PackageTimeline — states", () => {
  const steps: PackageTimelineStep[] = [
    { label: "Booked", occurredAt: T1, state: "completed" },
    { label: "In transit", occurredAt: T2, state: "current" },
    { label: "Out for delivery", occurredAt: T3, state: "upcoming" },
  ];

  it("renders an ordered list with one item per step, in order", () => {
    const { container } = render(<PackageTimeline steps={steps} />);
    const list = screen.getByRole("list", { name: "Package progress" });
    expect(list.tagName).toBe("OL");
    const items = stepItems(container);
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("Booked");
    expect(items[1].textContent).toContain("In transit");
    expect(items[2].textContent).toContain("Out for delivery");
    expect(items.map((li) => li.getAttribute("data-state"))).toEqual([
      "completed",
      "current",
      "upcoming",
    ]);
  });

  it("marks only the current step with aria-current and a pulse ring", () => {
    const { container } = render(<PackageTimeline steps={steps} />);
    const items = stepItems(container);
    expect(items[0].getAttribute("aria-current")).toBeNull();
    expect(items[1].getAttribute("aria-current")).toBe("step");
    expect(items[2].getAttribute("aria-current")).toBeNull();
    // Pulse ring exists on the current step only.
    expect(items[0].querySelector("[data-pulse-ring]")).toBeNull();
    const ring = items[1].querySelector("[data-pulse-ring]");
    expect(ring).not.toBeNull();
    expect(ring?.className).toContain("motion-safe:animate-ping");
    expect(items[2].querySelector("[data-pulse-ring]")).toBeNull();
  });

  it("uses the Success filled marker + check icon for completed, primary for current, neutral outline for upcoming", () => {
    const { container } = render(<PackageTimeline steps={steps} />);
    const items = stepItems(container);
    // Completed: an SVG check icon renders, on a Success-tone marker.
    expect(items[0].querySelector("svg")).not.toBeNull();
    expect(items[0].innerHTML).toContain("bg-success");
    // Current: primary marker.
    expect(items[1].innerHTML).toContain("bg-primary");
    // Upcoming: outline marker (border, no fill tone, no icon).
    expect(items[2].querySelector("svg")).toBeNull();
    expect(items[2].innerHTML).toContain("border-border-control");
    expect(items[2].innerHTML).not.toContain("bg-success");
    expect(items[2].innerHTML).not.toContain("bg-primary");
  });

  it("colours the connector Success below a completed step and border after the current step", () => {
    const { container } = render(<PackageTimeline steps={steps} />);
    const items = stepItems(container);
    const connectorOf = (li: HTMLElement) => li.querySelector("span.absolute");
    expect(connectorOf(items[0])?.className).toContain("bg-success");
    expect(connectorOf(items[1])?.className).toContain("bg-border");
    // The last step has no connector.
    expect(connectorOf(items[2])).toBeNull();
  });

  it("shows timestamps where provided — and never for upcoming steps", () => {
    const { container } = render(<PackageTimeline steps={steps} />);
    const items = stepItems(container);
    const timeOf = (li: HTMLElement) => li.querySelector("time");
    expect(timeOf(items[0])?.getAttribute("dateTime")).toBe(T1);
    expect(timeOf(items[0])?.textContent).toBe(formatDateTime(T1));
    expect(timeOf(items[1])?.getAttribute("dateTime")).toBe(T2);
    expect(timeOf(items[1])?.textContent).toBe(formatDateTime(T2));
    // Upcoming carries an occurredAt in this fixture on purpose:
    // DS §7.10 says future steps show no timestamp.
    expect(timeOf(items[2])).toBeNull();
    expect(items[2].textContent).not.toContain(formatDateTime(T3));
  });

  it("omits the timestamp when a completed/current step has none, and renders nothing for no steps", () => {
    const { container } = render(
      <PackageTimeline steps={[{ label: "Booked", occurredAt: null, state: "completed" }]} />,
    );
    expect(stepItems(container)[0].querySelector("time")).toBeNull();
    cleanup();
    const empty = render(<PackageTimeline steps={[]} />);
    expect(empty.container.querySelector("ol")).toBeNull();
    expect(empty.container.querySelector("li")).toBeNull();
  });

  it("renders the cancelled state with the Failed-tone marker, its timestamp, and no pulse or aria-current", () => {
    const { container } = render(
      <PackageTimeline
        steps={[
          { label: "Booked", occurredAt: T1, state: "completed" },
          { label: "Cancelled", occurredAt: T2, state: "cancelled" },
        ]}
      />,
    );
    const items = stepItems(container);
    expect(items[1].getAttribute("data-state")).toBe("cancelled");
    expect(items[1].getAttribute("aria-current")).toBeNull();
    expect(items[1].querySelector("[data-pulse-ring]")).toBeNull();
    expect(items[1].querySelector("svg")).not.toBeNull();
    expect(items[1].innerHTML).toContain("bg-danger");
    expect(items[1].querySelector("time")?.getAttribute("dateTime")).toBe(T2);
  });

  it("renders the optional caption", () => {
    render(<PackageTimeline steps={steps} caption="Recorded events only" />);
    expect(screen.getByText("Recorded events only")).toBeTruthy();
  });
});

describe("publicTrackingToSteps — mapping the frozen public view", () => {
  const timeline = [
    { status: "BOOKED", label: "Booked", occurredAt: T1 },
    { status: "IN_TRANSIT", label: "In transit", occurredAt: T2 },
    { status: "OUT_FOR_DELIVERY", label: "Out for delivery", occurredAt: T3 },
  ];

  it("in transit: earlier events completed, last event current, nothing projected", () => {
    const steps = publicTrackingToSteps({ status: "IN_TRANSIT", timeline: timeline.slice(0, 2) });
    expect(steps).toEqual([
      { label: "Booked", occurredAt: T1, state: "completed" },
      { label: "In transit", occurredAt: T2, state: "current" },
    ]);
  });

  it("delivered: every event completed and no step is current", () => {
    const steps = publicTrackingToSteps({
      status: "DELIVERED",
      timeline: [...timeline, { status: "DELIVERED", label: "Delivered", occurredAt: T3 }],
    });
    expect(steps).toHaveLength(4);
    expect(steps.every((s) => s.state === "completed")).toBe(true);
    expect(steps.some((s) => s.state === "current")).toBe(false);
    // Rendered: no aria-current, no pulse anywhere.
    const { container } = render(<PackageTimeline steps={steps} />);
    expect(container.querySelector("[aria-current]")).toBeNull();
    expect(container.querySelector("[data-pulse-ring]")).toBeNull();
  });

  it("cancelled: last event is the cancelled terminal step — no current, no pulse", () => {
    const steps = publicTrackingToSteps({
      status: "CANCELLED",
      timeline: [
        { status: "BOOKED", label: "Booked", occurredAt: T1 },
        { status: "CANCELLED", label: "Cancelled", occurredAt: T2 },
      ],
    });
    expect(steps).toEqual([
      { label: "Booked", occurredAt: T1, state: "completed" },
      { label: "Cancelled", occurredAt: T2, state: "cancelled" },
    ]);
    const { container } = render(<PackageTimeline steps={steps} />);
    expect(container.querySelector("[aria-current]")).toBeNull();
    expect(container.querySelector("[data-pulse-ring]")).toBeNull();
  });

  it("empty timeline maps to no steps", () => {
    expect(publicTrackingToSteps({ status: "BOOKED", timeline: [] })).toEqual([]);
  });

  it("a single recorded event on an in-flight parcel is the current step", () => {
    expect(
      publicTrackingToSteps({ status: "BOOKED", timeline: timeline.slice(0, 1) }),
    ).toEqual([{ label: "Booked", occurredAt: T1, state: "current" }]);
  });
});
