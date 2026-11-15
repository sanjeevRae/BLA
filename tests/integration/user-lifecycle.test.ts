import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hash } from "bcryptjs";
import type { PrismaClient } from "@prisma/client";

// `server-only` throws outside a React Server Component environment.
vi.mock("server-only", () => ({}));

// Same bla_test targeting pattern as the other integration tests.
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
let invitationsSvc: typeof import("@/server/services/invitations");
let verifyCredentials: typeof import("@/server/services/authentication").verifyCredentials;
let errors: typeof import("@/lib/errors");
let catalog: typeof import("@/lib/permissions/catalog");

let adminId: string;

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

async function makeUser(
  label: string,
  password: string,
  opts: { roleCode?: string; mustChangePassword?: boolean } = {},
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `Test ${label}`,
      passwordHash: await hash(password, 10),
      status: "ACTIVE",
      mustChangePassword: opts.mustChangePassword ?? false,
    },
  });
  if (opts.roleCode) {
    const role = await prisma.role.findUnique({ where: { code: opts.roleCode } });
    if (!role) throw new Error(`role ${opts.roleCode} not seeded in bla_test`);
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }
  return user.id;
}

async function addSession(userId: string, token: string): Promise<void> {
  await prisma.session.create({
    data: {
      userId,
      sessionToken: token,
      expires: new Date(Date.now() + 3_600_000),
    },
  });
}

