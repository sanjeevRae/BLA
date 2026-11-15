import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { compare, hash } from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import type { ActorContext } from "@/lib/auth/actor";

// `server-only` throws outside a React Server Component environment; the
// services under test are server-only code, so stub the marker module.
vi.mock("server-only", () => ({}));

// The route handlers and server actions under test resolve their actor
// through "@/lib/auth/permissions" (NextAuth-backed). Stub ONLY that
// resolver: the real actor module (errors, requirePermission,
// requireUnflagged) is kept, and the services keep using the real
// "@/lib/auth/actor" — so the P2-3 gate is exercised end to end.
const mockState = vi.hoisted(() => ({
  actor: null as ActorContext | null,
}));
vi.mock("@/lib/auth/permissions", async () => {
  const actorModule = await vi.importActual<typeof import("@/lib/auth/actor")>(
    "@/lib/auth/actor",
  );
  return {
    ...actorModule,
    getActorContext: async () => mockState.actor,
    requireActor: async () => {
      if (!mockState.actor) throw new actorModule.AuthenticationError();
      return mockState.actor;
    },
    requireUnflaggedActor: async () => {
      if (!mockState.actor) throw new actorModule.AuthenticationError();
      actorModule.requireUnflagged(mockState.actor);
      return mockState.actor;
    },
  };
});

// Point the app at bla_test BEFORE the service layer is imported (same
// pattern as the other integration suites). Refuse to run anywhere else.
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
const pair = String((Date.now() % 90) + 10);
const CODE_A = `WH-ISA-${pair}`;
const CODE_B = `WH-ISB-${pair}`;

let prisma: PrismaClient;
let invitationsSvc: typeof import("@/server/services/invitations");
let usersSvc: typeof import("@/server/services/users");
let warehousesSvc: typeof import("@/server/services/warehouses");
let errors: typeof import("@/lib/errors");
let actorLib: typeof import("@/lib/auth/actor");
let catalog: typeof import("@/lib/permissions/catalog");
let warehousesRoute: typeof import("@/app/api/warehouses/route");
let meRoute: typeof import("@/app/api/me/route");
let invitationActions: typeof import("@/server/actions/invitations");

let adminId: string;
let waId: string;
let dualId: string;
let financeId: string;
let whA: string;
let whB: string;

/** Build an ActorContext exactly the way getActorContext does. */
async function actorFor(userId: string): Promise<ActorContext> {
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
    roles: roles as ActorContext["roles"],
    primaryRole: catalog.primaryRoleFor(roles as ActorContext["roles"]),
    permissions,
    warehouseIds: user.memberships.map((m) => m.warehouseId),
    membershipRoles: user.memberships.map((m) => ({
      warehouseId: m.warehouseId,
      roleCode: m.role.code as ActorContext["roles"][number],
    })),
    vendorId: null,
    vendorRole: null,
    driverId: null,
    customerId: null,
    landingPath: catalog.landingPathForRoles(roles as ActorContext["roles"]),
  };
}

async function makeUser(
  label: string,
  roleCode: string,
  opts: { password?: string; mustChangePassword?: boolean } = {},
): Promise<string> {
  const user = await prisma.user.create({
    data: {
      email: email(label),
      fullName: `Test ${label}`,
      passwordHash: await hash(opts.password ?? "fixture-password", 10),
      status: "ACTIVE",
      mustChangePassword: opts.mustChangePassword ?? false,
    },
  });
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new Error(`role ${roleCode} not seeded in bla_test`);
  await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  return user.id;
}

async function addMembership(
  userId: string,
  warehouseId: string,
  roleCode: "WAREHOUSE_ADMIN" | "WAREHOUSE_STAFF",
): Promise<void> {
  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  await prisma.warehouseMembership.create({
    data: { userId, warehouseId, roleId: role!.id, isPrimary: false },
  });
}

