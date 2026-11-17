// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { DataTable } from "@/components/ui/DataTable";
import { FilterBar, FilterChip, FilterClearAll } from "@/components/ui/FilterBar";
import {
  DensityScope,
  DensityToggle,
  TABLE_DENSITY_STORAGE_KEY,
} from "@/components/ui/TableDensity";
import {
  TABLE_CLASS,
  TD_ID_CLASS,
  TD_NUMERIC_CLASS,
  TH_CLASS,
  TR_CLASS,
} from "@/components/ui/table-chrome";

/**
 * V3 Step 9 — DataTable density + FilterBar + shared table chrome
 * (DS §7.6/§7.7). Density is one persisted mechanism
 * (localStorage `bla.tableDensity`, comfortable 44px = h-11 default,
 * compact 40px = h-10); result counts are live-region announced;
 * FilterBar chips carry the DS active treatment (primary-light /
 * primary-dark + check glyph) in both link and button variants.
 */

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

type Row = { id: string; code: string; amount: number };

const COLUMNS = [
  { key: "code", header: "Code" },
  { key: "amount", header: "Amount", align: "right" as const },
];

const ROWS: Row[] = [
  { id: "1", code: "BLA-1", amount: 1200 },
  { id: "2", code: "BLA-2", amount: 3400 },
];

function renderTable(extra: Partial<Parameters<typeof DataTable<Row>>[0]> = {}) {
  return render(
    <DataTable<Row>
      ariaLabel="Packages"
      columns={COLUMNS}
      rows={ROWS}
      rowKey={(row) => row.id}
      {...extra}
    />,
  );
}

function bodyRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll("tbody tr"));
}

