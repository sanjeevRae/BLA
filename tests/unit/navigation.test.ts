import { existsSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ROLE_PERMISSIONS, type RoleCode } from "@/lib/permissions/catalog";
import {
  NAV_ITEMS,
  groupNavItems,
  visibleNavItems,
  visibleQuickActions,
  type DashboardId,
} from "@/lib/navigation/registry";

/**
 * V2 Phase 1 — the navigation registry is the single source for the
 * shell's sidebar, quick actions, and search index. These tests pin
 * the contract: a role sees exactly the items its catalog permissions
 * entitle it to, every registered href is a route that exists, and no
 * item is registered for a dashboard its role cannot open.
 *
 * NOTE: expectations are written against the permission catalog. When
 * a later phase changes a role's grants (e.g. Phase 2 granting
 * CUSTOMER notification.read_own for audit H-3), the affected
 * expectation here must be updated in the same change — that is the
 * point of pinning them.
 */

const DASHBOARD_FOR_ROLE: Record<RoleCode, DashboardId> = {
  SUPER_ADMIN: "super-admin",
  ADMIN: "admin",
  WAREHOUSE_ADMIN: "warehouse",
  WAREHOUSE_STAFF: "staff",
  RIDER: "rider",
  LINEHAUL_DRIVER: "transport-driver",
  VENDOR: "vendor",
  CUSTOMER: "customer",
  FINANCE: "finance",
  SUPPORT: "support",
};

function hrefsFor(role: RoleCode): string[] {
  const permissions = new Set(ROLE_PERMISSIONS[role]);
  return visibleNavItems(permissions, DASHBOARD_FOR_ROLE[role]).map((item) => item.href);
}

describe("navigation registry — per-role visibility", () => {
  it("Super Admin sees the full admin tree plus adjustments", () => {
    expect(hrefsFor("SUPER_ADMIN")).toEqual([
      "/super-admin",
      "/super-admin/tasks",
      "/super-admin/notifications",
      "/super-admin/bookings",
      "/super-admin/bookings/new",
      "/super-admin/warehouses",
      "/super-admin/incidents",
      "/super-admin/tickets",
      "/super-admin/vendors",
      "/super-admin/customers",
      "/super-admin/drivers",
      "/super-admin/vehicles",
      "/super-admin/settlements",
      "/super-admin/reports",
      "/super-admin/adjustments",
    ]);
  });

  it("Admin sees the same tree without the adjustments page (no route exists)", () => {
    const hrefs = hrefsFor("ADMIN");
    expect(hrefs).toContain("/admin/bookings");
    expect(hrefs).toContain("/admin/warehouses");
    expect(hrefs).not.toContain("/admin/adjustments");
    expect(hrefs).toHaveLength(14);
  });

  it("Warehouse Admin sees the full warehouse operations tree", () => {
    expect(hrefsFor("WAREHOUSE_ADMIN")).toEqual([
      "/warehouse",
      "/warehouse/tasks",
      "/warehouse/notifications",
      "/warehouse/operations",
      "/warehouse/arrivals",
      "/warehouse/inventory",
      "/warehouse/transfers",
      "/warehouse/transfers/new",
      "/warehouse/deliveries",
      "/warehouse/deliveries/new",
      "/warehouse/handovers",
      "/warehouse/supplies",
      "/warehouse/returns",
      "/warehouse/bookings",
      "/warehouse/incidents",
      "/warehouse/reports",
    ]);
  });

  it("Warehouse Staff never sees create/dispatch/report items it is not granted", () => {
    const hrefs = hrefsFor("WAREHOUSE_STAFF");
    expect(hrefs).toEqual([
      "/staff",
      "/staff/tasks",
      "/staff/notifications",
      "/staff/operations",
      "/staff/arrivals",
      "/staff/inventory",
      "/staff/transfers",
      "/staff/deliveries",
      "/staff/handovers",
      "/staff/supplies",
      "/staff/returns",
      "/staff/bookings",
      "/staff/incidents",
    ]);
    // The dead Staff create routes (audit M-7) must stay unlinked.
    expect(hrefs).not.toContain("/staff/transfers/new");
    expect(hrefs).not.toContain("/staff/deliveries/new");
  });

  it("Rider sees home (the batch list), tasks, performance, notifications, COD", () => {
    expect(hrefsFor("RIDER")).toEqual([
      "/rider",
      "/rider/tasks",
      "/rider/reports",
      "/rider/notifications",
      "/rider/cod",
    ]);
  });

  it("Line-haul Driver sees only its workspace items", () => {
    expect(hrefsFor("LINEHAUL_DRIVER")).toEqual([
      "/transport-driver",
      "/transport-driver/tasks",
      "/transport-driver/reports",
      "/transport-driver/notifications",
    ]);
  });

  it("Vendor sees its org-scoped tree including billing and profile", () => {
    expect(hrefsFor("VENDOR")).toEqual([
      "/vendor",
      "/vendor/notifications",
      "/vendor/bookings",
      "/vendor/bookings/new",
      "/vendor/incidents",
      "/vendor/tickets",
      "/vendor/billing",
      "/vendor/reports",
      "/vendor/profile",
    ]);
  });

  it("Customer sees packages, tickets and notifications (notification.read_own granted in Phase 2, audit H-3)", () => {
    expect(hrefsFor("CUSTOMER")).toEqual([
      "/customer",
      "/customer/tickets",
      "/customer/notifications",
    ]);
  });

  it("Finance sees the finance tree; custody modules never appear", () => {
    const hrefs = hrefsFor("FINANCE");
    expect(hrefs).toEqual([
      "/finance",
      "/finance/notifications",
      "/finance/incidents",
      "/finance/invoices",
      "/finance/ledger",
      "/finance/remittances",
      "/finance/settlements",
      "/finance/adjustments",
      "/finance/reports",
    ]);
    expect(hrefs.some((h) => h.includes("transfers") || h.includes("inventory"))).toBe(false);
  });

  it("Support sees home, notifications, tickets, incidents", () => {
    expect(hrefsFor("SUPPORT")).toEqual([
      "/support",
      "/support/notifications",
      "/support/tickets",
      "/support/incidents",
    ]);
  });
});

