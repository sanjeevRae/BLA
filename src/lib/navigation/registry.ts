import type { RoleCode } from "@/lib/permissions/catalog";

/**
 * The single navigation registry for every dashboard (V2 Phase 1,
 * audit defect H-1). Every sidebar item, quick action, and shell
 * search result is derived from this one list — there is no second
 * hand-maintained menu anywhere.
 *
 * Visibility is a UX convenience ONLY: an item renders when the
 * signed-in actor's permission set satisfies the item's gate, but the
 * pages and services behind every route keep enforcing their own
 * server-side checks exactly as before. Hiding a link never grants or
 * removes access.
 *
 * Every `href` below names a route that exists today — no placeholder
 * or dead links. (Live Operations landed in V2 Phase 5; the Super
 * Admin users/settings/audit surfaces, Warehouse Admin fleet and
 * booking-create, Finance/Support tasks, and the Customer
 * self-service pages landed in V2 Phase 6 and are registered below.)
 */

export type DashboardId =
  | "super-admin"
  | "admin"
  | "warehouse"
  | "staff"
  | "rider"
  | "transport-driver"
  | "vendor"
  | "customer"
  | "finance"
  | "support";

export const ROLE_TO_DASHBOARD: Record<RoleCode, DashboardId> = {
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

export type NavGroupId =
  | "overview"
  | "operations"
  | "network"
  | "work-management"
  | "finance"
  | "management";

export const NAV_GROUP_ORDER: readonly NavGroupId[] = [
  "overview",
  "operations",
  "network",
  "work-management",
  "finance",
  "management",
];

export const NAV_GROUP_LABELS: Record<NavGroupId, string> = {
  overview: "Overview",
  operations: "Operations",
  network: "Network",
  "work-management": "Work Management",
  finance: "Finance",
  management: "Management",
};

/** Icon names rendered by the shell's NavIcon component. */
export type NavIconName =
  | "home"
  | "tasks"
  | "bell"
  | "package"
  | "warehouse"
  | "alert"
  | "ticket"
  | "store"
  | "users"
  | "truck"
  | "car"
  | "coins"
  | "sliders"
  | "chart"
  | "scan"
  | "inbox"
  | "boxes"
  | "swap"
  | "hand"
  | "undo"
  | "wallet"
  | "file"
  | "user"
  | "map";

export interface NavItemDef {
  id: string;
  label: string;
  href: string;
  dashboard: DashboardId;
  group: NavGroupId;
  icon: NavIconName;
  /** Visible when the actor holds ANY of these permissions. */
  anyOf?: readonly string[];
  /** Visible only when the actor holds ALL of these permissions. */
  allOf?: readonly string[];
  /** Also offered in the top-bar quick-actions toolbar. */
  quickAction?: boolean;
}

type ItemSpec = Omit<NavItemDef, "dashboard" | "href" | "id"> & { path: string };

function define(dashboard: DashboardId, specs: readonly ItemSpec[]): NavItemDef[] {
  return specs.map((spec) => ({
    ...spec,
    dashboard,
    href: `/${dashboard}${spec.path}`,
    id: `${dashboard}:${spec.path === "" ? "home" : spec.path.slice(1)}`,
  }));
}

/** Admin and Super Admin share one route tree; Super Admin additionally
 *  owns the finance adjustments decision page. */
function adminItems(dashboard: "admin" | "super-admin"): NavItemDef[] {
  const items: ItemSpec[] = [
    { path: "", label: "Overview", group: "overview", icon: "home" },
    {
      path: "/tasks", label: "Tasks", group: "work-management", icon: "tasks",
      anyOf: ["task.create", "task.assign", "task.update_own"],
    },
    {
      path: "/notifications", label: "Notifications", group: "overview", icon: "bell",
      anyOf: ["notification.read_own"],
    },
    {
      path: "/bookings", label: "Bookings", group: "operations", icon: "package",
      anyOf: ["booking.read_all"],
    },
    {
      path: "/bookings/new", label: "New booking", group: "operations", icon: "package",
      anyOf: ["booking.create"], quickAction: true,
    },
    {
      path: "/warehouses", label: "Warehouses", group: "network", icon: "warehouse",
      anyOf: ["warehouse.read_all"],
    },
    {
      path: "/live-operations", label: "Live Operations", group: "operations", icon: "map",
      anyOf: ["operations.live_view"],
    },
    {
      path: "/incidents", label: "Exceptions", group: "work-management", icon: "alert",
      anyOf: ["incident.manage", "incident.resolve"],
    },
    {
      path: "/tickets", label: "Support Tickets", group: "work-management", icon: "ticket",
      anyOf: ["support.ticket.manage"],
    },
    {
      path: "/vendors", label: "Vendors", group: "network", icon: "store",
      anyOf: ["vendor.read_all"],
    },
    {
      path: "/customers", label: "Customers", group: "network", icon: "users",
      anyOf: ["customer.read"],
    },
    {
      path: "/drivers", label: "Drivers", group: "network", icon: "truck",
      anyOf: ["driver.manage", "driver.assign"],
    },
    {
      path: "/vehicles", label: "Vehicles", group: "network", icon: "car",
      anyOf: ["vehicle.manage", "vehicle.assign"],
    },
    {
      path: "/settlements", label: "Settlements", group: "finance", icon: "coins",
      anyOf: ["settlement.read"],
    },
    {
      path: "/reports", label: "Reports", group: "management", icon: "chart",
      anyOf: ["report.read_all"],
    },
  ];
  if (dashboard === "super-admin") {
    items.push({
      path: "/adjustments", label: "Adjustments", group: "finance", icon: "sliders",
      anyOf: ["finance.adjust", "finance.approve_adjustment"],
    });
  }
  // Phase 6 (audit H-4): identity administration. Users & Roles and
  // Audit Logs exist in both trees (both roles hold user.manage /
  // audit.read); Settings is Super Admin only (ADMIN does not hold
  // settings.manage and has no settings route).
  items.push({
    path: "/users", label: "Users & Roles", group: "management", icon: "users",
    anyOf: ["user.manage"],
  });
  if (dashboard === "super-admin") {
    items.push({
      path: "/settings", label: "Settings", group: "management", icon: "sliders",
      anyOf: ["settings.manage"],
    });
  }
  items.push({
    path: "/audit", label: "Audit Logs", group: "management", icon: "file",
    anyOf: ["audit.read"],
  });
  return define(dashboard, items);
}

/** Warehouse Admin and Warehouse Staff share the operational route
 *  tree; the permission gates are what differ (Staff never sees the
 *  create/dispatch actions it is not granted). The dead Staff create
 *  routes (audit M-7) are deliberately not linked. */
function warehouseItems(dashboard: "warehouse" | "staff"): NavItemDef[] {
  return define(dashboard, [
    { path: "", label: "Overview", group: "overview", icon: "home" },
    {
      path: "/tasks", label: "Tasks", group: "work-management", icon: "tasks",
      anyOf: ["task.create", "task.assign", "task.update_own"],
    },
    {
      path: "/notifications", label: "Notifications", group: "overview", icon: "bell",
      anyOf: ["notification.read_own"],
    },
    {
      path: "/operations", label: "Receive & scan", group: "operations", icon: "scan",
      anyOf: ["package.receive"], quickAction: dashboard === "warehouse",
    },
    {
      path: "/arrivals", label: "Arrivals", group: "operations", icon: "inbox",
      anyOf: ["transfer.receive"],
    },
    {
      path: "/inventory", label: "Inventory", group: "operations", icon: "boxes",
      anyOf: ["inventory.read_warehouse"],
    },
    {
      path: "/transfers", label: "Transfers", group: "operations", icon: "swap",
      anyOf: ["transfer.read_warehouse"],
    },
    ...(dashboard === "warehouse"
      ? [
          {
            path: "/transfers/new", label: "New transfer", group: "operations", icon: "swap",
            anyOf: ["transfer.create"], quickAction: true,
          } as ItemSpec,
        ]
      : []),
    ...(dashboard === "warehouse"
      ? [
          {
            path: "/live-operations", label: "Live Operations", group: "operations", icon: "map",
            anyOf: ["operations.live_view"],
          } as ItemSpec,
        ]
      : []),
    {
      path: "/deliveries", label: "Deliveries", group: "operations", icon: "truck",
      anyOf: ["delivery.assign", "delivery.read_assigned", "package.receive"],
    },
    ...(dashboard === "warehouse"
      ? [
          {
            path: "/deliveries/new", label: "New delivery batch", group: "operations", icon: "truck",
            anyOf: ["delivery.assign"], quickAction: true,
          } as ItemSpec,
        ]
      : []),
    {
      path: "/handovers", label: "Handovers", group: "operations", icon: "hand",
      anyOf: ["custody.read"],
    },
    {
      path: "/supplies", label: "Supplies", group: "operations", icon: "boxes",
      anyOf: ["supplies.manage"],
    },
    {
      path: "/returns", label: "Returns", group: "operations", icon: "undo",
      anyOf: ["package.return_initiate", "package.read_assigned"],
    },
    {
      path: "/bookings", label: "Bookings", group: "operations", icon: "package",
      anyOf: ["booking.read_warehouse"],
    },
    ...(dashboard === "warehouse"
      ? [
          {
            // Phase 6 (audit M-5): WA holds booking.create; the create
            // page exists only in the warehouse tree, never for Staff.
            path: "/bookings/new", label: "New booking", group: "operations", icon: "package",
            anyOf: ["booking.create"], quickAction: true,
          } as ItemSpec,
        ]
      : []),
    {
      path: "/incidents", label: "Incidents", group: "work-management", icon: "alert",
      anyOf: ["incident.report", "incident.manage"],
    },
    ...(dashboard === "warehouse"
      ? [
          {
            path: "/reports", label: "Reports", group: "management", icon: "chart",
            anyOf: ["report.read_warehouse"],
          } as ItemSpec,
          {
            // Phase 6 (audit M-4): WA fleet surface. Warehouse tree
            // only — Staff holds none of these grants and has no
            // such routes.
            path: "/drivers", label: "Drivers", group: "network", icon: "truck",
            anyOf: ["driver.manage", "driver.assign"],
          } as ItemSpec,
          {
            path: "/vehicles", label: "Vehicles", group: "network", icon: "car",
            anyOf: ["vehicle.assign"],
          } as ItemSpec,
        ]
      : []),
  ]);
}

export const NAV_ITEMS: readonly NavItemDef[] = [
  ...adminItems("super-admin"),
  ...adminItems("admin"),
  ...warehouseItems("warehouse"),
  ...warehouseItems("staff"),
  ...define("rider", [
    { path: "", label: "Home", group: "overview", icon: "home" },
    {
      path: "/tasks", label: "Tasks", group: "operations", icon: "tasks",
      anyOf: ["task.update_own"],
    },
    {
      path: "/reports", label: "My performance", group: "overview", icon: "chart",
      anyOf: ["report.read_self"],
    },
    {
      path: "/notifications", label: "Notifications", group: "overview", icon: "bell",
      anyOf: ["notification.read_own"],
    },
    // No "/batches" item: there is no batch-list route — the rider
    // home page IS the batch list and links to /rider/batches/[id]
    // detail pages (existing V1 design). Registering the list path
    // would be a dead link.
    {
      path: "/cod", label: "COD", group: "finance", icon: "wallet",
      anyOf: ["cod.read"],
    },
  ]),
  ...define("transport-driver", [
    { path: "", label: "Home", group: "overview", icon: "home" },
    {
      path: "/tasks", label: "Tasks", group: "operations", icon: "tasks",
      anyOf: ["task.update_own"],
    },
    {
      path: "/reports", label: "My performance", group: "overview", icon: "chart",
      anyOf: ["report.read_self"],
    },
    {
      path: "/notifications", label: "Notifications", group: "overview", icon: "bell",
      anyOf: ["notification.read_own"],
    },
  ]),
  ...define("vendor", [
    { path: "", label: "Home", group: "overview", icon: "home" },
    {
      path: "/notifications", label: "Notifications", group: "overview", icon: "bell",
      anyOf: ["notification.read_own"],
    },
    {
      path: "/bookings", label: "Bookings", group: "operations", icon: "package",
      anyOf: ["booking.read_vendor"],
    },
    {
      path: "/bookings/new", label: "New booking", group: "operations", icon: "package",
      anyOf: ["booking.create"], quickAction: true,
    },
    {
      path: "/incidents", label: "Incidents", group: "work-management", icon: "alert",
      anyOf: ["incident.report"],
    },
    { path: "/tickets", label: "Support tickets", group: "work-management", icon: "ticket" },
    {
      path: "/billing", label: "Billing", group: "finance", icon: "wallet",
      anyOf: ["invoice.read", "settlement.read"],
    },
    // No "/billing/invoices" or "/billing/settlements" items: the
    // vendor billing page lists both; only [id] detail routes exist
    // below it. Registering the list paths would be dead links.
    {
      path: "/reports", label: "Reports", group: "management", icon: "chart",
      anyOf: ["report.read_vendor"],
    },
    {
      path: "/profile", label: "Profile", group: "management", icon: "user",
      anyOf: ["profile.update_own"],
    },
  ]),
  ...define("customer", [
    { path: "", label: "My packages", group: "overview", icon: "package" },
    { path: "/tickets", label: "Support tickets", group: "work-management", icon: "ticket" },
    {
      // CUSTOMER holds notification.read_own (audit H-3, granted in
      // V2 Phase 2), so this item renders for customers and the
      // notifications service calls behind it are authorised.
      path: "/notifications", label: "Notifications", group: "overview", icon: "bell",
      anyOf: ["notification.read_own"],
    },
    {
      // Phase 6 (audit M-3): the customer's own incident reports,
      // including payment disputes (PAYMENT_DISPUTE incidents).
      path: "/incidents", label: "My incidents", group: "work-management", icon: "alert",
      anyOf: ["incident.report", "payment.dispute.raise"],
    },
    {
      path: "/incidents/new", label: "Report an incident", group: "work-management", icon: "alert",
      anyOf: ["incident.report", "payment.dispute.raise"], quickAction: true,
    },
    {
      path: "/billing", label: "My invoices", group: "finance", icon: "wallet",
      anyOf: ["invoice.read"],
    },
    {
      path: "/profile", label: "Profile", group: "management", icon: "user",
      anyOf: ["profile.update_own"],
    },
  ]),
  ...define("finance", [
    { path: "", label: "Overview", group: "overview", icon: "home" },
    {
      // Phase 6 (audit M-2): FINANCE holds task.* — the shared task
      // board now has a finance route.
      path: "/tasks", label: "Tasks", group: "work-management", icon: "tasks",
      anyOf: ["task.create", "task.assign", "task.update_own"],
    },
    {
      path: "/notifications", label: "Notifications", group: "overview", icon: "bell",
      anyOf: ["notification.read_own"],
    },
    {
      path: "/incidents", label: "Incidents", group: "work-management", icon: "alert",
      anyOf: ["incident.manage", "incident.report"],
    },
    {
      path: "/invoices", label: "Invoices", group: "finance", icon: "file",
      anyOf: ["invoice.read"],
    },
    {
      path: "/ledger", label: "Ledger", group: "finance", icon: "wallet",
      anyOf: ["finance.read"],
    },
    {
      path: "/remittances", label: "COD remittances", group: "finance", icon: "coins",
      anyOf: ["cod.read"],
    },
    {
      path: "/settlements", label: "Settlements", group: "finance", icon: "coins",
      anyOf: ["settlement.read"],
    },
    {
      path: "/adjustments", label: "Adjustments & refunds", group: "finance", icon: "sliders",
      anyOf: ["finance.adjust", "finance.approve_adjustment"],
    },
    {
      path: "/reports", label: "Reports", group: "management", icon: "chart",
      anyOf: ["report.read_all"],
    },
  ]),
  ...define("support", [
    { path: "", label: "Home", group: "overview", icon: "home" },
    {
      // Phase 6 (audit M-2): SUPPORT holds task.* — the shared task
      // board now has a support route.
      path: "/tasks", label: "Tasks", group: "work-management", icon: "tasks",
      anyOf: ["task.create", "task.assign", "task.update_own"],
    },
    {
      path: "/notifications", label: "Notifications", group: "overview", icon: "bell",
      anyOf: ["notification.read_own"],
    },
    {
      path: "/tickets", label: "Support tickets", group: "work-management", icon: "ticket",
      anyOf: ["support.ticket.manage"],
    },
    {
      path: "/incidents", label: "Incidents", group: "work-management", icon: "alert",
      anyOf: ["incident.manage"],
    },
  ]),
];

/** The permission predicate: no gate = visible to the dashboard's role
 *  (the layout already role-gates the whole tree); anyOf = at least one
 *  held; allOf = every one held. */
export function navItemVisible(
  item: NavItemDef,
  permissions: ReadonlySet<string>,
): boolean {
  if (item.anyOf && !item.anyOf.some((code) => permissions.has(code))) return false;
  if (item.allOf && !item.allOf.every((code) => permissions.has(code))) return false;
  return true;
}

export function visibleNavItems(
  permissions: ReadonlySet<string>,
  dashboard: DashboardId,
): NavItemDef[] {
  return NAV_ITEMS.filter(
    (item) => item.dashboard === dashboard && navItemVisible(item, permissions),
  );
}

export interface NavGroup {
  id: NavGroupId;
  label: string;
  items: NavItemDef[];
}

export function groupNavItems(items: readonly NavItemDef[]): NavGroup[] {
  return NAV_GROUP_ORDER.map((id) => ({
    id,
    label: NAV_GROUP_LABELS[id],
    items: items.filter((item) => item.group === id),
  })).filter((group) => group.items.length > 0);
}

export function visibleQuickActions(
  permissions: ReadonlySet<string>,
  dashboard: DashboardId,
): NavItemDef[] {
  return visibleNavItems(permissions, dashboard).filter((item) => item.quickAction);
}

/** Serializable projection the server shell hands to client chrome
 *  (sidebar, search) — no functions, no permission internals beyond
 *  what the actor already sees rendered. */
export interface NavItemView {
  id: string;
  label: string;
  href: string;
  icon: NavIconName;
}

export interface NavGroupView {
  id: NavGroupId;
  label: string;
  items: NavItemView[];
}

export function toNavGroupViews(groups: readonly NavGroup[]): NavGroupView[] {
  return groups.map((group) => ({
    id: group.id,
    label: group.label,
    items: group.items.map((item) => ({
      id: item.id,
      label: item.label,
      href: item.href,
      icon: item.icon,
    })),
  }));
}
