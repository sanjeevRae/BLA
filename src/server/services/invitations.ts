import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { hash as bcryptHash } from "bcryptjs";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  requirePermission,
  type ActorContext,
} from "@/lib/auth/actor";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import { ROLE_CODES } from "@/lib/permissions/catalog";
import { newPasswordSchema } from "@/server/services/users";

/**
 * Invitation lifecycle (docs/security-architecture.md §5): operational
 * accounts are created by admins or by invitation with the role fixed by
 * the inviter — there is no public self-registration.
 *
 * The raw token is returned to the inviter exactly once; only its
 * SHA-256 hash is stored (UserInvitation.tokenHash). Acceptance is
 * single-use (status flips to ACCEPTED) and time-boxed (expiresAt).
 */

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashInvitationToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export const createInvitationSchema = z.object({
  email: z.string().email().max(254),
  roleCode: z.enum(ROLE_CODES),
  warehouseId: z.string().uuid().optional().nullable(),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export interface CreatedInvitation {
  invitationId: string;
  email: string;
  roleCode: string;
  /** The raw token — shown to the inviter once, never stored. */
  token: string;
  expiresAt: string;
}

export async function createInvitation(
  actor: ActorContext,
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  requirePermission(actor, "user.invite");
  const parsed = createInvitationSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainValidationError(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const email = parsed.data.email.trim().toLowerCase();

  // Only a Super Admin can invite another Super Admin (matrix §3
  // footnote: Admin cannot manage Super Admin accounts).
  if (parsed.data.roleCode === "SUPER_ADMIN" && actor.primaryRole !== "SUPER_ADMIN") {
    throw new AuthorizationError("Only a Super Admin can invite a Super Admin");
  }
  const role = await prisma.role.findUnique({ where: { code: parsed.data.roleCode } });
  if (!role) throw new DomainValidationError(`Unknown role: ${parsed.data.roleCode}`);

  let warehouseId: string | null = null;
  if (parsed.data.warehouseId) {
    const warehouse = await prisma.warehouse.findUnique({
      where: { id: parsed.data.warehouseId },
    });
    if (!warehouse) throw new NotFoundError("Warehouse not found for invitation");
    if (!["WAREHOUSE_ADMIN", "WAREHOUSE_STAFF", "RIDER", "LINEHAUL_DRIVER"].includes(parsed.data.roleCode)) {
      throw new DomainValidationError(
        "A warehouse-scoped invitation must be for a warehouse role",
      );
    }
    warehouseId = warehouse.id;
  }

  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser && existingUser.status === "ACTIVE" && existingUser.passwordHash) {
    throw new ConflictError(`${email} already has an active account`);
  }
  const pending = await prisma.userInvitation.findFirst({
    where: { email, status: "PENDING", expiresAt: { gt: new Date() } },
  });
  if (pending) {
    throw new ConflictError(`A pending invitation already exists for ${email}`);
  }

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
  const invitation = await prisma.userInvitation.create({
    data: {
      email,
      roleId: role.id,
      warehouseId,
      tokenHash: hashInvitationToken(token),
      invitedById: actor.userId,
      expiresAt,
      status: "PENDING",
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "user.invited",
      entityType: "UserInvitation",
      entityId: invitation.id,
      warehouseId,
      after: { email, roleCode: parsed.data.roleCode, expiresAt: expiresAt.toISOString() },
    },
  });
  return {
    invitationId: invitation.id,
    email,
    roleCode: parsed.data.roleCode,
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

export const acceptInvitationSchema = z.object({
  token: z.string().min(32).max(256),
  fullName: z.string().min(2).max(120),
  password: newPasswordSchema,
});
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

export interface AcceptedInvitation {
  userId: string;
  email: string;
  roleCode: string;
}

/**
 * Accept an invitation: verify the token (hash lookup + constant-time
 * compare), enforce single-use and expiry, then create/activate the
 * account with the invitee-chosen password, grant the fixed role (and
 * the warehouse membership, when the invitation was warehouse-scoped),
 * mark the invitation used, and audit the acceptance.
 */
export async function acceptInvitation(
  input: AcceptInvitationInput,
): Promise<AcceptedInvitation> {
  const parsed = acceptInvitationSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainValidationError(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const tokenHash = hashInvitationToken(parsed.data.token);
  const invitation = await prisma.userInvitation.findUnique({
    where: { tokenHash },
    include: { role: true },
  });
  if (!invitation) {
    throw new DomainValidationError("Invitation is invalid or has already been used");
  }
  // Constant-time confirmation of the stored hash (defence in depth on
  // top of the unique lookup).
  const stored = Buffer.from(invitation.tokenHash, "hex");
  const presented = Buffer.from(tokenHash, "hex");
  if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) {
    throw new DomainValidationError("Invitation is invalid or has already been used");
  }
  if (invitation.status !== "PENDING") {
    throw new DomainValidationError("Invitation is invalid or has already been used");
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    await prisma.userInvitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    throw new DomainValidationError("Invitation has expired — ask for a new one");
  }

  const passwordHash = await bcryptHash(parsed.data.password, 10);
  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { email: invitation.email } });
    const user = existing
      ? await tx.user.update({
          where: { id: existing.id },
          data: {
            passwordHash,
            status: "ACTIVE",
            emailVerifiedAt: new Date(),
            mustChangePassword: false,
            failedLoginAttempts: 0,
            lockedUntil: null,
          },
        })
      : await tx.user.create({
          data: {
            email: invitation.email,
            fullName: parsed.data.fullName,
            passwordHash,
            status: "ACTIVE",
            emailVerifiedAt: new Date(),
          },
        });

    await tx.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: invitation.roleId } },
      update: {},
      create: {
        userId: user.id,
        roleId: invitation.roleId,
        assignedById: invitation.invitedById,
      },
    });

    if (invitation.warehouseId) {
      const alreadyMember = await tx.warehouseMembership.findFirst({
        where: { userId: user.id, warehouseId: invitation.warehouseId, revokedAt: null },
      });
      if (!alreadyMember) {
        const membershipCount = await tx.warehouseMembership.count({
          where: { userId: user.id, revokedAt: null },
        });
        await tx.warehouseMembership.create({
          data: {
            userId: user.id,
            warehouseId: invitation.warehouseId,
            roleId: invitation.roleId,
            isPrimary: membershipCount === 0,
            assignedById: invitation.invitedById,
          },
        });
      }
    }

    await tx.userInvitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED", acceptedAt: new Date() },
    });
    await tx.auditLog.create({
      data: {
        actorId: user.id,
        actorRole: invitation.role.code,
        action: "user.invitation_accepted",
        entityType: "UserInvitation",
        entityId: invitation.id,
        warehouseId: invitation.warehouseId,
        after: { email: invitation.email, roleCode: invitation.role.code },
      },
    });
    return { userId: user.id, email: user.email, roleCode: invitation.role.code };
  });
  return result;
}
