import "server-only";

import { compare, hash } from "bcryptjs";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  requirePermission,
  type ActorContext,
} from "@/lib/auth/actor";
import { DomainValidationError, NotFoundError } from "@/lib/errors";

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
  const target = await prisma.user.findUnique({ where: { id: targetUserId } });
  if (!target) throw new NotFoundError(`User not found: ${targetUserId}`);
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
