import "server-only";

import type { Prisma } from "@prisma/client";
import { compare, hash } from "bcryptjs";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  requirePermission,
  type ActorContext,
} from "@/lib/auth/actor";
import { DomainValidationError, NotFoundError } from "@/lib/errors";
import { ROLE_CODES } from "@/lib/permissions/catalog";
import {
  auditAccessDenied,
  pageArgs,
  pageMeta,
  requirePermAudited,
} from "@/server/services/scoping";

/**
 * User lifecycle operations (docs/security-architecture.md §2, §4):
 * password change with revocation of all other sessions, and account
 * suspension/reactivation with full session revocation. Every sensitive
 * action writes an AuditLog row, following the AuthenticationService
 * pattern from Phase 1.
 */

export const newPasswordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(200);

/**
 * requirePermission("user.manage") + an access.denied AuditLog row when
 * the permission is missing (security doc §3.4; Phase 2 review P2-8 —
 * the identity services now audit denials exactly like WarehouseService).
 */
async function requireManagePermissionAudited(
  actor: ActorContext,
  targetUserId: string,
): Promise<void> {
  try {
    requirePermission(actor, "user.manage");
  } catch (error) {
    if (error instanceof AuthorizationError) {
      await prisma.auditLog.create({
        data: {
          actorId: actor.userId,
          actorRole: actor.primaryRole,
          action: "access.denied",
          entityType: "User",
          entityId: targetUserId,
          after: { reason: "missing_permission:user.manage" },
        },
      });
    }
    throw error;
  }
}

/**
 * Reset a user's MFA enrolment (Phase 10 gate F13 recovery path).
 * SUPER_ADMIN only — and never on oneself: recovery is one privileged
 * user restoring another (e.g. a lost authenticator). The target is
 * returned to the enrolment-required state: secret cleared, watermark
 * cleared, and ALL of the target's sessions deleted (a session that
 * had passed the old factor must not survive the reset). Audited.
 */
export async function resetUserMfa(
  actor: ActorContext,
  targetUserId: string,
): Promise<{ reset: true }> {
  await requireManagePermissionAudited(actor, targetUserId);
  if (!actor.roles.includes("SUPER_ADMIN")) {
    await prisma.auditLog.create({
      data: {
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        action: "access.denied",
        entityType: "User",
        entityId: targetUserId,
        after: { reason: "mfa_reset_requires_super_admin" },
      },
    });
    throw new AuthorizationError("Only a Super Admin can reset a user's MFA enrolment");
  }
  if (targetUserId === actor.userId) {
    throw new DomainValidationError("You cannot reset your own MFA — ask another Super Admin");
  }
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw new NotFoundError(`User not found: ${targetUserId}`);
  if (!target.mfaEnabled && !target.mfaSecretEncrypted) {
    throw new DomainValidationError("MFA is not enrolled for this account");
  }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: target.id },
      data: { mfaEnabled: false, mfaSecretEncrypted: null, mfaLastUsedCounter: null },
    });
    await tx.session.deleteMany({ where: { userId: target.id } });
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        action: "user.mfa_reset",
        entityType: "User",
        entityId: target.id,
        before: { mfaEnabled: target.mfaEnabled },
        after: { mfaEnabled: false },
      },
    });
  });
  return { reset: true };
}

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: newPasswordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/**
 * Change the signed-in user's own password. Verifies the current
 * password, clears any mustChangePassword flag and lockout state, and
 * deletes every OTHER session row — the session performing the change
 * survives, all others are revoked (§4: password change ⇒ other
 * sessions deleted).
 */
export async function changePassword(
  actor: ActorContext,
  input: ChangePasswordInput,
  currentSessionToken: string | null,
): Promise<{ changed: true }> {
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainValidationError(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const user = await prisma.user.findUnique({ where: { id: actor.userId } });
  if (!user || user.status !== "ACTIVE") {
    throw new DomainValidationError("Account is not active");
  }
  if (!user.passwordHash) {
    throw new DomainValidationError("Account has no password set");
  }
  const currentOk = await compare(parsed.data.currentPassword, user.passwordHash);
  if (!currentOk) {
    throw new DomainValidationError("Current password is incorrect");
  }
  const sameAsCurrent = await compare(parsed.data.newPassword, user.passwordHash);
  if (sameAsCurrent) {
    throw new DomainValidationError("New password must be different from the current password");
  }

  const passwordHash = await hash(parsed.data.newPassword, 12);
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        mustChangePassword: false,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
    await tx.session.deleteMany({
      where: {
        userId: user.id,
        ...(currentSessionToken ? { sessionToken: { not: currentSessionToken } } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        action: "user.password_changed",
        entityType: "User",
        entityId: user.id,
      },
    });
  });
  return { changed: true };
}

/**
 * Suspend a user account (user.manage). Deletes ALL of the user's
 * sessions — revocation is immediate because actor contexts are rebuilt
 * from the database on every request and a non-ACTIVE account resolves
 * to no session at all (security doc §4, spec Scenario 17).
 *
 * Guardrails: an actor cannot suspend themselves, and only a Super
 * Admin can suspend another Super Admin (matrix §3 footnote: Admin
 * cannot manage Super Admin accounts).
 */
