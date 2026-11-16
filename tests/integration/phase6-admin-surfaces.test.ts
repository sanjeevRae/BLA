import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

// `server-only` throws outside a React Server Component environment; the
// services under test are server-only code, so stub the marker module.
vi.mock("server-only", () => ({}));

// Point the app at bla_test BEFORE the service layer is imported (same
// pattern as warehouses.test.ts). Refuse to run anywhere else.
function readDevDatabaseUrl(): string {
  for (const file of [".env.local", "prisma/.env"]) {
    try {
      const text = readFileSync(path.resolve(process.cwd(), file), "utf8");
      const match = text.match(/^DATABASE_URL=(.+)$/m);
      if (match) return match[1].trim().replace(/^["']|["']$/g, "");
    } catch {
      // try the next file
    }
  }
  throw new Error("DATABASE_URL not found in .env.local or prisma/.env");
}

const devUrl = readDevDatabaseUrl();
if (new URL(devUrl).pathname !== "/bla_dev") {
  throw new Error(
    "Integration tests require DATABASE_URL to target bla_dev (it is rewritten to bla_test).",
  );
}
const marker = "/bla_dev";
const idx = devUrl.lastIndexOf(marker);
process.env.DATABASE_URL =
  devUrl.slice(0, idx) + "/bla_test" + devUrl.slice(idx + marker.length);

const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6)}`;
const email = (label: string) => `${label}-${RUN}@test.local`;

let prisma: PrismaClient;
let usersSvc: typeof import("@/server/services/users");
let settingsSvc: typeof import("@/server/services/system-settings");
let auditSvc: typeof import("@/server/services/audit-log");
let errors: typeof import("@/lib/errors");
let actorLib: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

let saId: string;
let adminId: string;
let financeId: string;
let staffId: string;
let waId: string;
let warehouseId: string;
let otherWarehouseId: string;

async function actorFor(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: {
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      },
      memberships: { where: { revokedAt: null }, include: { role: true } },
    },
  });
  if (!user) throw new Error("fixture user missing");
  const roles: string[] = [];
  const permissions = new Set<string>();
  for (const userRole of user.roles) {
    if (!userRole.role.isActive) continue;
    roles.push(userRole.role.code);
    for (const rp of userRole.role.permissions) permissions.add(rp.permission.code);
  }
  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    roles: roles as never[],
    primaryRole: catalog.primaryRoleFor(roles as never[]),
    permissions,
    warehouseIds: user.memberships.map((m) => m.warehouseId),
    membershipRoles: user.memberships.map((m) => ({
      warehouseId: m.warehouseId,
      roleCode: m.role.code as never,
    })),
    vendorId: null,
    vendorRole: null,
    driverId: null,
    customerId: null,
    landingPath: catalog.landingPathForRoles(roles as never[]),
  };
}

async function makeUser(label: string, roleCode: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `P6 ${label} ${RUN}`,
      passwordHash: await hash("fixture-password", 10),
      status: "ACTIVE",
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role ${roleCode} not seeded in bla_test`);
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user.id;
}

async function makeWarehouse(prefix: string): Promise<string> {
  for (let n = 10; n < 100; n++) {
    try {
      const wh = await prisma.warehouse.create({
        data: {
          code: `WH-${prefix}-${n}`,
          name: `Phase6 ${prefix} Warehouse`,
          type: "REGIONAL",
          district: "Kathmandu",
          city: "Kathmandu",
          province: "Bagmati",
          status: "ACTIVE",
        },
      });
      return wh.id;
    } catch (e) {
      if ((e as { code?: string })?.code !== "P2002") throw e;
    }
  }
  throw new Error("no warehouse code available");
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  usersSvc = await import("@/server/services/users");
  settingsSvc = await import("@/server/services/system-settings");
  auditSvc = await import("@/server/services/audit-log");
  errors = await import("@/lib/errors");
  actorLib = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");

  const permissionIdByCode = new Map<string, string>();
  for (const permission of catalog.PERMISSIONS) {
    const row = await prisma.permission.upsert({
      where: { code: permission.code },
      update: { name: permission.name, module: permission.module },
      create: { code: permission.code, name: permission.name, module: permission.module },
    });
    permissionIdByCode.set(permission.code, row.id);
  }
  for (const roleDef of catalog.ROLES) {
    const role = await prisma.role.upsert({
      where: { code: roleDef.code },
      update: { name: roleDef.name },
      create: { code: roleDef.code, name: roleDef.name },
    });
    for (const code of catalog.ROLE_PERMISSIONS[roleDef.code]) {
      const permissionId = permissionIdByCode.get(code);
      if (!permissionId) continue;
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId } },
        update: {},
        create: { roleId: role.id, permissionId },
      });
    }
  }

  saId = await makeUser("sa", "SUPER_ADMIN");
  adminId = await makeUser("admin", "ADMIN");
  financeId = await makeUser("finance", "FINANCE");
  staffId = await makeUser("staff", "WAREHOUSE_STAFF");
  waId = await makeUser("wa", "WAREHOUSE_ADMIN");
  warehouseId = await makeWarehouse("PSA");
  otherWarehouseId = await makeWarehouse("PSB");
  const waRole = await prisma.role.findUnique({ where: { code: "WAREHOUSE_ADMIN" } });
  await prisma.warehouseMembership.create({
    data: { userId: waId, warehouseId, roleId: waRole!.id, isPrimary: true },
  });
}, 60_000);

