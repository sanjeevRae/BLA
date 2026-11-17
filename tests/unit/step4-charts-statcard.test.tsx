// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { cleanup, render, screen, within } from "@testing-library/react";

afterEach(() => cleanup());

import { NavIcon } from "@/components/layout/icons";
import { StatCard } from "@/components/ui/StatCard";
import { TrendIndicator } from "@/components/ui/TrendIndicator";
import { BarChart, DistributionBar, LineChart } from "@/components/ui/charts";

/**
 * V3 Step 4 (DS §7.5 / §7.12) — StatCard, TrendIndicator, and the
 * hand-rolled SVG chart primitives: anatomy, tint tokens, link-only-
 * with-href, honest trend colouring, and the all-zero empty state.
 */

describe("StatCard (DS §7.5)", () => {
  it("renders label, value and context", () => {
    render(
      <StatCard
        label="Bookings today"
        value="42"
        context="Today"
        tint="brand"
        icon={<NavIcon name="package" />}
      />,
    );
    expect(screen.getByText("Bookings today")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("Today")).toBeTruthy();
  });

  it("is a plain div without href and a link only with href", () => {
    const { container, unmount } = render(
      <StatCard
        label="Delivered"
        value="7"
        tint="success"
        icon={<NavIcon name="package" />}
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    unmount();

    render(
      <StatCard
        label="Delivered"
        value="7"
        tint="success"
        href="/admin/bookings?status=DELIVERED"
        icon={<NavIcon name="package" />}
      />,
    );
    const link = screen.getByRole("link", { name: /delivered/i });
    expect(link.getAttribute("href")).toBe("/admin/bookings?status=DELIVERED");
    expect(link.className).toContain("hover:border-primary");
  });

  it("applies the tint token classes to the icon container", () => {
    const { unmount } = render(
      <StatCard
        label="Delivered"
        value="7"
        tint="success"
        icon={<NavIcon name="package" />}
      />,
    );
    let iconBox = screen.getByTestId("stat-card-icon");
    expect(iconBox.className).toContain("bg-successbg");
    expect(iconBox.className).toContain("text-success");
    unmount();

    render(
      <StatCard
        label="Bookings"
        value="3"
        tint="brand"
        icon={<NavIcon name="package" />}
      />,
    );
    iconBox = screen.getByTestId("stat-card-icon");
    expect(iconBox.className).toContain("bg-primary-light");
    expect(iconBox.className).toContain("text-primary-dark");
  });

  it("renders the trend slot under the context line", () => {
    render(
      <StatCard
        label="Bookings today"
        value="42"
        context="Today"
        tint="brand"
        icon={<NavIcon name="package" />}
        trend={<TrendIndicator delta={3} goodDirection="up" label="vs yesterday" />}
      />,
    );
    expect(screen.getByText(/vs yesterday/)).toBeTruthy();
  });
});

describe("TrendIndicator (DS §7.5)", () => {
  it("colours movement in the good direction success and spells it out", () => {
    const { container } = render(
      <TrendIndicator delta={3} goodDirection="up" label="vs yesterday" />,
    );
    const root = container.querySelector("[aria-label]");
    expect(root?.className).toContain("text-success");
    expect(root?.getAttribute("aria-label")).toMatch(/increased by 3 vs yesterday/i);
    expect(root?.getAttribute("aria-label")).toMatch(/improvement/i);
    expect(root?.textContent).toContain("+3");
  });

  it("colours movement against the good direction danger", () => {
    const { container } = render(
      <TrendIndicator delta={3} goodDirection="down" label="vs yesterday" />,
    );
    const root = container.querySelector("[aria-label]");
    expect(root?.className).toContain("text-danger");
    expect(root?.getAttribute("aria-label")).toMatch(/decline/i);
  });

  it("colours a good downward movement success", () => {
    const { container } = render(
      <TrendIndicator delta={-2} goodDirection="down" label="vs yesterday" />,
    );
    const root = container.querySelector("[aria-label]");
    expect(root?.className).toContain("text-success");
    expect(root?.getAttribute("aria-label")).toMatch(/decreased by 2/i);
  });

  it("renders a zero delta neutrally with no colour claim", () => {
    const { container } = render(
      <TrendIndicator delta={0} goodDirection="up" label="vs yesterday" />,
    );
    const root = container.querySelector("[aria-label]");
    expect(root?.className).toContain("text-ink-2");
    expect(root?.className).not.toContain("text-success");
    expect(root?.className).not.toContain("text-danger");
    expect(root?.textContent).toBe("0 · vs yesterday");
    expect(root?.getAttribute("aria-label")).toMatch(/no change vs yesterday/i);
  });
});

describe("BarChart (DS §7.12)", () => {
  const data = [
    { label: "13 Nov", value: 4 },
    { label: "14 Nov", value: 7 },
    { label: "15 Nov", value: 2 },
  ];

  it("renders one bar per point with direct value labels and tooltips", () => {
    const { container } = render(
      <BarChart data={data} ariaLabel="Bookings per day" valueLabel="bookings" />,
    );
    expect(container.querySelectorAll("rect")).toHaveLength(3);
    const titles = Array.from(container.querySelectorAll("title")).map(
      (title) => title.textContent,
    );
    expect(titles).toContain("13 Nov — 4 bookings");
    const svgTexts = Array.from(container.querySelectorAll("svg text")).map(
      (text) => text.textContent,
    );
    expect(svgTexts).toContain("4");
    expect(svgTexts).toContain("7");
    // The series is repeated in a visually-hidden data table.
    const table = container.querySelector("table.sr-only");
    expect(table).toBeTruthy();
    expect(within(table as HTMLElement).getByText("14 Nov")).toBeTruthy();
  });

  it("renders the honest empty state for all-zero data, with no bars", () => {
    const { container } = render(
      <BarChart
        data={[
          { label: "13 Nov", value: 0 },
          { label: "14 Nov", value: 0 },
        ]}
        ariaLabel="Bookings per day"
      />,
    );
    expect(screen.getByText("No activity in this period")).toBeTruthy();
    expect(container.querySelectorAll("rect")).toHaveLength(0);
  });

  it("renders the honest empty state for empty data", () => {
    const { container } = render(<BarChart data={[]} ariaLabel="Bookings per day" />);
    expect(screen.getByText("No activity in this period")).toBeTruthy();
    expect(container.querySelectorAll("rect")).toHaveLength(0);
  });
});

describe("LineChart (DS §7.12)", () => {
  it("renders a polyline and point markers for real data", () => {
    const { container } = render(
      <LineChart
        data={[
          { label: "13 Nov", value: 4 },
          { label: "14 Nov", value: 7 },
        ]}
        ariaLabel="Bookings trend"
        valueLabel="bookings"
      />,
    );
    expect(container.querySelector("polyline")).toBeTruthy();
    expect(container.querySelectorAll("circle")).toHaveLength(2);
  });

  it("renders the honest empty state for all-zero data", () => {
    const { container } = render(
      <LineChart
        data={[
          { label: "13 Nov", value: 0 },
          { label: "14 Nov", value: 0 },
        ]}
        ariaLabel="Bookings trend"
      />,
    );
    expect(screen.getByText("No activity in this period")).toBeTruthy();
    expect(container.querySelector("polyline")).toBeNull();
  });
});

describe("DistributionBar (DS §7.12)", () => {
  const segments = [
    { label: "Delivered", value: 50, tone: "success" as const },
    { label: "In transit", value: 25, tone: "info" as const },
    { label: "Pending", value: 25, tone: "warning" as const },
    { label: "Failed", value: 0, tone: "danger" as const },
  ];

  it("lists every segment in the legend, including zero-value ones", () => {
    render(<DistributionBar segments={segments} ariaLabel="Delivery status mix" />);
    const legend = within(screen.getByTestId("distribution-legend"));
    expect(legend.getByText("Delivered")).toBeTruthy();
    expect(legend.getByText("In transit")).toBeTruthy();
    expect(legend.getByText("Pending")).toBeTruthy();
    expect(legend.getByText("Failed")).toBeTruthy();
    expect(legend.getByText("50")).toBeTruthy();
    expect(legend.getByText("50%")).toBeTruthy();
    expect(legend.getByText("0")).toBeTruthy();
    expect(legend.getByText("0%")).toBeTruthy();
  });

  it("omits zero-value segments from the bar itself", () => {
    render(<DistributionBar segments={segments} ariaLabel="Delivery status mix" />);
    const bar = screen.getByTestId("distribution-bar");
    expect(bar.children).toHaveLength(3);
    const widths = Array.from(bar.children).map(
      (child) => (child as HTMLElement).style.width,
    );
    expect(widths).toEqual(["50%", "25%", "25%"]);
  });

  it("renders the honest empty state when every segment is zero", () => {
    render(
      <DistributionBar
        segments={[{ label: "Delivered", value: 0, tone: "success" }]}
        ariaLabel="Delivery status mix"
      />,
    );
    expect(screen.getByText("No activity in this period")).toBeTruthy();
    expect(screen.queryByTestId("distribution-bar")).toBeNull();
  });
});