const meta = { ipAddress: "198.51.100.40", userAgent: "vitest" };

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  usersSvc = await import("@/server/services/users");
  invitationsSvc = await import("@/server/services/invitations");
  ({ verifyCredentials } = await import("@/server/services/authentication"));
  errors = await import("@/lib/errors");
  catalog = await import("@/lib/permissions/catalog");

  // Ensure the catalog exists in bla_test (idempotent; shared with the
  // warehouses integration test — upserts are safe under either order).
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

  adminId = await makeUser("admin", "admin-password-1", { roleCode: "ADMIN" });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("password change (security doc §4)", () => {
  it("revokes all OTHER sessions, keeps the current one, and audits", async () => {
    const userId = await makeUser("changer", "old-password-1");
    await addSession(userId, `tok-current-${RUN}`);
    await addSession(userId, `tok-other-${RUN}`);

    const actor = await actorFor(userId);
    await usersSvc.changePassword(
      actor,
      { currentPassword: "old-password-1", newPassword: "new-password-1" },
      `tok-current-${RUN}`,
    );

    const sessions = await prisma.session.findMany({ where: { userId } });
    expect(sessions.map((s) => s.sessionToken)).toEqual([`tok-current-${RUN}`]);

    const audit = await prisma.auditLog.findFirst({
      where: { actorId: userId, action: "user.password_changed" },
    });
    expect(audit).not.toBeNull();

    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(
      await verifyCredentials(user!.email, "new-password-1", meta),
    ).not.toBeNull();
    expect(await verifyCredentials(user!.email, "old-password-1", meta)).toBeNull();
  }, 30_000);

  it("rejects a wrong current password and reusing the same password", async () => {
    const userId = await makeUser("changer2", "old-password-2");
    const actor = await actorFor(userId);
    await expect(
      usersSvc.changePassword(
        actor,
        { currentPassword: "not-the-password", newPassword: "new-password-2" },
        null,
      ),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    await expect(
      usersSvc.changePassword(
        actor,
        { currentPassword: "old-password-2", newPassword: "old-password-2" },
        null,
      ),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
  }, 30_000);
});

describe("mustChangePassword (security doc §2)", () => {
  it("verifyCredentials surfaces the flag so login can force the set-password step", async () => {
    const userId = await makeUser("flagged", "temp-password-1", {
      mustChangePassword: true,
    });
    const user = await prisma.user.findUnique({ where: { id: userId } });
    const result = await verifyCredentials(user!.email, "temp-password-1", meta);
    expect(result?.mustChangePassword).toBe(true);

    // After changing, the flag clears.
    const actor = await actorFor(userId);
    await usersSvc.changePassword(
      actor,
      { currentPassword: "temp-password-1", newPassword: "chosen-password-1" },
      null,
    );
    const after = await prisma.user.findUnique({ where: { id: userId } });
    expect(after?.mustChangePassword).toBe(false);
  }, 30_000);
});

describe("suspension (security doc §4)", () => {
  it("deletes ALL sessions, blocks login, and audits; reactivation restores login", async () => {
    const targetId = await makeUser("target", "target-password-1");
    await addSession(targetId, `tok-a-${RUN}`);
    await addSession(targetId, `tok-b-${RUN}`);

    const admin = await actorFor(adminId);
    await usersSvc.suspendUser(admin, targetId);

    const target = await prisma.user.findUnique({ where: { id: targetId } });
    expect(target?.status).toBe("SUSPENDED");
    expect(await prisma.session.count({ where: { userId: targetId } })).toBe(0);
    expect(
      await verifyCredentials(target!.email, "target-password-1", meta),
    ).toBeNull();
    const audit = await prisma.auditLog.findFirst({
      where: { actorId: adminId, action: "user.suspended", entityId: targetId },
    });
    expect(audit).not.toBeNull();

    await usersSvc.reactivateUser(admin, targetId);
    expect(
      await verifyCredentials(target!.email, "target-password-1", meta),
    ).not.toBeNull();
  }, 30_000);

  it("an admin cannot suspend themselves", async () => {
    const admin = await actorFor(adminId);
    await expect(usersSvc.suspendUser(admin, adminId)).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
  }, 30_000);
});

describe("invitations (security doc §5)", () => {
  it("stores only the token hash; acceptance is single-use and sets the password", async () => {
    const admin = await actorFor(adminId);
    const inviteeEmail = email("invitee");
    const created = await invitationsSvc.createInvitation(admin, {
      email: inviteeEmail,
      roleCode: "WAREHOUSE_STAFF",
    });
    const token = created.token;
    const invitation = { id: created.invitationId };

    const row = await prisma.userInvitation.findUnique({ where: { id: invitation.id } });
    expect(row?.tokenHash).not.toBe(token);
    expect(row?.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(row?.status).toBe("PENDING");

    const accepted = await invitationsSvc.acceptInvitation({
      token,
      fullName: "Invited Person",
      password: "invitee-password-1",
    });
    expect(accepted.email).toBe(inviteeEmail);
    expect(
      await verifyCredentials(inviteeEmail, "invitee-password-1", meta),
    ).not.toBeNull();

    const after = await prisma.userInvitation.findUnique({ where: { id: invitation.id } });
    expect(after?.status).toBe("ACCEPTED");
    expect(after?.acceptedAt).not.toBeNull();

    // Single-use: the same token can never be accepted again.
    await expect(
      invitationsSvc.acceptInvitation({
        token,
        fullName: "Second Try",
        password: "invitee-password-2",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "user.invitation_accepted", entityId: invitation.id },
    });
    expect(audit).not.toBeNull();
  }, 30_000);

  it("an expired invitation is rejected and marked EXPIRED", async () => {
    const rawToken = `expired-token-${RUN}-0123456789abcdef`; // ≥32 chars (schema minimum)
    const role = await prisma.role.findUnique({ where: { code: "WAREHOUSE_STAFF" } });
    const invitation = await prisma.userInvitation.create({
      data: {
        email: email("expired"),
        roleId: role!.id,
        tokenHash: createHash("sha256").update(rawToken).digest("hex"),
        status: "PENDING",
        invitedById: adminId,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    await expect(
      invitationsSvc.acceptInvitation({
        token: rawToken,
        fullName: "Too Late",
        password: "late-password-1",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
    const after = await prisma.userInvitation.findUnique({ where: { id: invitation.id } });
    expect(after?.status).toBe("EXPIRED");
  }, 30_000);

  it("an unknown token is rejected without creating a user", async () => {
    await expect(
      invitationsSvc.acceptInvitation({
        token: `unknown-token-${RUN}-0123456789abcdef`, // ≥32 chars (schema minimum)
        fullName: "Ghost",
        password: "ghost-password-1",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);
  }, 30_000);
});
