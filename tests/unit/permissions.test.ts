import { describe, expect, it } from "vitest";

import {
  AuthorizationError,
  hasPermission,
  requirePermission,
  type ActorContext,
} from "@/lib/auth/actor";
import {
  PERMISSIONS,
  PERMISSION_CODES,
  ROLES,
  ROLE_PERMISSIONS,
  type RoleCode,
} from "@/lib/permissions/catalog";

/** Build an ActorContext whose permissions come straight from the catalog. */
function actorForRole(role: RoleCode): ActorContext {
  return {
    userId: "00000000-0000-0000-0000-000000000001",
    email: `${role.toLowerCase()}@example.test`,
    fullName: `Test ${role}`,
    status: "ACTIVE",
    mustChangePassword: false,
    roles: [role],
    primaryRole: role,
    permissions: new Set(ROLE_PERMISSIONS[role]),
    warehouseIds: [],
    vendorId: null,
    driverId: null,
    customerId: null,
    landingPath: "/login",
  };
}

describe("permission catalog integrity", () => {
  it("defines every role from the matrix", () => {
    expect(ROLES.map((r) => r.code)).toEqual([
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
    ]);
  });

  it("grants only permissions that exist in the catalog", () => {
    for (const role of ROLES) {
      for (const code of ROLE_PERMISSIONS[role.code]) {
        expect(PERMISSION_CODES.has(code), `${role.code} -> ${code}`).toBe(true);
      }
    }
  });

  it("has no duplicate grants within a role", () => {
    for (const role of ROLES) {
      const grants = ROLE_PERMISSIONS[role.code];
      expect(new Set(grants).size, role.code).toBe(grants.length);
    }
  });

  it("every role holds at least one permission", () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role.code].length, role.code).toBeGreaterThan(0);
    }
  });

  it("package.change_status is granted to NO role (lifecycle service only)", () => {
    expect(PERMISSIONS.some((p) => p.code === "package.change_status")).toBe(true);
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role.code]).not.toContain("package.change_status");
    }
  });
});

describe("permission decisions (docs/role-permission-matrix.md §3)", () => {
  it("Finance cannot touch physical custody (spec §4.9 separation)", () => {
    const finance = actorForRole("FINANCE");
    for (const custodyPermission of [
      "package.receive",
      "transfer.dispatch",
      "package.sort",
      "delivery.confirm",
      "custody.handover",
      "inventory.move_internal",
    ]) {
      expect(hasPermission(finance, custodyPermission), custodyPermission).toBe(false);
    }
    // ...while holding its own finance permissions.
    expect(hasPermission(finance, "finance.adjust")).toBe(true);
    expect(hasPermission(finance, "cod.verify")).toBe(true);
    expect(hasPermission(finance, "settlement.pay")).toBe(true);
  });

  it("Warehouse roles cannot touch financial records", () => {
    for (const role of ["WAREHOUSE_ADMIN", "WAREHOUSE_STAFF"] as const) {
      const actor = actorForRole(role);
      expect(hasPermission(actor, "finance.record_payment"), role).toBe(false);
      expect(hasPermission(actor, "finance.adjust"), role).toBe(false);
      expect(hasPermission(actor, "settlement.pay"), role).toBe(false);
    }
  });

  it("Warehouse Admin is scoped: holds warehouse operations, not global reads", () => {
    const warehouseAdmin = actorForRole("WAREHOUSE_ADMIN");
    expect(hasPermission(warehouseAdmin, "package.receive")).toBe(true);
    expect(hasPermission(warehouseAdmin, "transfer.reconcile")).toBe(true);
    expect(hasPermission(warehouseAdmin, "package.read_all")).toBe(false);
    expect(hasPermission(warehouseAdmin, "inventory.read_all")).toBe(false);
    expect(hasPermission(warehouseAdmin, "warehouse.create")).toBe(false);
  });

  it("a Warehouse Admin actor lacks Super-Admin-only permissions", () => {
    const warehouseAdmin = actorForRole("WAREHOUSE_ADMIN");
    // role.manage and settings.manage are Super Admin only in the matrix.
    expect(hasPermission(warehouseAdmin, "role.manage")).toBe(false);
    expect(hasPermission(warehouseAdmin, "settings.manage")).toBe(false);
    expect(() => requirePermission(warehouseAdmin, "role.manage")).toThrow(AuthorizationError);
    expect(() => requirePermission(warehouseAdmin, "settings.manage")).toThrow(/role\.manage|settings\.manage/);
    // ...and the same guard passes for a permission the role does hold.
    expect(() => requirePermission(warehouseAdmin, "package.receive")).not.toThrow();
  });

  it("Super Admin holds organisation-security permissions but not rider-only COD collection", () => {
    const superAdmin = actorForRole("SUPER_ADMIN");
    expect(hasPermission(superAdmin, "role.manage")).toBe(true);
    expect(hasPermission(superAdmin, "user.manage")).toBe(true);
    expect(hasPermission(superAdmin, "finance.approve_adjustment")).toBe(true);
    // cod.collect / cod.remit belong to the rider at the door, not to admins.
    expect(hasPermission(superAdmin, "cod.collect")).toBe(false);
    expect(hasPermission(superAdmin, "cod.remit")).toBe(false);
  });

  it("Admin cannot approve financial adjustments or manage roles", () => {
    const admin = actorForRole("ADMIN");
    expect(hasPermission(admin, "finance.approve_adjustment")).toBe(false);
    expect(hasPermission(admin, "role.manage")).toBe(false);
    expect(hasPermission(admin, "settings.manage")).toBe(false);
    expect(hasPermission(admin, "settlement.approve")).toBe(true);
  });

  it("Rider sees assigned work only — no warehouse or user administration", () => {
    const rider = actorForRole("RIDER");
    expect(hasPermission(rider, "delivery.confirm")).toBe(true);
    expect(hasPermission(rider, "cod.collect")).toBe(true);
    expect(hasPermission(rider, "warehouse.update")).toBe(false);
    expect(hasPermission(rider, "user.manage")).toBe(false);
    expect(hasPermission(rider, "package.read_all")).toBe(false);
    expect(() => requirePermission(rider, "driver.assign")).toThrow(AuthorizationError);
  });

  it("Vendor is confined to its own organisation's surface", () => {
    const vendor = actorForRole("VENDOR");
    expect(hasPermission(vendor, "booking.create")).toBe(true);
    expect(hasPermission(vendor, "booking.read_vendor")).toBe(true);
    expect(hasPermission(vendor, "booking.read_all")).toBe(false);
    expect(hasPermission(vendor, "settlement.read")).toBe(true);
    expect(hasPermission(vendor, "settlement.prepare")).toBe(false);
  });
});
