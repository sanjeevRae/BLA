/**
 * Permission catalog — the single source of truth for roles and permissions.
 *
 * Transcribed from docs/role-permission-matrix.md §3 (the authoritative
 * matrix). The seed (prisma/seed.ts) writes these rows to the database and
 * the unit tests assert the mapping. Scoped grants in the matrix
 * (W = own warehouse, V = own vendor, A = assigned only, O = own records)
 * grant the permission code; the scope itself is enforced in the
 * data-access layer, never by the permission check alone.
 */

export const ROLE_CODES = [
  "SUPER_ADMIN",
  "ADMIN",
  "WAREHOUSE_ADMIN",
  "WAREHOUSE_STAFF",
  "RIDER",
  "LINEHAUL_DRIVER",
  "VENDOR",
  "CUSTOMER",
  "FINANCE",
  "SUPPORT",
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export interface RoleDefinition {
  code: RoleCode;
  name: string;
  description: string;
}

export const ROLES: RoleDefinition[] = [
  { code: "SUPER_ADMIN", name: "Super Admin", description: "Organization-wide authority; still audit-logged." },
  { code: "ADMIN", name: "Admin / Operations Admin", description: "Day-to-day company-wide operations." },
  { code: "WAREHOUSE_ADMIN", name: "Warehouse Admin", description: "Manages only their assigned warehouse(s)." },
  { code: "WAREHOUSE_STAFF", name: "Warehouse Staff / Operator", description: "Physical package operations in one warehouse." },
  { code: "RIDER", name: "Delivery Rider", description: "Pickup and/or final-mile delivery, capability-flagged." },
  { code: "LINEHAUL_DRIVER", name: "Line-haul Driver", description: "Warehouse-to-warehouse transport." },
  { code: "VENDOR", name: "Vendor", description: "Business customer; sub-roles refine access inside the organisation." },
  { code: "CUSTOMER", name: "Customer / Recipient", description: "Recipient account; tracking needs no account." },
  { code: "FINANCE", name: "Finance / Accounts", description: "Payments, COD, settlements. Never custody." },
  { code: "SUPPORT", name: "Customer Support", description: "Complaints, cases, investigations." },
];

export interface PermissionDefinition {
  code: string;
  name: string;
  module: string;
}

const P = (code: string, name: string, module: string): PermissionDefinition => ({ code, name, module });

export const PERMISSIONS: PermissionDefinition[] = [
  // Identity, users, system
  P("user.manage", "Create, update, deactivate and suspend users", "identity"),
  P("user.invite", "Invite users", "identity"),
  P("role.manage", "Edit role to permission mapping", "identity"),
  P("settings.manage", "Manage system settings and rules", "system"),
  P("pricing.manage", "Manage tariffs and pricing configuration", "system"),
  P("service_area.manage", "Manage service areas", "system"),
  P("audit.read", "Read the audit log", "identity"),
  P("profile.update_own", "Update own profile", "identity"),
  // Warehouses
  P("warehouse.create", "Create warehouses", "warehouses"),
  P("warehouse.read_all", "Read all warehouses", "warehouses"),
  P("warehouse.read_assigned", "Read assigned warehouse(s)", "warehouses"),
  P("warehouse.update", "Update warehouse information", "warehouses"),
  P("warehouse.deactivate", "Deactivate warehouses (never delete)", "warehouses"),
  P("warehouse.assign_staff", "Assign staff to a warehouse", "warehouses"),
  P("warehouse.manage_locations", "Manage zones, racks, shelves and bins", "warehouses"),
  P("warehouse.capacity.read", "Read warehouse capacity", "warehouses"),
  // Bookings and packages
  P("booking.create", "Create bookings", "bookings"),
  P("booking.approve", "Approve or reject vendor-submitted bookings", "bookings"),
  P("booking.read_all", "Read all bookings", "bookings"),
  P("booking.read_warehouse", "Read bookings for own warehouse", "bookings"),
  P("booking.read_vendor", "Read own vendor organisation bookings", "bookings"),
  P("booking.update", "Correct bookings within stage rules", "bookings"),
  P("booking.cancel", "Cancel bookings within stage rules", "bookings"),
  P("package.create", "Generate packages and tracking IDs", "packages"),
  P("package.read_all", "Read all packages", "packages"),
  P("package.read_assigned", "Read packages in own scope", "packages"),
  P("package.receive", "Receiving scan into inventory", "packages"),
  P("package.inspect", "Record condition, weight and damage", "packages"),
  P("package.sort", "Sort packages and set storage location", "packages"),
  P("package.hold", "Place or release a package hold", "packages"),
  P("package.change_status", "Set a package status directly (granted to NO role by design)", "packages"),
  P("package.return_initiate", "Initiate a return", "packages"),
  P("tracking.read_public", "Read the public tracking projection", "packages"),
  // Vendors and customers
  P("vendor.manage", "Create and update vendor profiles, addresses and warehouse assignments", "vendors"),
  P("vendor.approve", "Run the vendor verification lifecycle and review verification documents", "vendors"),
  P("vendor.read_all", "Read all vendor organisations", "vendors"),
  P("customer.manage", "Create, update and merge customer records", "customers"),
  P("customer.read", "Read customer records", "customers"),
  // Inventory and custody
  P("inventory.read_all", "Read inventory across all warehouses", "inventory"),
  P("inventory.read_warehouse", "Read own warehouse inventory", "inventory"),
  P("inventory.move_internal", "Move packages between internal locations", "inventory"),
  P("inventory.correct", "Correct inventory with reason and incident link", "inventory"),
  P("supplies.manage", "Manage supplies stock", "inventory"),
  P("custody.handover", "Offer or confirm a custody handover", "inventory"),
  P("custody.read", "Read custody records", "inventory"),
  // Transfers, trips, vehicles, drivers
  P("transfer.create", "Create transfers", "transport"),
  P("transfer.read_all", "Read all transfers", "transport"),
  P("transfer.read_warehouse", "Read transfers for own warehouse or assignment", "transport"),
  P("transfer.approve", "Approve transfers", "transport"),
  P("transfer.prepare", "Prepare manifests and pick packages", "transport"),
  P("transfer.load", "Perform loading scans", "transport"),
  P("transfer.dispatch", "Dispatch transfers", "transport"),
  P("transfer.receive", "Receive transfers at destination", "transport"),
  P("transfer.reconcile", "Reconcile transfer quantities", "transport"),
  P("trip.read_assigned", "Read assigned trips", "transport"),
  P("trip.update_progress", "Update trip progress and checkpoints", "transport"),
  P("trip.report_incident", "Report a trip incident", "transport"),
  P("vehicle.manage", "Manage vehicles", "transport"),
  P("vehicle.assign", "Assign vehicles", "transport"),
  P("driver.manage", "Manage driver profiles and documents", "transport"),
  P("driver.assign", "Assign work to drivers", "transport"),
  P("driver.read_self", "Read own driver record", "transport"),
  // Pickup and delivery
  P("pickup.assign", "Assign pickups", "delivery"),
  P("pickup.confirm", "Confirm pickup collection", "delivery"),
  P("delivery.assign", "Assign deliveries and batches", "delivery"),
  P("delivery.attempt.record", "Record a delivery attempt", "delivery"),
  P("delivery.confirm", "Confirm delivery with proof and COD capture", "delivery"),
  P("delivery.read_assigned", "Read assigned deliveries", "delivery"),
  P("delivery.reschedule_request", "Request delivery rescheduling", "delivery"),
  // Finance, COD, settlements
  P("finance.read", "Read financial records", "finance"),
  P("invoice.create", "Create invoices", "finance"),
  P("invoice.read", "Read invoices", "finance"),
  P("finance.record_payment", "Record payments", "finance"),
  P("finance.adjust", "Create linked financial adjustments", "finance"),
  P("finance.approve_adjustment", "Approve financial adjustments", "finance"),
  P("cod.collect", "Record COD collection at delivery", "finance"),
  P("cod.remit", "Submit a COD remittance", "finance"),
  P("cod.verify", "Verify COD remittances", "finance"),
  P("cod.read", "Read COD records", "finance"),
  P("settlement.read", "Read vendor settlements", "finance"),
  P("settlement.prepare", "Prepare vendor settlements", "finance"),
  P("settlement.approve", "Approve vendor settlements", "finance"),
  P("settlement.pay", "Record settlement payouts", "finance"),
  P("refund.process", "Process refunds", "finance"),
  P("payment.dispute.raise", "Raise a payment dispute", "finance"),
  // Tasks, incidents, support, notifications, reports
  P("task.create", "Create tasks", "work"),
  P("task.assign", "Assign tasks", "work"),
  P("task.update_own", "Work on own tasks", "work"),
  P("task.verify", "Review and close tasks", "work"),
  P("incident.report", "Report incidents", "work"),
  P("incident.manage", "Triage and investigate incidents", "work"),
  P("incident.resolve", "Resolve incidents", "work"),
  P("support.ticket.manage", "Manage support tickets", "work"),
  P("notification.read_own", "Read own notifications", "work"),
  P("report.read_all", "Read company-wide reports", "work"),
  P("report.read_warehouse", "Read own warehouse reports", "work"),
  P("report.read_vendor", "Read own vendor reports and statements", "work"),
  P("report.read_self", "Read own performance reports", "work"),
];

export const PERMISSION_CODES: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.code));

