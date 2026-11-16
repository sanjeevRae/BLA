import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { hash as bcryptHash } from "bcryptjs";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  hasPermission,
  requirePermission,
  type ActorContext,
} from "@/lib/auth/actor";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import { ROLE_CODES } from "@/lib/permissions/catalog";
import { VENDOR_ROLES } from "@/lib/bookings/domain";
import {
  INVITATION_IP_FAILURE_LIMIT,
  INVITATION_IP_FAILURE_WINDOW_MS,
} from "@/lib/auth/login-guard";
import { newPasswordSchema } from "@/server/services/users";

/**
 * Invitation lifecycle (docs/security-architecture.md §5): operational
 * accounts are created by admins or by invitation with the role fixed by
 * the inviter — there is no public self-registration.
 *
 * The raw token is returned to the inviter exactly once; only its
 * SHA-256 hash is stored (UserInvitation.tokenHash). Acceptance is
 * single-use (status flips to ACCEPTED) and time-boxed (expiresAt).
 *
 * Phase 2 review hardening:
 * - P2-1: invitation rights are scoped. Only a company-wide user
 *   administrator (user.manage — Super Admin / Admin) may invite
 *   company roles or warehouse-less accounts. A scoped inviter (e.g. a
 *   Warehouse Admin holding user.invite) may invite WAREHOUSE_STAFF
 *   only, and only into a warehouse inside their own membership scope —
 *   previously a WA could mint a full ADMIN account for themselves.
 * - P2-2: an invitation can never become an account-takeover primitive.
 *   Creation rejects any email whose account already holds a password
 *   or any role (reactivation lives only in reactivateUser under
 *   user.manage), and acceptance refuses an existing account that holds
 *   a password or any role beyond the invited one. Acceptance completes
 *   only a brand-new account or a password-less, role-less shell.
 * - P2-5: acceptance flips PENDING → ACCEPTED with a conditional
 *   updateMany inside the transaction, so two parallel accepts of one
 *   token cannot both succeed.
 * Every denial writes an access.denied AuditLog row (§3.4), following
 * the WarehouseService pattern.
 */

async function auditInvitationDenied(
  actor: ActorContext,
  attempted: { warehouseId?: string | null; email?: string; reason: string },
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "access.denied",
      entityType: "UserInvitation",
      warehouseId: attempted.warehouseId ?? null,
      after: {
        reason: attempted.reason,
        ...(attempted.email ? { email: attempted.email } : {}),
      },
    },
  });
}

/** requirePermission("user.invite") + an audit row when it is missing. */
async function requireInvitePermission(actor: ActorContext): Promise<void> {
  try {
    requirePermission(actor, "user.invite");
  } catch (error) {
    if (error instanceof AuthorizationError) {
      await auditInvitationDenied(actor, { reason: "missing_permission:user.invite" });
    }
    throw error;
  }
}

/**
 * Company-wide inviters hold user.manage (Super Admin / Admin). Anyone
 * else holding user.invite (Warehouse Admin, Vendor) is a scoped
 * inviter, confined by P2-1 to staff invitations inside their scope.
 */
