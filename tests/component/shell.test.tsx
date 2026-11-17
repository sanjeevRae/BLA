// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  usePathname: () => "/warehouse/inventory",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// The bell pulls server actions (and through them the service layer);
// the shell contract under test is navigation, not notifications.
vi.mock("@/components/operations/bell", () => ({
  NotificationsBell: () => <button type="button" aria-label="Notifications">Bell</button>,
}));

// The warehouse selector's action imports the auth chain; stub it.
vi.mock("@/server/actions/shell", () => ({
  setWarehouseScopeAction: vi.fn(async () => undefined),
}));

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

afterEach(() => cleanup());

import { ROLE_PERMISSIONS, type RoleCode } from "@/lib/permissions/catalog";
import {
  groupNavItems,
  toNavGroupViews,
  visibleNavItems,
  visibleQuickActions,
  ROLE_TO_DASHBOARD,
  type NavItemView,
} from "@/lib/navigation/registry";
import { ShellFrame, type ShellFrameProps } from "@/components/layout/ShellFrame";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { DataTable } from "@/components/ui/DataTable";

function framePropsFor(role: RoleCode, stripPermissions: string[] = []): ShellFrameProps {
  const dashboard = ROLE_TO_DASHBOARD[role];
  const permissions = new Set(ROLE_PERMISSIONS[role]);
  for (const code of stripPermissions) permissions.delete(code);
  const items = visibleNavItems(permissions, dashboard);
  const toView = (item: (typeof items)[number]): NavItemView => ({
    id: item.id,
    label: item.label,
    href: item.href,
    icon: item.icon,
  });
  return {
    title: "Test Dashboard",
    dashboardHomeHref: `/${dashboard}`,
    groups: toNavGroupViews(groupNavItems(items)),
    quickActions: visibleQuickActions(permissions, dashboard).map(toView),
    searchItems: items.map(toView),
    recentsScope: "test-user-id",
    warehouses: null,
    selectedWarehouseId: null,
    canSelectAllWarehouses: false,
    userName: "Test User",
    userEmail: "test@bla.test",
    notificationsHref: permissions.has("notification.read_own")
      ? `/${dashboard}/notifications`
      : null,
    signOut: <button type="button">Sign out</button>,
    children: <p>Page body</p>,
  };
}

function navLinks(container: HTMLElement): string[] {
  const nav = container.querySelector("aside nav") ?? container.querySelector("nav");
  if (!nav) return [];
  return within(nav as HTMLElement)
    .getAllByRole("link")
    .map((link) => link.getAttribute("href") ?? "");
}

describe("ShellFrame — role navigation rendering", () => {
  it("Super Admin sidebar links the full module tree incl. previously unreachable modules", () => {
    const { container } = render(<ShellFrame {...framePropsFor("SUPER_ADMIN")} />);
    const hrefs = navLinks(container);
    for (const expected of [
      "/super-admin/warehouses",
      "/super-admin/vendors",
      "/super-admin/customers",
      "/super-admin/drivers",
      "/super-admin/settlements",
      "/super-admin/reports",
      "/super-admin/adjustments",
    ]) {
      expect(hrefs).toContain(expected);
    }
    // Quick action renders as a top-bar link.
    expect(screen.getAllByRole("link", { name: /new booking/i }).length).toBeGreaterThan(0);
    expect(screen.getByText("Page body")).toBeTruthy();
  });

  it("Warehouse Staff sidebar has no create/dispatch links and no quick actions", () => {
    const { container } = render(<ShellFrame {...framePropsFor("WAREHOUSE_STAFF")} />);
    const hrefs = navLinks(container);
    expect(hrefs).toContain("/staff/inventory");
    expect(hrefs).not.toContain("/staff/transfers/new");
    expect(hrefs).not.toContain("/staff/deliveries/new");
    expect(screen.queryByRole("link", { name: /new transfer/i })).toBeNull();
  });

  it("Customer sidebar shows packages, tickets, notifications and the Phase 6 self-service pages (audit H-3, M-3)", () => {
    const { container } = render(<ShellFrame {...framePropsFor("CUSTOMER")} />);
    const hrefs = navLinks(container);
    // V3 regrouping renders the same href SET in DS §6 group order:
    // overview (packages, notifications) → work-management (tickets,
    // incidents) → finance (invoices) → management (profile).
    expect(hrefs).toEqual([
      "/customer",
      "/customer/notifications",
      "/customer/tickets",
      "/customer/incidents",
      "/customer/incidents/new",
      "/customer/billing",
      "/customer/profile",
    ]);
    expect([...hrefs].sort()).toEqual(
      [
        "/customer",
        "/customer/tickets",
        "/customer/notifications",
        "/customer/incidents",
        "/customer/incidents/new",
        "/customer/billing",
        "/customer/profile",
      ].sort(),
    );
  });

  it("notifications chrome (bell) renders only for actors holding notification.read_own", () => {
    // Every role holds the grant since Phase 2 (H-3), so the negative
    // case is a synthetic actor whose permission set lacks it — the
    // F3 chrome gate itself is what is under test.
    render(<ShellFrame {...framePropsFor("CUSTOMER", ["notification.read_own"])} />);
    expect(screen.queryByRole("button", { name: "Notifications" })).toBeNull();
    cleanup();
    render(<ShellFrame {...framePropsFor("CUSTOMER")} />);
    expect(screen.getByRole("button", { name: "Notifications" })).toBeTruthy();
  });

  it("the current route's nav item is marked aria-current", () => {
    const { container } = render(<ShellFrame {...framePropsFor("WAREHOUSE_ADMIN")} />);
    const current = container.querySelector('a[aria-current="page"]');
    expect(current?.getAttribute("href")).toBe("/warehouse/inventory");
  });

  it("profile menu button is labelled with the user name", () => {
    render(<ShellFrame {...framePropsFor("FINANCE")} />);
    expect(screen.getByRole("button", { name: /account menu for test user/i })).toBeTruthy();
  });
});