describe("DataTable — density toggle (DS §7.6)", () => {
  it("renders the density toggle in the toolbar, comfortable by default", () => {
    const { container } = renderTable();
    expect(screen.getByRole("group", { name: "Table density" })).toBeTruthy();
    expect(screen.getByText("Density:")).toBeTruthy();
    const comfortable = screen.getByRole("button", { name: "Comfortable" });
    const compact = screen.getByRole("button", { name: "Compact" });
    expect(comfortable.getAttribute("aria-pressed")).toBe("true");
    expect(compact.getAttribute("aria-pressed")).toBe("false");
    // Comfortable = 44px rows (h-11), and the wrapper stamps the scope.
    for (const tr of bodyRows(container)) {
      expect(tr.className).toContain("h-11");
      expect(tr.className).not.toContain("h-10");
    }
    expect(container.querySelector("[data-density='comfortable']")).not.toBeNull();
    // The table carries the shared bla-table density hook class.
    expect(container.querySelector("table")?.className).toContain("bla-table");
  });

  it("clicking Compact switches rows to h-10, persists compact, and back", () => {
    const { container } = renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    for (const tr of bodyRows(container)) {
      expect(tr.className).toContain("h-10");
      expect(tr.className).not.toContain("h-11");
    }
    expect(screen.getByRole("button", { name: "Compact" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(window.localStorage.getItem(TABLE_DENSITY_STORAGE_KEY)).toBe("compact");
    expect(container.querySelector("[data-density='compact']")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Comfortable" }));
    for (const tr of bodyRows(container)) {
      expect(tr.className).toContain("h-11");
    }
    expect(window.localStorage.getItem(TABLE_DENSITY_STORAGE_KEY)).toBe("comfortable");
  });

  it("reads a persisted compact preference on mount", () => {
    window.localStorage.setItem(TABLE_DENSITY_STORAGE_KEY, "compact");
    const { container } = renderTable();
    for (const tr of bodyRows(container)) {
      expect(tr.className).toContain("h-10");
    }
    expect(screen.getByRole("button", { name: "Compact" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("densityToggle={false} hides the toggle and renders no toolbar for it", () => {
    renderTable({ densityToggle: false });
    expect(screen.queryByRole("button", { name: "Compact" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Table density" })).toBeNull();
  });
});

describe("DataTable — live-region result counts (DS §7.6, WCAG 4.1.3)", () => {
  it("without pagination, a visually-hidden aria-live region announces the row count", () => {
    const { container } = renderTable();
    const region = container.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe("2 rows");
    expect(region?.className).toContain("sr-only");
  });

  it("with pagination, the visible summary is the aria-live region", () => {
    const { container } = renderTable({
      pagination: { page: 1, pageSize: 10, total: 25, onPageChange: vi.fn() },
    });
    const region = container.querySelector('[aria-live="polite"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toMatch(/showing 1–10 of 25/i);
    expect(region?.className).not.toContain("sr-only");
  });
});

describe("DensityScope + DensityToggle — the shared mechanism", () => {
  it("stamps data-density and its toggle drives the scope + storage", () => {
    const { container } = render(
      <DensityScope showToggle>
        <table className={TABLE_CLASS}>
          <tbody>
            <tr>
              <td>BLA-1</td>
            </tr>
          </tbody>
        </table>
      </DensityScope>,
    );
    const scope = container.querySelector("[data-density]");
    expect(scope?.getAttribute("data-density")).toBe("comfortable");
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(scope?.getAttribute("data-density")).toBe("compact");
    expect(window.localStorage.getItem(TABLE_DENSITY_STORAGE_KEY)).toBe("compact");
  });

  it("DensityToggle works standalone (uncontrolled)", () => {
    render(<DensityToggle />);
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(screen.getByRole("button", { name: "Compact" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(window.localStorage.getItem(TABLE_DENSITY_STORAGE_KEY)).toBe("compact");
  });
});

describe("table-chrome constants — client/server parity", () => {
  it("carry the DataTable's rendered chrome classes", () => {
    expect(TABLE_CLASS).toContain("bla-table");
    expect(TABLE_CLASS).toContain("w-full");
    expect(TABLE_CLASS).toContain("border-collapse");
    expect(TH_CLASS).toContain("bg-surface-2");
    expect(TH_CLASS).toContain("text-[12px]");
    expect(TH_CLASS).toContain("font-semibold");
    expect(TH_CLASS).toContain("uppercase");
    expect(TH_CLASS).toContain("text-ink-2");
    expect(TD_NUMERIC_CLASS).toContain("text-right");
    expect(TD_NUMERIC_CLASS).toContain("tabular-nums");
    expect(TD_ID_CLASS).toContain("font-mono");
    expect(TD_ID_CLASS).toContain("whitespace-nowrap");
    expect(TR_CLASS).toContain("border-t");
    expect(TR_CLASS).toContain("border-border");
    expect(TR_CLASS).toContain("hover:bg-surface-2");
  });
});

describe("FilterBar / FilterChip / FilterClearAll (DS §7.7)", () => {
  it("renders a labelled group; the active link chip has the check + primary classes", () => {
    render(
      <FilterBar ariaLabel="Status filters">
        <FilterChip href="/bookings?status=open" active>
          Open
        </FilterChip>
        <FilterChip href="/bookings?status=done">Done</FilterChip>
        <FilterClearAll href="/bookings" />
      </FilterBar>,
    );
    expect(screen.getByRole("group", { name: "Status filters" })).toBeTruthy();

    const active = screen.getByRole("link", { name: /open/i });
    expect(active.className).toContain("bg-primary-light");
    expect(active.className).toContain("text-primary-dark");
    expect(active.textContent).toContain("✓");
    expect(active.getAttribute("href")).toBe("/bookings?status=open");
    // ≥32px hit height.
    expect(active.className).toContain("min-h-[32px]");

    const inactive = screen.getByRole("link", { name: /done/i });
    expect(inactive.className).toContain("bg-surface-2");
    expect(inactive.className).toContain("text-ink");
    expect(inactive.textContent).not.toContain("✓");

    const clear = screen.getByRole("link", { name: "Clear all" });
    expect(clear.getAttribute("href")).toBe("/bookings");
  });

  it("button-variant chips use aria-pressed and fire onClick; Clear all renders as a button", () => {
    const onChip = vi.fn();
    const onClear = vi.fn();
    render(
      <FilterBar>
        <FilterChip active onClick={onChip}>
          Mine
        </FilterChip>
        <FilterChip onClick={vi.fn()}>All</FilterChip>
        <FilterClearAll onClick={onClear} />
      </FilterBar>,
    );
    const active = screen.getByRole("button", { name: /mine/i });
    expect(active.getAttribute("aria-pressed")).toBe("true");
    expect(active.className).toContain("bg-primary-light");
    expect(active.textContent).toContain("✓");
    fireEvent.click(active);
    expect(onChip).toHaveBeenCalledTimes(1);

    const inactive = screen.getByRole("button", { name: "All" });
    expect(inactive.getAttribute("aria-pressed")).toBe("false");
    expect(inactive.className).toContain("bg-surface-2");

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