describe("navigation registry — structural invariants", () => {
  it("every registered href maps to an existing dashboard page (no dead links)", () => {
    const appRoot = path.resolve(__dirname, "../../src/app/(dashboards)");
    for (const item of NAV_ITEMS) {
      const pagePath = path.join(appRoot, item.href.replace(/^\//, ""), "page.tsx");
      expect(existsSync(pagePath), `${item.href} should have a page.tsx`).toBe(true);
    }
  });

  it("item ids are unique and every href starts with its dashboard prefix", () => {
    const ids = NAV_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of NAV_ITEMS) {
      expect(item.href === `/${item.dashboard}` || item.href.startsWith(`/${item.dashboard}/`)).toBe(
        true,
      );
    }
  });

  it("an empty permission set yields only each dashboard's ungated items (home; vendor/customer ticket pages are ownership-scoped, not permission-gated)", () => {
    const expected: Record<DashboardId, string[]> = {
      "super-admin": ["/super-admin"],
      admin: ["/admin"],
      warehouse: ["/warehouse"],
      staff: ["/staff"],
      rider: ["/rider"],
      "transport-driver": ["/transport-driver"],
      vendor: ["/vendor", "/vendor/tickets"],
      customer: ["/customer", "/customer/tickets"],
      finance: ["/finance"],
      support: ["/support"],
    };
    for (const dashboard of Object.values(DASHBOARD_FOR_ROLE)) {
      const visible = visibleNavItems(new Set(), dashboard);
      expect(visible.map((i) => i.href)).toEqual(expected[dashboard]);
    }
  });

  it("quick actions are permission-filtered create/receive flows", () => {
    const sa = visibleQuickActions(new Set(ROLE_PERMISSIONS.SUPER_ADMIN), "super-admin");
    expect(sa.map((i) => i.href)).toEqual(["/super-admin/bookings/new"]);
    const wa = visibleQuickActions(new Set(ROLE_PERMISSIONS.WAREHOUSE_ADMIN), "warehouse");
    expect(wa.map((i) => i.href)).toEqual([
      "/warehouse/operations",
      "/warehouse/transfers/new",
      "/warehouse/deliveries/new",
    ]);
    const staff = visibleQuickActions(new Set(ROLE_PERMISSIONS.WAREHOUSE_STAFF), "staff");
    expect(staff).toEqual([]);
    const vendor = visibleQuickActions(new Set(ROLE_PERMISSIONS.VENDOR), "vendor");
    expect(vendor.map((i) => i.href)).toEqual(["/vendor/bookings/new"]);
  });

  it("grouping preserves registry order and drops empty groups", () => {
    const groups = groupNavItems(visibleNavItems(new Set(ROLE_PERMISSIONS.RIDER), "rider"));
    expect(groups.map((g) => g.id)).toEqual(["workspace", "operations"]);
    expect(groups[0].items.map((i) => i.label)).toEqual([
      "Home",
      "Tasks",
      "My performance",
      "Notifications",
    ]);
  });
});
