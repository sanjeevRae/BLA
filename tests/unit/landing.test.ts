import { describe, expect, it } from "vitest";

import { landingPathForRoles, primaryRoleFor } from "@/lib/permissions/catalog";

describe("role-based landing (docs/security-architecture.md §2)", () => {
  it("lands each single role on its own dashboard", () => {
    expect(landingPathForRoles(["SUPER_ADMIN"])).toBe("/super-admin");
    expect(landingPathForRoles(["ADMIN"])).toBe("/admin");
    expect(landingPathForRoles(["WAREHOUSE_ADMIN"])).toBe("/warehouse");
    expect(landingPathForRoles(["WAREHOUSE_STAFF"])).toBe("/staff");
    expect(landingPathForRoles(["RIDER"])).toBe("/rider");
    expect(landingPathForRoles(["LINEHAUL_DRIVER"])).toBe("/transport-driver");
    expect(landingPathForRoles(["VENDOR"])).toBe("/vendor");
    expect(landingPathForRoles(["CUSTOMER"])).toBe("/customer");
    expect(landingPathForRoles(["FINANCE"])).toBe("/finance");
    expect(landingPathForRoles(["SUPPORT"])).toBe("/support");
  });

  it("picks the highest-precedence role when a user holds several", () => {
    expect(primaryRoleFor(["VENDOR", "ADMIN"])).toBe("ADMIN");
    expect(primaryRoleFor(["WAREHOUSE_STAFF", "WAREHOUSE_ADMIN"])).toBe("WAREHOUSE_ADMIN");
    expect(primaryRoleFor(["CUSTOMER", "SUPER_ADMIN"])).toBe("SUPER_ADMIN");
    expect(landingPathForRoles(["RIDER", "WAREHOUSE_STAFF"])).toBe("/staff");
  });

  it("sends role-less or unknown-role users back to login", () => {
    expect(primaryRoleFor([])).toBeNull();
    expect(landingPathForRoles([])).toBe("/login");
    expect(landingPathForRoles(["not-a-role"])).toBe("/login");
  });
});