export async function suspendUser(
  actor: ActorContext,
  targetUserId: string,
  reason?: string,
): Promise<{ suspended: true }> {
  await requireManagePermissionAudited(actor, targetUserId);
  if (targetUserId === actor.userId) {
    throw new DomainValidationError("You cannot suspend your own account");
  }
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { roles: { include: { role: true } } },
  });
  if (!target) throw new NotFoundError(`User not found: ${targetUserId}`);
  const targetIsSuperAdmin = target.roles.some((r) => r.role.code === "SUPER_ADMIN");
  if (targetIsSuperAdmin && actor.primaryRole !== "SUPER_ADMIN") {
    throw new AuthorizationError("Only a Super Admin can suspend a Super Admin account");
  }
  if (target.status === "SUSPENDED") {
    throw new DomainValidationError("User is already suspended");
  }
  // P2-9: a DEACTIVATED account must stay deactivated. Suspending it
  // would move it to SUSPENDED, from where reactivateUser would
  // resurrect it to ACTIVE — deactivation is a one-way door here.
  if (target.status === "DEACTIVATED") {
    throw new DomainValidationError("A deactivated account cannot be suspended");
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: target.id }, data: { status: "SUSPENDED" } });
    await tx.session.deleteMany({ where: { userId: target.id } });
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        action: "user.suspended",
        entityType: "User",
        entityId: target.id,
        before: { status: target.status },
        after: { status: "SUSPENDED", ...(reason ? { reason } : {}) },
      },
    });
  });
  return { suspended: true };
}

/** Reverse a suspension (user.manage). The user must sign in again —
 *  suspension deleted their sessions and reactivation does not
 *  resurrect them. */
export async function reactivateUser(
  actor: ActorContext,
  targetUserId: string,
): Promise<{ reactivated: true }> {
  await requireManagePermissionAudited(actor, targetUserId);
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { roles: { include: { role: true } } },
  });
  if (!target) throw new NotFoundError(`User not found: ${targetUserId}`);
  // Mirror suspendUser's guard exactly (Phase 6 security review F5):
  // only a Super Admin can reactivate a Super Admin account.
  const targetIsSuperAdmin = target.roles.some((r) => r.role.code === "SUPER_ADMIN");
  if (targetIsSuperAdmin && actor.primaryRole !== "SUPER_ADMIN") {
    throw new AuthorizationError("Only a Super Admin can reactivate a Super Admin account");
  }
  if (target.status !== "SUSPENDED") {
    throw new DomainValidationError("Only a suspended user can be reactivated");
  }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: target.id },
      data: { status: "ACTIVE", failedLoginAttempts: 0, lockedUntil: null },
    });
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        action: "user.reactivated",
        entityType: "User",
        entityId: target.id,
        before: { status: target.status },
        after: { status: "ACTIVE" },
      },
    });
  });
  return { reactivated: true };
}

// ---------------------------------------------------------------------------
// Phase 6 (V2): Super Admin / Admin identity surfaces (audit H-4)
// ---------------------------------------------------------------------------

export interface UserMembershipView {
  membershipId: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  roleCode: string;
  isPrimary: boolean;
}

export interface UserListView {
  id: string;
  fullName: string;
  email: string;
  status: string;
  roles: string[];
  memberships: UserMembershipView[];
  vendor: { vendorId: string; businessName: string; vendorRole: string } | null;
  hasPassword: boolean;
  mfaEnrolled: boolean;
  createdAt: string;
}