afterAll(async () => {
  // Restore the shared settings rows to the documented defaults so
  // other suites (session gates, GPS config) see the seeded state.
  await prisma.systemSetting.upsert({
    where: { key: "session.idle_timeout.staff_hours" },
    update: { value: 24 },
    create: { key: "session.idle_timeout.staff_hours", value: 24 },
  });
  await prisma.systemSetting.upsert({
    where: { key: "session.idle_timeout.privileged_hours" },
    update: { value: 12 },
    create: { key: "session.idle_timeout.privileged_hours", value: 12 },
  });
  await prisma.systemSetting.upsert({
    where: { key: "auth.mfa_required_for_privileged" },
    update: { value: true },
    create: { key: "auth.mfa_required_for_privileged", value: true },
  });
  await prisma.systemSetting.deleteMany({ where: { key: "tracking.config" } });
  await prisma.$disconnect();
});

describe("listUsers (Phase 6)", () => {
  it("denies a FINANCE actor (no user.manage) and audits the denial", async () => {
    const finance = await actorFor(financeId);
    await expect(usersSvc.listUsers(finance, {})).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
    const denial = await prisma.auditLog.findFirst({
      where: { actorId: financeId, action: "access.denied", entityType: "User" },
      orderBy: { createdAt: "desc" },
    });
    expect(denial).not.toBeNull();
    expect((denial?.after as { reason?: string })?.reason).toBe(
      "missing_permission:user.manage",
    );
  }, 30_000);

  it("lists users for an Admin with a secret-free projection and working filters", async () => {
    const admin = await actorFor(adminId);
    const all = await usersSvc.listUsers(admin, { search: RUN, pageSize: 100 });
    expect(all.items.map((u) => u.id)).toEqual(
      expect.arrayContaining([saId, adminId, financeId, staffId]),
    );
    const serialized = JSON.stringify(all.items);
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("mfaSecretEncrypted");
    const staffOnly = await usersSvc.listUsers(admin, {
      search: RUN,
      roleCode: "WAREHOUSE_STAFF",
    });
    expect(staffOnly.items.map((u) => u.id)).toEqual([staffId]);
    expect(staffOnly.items[0].hasPassword).toBe(true);
  }, 30_000);
});