function isCompanyWideInviter(actor: ActorContext): boolean {
  return hasPermission(actor, "user.manage");
}

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashInvitationToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export const createInvitationSchema = z.object({
  email: z.string().email().max(254),
  roleCode: z.enum(ROLE_CODES),
  warehouseId: z.string().uuid().optional().nullable(),
  /** Vendor-scoped invitation (Phase 3): the invitee joins this vendor
   *  organisation with `vendorRole` on acceptance. */
  vendorId: z.string().uuid().optional().nullable(),
  vendorRole: z.enum(VENDOR_ROLES).optional().nullable(),
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export interface CreatedInvitation {
  invitationId: string;
  email: string;
  roleCode: string;
  vendorId: string | null;
  /** The raw token — shown to the inviter once, never stored. */
  token: string;
  expiresAt: string;
}

export async function createInvitation(
  actor: ActorContext,
  input: CreateInvitationInput,
): Promise<CreatedInvitation> {
  await requireInvitePermission(actor);
  const parsed = createInvitationSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainValidationError(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const email = parsed.data.email.trim().toLowerCase();
  const roleCode = parsed.data.roleCode;

  // Only a Super Admin can invite another Super Admin (matrix §3
  // footnote: Admin cannot manage Super Admin accounts).
  if (roleCode === "SUPER_ADMIN" && actor.primaryRole !== "SUPER_ADMIN") {
    await auditInvitationDenied(actor, {
      email,
      warehouseId: parsed.data.warehouseId ?? null,
      reason: "super_admin_invite_requires_super_admin",
    });
    throw new AuthorizationError("Only a Super Admin can invite a Super Admin");
  }

  // Phase 3 vendor scoping: a vendor-scoped invitation is authorised
  // either by a company-wide inviter, or by the OWNER of that very
  // vendor inviting into their own organisation (matrix §3 footnote:
  // a Vendor Owner may invite users only inside their own vendor).
  let vendorInviteId: string | null = null;
  let vendorInviteRole: string | null = null;
  if (parsed.data.vendorId) {
    if (parsed.data.warehouseId) {
      throw new DomainValidationError(
        "An invitation cannot be both warehouse- and vendor-scoped",
      );
    }
    if (roleCode !== "VENDOR") {
      throw new DomainValidationError("A vendor-scoped invitation must be for the VENDOR role");
    }
    const vendor = await prisma.vendor.findUnique({ where: { id: parsed.data.vendorId } });
    if (!vendor) throw new NotFoundError("Vendor not found for invitation");
    const ownVendorOwner =
      actor.vendorId === vendor.id && actor.vendorRole === "OWNER";
    if (!isCompanyWideInviter(actor) && !ownVendorOwner) {
      await auditInvitationDenied(actor, {
        email,
        reason: "vendor_invite_out_of_scope",
      });
      throw new AuthorizationError(
        "Only an administrator or the vendor's OWNER can invite users into a vendor",
      );
    }
    vendorInviteId = vendor.id;
    // P3-9: an unspecified sub-role defaults to the least-privileged
    // booking role — OWNER must always be granted explicitly.
    vendorInviteRole = parsed.data.vendorRole ?? "BOOKING_STAFF";
  }

  // P2-1: scoped inviters (no user.manage) may invite WAREHOUSE_STAFF
  // only, and only into a warehouse inside their own membership scope.
  // Inviting a company role (ADMIN, FINANCE, SUPPORT, VENDOR, CUSTOMER,
  // …) or a warehouse-less account requires a company-wide inviter.
  // (Vendor-scoped invitations were authorised separately above.)
  if (!isCompanyWideInviter(actor) && !vendorInviteId) {
    if (roleCode !== "WAREHOUSE_STAFF") {
      await auditInvitationDenied(actor, {
        email,
        warehouseId: parsed.data.warehouseId ?? null,
        reason: `scoped_invite_role:${roleCode}`,
      });
      throw new AuthorizationError(
        "Warehouse-scoped inviters can only invite Warehouse Staff into their own warehouse",
      );
    }
    if (!parsed.data.warehouseId || !actor.warehouseIds.includes(parsed.data.warehouseId)) {
      await auditInvitationDenied(actor, {
        email,
        warehouseId: parsed.data.warehouseId ?? null,
        reason: "scoped_invite_warehouse_out_of_scope",
      });
      throw new AuthorizationError(
        "Warehouse-scoped inviters can only invite staff into their own warehouse",
      );
    }
  }

  const role = await prisma.role.findUnique({ where: { code: roleCode } });
  if (!role) throw new DomainValidationError(`Unknown role: ${roleCode}`);

  let warehouseId: string | null = null;
  if (parsed.data.warehouseId) {
    const warehouse = await prisma.warehouse.findUnique({
      where: { id: parsed.data.warehouseId },
    });
    if (!warehouse) throw new NotFoundError("Warehouse not found for invitation");
    if (!["WAREHOUSE_ADMIN", "WAREHOUSE_STAFF", "RIDER", "LINEHAUL_DRIVER"].includes(roleCode)) {
      throw new DomainValidationError(
        "A warehouse-scoped invitation must be for a warehouse role",
      );
    }
    warehouseId = warehouse.id;
  }

  // P2-2: an invitation must never reset an established account. Any
  // existing account that already holds a password OR any role is
  // rejected — suspended/deactivated admins included. Reactivating such
  // an account is reactivateUser's job, under user.manage.
  const existingUser = await prisma.user.findUnique({
    where: { email },
    include: { roles: true },
  });
  if (existingUser && (existingUser.passwordHash || existingUser.roles.length > 0)) {
    await auditInvitationDenied(actor, {
      email,
      warehouseId,
      reason: "invitation_existing_account",
    });
    throw new ConflictError(
      `${email} already has an account — manage it from the Users module instead of inviting`,
    );
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
      vendorId: vendorInviteId,
      vendorRole: vendorInviteRole,
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
      after: {
        email,
        roleCode: parsed.data.roleCode,
        ...(vendorInviteId ? { vendorId: vendorInviteId, vendorRole: vendorInviteRole } : {}),
        expiresAt: expiresAt.toISOString(),
      },
    },
  });
  return {
    invitationId: invitation.id,
    email,
    roleCode: parsed.data.roleCode,
    vendorId: vendorInviteId,
    token,
    expiresAt: expiresAt.toISOString(),
  };
}

/** The one generic redemption refusal: unknown, used, throttled and
 *  account-conflict redemptions are indistinguishable to the caller. */
export const INVITATION_GENERIC_REFUSAL =
  "Invitation is invalid or has already been used";

/** Optional request metadata for redemption (Phase 2 V2 rate limit).
 *  `ipAddress` comes from the trusted forwarding header (see
 *  src/lib/auth/client-ip.ts). When no IP is present the limiter is
 *  inert — exactly like the login / tracking per-IP throttles. */
export interface AcceptInvitationMeta {
  ipAddress?: string | null;
}

/** True when the IP has exhausted its failed-redemption budget. */
async function isInvitationIpBudgetExceeded(
  ipAddress: string | null | undefined,
): Promise<boolean> {
  if (!ipAddress) return false;
  const failures = await prisma.invitationAttempt.count({
    where: {
      ipAddress,
      succeeded: false,
      createdAt: { gt: new Date(Date.now() - INVITATION_IP_FAILURE_WINDOW_MS) },
    },
  });
  return failures >= INVITATION_IP_FAILURE_LIMIT;
}

/** Record one redemption attempt. Only ever called when an IP is
 *  present; a bookkeeping failure must never mask the redemption
 *  outcome itself, so write errors are swallowed. */
async function recordInvitationAttempt(
  tokenHash: string,
  succeeded: boolean,
  ipAddress: string | null | undefined,
): Promise<void> {
  if (!ipAddress) return;
  try {
    await prisma.invitationAttempt.create({
      data: { tokenHash, succeeded, ipAddress },
    });
  } catch {
    // Best-effort forensics — the caller's result stands.
  }
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
  meta?: AcceptInvitationMeta,
): Promise<AcceptedInvitation> {
  const parsed = acceptInvitationSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainValidationError(parsed.error.issues[0]?.message ?? "Invalid input");
  }
  const ipAddress = meta?.ipAddress ?? null;
  const tokenHash = hashInvitationToken(parsed.data.token);
  // Phase 2 V2 rate limit: the per-IP failure budget is checked
  // BEFORE the token lookup, following the tracking-access
  // philosophy — an exhausted IP is refused with the SAME generic
  // message as an invalid token (never a distinguishable throttle
  // error), and the limiter's own refusal writes no attempt row, so
  // the budget decays with its window. With no IP the limiter is
  // inert and behaviour is identical to before.
  if (await isInvitationIpBudgetExceeded(ipAddress)) {
    throw new DomainValidationError(INVITATION_GENERIC_REFUSAL);
  }
  const invitation = await prisma.userInvitation.findUnique({
    where: { tokenHash },
    include: { role: true },
  });
  if (!invitation) {
    await recordInvitationAttempt(tokenHash, false, ipAddress);
    throw new DomainValidationError(INVITATION_GENERIC_REFUSAL);
  }
  // Constant-time confirmation of the stored hash (defence in depth on
  // top of the unique lookup).
  const stored = Buffer.from(invitation.tokenHash, "hex");
  const presented = Buffer.from(tokenHash, "hex");
  if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) {
    await recordInvitationAttempt(tokenHash, false, ipAddress);
    throw new DomainValidationError(INVITATION_GENERIC_REFUSAL);
  }
  if (invitation.status !== "PENDING") {
    await recordInvitationAttempt(tokenHash, false, ipAddress);
    throw new DomainValidationError(INVITATION_GENERIC_REFUSAL);
  }
  if (invitation.expiresAt.getTime() <= Date.now()) {
    await prisma.userInvitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    await recordInvitationAttempt(tokenHash, false, ipAddress);
    // Security review F-4: expired tokens refuse with the SAME
    // generic message as every other refusal class — a distinct
    // "has expired" message was an oracle distinguishing token
    // states. The status flip above still records the expiry.
    throw new DomainValidationError(INVITATION_GENERIC_REFUSAL);
  }

  const passwordHash = await bcryptHash(parsed.data.password, 12);
  let result: AcceptedInvitation;
  try {
    result = await prisma.$transaction(async (tx) => {
    // P2-5: claim the invitation atomically. The pre-transaction PENDING
    // check above is only a fast path — under two parallel accepts, the
    // conditional flip is what guarantees exactly one winner: the loser
    // observes count 0 and the whole transaction rolls back.
    const claimed = await tx.userInvitation.updateMany({
      where: { id: invitation.id, status: "PENDING" },
      data: { status: "ACCEPTED", acceptedAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new DomainValidationError("Invitation is invalid or has already been used");
    }

    const existing = await tx.user.findUnique({
      where: { email: invitation.email },
      include: { roles: true },
    });
    // P2-2 (acceptance side): never reset an established account. An
    // existing account may be completed only when it is a shell — no
    // password set and no role beyond the invited one. Anything else
    // means this invitation was aimed at a real account (e.g. a
    // suspended admin); refuse with the generic message so the response
    // does not leak the account's state.
    if (
      existing &&
      (existing.passwordHash ||
        existing.roles.some((r) => r.roleId !== invitation.roleId))
    ) {
      throw new DomainValidationError("Invitation is invalid or has already been used");
    }
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

    if (invitation.vendorId) {
      // Vendor-scoped invitation: link the new account into the vendor
      // organisation with the inviter-fixed sub-role (Phase 3).
      await tx.vendorUser.upsert({
        where: { vendorId_userId: { vendorId: invitation.vendorId, userId: user.id } },
        update: { isActive: true, vendorRole: invitation.vendorRole ?? "BOOKING_STAFF" },
        create: {
          vendorId: invitation.vendorId,
          userId: user.id,
          vendorRole: invitation.vendorRole ?? "BOOKING_STAFF",
          invitedById: invitation.invitedById,
        },
      });
    }

    await tx.auditLog.create({
      data: {
        actorId: user.id,
        actorRole: invitation.role.code,
        action: "user.invitation_accepted",
        entityType: "UserInvitation",
        entityId: invitation.id,
        warehouseId: invitation.warehouseId,
        after: {
          email: invitation.email,
          roleCode: invitation.role.code,
          ...(invitation.vendorId ? { vendorId: invitation.vendorId } : {}),
        },
      },
    });
      return { userId: user.id, email: user.email, roleCode: invitation.role.code };
    });
  } catch (error) {
    // In-transaction generic refusals (the P2-5 claim race loser,
    // the P2-2 established-account guard) rolled back with the
    // transaction — record the failed attempt outside it.
    if (
      error instanceof DomainValidationError &&
      error.message === INVITATION_GENERIC_REFUSAL
    ) {
      await recordInvitationAttempt(tokenHash, false, ipAddress);
    }
    throw error;
  }
  await recordInvitationAttempt(tokenHash, true, ipAddress);
  return result;
}