describe("ShellFrame — V3 dark sidebar (DS §7.1)", () => {
  it("renders the dark sidebar with the six V3 group labels and a user card", () => {
    const { container } = render(<ShellFrame {...framePropsFor("SUPER_ADMIN")} />);
    const aside = container.querySelector("aside");
    expect(aside?.className).toContain("bg-sidebar");
    expect(aside?.className).toContain("w-[248px]");
    const sidebar = within(aside as HTMLElement);
    const groupLabels = Array.from(aside.querySelectorAll(".text-sidebar-label")).map(
      (el) => el.textContent,
    );
    expect(groupLabels).toEqual([
      "Overview",
      "Operations",
      "Network",
      "Work Management",
      "Finance",
      "Management",
    ]);
    // Brand wordmark + user card (name + role) at the sidebar bottom.
    expect(sidebar.getByText("BLA")).toBeTruthy();
    expect(sidebar.getByText("Logistics")).toBeTruthy();
    expect(sidebar.getByText("Test User")).toBeTruthy();
    expect(sidebar.getByText("Test Dashboard")).toBeTruthy();
  });

  it("marks the active item with the primary-dark fill and accent indicator", () => {
    const { container } = render(<ShellFrame {...framePropsFor("WAREHOUSE_ADMIN")} />);
    const current = container.querySelector('aside a[aria-current="page"]');
    expect(current?.getAttribute("href")).toBe("/warehouse/inventory");
    expect(current?.className).toContain("bg-primary-dark");
    expect(current?.className).toContain("text-white");
    expect(current?.querySelector(".bg-accent")).toBeTruthy();
  });

  it("collapse toggle switches to the 72px icon rail with labelled icon links", () => {
    const { container } = render(<ShellFrame {...framePropsFor("WAREHOUSE_ADMIN")} />);
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    const aside = container.querySelector("aside");
    expect(aside?.className).toContain("w-[72px]");
    const sidebar = within(aside as HTMLElement);
    // Group labels are replaced by hairlines; items keep accessible names.
    expect(sidebar.queryByText("Operations")).toBeNull();
    expect(sidebar.getByRole("link", { name: "Inventory" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(container.querySelector("aside")?.className).toContain("w-[248px]");
    expect(sidebar.getByText("Operations")).toBeTruthy();
  });

  it("mobile drawer opens a second Dashboard navigation and closes on navigate", () => {
    render(<ShellFrame {...framePropsFor("WAREHOUSE_ADMIN")} />);
    expect(screen.getAllByRole("navigation", { name: "Dashboard" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const navs = screen.getAllByRole("navigation", { name: "Dashboard" });
    expect(navs).toHaveLength(2);
    const drawerLink = within(navs[1]).getByRole("link", { name: /inventory/i });
    fireEvent.click(drawerLink);
    expect(screen.getAllByRole("navigation", { name: "Dashboard" })).toHaveLength(1);
  });

  it("header carries the command-menu trigger instead of the old search field", () => {
    render(<ShellFrame {...framePropsFor("ADMIN")} />);
    expect(screen.getByRole("button", { name: /search or jump to/i })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: /search pages/i })).toBeNull();
  });
});

describe("StatusBadge — shared component", () => {
  it("renders the operational domain tone for DELIVERED", () => {
    render(<StatusBadge domain="operational" status="DELIVERED" />);
    const badge = screen.getByText("Delivered");
    expect(badge.className).toContain("bg-successbg");
    expect(badge.className).toContain("text-success");
  });

  it("renders exception MISSING as danger and payment COD_DUE as warning", () => {
    render(
      <>
        <StatusBadge domain="exception" status="MISSING" />
        <StatusBadge domain="payment" status="COD_DUE" />
      </>,
    );
    expect(screen.getByText("Missing").className).toContain("bg-dangerbg");
    expect(screen.getByText("COD due").className).toContain("bg-warningbg");
  });
});

describe("DataTable — foundation behaviour", () => {
  it("renders rows, search wiring, and pagination bounds", () => {
    const onSearch = vi.fn();
    const onPageChange = vi.fn();
    render(
      <DataTable
        ariaLabel="Packages"
        columns={[
          { key: "code", header: "Code" },
          { key: "status", header: "Status" },
        ]}
        rows={[
          { id: "1", code: "BLA-1", status: "BOOKED" },
          { id: "2", code: "BLA-2", status: "DELIVERED" },
        ]}
        rowKey={(row) => row.id}
        search={{ value: "", onChange: onSearch, placeholder: "Search packages" }}
        pagination={{ page: 1, pageSize: 10, total: 25, onPageChange }}
      />,
    );
    expect(screen.getByText("BLA-1")).toBeTruthy();
    expect(screen.getByText("BLA-2")).toBeTruthy();
    expect(screen.getByPlaceholderText("Search packages")).toBeTruthy();
    expect(screen.getByText(/showing 1–10 of 25/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("renders the empty state when there are no rows", () => {
    render(
      <DataTable
        ariaLabel="Empty table"
        columns={[{ key: "code", header: "Code" }]}
        rows={[] as { id: string; code: string }[]}
        rowKey={(row) => row.id}
      />,
    );
    expect(screen.getByText("No records")).toBeTruthy();
  });
});