describe("setUserRoles protections (Phase 6)", () => {
  it("an ADMIN cannot call setUserRoles at all (no role.manage) — denied and audited", async () => {
    const admin = await actorFor(adminId);
    await expect(
      usersSvc.setUserRoles(admin, staffId, ["WAREHOUSE_STAFF", "SUPPORT"]),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
    const denial = await prisma.auditLog.findFirst({
      where: { actorId: adminId, action: "access.denied", entityType: "User", entityId: staffId },
      orderBy: { createdAt: "desc" },
    });
    expect((denial?.after as { reason?: string })?.reason).toBe("missing_permission:role.manage");
  }, 30_000);

  it("self-edit is refused", async () => {
    const sa = await actorFor(saId);
    await expect(usersSvc.setUserRoles(sa, saId, ["ADMIN"])).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
  }, 30_000);

  it("granting SUPER_ADMIN requires a Super Admin actor even when role.manage is held", async () => {
    // Synthetic actor: ADMIN identity + role.manage grafted on — the
    // catalog gives role.manage to SUPER_ADMIN only, so this isolates
    // the grant guard from the permission gate.
    const admin = await actorFor(adminId);
    const synthetic = {
      ...admin,
      permissions: new Set([...admin.permissions, "role.manage"]),
    };
    await expect(
      usersSvc.setUserRoles(synthetic as never, staffId, ["SUPER_ADMIN"]),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
  }, 30_000);

  it("the last active Super Admin cannot lose the role; with a second SA present the change applies and audits before/after", async () => {
    const sa = await actorFor(saId);
    const targetSa = await makeUser("target-sa", "SUPER_ADMIN");

    // Make targetSa the ONLY other active Super Admin besides the
    // actor by suspending every other active SA holder, then try to
    // strip the actor's own... self-edit blocks that path, so instead:
    // suspend all active SAs except targetSa and the actor, then have
    // a SECOND actor attempt the strip. Simplest deterministic setup:
    // suspend every active SA except targetSa; the actor is targetSa's
    // peer — use the (still ACTIVE) fixture SA as actor after
    // re-activating only it and targetSa.
    const allSa = await prisma.user.findMany({
      where: { status: "ACTIVE", roles: { some: { role: { code: "SUPER_ADMIN" } } } },
      select: { id: true },
    });
    const others = allSa.filter((u) => u.id !== targetSa && u.id !== saId);
    await prisma.user.updateMany({
      where: { id: { in: others.map((u) => u.id) } },
      data: { status: "SUSPENDED" },
    });
    try {
      // Now the only active SAs are the actor (saId) and targetSa:
      // stripping targetSa still leaves the actor — allowed. Strip the
      // ACTOR via a peer is impossible (self-edit), so verify the
      // protection from the other side: suspend the actor's account
      // row is not possible either. Instead directly assert the guard
      // by making targetSa the sole active SA: suspend saId's row in
      // the DB and drive the call with a synthetic SA actor whose
      // userId differs from targetSa.
      await prisma.user.update({ where: { id: saId }, data: { status: "SUSPENDED" } });
      const peer = await actorFor(saId); // context is a snapshot; status is not re-checked by the service
      await expect(
        usersSvc.setUserRoles(peer, targetSa, ["ADMIN"]),
      ).rejects.toBeInstanceOf(errors.DomainValidationError);
      const row = await prisma.user.findUnique({
        where: { id: targetSa },
        include: { roles: { include: { role: true } } },
      });
      expect(row?.roles.map((r) => r.role.code)).toContain("SUPER_ADMIN");
    } finally {
      await prisma.user.update({ where: { id: saId }, data: { status: "ACTIVE" } });
      await prisma.user.updateMany({
        where: { id: { in: others.map((u) => u.id) } },
        data: { status: "ACTIVE" },
      });
    }

    // With the actor active again, targetSa is no longer the last SA:
    // the strip applies and the audit row carries before/after codes.
    const result = await usersSvc.setUserRoles(sa, targetSa, ["ADMIN"]);
    expect(result.roles).toEqual(["ADMIN"]);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "user.roles_updated", entityType: "User", entityId: targetSa },
      orderBy: { createdAt: "desc" },
    });
    expect((audit?.before as { roles?: string[] })?.roles).toContain("SUPER_ADMIN");
    expect((audit?.after as { roles?: string[] })?.roles).toEqual(["ADMIN"]);
  }, 60_000);
});