async function latestDenial(actorId: string, entityType: string) {
  return prisma.auditLog.findFirst({
    where: { actorId, action: "access.denied", entityType },
    orderBy: { createdAt: "desc" },
  });
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db/prisma"));
  invitationsSvc = await import("@/server/services/invitations");
  usersSvc = await import("@/server/services/users");
  warehousesSvc = await import("@/server/services/warehouses");
  errors = await import("@/lib/errors");
  actorLib = await import("@/lib/auth/actor");
  catalog = await import("@/lib/permissions/catalog");
  warehousesRoute = await import("@/app/api/warehouses/route");
  meRoute = await import("@/app/api/me/route");
  invitationActions = await import("@/server/actions/invitations");

  // Role/permission catalog must exist in bla_test (idempotent upserts,
  // same as prisma/seed.ts and the other integration suites).
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

  adminId = await makeUser("admin", "ADMIN");
  waId = await makeUser("wa", "WAREHOUSE_ADMIN");
  dualId = await makeUser("dual", "WAREHOUSE_ADMIN");
  financeId = await makeUser("finance", "FINANCE");

  const mkWarehouse = (code: string, name: string) =>
    prisma.warehouse.create({
      data: {
        code,
        name,
        type: "REGIONAL",
        district: "Kathmandu",
        city: "Kathmandu",
        province: "Bagmati",
        status: "ACTIVE",
      },
    });
  whA = (await mkWarehouse(CODE_A, "InviteSec Warehouse A")).id;
  whB = (await mkWarehouse(CODE_B, "InviteSec Warehouse B")).id;

  await addMembership(waId, whA, "WAREHOUSE_ADMIN");
  await addMembership(dualId, whA, "WAREHOUSE_ADMIN");
  await addMembership(dualId, whB, "WAREHOUSE_STAFF");
}, 60_000);

afterAll(async () => {
  mockState.actor = null;
  await prisma.$disconnect();
});