/**
 * Role -> permission grants, transcribed from the matrix (§3.1–§3.8).
 * Footnote restrictions (e.g. Admin cannot manage Super Admin accounts,
 * Finance adjustments need a separate approver) are enforced in services,
 * not in this table.
 */
export const ROLE_PERMISSIONS: Record<RoleCode, string[]> = {
  SUPER_ADMIN: [
    "user.manage", "user.invite", "role.manage", "settings.manage", "pricing.manage",
    "service_area.manage", "audit.read", "profile.update_own",
    "warehouse.create", "warehouse.read_all", "warehouse.read_assigned", "warehouse.update",
    "warehouse.deactivate", "warehouse.assign_staff", "warehouse.manage_locations", "warehouse.capacity.read",
    "booking.create", "booking.approve", "booking.read_all", "booking.read_warehouse", "booking.update", "booking.cancel",
    "package.create", "package.read_all", "package.read_assigned", "package.receive", "package.inspect",
    "package.sort", "package.hold", "package.return_initiate", "tracking.read_public",
    "vendor.manage", "vendor.approve", "vendor.read_all", "customer.manage", "customer.read",
    "inventory.read_all", "inventory.read_warehouse", "inventory.move_internal", "inventory.correct",
    "supplies.manage", "custody.handover", "custody.read",
    "transfer.create", "transfer.read_all", "transfer.read_warehouse", "transfer.approve",
    "transfer.prepare", "transfer.load", "transfer.dispatch", "transfer.receive", "transfer.reconcile",
    "trip.read_assigned", "trip.update_progress", "trip.report_incident",
    "vehicle.manage", "vehicle.assign", "driver.manage", "driver.assign",
    "pickup.assign", "pickup.confirm", "delivery.assign", "delivery.attempt.record",
    "delivery.confirm", "delivery.read_assigned",
    "finance.read", "invoice.create", "invoice.read", "finance.record_payment", "finance.adjust",
    "finance.approve_adjustment", "cod.verify", "cod.read",
    "settlement.read", "settlement.prepare", "settlement.approve", "settlement.pay", "refund.process",
    "task.create", "task.assign", "task.update_own", "task.verify",
    "incident.report", "incident.manage", "incident.resolve", "support.ticket.manage",
    "notification.read_own", "report.read_all", "report.read_warehouse",
  ],
  ADMIN: [
    "user.manage", "user.invite", "pricing.manage", "service_area.manage", "audit.read", "profile.update_own",
    "warehouse.create", "warehouse.read_all", "warehouse.read_assigned", "warehouse.update",
    "warehouse.deactivate", "warehouse.assign_staff", "warehouse.manage_locations", "warehouse.capacity.read",
    "booking.create", "booking.approve", "booking.read_all", "booking.read_warehouse", "booking.update", "booking.cancel",
    "package.create", "package.read_all", "package.read_assigned", "package.receive", "package.inspect",
    "package.sort", "package.hold", "package.return_initiate", "tracking.read_public",
    "vendor.manage", "vendor.approve", "vendor.read_all", "customer.manage", "customer.read",
    "inventory.read_all", "inventory.read_warehouse", "inventory.move_internal", "inventory.correct",
    "supplies.manage", "custody.handover", "custody.read",
    "transfer.create", "transfer.read_all", "transfer.read_warehouse", "transfer.approve",
    "transfer.prepare", "transfer.load", "transfer.dispatch", "transfer.receive", "transfer.reconcile",
    "trip.read_assigned", "trip.update_progress", "trip.report_incident",
    "vehicle.manage", "vehicle.assign", "driver.manage", "driver.assign",
    "pickup.assign", "pickup.confirm", "delivery.assign", "delivery.attempt.record",
    "delivery.confirm", "delivery.read_assigned",
    "finance.read", "invoice.read", "cod.read", "settlement.read", "settlement.approve",
    "task.create", "task.assign", "task.update_own", "task.verify",
    "incident.report", "incident.manage", "incident.resolve", "support.ticket.manage",
    "notification.read_own", "report.read_all", "report.read_warehouse",
  ],
  WAREHOUSE_ADMIN: [
    "user.invite", "audit.read", "profile.update_own",
    "warehouse.read_assigned", "warehouse.update", "warehouse.assign_staff",
    "warehouse.manage_locations", "warehouse.capacity.read",
    "booking.create", "booking.read_warehouse", "booking.update", "booking.cancel",
    "package.create", "package.read_assigned", "package.receive", "package.inspect",
    "package.sort", "package.hold", "package.return_initiate", "tracking.read_public",
    "inventory.read_warehouse", "inventory.move_internal", "inventory.correct",
    "supplies.manage", "custody.handover", "custody.read",
    "transfer.create", "transfer.read_warehouse", "transfer.approve", "transfer.prepare",
    "transfer.load", "transfer.dispatch", "transfer.receive", "transfer.reconcile",
    "trip.read_assigned", "trip.update_progress", "trip.report_incident",
    "vehicle.assign", "driver.manage", "driver.assign",
    "pickup.assign", "pickup.confirm", "delivery.assign", "delivery.attempt.record",
    "delivery.confirm", "delivery.read_assigned",
    "cod.read",
    "task.create", "task.assign", "task.update_own", "task.verify",
    "incident.report", "incident.manage", "incident.resolve",
    "notification.read_own", "report.read_warehouse",
  ],
  WAREHOUSE_STAFF: [
    "profile.update_own",
    "warehouse.read_assigned", "warehouse.capacity.read",
    "booking.read_warehouse",
    "package.read_assigned", "package.receive", "package.inspect", "package.sort", "tracking.read_public",
    "inventory.read_warehouse", "inventory.move_internal", "supplies.manage",
    "custody.handover", "custody.read",
    "transfer.read_warehouse", "transfer.prepare", "transfer.load", "transfer.receive",
    "trip.report_incident",
    "task.update_own", "incident.report", "notification.read_own",
  ],
  RIDER: [
    "profile.update_own", "warehouse.read_assigned",
    "package.read_assigned", "package.inspect", "package.return_initiate", "tracking.read_public",
    "custody.handover", "custody.read",
    "trip.read_assigned", "trip.update_progress", "trip.report_incident", "driver.read_self",
    "pickup.confirm", "delivery.attempt.record", "delivery.confirm", "delivery.read_assigned",
    "cod.collect", "cod.remit", "cod.read",
    "task.update_own", "incident.report", "notification.read_own", "report.read_self",
  ],
  LINEHAUL_DRIVER: [
    "profile.update_own", "warehouse.read_assigned",
    "package.read_assigned", "tracking.read_public",
    "custody.handover", "custody.read",
    "transfer.read_warehouse", "transfer.load",
    "trip.read_assigned", "trip.update_progress", "trip.report_incident", "driver.read_self",
    "task.update_own", "incident.report", "notification.read_own", "report.read_self",
  ],
  VENDOR: [
    "user.invite", "profile.update_own",
    "booking.create", "booking.read_vendor", "booking.update", "booking.cancel",
    "package.create", "package.return_initiate", "tracking.read_public",
    "custody.read", "delivery.reschedule_request",
    "invoice.read", "cod.read", "settlement.read", "payment.dispute.raise",
    "incident.report", "notification.read_own", "report.read_vendor",
  ],
  CUSTOMER: [
    "profile.update_own", "tracking.read_public",
    "package.return_initiate", "delivery.reschedule_request",
    "invoice.read", "payment.dispute.raise", "incident.report",
  ],
  FINANCE: [
    "audit.read", "profile.update_own",
    "warehouse.read_all",
    "booking.read_all", "package.read_all", "tracking.read_public",
    "vendor.read_all",
    "finance.read", "invoice.create", "invoice.read", "finance.record_payment", "finance.adjust",
    "cod.verify", "cod.read",
    "settlement.read", "settlement.prepare", "settlement.pay", "refund.process",
    "task.create", "task.assign", "task.update_own", "task.verify",
    "incident.report", "incident.manage", "incident.resolve",
    "notification.read_own", "report.read_all",
  ],
  SUPPORT: [
    "profile.update_own",
    "warehouse.read_all",
    "vendor.read_all", "customer.read",
    "booking.read_all", "booking.update",
    "package.read_all", "package.hold", "package.return_initiate", "tracking.read_public",
    "transfer.read_all", "custody.read",
    "delivery.reschedule_request", "payment.dispute.raise",
    "task.create", "task.assign", "task.update_own", "task.verify",
    "incident.report", "incident.manage", "incident.resolve", "support.ticket.manage",
    "notification.read_own",
  ],
};