describe("settings updates (Phase 6)", () => {
  it("rejects out-of-bounds and malformed values; applies valid ones with an audit row", async () => {
    const sa = await actorFor(saId);
    await expect(
      settingsSvc.updateSetting(sa, "session.idle_timeout.staff_hours", 0),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      settingsSvc.updateSetting(sa, "session.idle_timeout.staff_hours", 169),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      settingsSvc.updateSetting(sa, "session.idle_timeout.staff_hours", 12.5),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      settingsSvc.updateSetting(sa, "auth.mfa_required_for_privileged", "yes"),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(settingsSvc.updateSetting(sa, "unknown.key", 1)).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
    await expect(
      settingsSvc.updateSetting(sa, "tracking.config", { minPingIntervalSeconds: 1 }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      settingsSvc.updateSetting(sa, "tracking.config", { retentionDays: 30.5 }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      settingsSvc.updateSetting(sa, "tracking.config", { bogusField: 3 }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);

    const updated = await settingsSvc.updateSetting(sa, "session.idle_timeout.staff_hours", 10);
    expect(updated.value).toBe(10);
    const audit = await prisma.auditLog.findFirst({
      where: { action: "settings.updated", entityId: "session.idle_timeout.staff_hours" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).not.toBeNull();
    expect((audit?.after as { value?: number })?.value).toBe(10);
    await settingsSvc.updateSetting(sa, "session.idle_timeout.staff_hours", 24);

    const tracking = await settingsSvc.updateSetting(sa, "tracking.config", { retentionDays: 45 });
    expect((tracking.value as { retentionDays?: number }).retentionDays).toBe(45);
    await prisma.systemSetting.deleteMany({ where: { key: "tracking.config" } });
  }, 60_000);

  it("denies listSettings to an actor without settings.manage", async () => {
    const admin = await actorFor(adminId);
    await expect(settingsSvc.listSettings(admin)).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
    const list = await settingsSvc.listSettings(await actorFor(saId));
    expect(list.map((s) => s.key)).toEqual(
      expect.arrayContaining([
        "session.idle_timeout.staff_hours",
        "session.idle_timeout.privileged_hours",
        "auth.mfa_required_for_privileged",
        "tracking.config",
      ]),
    );
  }, 30_000);
});

describe("audit log reads (Phase 6)", () => {
  it("scopes non-global readers to their warehouses and filters by outcome", async () => {
    const action = `phase6.probe.${RUN}`;
    await prisma.auditLog.createMany({
      data: [
        {
          actorId: saId,
          actorRole: "SUPER_ADMIN",
          action,
          entityType: "Probe",
          warehouseId,
        },
        {
          actorId: saId,
          actorRole: "SUPER_ADMIN",
          action,
          entityType: "Probe",
          warehouseId: otherWarehouseId,
        },
        {
          actorId: saId,
          actorRole: "SUPER_ADMIN",
          action: "access.denied",
          entityType: "Probe",
          warehouseId: otherWarehouseId,
        },
      ],
    });

    const sa = await actorFor(saId);
    const all = await auditSvc.listAuditLogs(sa, { action, pageSize: 100 });
    expect(all.total).toBe(2);

    const denied = await auditSvc.listAuditLogs(sa, { outcome: "denied", pageSize: 100 });
    expect(denied.items.every((i) => i.action === "access.denied")).toBe(true);
    expect(denied.items.some((i) => i.entityType === "Probe")).toBe(true);
    const recorded = await auditSvc.listAuditLogs(sa, {
      action,
      outcome: "recorded",
      pageSize: 100,
    });
    expect(recorded.total).toBe(2);

    // Warehouse Admin holds audit.read but is NOT global: only rows
    // for their own warehouse are visible.
    const wa = await actorFor(waId);
    const waList = await auditSvc.listAuditLogs(wa, { action, pageSize: 100 });
    expect(waList.total).toBe(1);
    expect(waList.items[0].warehouseId).toBe(warehouseId);

    // Actor search matches the acting user's name/email.
    const byActor = await auditSvc.listAuditLogs(sa, { actorSearch: RUN, action, pageSize: 100 });
    expect(byActor.total).toBe(2);

    // No audit.read → denied.
    const staff = await actorFor(staffId);
    await expect(auditSvc.listAuditLogs(staff, {})).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
  }, 30_000);
});

describe("suspend / reactivate still work via the service (Phase 6)", () => {
  it("suspends and reactivates a user", async () => {
    const sa = await actorFor(saId);
    const target = await makeUser("lifecycle", "WAREHOUSE_STAFF");
    await usersSvc.suspendUser(sa, target, "phase6 test");
    let row = await prisma.user.findUnique({ where: { id: target } });
    expect(row?.status).toBe("SUSPENDED");
    await usersSvc.reactivateUser(sa, target);
    row = await prisma.user.findUnique({ where: { id: target } });
    expect(row?.status).toBe("ACTIVE");
  }, 30_000);
});