describe("P2-1 — invitation scope", () => {
  it("a Warehouse Admin inviting an ADMIN is denied and the denial is audited", async () => {
    const wa = await actorFor(waId);
    await expect(
      invitationsSvc.createInvitation(wa, {
        email: email("escalation"),
        roleCode: "ADMIN",
        warehouseId: whA,
      }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);

    const denial = await latestDenial(waId, "UserInvitation");
    expect(denial).not.toBeNull();
    expect((denial?.after as { reason?: string })?.reason).toBe("scoped_invite_role:ADMIN");
  }, 30_000);

  it("a Warehouse Admin inviting staff for a warehouse outside their scope is denied", async () => {
    const wa = await actorFor(waId);
    await expect(
      invitationsSvc.createInvitation(wa, {
        email: email("outsider"),
        roleCode: "WAREHOUSE_STAFF",
        warehouseId: whB,
      }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);

    const denial = await latestDenial(waId, "UserInvitation");
    expect((denial?.after as { reason?: string })?.reason).toBe(
      "scoped_invite_warehouse_out_of_scope",
    );
  }, 30_000);

  it("a Warehouse Admin can still invite staff into their own warehouse", async () => {
    const wa = await actorFor(waId);
    const created = await invitationsSvc.createInvitation(wa, {
      email: email("own-staff"),
      roleCode: "WAREHOUSE_STAFF",
      warehouseId: whA,
    });
    expect(created.token).toBeTruthy();
    expect(created.roleCode).toBe("WAREHOUSE_STAFF");
  }, 30_000);

  it("an Admin inviting an ADMIN succeeds", async () => {
    const admin = await actorFor(adminId);
    const created = await invitationsSvc.createInvitation(admin, {
      email: email("new-admin"),
      roleCode: "ADMIN",
    });
    expect(created.token).toBeTruthy();
    expect(created.roleCode).toBe("ADMIN");
  }, 30_000);
});

describe("P2-2 — invitations never reset an established account", () => {
  it("creation is rejected for a suspended user's email", async () => {
    const suspendedId = await makeUser("suspended", "WAREHOUSE_STAFF", {
      password: "suspended-password-1",
    });
    await prisma.user.update({
      where: { id: suspendedId },
      data: { status: "SUSPENDED" },
    });
    const suspended = await prisma.user.findUnique({ where: { id: suspendedId } });

    const admin = await actorFor(adminId);
    await expect(
      invitationsSvc.createInvitation(admin, {
        email: suspended!.email,
        roleCode: "WAREHOUSE_STAFF",
        warehouseId: whA,
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);

    const denial = await latestDenial(adminId, "UserInvitation");
    expect((denial?.after as { reason?: string })?.reason).toBe(
      "invitation_existing_account",
    );
  }, 30_000);

  it("creation is rejected for an account that has a password but no roles", async () => {
    const user = await prisma.user.create({
      data: {
        email: email("password-only"),
        fullName: "Password Only",
        passwordHash: await hash("some-password-1", 10),
        status: "ACTIVE",
      },
    });
    const admin = await actorFor(adminId);
    await expect(
      invitationsSvc.createInvitation(admin, {
        email: user.email,
        roleCode: "WAREHOUSE_STAFF",
        warehouseId: whA,
      }),
    ).rejects.toBeInstanceOf(errors.ConflictError);
  }, 30_000);

  it("creation still works for a password-less, role-less shell account", async () => {
    const shell = await prisma.user.create({
      data: { email: email("shell"), fullName: "Shell", status: "ACTIVE" },
    });
    const admin = await actorFor(adminId);
    const created = await invitationsSvc.createInvitation(admin, {
      email: shell.email,
      roleCode: "WAREHOUSE_STAFF",
      warehouseId: whA,
    });
    expect(created.token).toBeTruthy();
  }, 30_000);

  it("acceptance refuses an account that already holds another role", async () => {
    // Shell with a password-less account but a pre-granted FINANCE role;
    // the invitation row is written directly (as one issued before the
    // P2-2 creation guard, or through any other path, would look).
    const holder = await prisma.user.create({
      data: { email: email("role-holder"), fullName: "Role Holder", status: "ACTIVE" },
    });
    const finance = await prisma.role.findUnique({ where: { code: "FINANCE" } });
    await prisma.userRole.create({
      data: { userId: holder.id, roleId: finance!.id },
    });
    const staff = await prisma.role.findUnique({ where: { code: "WAREHOUSE_STAFF" } });
    const rawToken = `role-holder-token-${RUN}-0123456789abcdef`;
    const invitation = await prisma.userInvitation.create({
      data: {
        email: holder.email,
        roleId: staff!.id,
        warehouseId: whA,
        tokenHash: createHash("sha256").update(rawToken).digest("hex"),
        invitedById: adminId,
        expiresAt: new Date(Date.now() + 60_000),
        status: "PENDING",
      },
    });

    await expect(
      invitationsSvc.acceptInvitation({
        token: rawToken,
        fullName: "Role Holder",
        password: "takeover-password-1",
      }),
    ).rejects.toBeInstanceOf(errors.DomainValidationError);

    const after = await prisma.user.findUnique({ where: { id: holder.id } });
    expect(after?.passwordHash).toBeNull();
    const invAfter = await prisma.userInvitation.findUnique({
      where: { id: invitation.id },
    });
    expect(invAfter?.status).toBe("PENDING"); // rolled back, not consumed
  }, 30_000);
});

describe("P2-5 — parallel acceptance is single-use", () => {
  it("two parallel accepts of one token: exactly one succeeds", async () => {
    const admin = await actorFor(adminId);
    const inviteeEmail = email("race");
    const created = await invitationsSvc.createInvitation(admin, {
      email: inviteeEmail,
      roleCode: "WAREHOUSE_STAFF",
      warehouseId: whA,
    });

    const attempts = await Promise.allSettled([
      invitationsSvc.acceptInvitation({
        token: created.token,
        fullName: "Racer One",
        password: "racer-password-1",
      }),
      invitationsSvc.acceptInvitation({
        token: created.token,
        fullName: "Racer Two",
        password: "racer-password-2",
      }),
    ]);
    const succeeded = attempts.filter((a) => a.status === "fulfilled");
    const failed = attempts.filter((a) => a.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const users = await prisma.user.findMany({ where: { email: inviteeEmail } });
    expect(users).toHaveLength(1);
    // Exactly one of the two passwords is the stored one.
    const matches = await Promise.all([
      compare("racer-password-1", users[0].passwordHash!),
      compare("racer-password-2", users[0].passwordHash!),
    ]);
    expect(matches.filter(Boolean)).toHaveLength(1);

    const invitation = await prisma.userInvitation.findUnique({
      where: { id: created.invitationId },
    });
    expect(invitation?.status).toBe("ACCEPTED");
    const memberships = await prisma.warehouseMembership.findMany({
      where: { userId: users[0].id, warehouseId: whA, revokedAt: null },
    });
    expect(memberships).toHaveLength(1);
  }, 60_000);
});

describe("P2-3 — mustChangePassword gate beyond pages", () => {
  it("a flagged actor is refused by the API routes and server actions, but can change password", async () => {
    const flaggedId = await makeUser("flagged", "ADMIN", {
      password: "temp-password-1",
      mustChangePassword: true,
    });
    const flagged = await actorFor(flaggedId);
    expect(flagged.mustChangePassword).toBe(true);
    mockState.actor = flagged;

    const listResponse = await warehousesRoute.GET({
      nextUrl: new URL("http://localhost/api/warehouses"),
    } as never);
    expect(listResponse.status).toBe(403);

    const meResponse = await meRoute.GET();
    expect(meResponse.status).toBe(403);

    const actionResult = await invitationActions.createInvitationAction({
      email: email("flagged-invite"),
      roleCode: "WAREHOUSE_STAFF",
      warehouseId: whA,
    });
    expect(actionResult.success).toBe(false);
    if (!actionResult.success) {
      expect(actionResult.error).toMatch(/Password change required/);
    }

    // The exempt path still works: the flagged user can change password
    // (service level — changePasswordAction itself carries no gate).
    await usersSvc.changePassword(
      flagged,
      { currentPassword: "temp-password-1", newPassword: "chosen-password-1" },
      null,
    );
    const after = await prisma.user.findUnique({ where: { id: flaggedId } });
    expect(after?.mustChangePassword).toBe(false);

    // Control: an unflagged admin passes the same route.
    mockState.actor = await actorFor(adminId);
    const okResponse = await warehousesRoute.GET({
      nextUrl: new URL("http://localhost/api/warehouses"),
    } as never);
    expect(okResponse.status).toBe(200);
    mockState.actor = null;
  }, 60_000);
});

describe("P2-4 — membership-role-aware scope", () => {
  it("WA of A + staff of B can read B but cannot mutate B (zones, members, fields)", async () => {
    const dual = await actorFor(dualId);
    expect(dual.warehouseIds).toEqual(expect.arrayContaining([whA, whB]));

    // Reads stay presence-based.
    await warehousesSvc.getWarehouse(dual, whB);
    await warehousesSvc.listZones(dual, whB);

    await expect(
      warehousesSvc.createZone(dual, whB, { name: "Sneaky Zone", kind: "STORAGE" }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);
    const denial = await latestDenial(dualId, "Warehouse");
    expect((denial?.after as { reason?: string })?.reason).toBe(
      "scoped_mutation_requires_warehouse_admin",
    );

    const recruit = await makeUser("recruit", "WAREHOUSE_STAFF");
    const recruitUser = await prisma.user.findUnique({ where: { id: recruit } });
    await expect(
      warehousesSvc.assignMember(dual, whB, {
        email: recruitUser!.email,
        roleCode: "WAREHOUSE_STAFF",
      }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);

    await expect(
      warehousesSvc.updateWarehouse(dual, whB, { contactPhone: "9800000000" }),
    ).rejects.toBeInstanceOf(actorLib.AuthorizationError);

    // Controls: the same operations succeed in A, where dual is WA.
    const zone = await warehousesSvc.createZone(dual, whA, {
      name: `Zone ${RUN}`,
      kind: "STORAGE",
    });
    expect(zone.warehouseId).toBe(whA);
    const updated = await warehousesSvc.updateWarehouse(dual, whA, {
      contactPhone: "9801112223",
    });
    expect(updated.contactPhone).toBe("9801112223");
  }, 60_000);
});

describe("P2-11 — member roster is not directory data", () => {
  it("a Finance actor (warehouse.read_all only) can no longer list members", async () => {
    const finance = await actorFor(financeId);
    await expect(warehousesSvc.listMembers(finance, whA)).rejects.toBeInstanceOf(
      actorLib.AuthorizationError,
    );
  }, 30_000);
});