/** Precedence for choosing the primary role (landing + display). */
export const ROLE_PRECEDENCE: RoleCode[] = [
  "SUPER_ADMIN",
  "ADMIN",
  "WAREHOUSE_ADMIN",
  "WAREHOUSE_STAFF",
  "RIDER",
  "LINEHAUL_DRIVER",
  "VENDOR",
  "FINANCE",
  "SUPPORT",
  "CUSTOMER",
];

export const ROLE_LANDING_PATH: Record<RoleCode, string> = {
  SUPER_ADMIN: "/super-admin",
  ADMIN: "/admin",
  WAREHOUSE_ADMIN: "/warehouse",
  WAREHOUSE_STAFF: "/staff",
  RIDER: "/rider",
  LINEHAUL_DRIVER: "/transport-driver",
  VENDOR: "/vendor",
  CUSTOMER: "/customer",
  FINANCE: "/finance",
  SUPPORT: "/support",
};

export function primaryRoleFor(roles: readonly string[]): RoleCode | null {
  for (const code of ROLE_PRECEDENCE) {
    if (roles.includes(code)) return code;
  }
  return null;
}

export function landingPathForRoles(roles: readonly string[]): string {
  const primary = primaryRoleFor(roles);
  return primary ? ROLE_LANDING_PATH[primary] : "/login";
}
