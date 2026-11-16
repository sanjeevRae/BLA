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
const PASSWORD = "fixture-password-1";

let prisma: PrismaClient;
let inv: typeof import("@/server/services/invitations");
let errors: typeof import("@/lib/errors");
let actorLib: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");

let sa1Id: string;
let sa2Id: string;
let adminId: string;
let warehouseId: string;

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
      fullName: `Test ${label}`,
      passwordHash: await hash("fixture-password", 10),
      status: "ACTIVE",
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role ${roleCode} not seeded in bla_test`);
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user.id;
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  inv = await import("@/server/services/invitations");
  errors = await import("@/lib/errors");
  actorLib = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");

  // Role/permission catalog must exist in bla_test (idempotent upserts,
  // same as prisma/seed.ts).
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

  sa1Id = await makeUser("sa-one", "SUPER_ADMIN");
  sa2Id = await makeUser("sa-two", "SUPER_ADMIN");
  adminId = await makeUser("admin", "ADMIN");

  // A warehouse for the staff-invitation fixture (draw an unused code).
  for (let n = 10; n < 100; n++) {
    try {
      const wh = await prisma.warehouse.create({
        data: {
          code: `WH-TFE-${n}`,
          name: "Phase6 Four-Eyes Warehouse",
          type: "REGIONAL",
          district: "Kathmandu",
          city: "Kathmandu",
          province: "Bagmati",
          status: "ACTIVE",
        },
      });
      warehouseId = wh.id;
      break;
    } catch (e) {
      if ((e as { code?: string })?.code !== "P2002") throw e;
    }
  }
  if (!warehouseId) throw new Error("no warehouse code available for fixtures");
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe("four-eyes privileged invitations (Phase 6)", () => {
  it("a SUPER_ADMIN invitation lands in PENDING_APPROVAL and cannot be redeemed before approval", async () => {
    const sa1 = await actorFor(sa1Id);
    const created = await inv.createInvitation(sa1, {
      email: email("new-sa"),
      roleCode: "SUPER_ADMIN",
    });
    expect(created.status).toBe("PENDING_APPROVAL");

    const row = await prisma.userInvitation.findUnique({ where: { id: created.invitationId } });
    expect(row?.status).toBe("PENDING_APPROVAL");

    const audit = await prisma.auditLog.findFirst({
      where: { action: "user.invited", entityId: created.invitationId },
    });
    expect((audit?.after as { pendingApproval?: boolean })?.pendingApproval).toBe(true);

    // Redemption before approval: the generic refusal, indistinguishable
    // from an invalid token.
    await expect(
      inv.acceptInvitation({ token: created.token, fullName: "New SA", password: PASSWORD }),
    ).rejects.toThrow(inv.INVITATION_GENERIC_REFUSAL);
    const after = await prisma.userInvitation.findUnique({ where: { id: created.invitationId } });
    expect(after?.status).toBe("PENDING_APPROVAL");
  }, 30_000);

  it("the duplicate-pending check also covers PENDING_APPROVAL invitations", async () => {
    const sa1 = await actorFor(sa1Id);
    const target = email("dup-pending");
    await inv.createInvitation(sa1, { email: target, roleCode: "ADMIN" });
    await expect(
      inv.createInvitation(sa1, { email: target, roleCode: "ADMIN" }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  }, 30_000);

  it("self-approval is refused and audited; a second Super Admin approves and redemption then succeeds with the role", async () => {
    const sa1 = await actorFor(sa1Id);
    const created = await inv.createInvitation(sa1, {
      email: email("second-sa"),
      roleCode: "SUPER_ADMIN",
    });

    await expect(inv.approveInvitation(sa1, created.invitationId)).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
    const denial = await prisma.auditLog.findFirst({
      where: {
        actorId: sa1Id,
        action: "access.denied",
        entityType: "UserInvitation",
        entityId: created.invitationId,
      },
      orderBy: { createdAt: "desc" },
    });
    expect(denial).not.toBeNull();
    expect((denial?.after as { reason?: string })?.reason).toBe("invitation_self_approval");

    // An ADMIN cannot approve a SUPER_ADMIN invitation (eligibility
    // mirrors invite rights).
    const admin = await actorFor(adminId);
    await expect(inv.approveInvitation(admin, created.invitationId)).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );

    const sa2 = await actorFor(sa2Id);
    const approved = await inv.approveInvitation(sa2, created.invitationId);
    expect(approved.status).toBe("PENDING");
    expect(approved.approvedById).toBe(sa2Id);
    expect(approved.approvedAt).not.toBeNull();

    const accepted = await inv.acceptInvitation({
      token: created.token,
      fullName: "Second SA",
      password: PASSWORD,
    });
    expect(accepted.roleCode).toBe("SUPER_ADMIN");
    const newUser = await prisma.user.findUnique({
      where: { id: accepted.userId },
      include: { roles: { include: { role: true } } },
    });
    expect(newUser?.roles.map((r) => r.role.code)).toContain("SUPER_ADMIN");
  }, 30_000);

  it("an ADMIN invitation can be approved by a user.manage holder who is not the inviter", async () => {
    const sa1 = await actorFor(sa1Id);
    const created = await inv.createInvitation(sa1, {
      email: email("new-admin"),
      roleCode: "ADMIN",
    });
    expect(created.status).toBe("PENDING_APPROVAL");

    const admin = await actorFor(adminId);
    const approved = await inv.approveInvitation(admin, created.invitationId);
    expect(approved.status).toBe("PENDING");

    const accepted = await inv.acceptInvitation({
      token: created.token,
      fullName: "New Admin",
      password: PASSWORD,
    });
    expect(accepted.roleCode).toBe("ADMIN");
  }, 30_000);

  it("rejection is terminal: status REJECTED and the token can never be redeemed", async () => {
    const sa1 = await actorFor(sa1Id);
    const created = await inv.createInvitation(sa1, {
      email: email("rejected-admin"),
      roleCode: "ADMIN",
    });
    const sa2 = await actorFor(sa2Id);
    const rejected = await inv.rejectInvitation(sa2, created.invitationId, "Not needed");
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.rejectedById).toBe(sa2Id);
    expect(rejected.rejectionReason).toBe("Not needed");

    await expect(
      inv.acceptInvitation({ token: created.token, fullName: "Rejected", password: PASSWORD }),
    ).rejects.toThrow(inv.INVITATION_GENERIC_REFUSAL);

    // And it cannot be approved after rejection either.
    await expect(inv.approveInvitation(sa2, created.invitationId)).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
  }, 30_000);

  it("a non-privileged invitation is unchanged: PENDING and redeemable immediately", async () => {
    const sa1 = await actorFor(sa1Id);
    const created = await inv.createInvitation(sa1, {
      email: email("new-staff"),
      roleCode: "WAREHOUSE_STAFF",
      warehouseId,
    });
    expect(created.status).toBe("PENDING");
    const accepted = await inv.acceptInvitation({
      token: created.token,
      fullName: "New Staff",
      password: PASSWORD,
    });
    expect(accepted.roleCode).toBe("WAREHOUSE_STAFF");
  }, 30_000);

  it("revoking a PENDING_APPROVAL invitation blocks approval and redemption", async () => {
    const sa1 = await actorFor(sa1Id);
    const created = await inv.createInvitation(sa1, {
      email: email("revoked-admin"),
      roleCode: "ADMIN",
    });
    const revoked = await inv.revokeInvitation(sa1, created.invitationId);
    expect(revoked.status).toBe("REVOKED");

    const sa2 = await actorFor(sa2Id);
    await expect(inv.approveInvitation(sa2, created.invitationId)).rejects.toBeInstanceOf(
      errors.DomainValidationError,
    );
    await expect(
      inv.acceptInvitation({ token: created.token, fullName: "Revoked", password: PASSWORD }),
    ).rejects.toThrow(inv.INVITATION_GENERIC_REFUSAL);
  }, 30_000);

  it("listInvitations exposes the approval queue by status filter", async () => {
    const sa1 = await actorFor(sa1Id);
    const created = await inv.createInvitation(sa1, {
      email: email("queue-admin"),
      roleCode: "ADMIN",
    });
    const queue = await inv.listInvitations(sa1, { status: "PENDING_APPROVAL", pageSize: 100 });
    expect(queue.items.map((i) => i.id)).toContain(created.invitationId);
    const pendingOnly = await inv.listInvitations(sa1, { status: "PENDING", pageSize: 100 });
    expect(pendingOnly.items.map((i) => i.id)).not.toContain(created.invitationId);
    // The projection never carries token material.
    expect(JSON.stringify(queue.items)).not.toContain("tokenHash");
  }, 30_000);
});