const userListInclude = {
  roles: { include: { role: true } },
  memberships: {
    where: { revokedAt: null },
    include: { warehouse: true, role: true },
    orderBy: { assignedAt: "asc" as const },
  },
  vendorLinks: {
    where: { isActive: true },
    include: { vendor: true },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.UserInclude;

type UserListRow = Prisma.UserGetPayload<{ include: typeof userListInclude }>;

function toUserListView(row: UserListRow): UserListView {
  const vendorLink = row.vendorLinks[0];
  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    status: row.status,
    roles: row.roles.map((r) => r.role.code),
    memberships: row.memberships.map((m) => ({
      membershipId: m.id,
      warehouseId: m.warehouseId,
      warehouseCode: m.warehouse.code,
      warehouseName: m.warehouse.name,
      roleCode: m.role.code,
      isPrimary: m.isPrimary,
    })),
    vendor: vendorLink
      ? {
          vendorId: vendorLink.vendorId,
          businessName: vendorLink.vendor.businessName,
          vendorRole: vendorLink.vendorRole,
        }
      : null,
    // Projection discipline: only WHETHER a password / MFA enrolment
    // exists — never the hash, the secret, or any token material.
    hasPassword: row.passwordHash !== null,
    mfaEnrolled: row.mfaEnabled,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ListUsersQuery {
  search?: string;
  roleCode?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export interface ListUsersResult {
  items: UserListView[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** List users (user.manage). Company-wide by design — the identity
 *  module is a Super Admin / Admin surface, not a warehouse surface. */
export async function listUsers(
  actor: ActorContext,
  query: ListUsersQuery = {},
): Promise<ListUsersResult> {
  await requirePermAudited(actor, "user.manage", "User");
  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);

  const where: Prisma.UserWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.roleCode) {
    where.roles = { some: { role: { code: query.roleCode } } };
  }
  if (query.search?.trim()) {
    const term = query.search.trim();
    where.OR = [
      { fullName: { contains: term, mode: "insensitive" } },
      { email: { contains: term, mode: "insensitive" } },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      include: userListInclude,
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
  ]);
  return { items: rows.map(toUserListView), ...pageMeta(total, page, pageSize) };
}

/** One user's identity detail (user.manage) — same projection as the
 *  list, for the detail page. */
export async function getUserDetail(
  actor: ActorContext,
  userId: string,
): Promise<UserListView> {
  await requirePermAudited(actor, "user.manage", "User");
  const row = await prisma.user.findUnique({ where: { id: userId }, include: userListInclude });
  if (!row) throw new NotFoundError(`User not found: ${userId}`);
  return toUserListView(row);
}

export interface SetUserRolesResult {
  userId: string;
  roles: string[];
}

/**
 * Replace a user's global role set (role.manage — Super Admin only in
 * the catalog). Protections, each audited on denial:
 * - an actor cannot modify their own roles;
 * - SUPER_ADMIN cannot be removed from the last ACTIVE Super Admin;
 * - granting SUPER_ADMIN requires the actor to be a Super Admin.
 * The write and its `user.roles_updated` audit row (before/after role
 * codes) commit in one transaction.
 */
export async function setUserRoles(
  actor: ActorContext,
  userId: string,
  roleCodes: string[],
): Promise<SetUserRolesResult> {
  try {
    requirePermission(actor, "role.manage");
  } catch (error) {
    if (error instanceof AuthorizationError) {
      await auditAccessDenied(actor, "User", {
        entityId: userId,
        reason: "missing_permission:role.manage",
      });
    }
    throw error;
  }

  const uniqueCodes = [...new Set(roleCodes)];
  for (const code of uniqueCodes) {
    if (!(ROLE_CODES as readonly string[]).includes(code)) {
      throw new DomainValidationError(`Unknown role: ${code}`);
    }
  }

  const deny = async (reason: string): Promise<never> => {
    await auditAccessDenied(actor, "User", { entityId: userId, reason });
    throw new DomainValidationError(reason);
  };

  if (userId === actor.userId) {
    await deny("roles_self_edit_forbidden");
    throw new DomainValidationError("You cannot modify your own roles");
  }

  const target = await prisma.user.findUnique({
    where: { id: userId },
    include: { roles: { include: { role: true } } },
  });
  if (!target) throw new NotFoundError(`User not found: ${userId}`);
  const beforeCodes = target.roles.map((r) => r.role.code).sort();

  if (uniqueCodes.includes("SUPER_ADMIN") && actor.primaryRole !== "SUPER_ADMIN") {
    await auditAccessDenied(actor, "User", {
      entityId: userId,
      reason: "roles_grant_super_admin_requires_super_admin",
    });
    throw new AuthorizationError("Only a Super Admin can grant the Super Admin role");
  }

  if (
    beforeCodes.includes("SUPER_ADMIN") &&
    !uniqueCodes.includes("SUPER_ADMIN") &&
    target.status === "ACTIVE"
  ) {
    const otherActiveSuperAdmins = await prisma.user.count({
      where: {
        id: { not: userId },
        status: "ACTIVE",
        roles: { some: { role: { code: "SUPER_ADMIN" } } },
      },
    });
    if (otherActiveSuperAdmins === 0) {
      await deny("roles_last_super_admin_protected");
      throw new DomainValidationError(
        "Cannot remove Super Admin from the last active Super Admin account",
      );
    }
  }

  const roleRows = await prisma.role.findMany({
    where: { code: { in: uniqueCodes } },
  });
  if (roleRows.length !== uniqueCodes.length) {
    const found = new Set(roleRows.map((r) => r.code));
    const missing = uniqueCodes.find((c) => !found.has(c));
    throw new DomainValidationError(`Unknown role: ${missing}`);
  }
  const afterCodes = [...uniqueCodes].sort();

  await prisma.$transaction(async (tx) => {
    await tx.userRole.deleteMany({
      where: { userId, roleId: { notIn: roleRows.map((r) => r.id) } },
    });
    for (const role of roleRows) {
      await tx.userRole.upsert({
        where: { userId_roleId: { userId, roleId: role.id } },
        update: {},
        create: { userId, roleId: role.id, assignedById: actor.userId },
      });
    }
    await tx.auditLog.create({
      data: {
        actorId: actor.userId,
        actorRole: actor.primaryRole,
        action: "user.roles_updated",
        entityType: "User",
        entityId: userId,
        before: { roles: beforeCodes },
        after: { roles: afterCodes },
      },
    });
  });
  return { userId, roles: afterCodes };
}
