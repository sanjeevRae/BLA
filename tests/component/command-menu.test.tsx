// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: nav.push, refresh: vi.fn() }),
}));

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { NavItemView } from "@/lib/navigation/registry";
import {
  CommandMenu,
  CommandMenuTrigger,
} from "@/components/layout/CommandMenu";

/**
 * V3 Step 3 (DS §8) — command menu behaviour: Ctrl+K opens, local
 * groups (Navigate / Actions) render from the actor's registry
 * items, record search is debounced through /api/search and never
 * fires below 2 characters, and selecting a row navigates.
 */

const ITEMS: NavItemView[] = [
  { id: "admin:home", label: "Overview", href: "/admin", icon: "home" },
  { id: "admin:bookings", label: "Bookings", href: "/admin/bookings", icon: "package" },
  { id: "admin:vendors", label: "Vendors", href: "/admin/vendors", icon: "store" },
];
const QUICK_ACTIONS: NavItemView[] = [
  { id: "admin:bookings/new", label: "New booking", href: "/admin/bookings/new", icon: "package" },
];

const SEARCH_BODY = {
  groups: [
    {
      id: "packages",
      label: "Packages",
      results: [
        {
          id: "pkg-1",
          label: "BLA-4839201756",
          hint: "Recipient One · Pokhara",
          href: "/admin/bookings/order-1",
        },
      ],
    },
  ],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  nav.push.mockClear();
  // cmdk scrolls the active item into view and observes the list;
  // jsdom has neither layout nor ResizeObserver.
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => SEARCH_BODY,
  }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function openWithCtrlK() {
  fireEvent.keyDown(document, { key: "k", ctrlKey: true });
}

describe("CommandMenu", () => {
  it("renders Navigate + Actions groups when opened with Ctrl+K", async () => {
    render(<CommandMenu items={ITEMS} quickActions={QUICK_ACTIONS} />);
    expect(screen.queryByPlaceholderText("Search or jump to…")).toBeNull();
    openWithCtrlK();
    const input = await screen.findByPlaceholderText("Search or jump to…");
    expect(input).not.toBeNull();
    expect(screen.getByText("Navigate")).not.toBeNull();
    expect(screen.getByText("Actions")).not.toBeNull();
    expect(screen.getByText("Bookings")).not.toBeNull();
    expect(screen.getByText("New booking")).not.toBeNull();
    // Empty query → no record request at all.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens from the header trigger event", async () => {
    render(
      <>
        <CommandMenuTrigger />
        <CommandMenu items={ITEMS} quickActions={QUICK_ACTIONS} />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Search or jump to/ }));
    expect(await screen.findByPlaceholderText("Search or jump to…")).not.toBeNull();
  });

  it("does not fetch for queries under 2 characters", async () => {
    render(<CommandMenu items={ITEMS} quickActions={QUICK_ACTIONS} />);
    openWithCtrlK();
    const input = await screen.findByPlaceholderText("Search or jump to…");
    fireEvent.change(input, { target: { value: "b" } });
    // Well past the 200ms debounce — still no request.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches records at ≥2 characters and navigates on selection", async () => {
    render(<CommandMenu items={ITEMS} quickActions={QUICK_ACTIONS} />);
    openWithCtrlK();
    const input = await screen.findByPlaceholderText("Search or jump to…");
    fireEvent.change(input, { target: { value: "BLA-4839" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/search?q=BLA-4839",
    );
    const row = await screen.findByText("BLA-4839201756");
    expect(screen.getByText("Packages")).not.toBeNull();
    fireEvent.click(row);
    await waitFor(() =>
      expect(nav.push).toHaveBeenCalledWith("/admin/bookings/order-1"),
    );
    // Palette closed after selection.
    await waitFor(() =>
      expect(screen.queryByPlaceholderText("Search or jump to…")).toBeNull(),
    );
  });

  it("shows the designed no-results state", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ groups: [] }),
    }));
    render(<CommandMenu items={ITEMS} quickActions={QUICK_ACTIONS} />);
    openWithCtrlK();
    const input = await screen.findByPlaceholderText("Search or jump to…");
    fireEvent.change(input, { target: { value: "zzzz" } });
    const empty = await screen.findByText(/No matches for/);
    expect(empty.textContent).toContain("zzzz");
  });

  it("remembers the last selection as a Recent on the next open", async () => {
    render(<CommandMenu items={ITEMS} quickActions={QUICK_ACTIONS} />);
    openWithCtrlK();
    const input = await screen.findByPlaceholderText("Search or jump to…");
    fireEvent.change(input, { target: { value: "BLA-4839" } });
    const row = await screen.findByText("BLA-4839201756");
    fireEvent.click(row);
    await waitFor(() => expect(nav.push).toHaveBeenCalledTimes(1));
    openWithCtrlK();
    expect(await screen.findByText("Recent")).not.toBeNull();
    expect(screen.getByText("BLA-4839201756")).not.toBeNull();
  });
});
