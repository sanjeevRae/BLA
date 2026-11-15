import "server-only";

import { auth } from "@/auth";
import { prisma } from "@/lib/db/prisma";
import {
  landingPathForRoles,
  primaryRoleFor,
  type RoleCode,
} from "@/lib/permissions/catalog";
import {
  AuthenticationError,
  requireUnflagged,
  type ActorContext,
} from "@/lib/auth/actor";

export {
  AuthenticationError,
  AuthorizationError,
  hasPermission,
  requirePermission,
  requireUnflagged,
  type ActorContext,
} from "@/lib/auth/actor";

/**
 * Central authorization (docs/security-architecture.md §3).
 *
 * Every request builds an ActorContext once, server-side, from the session
 * plus the CURRENT database state — roles, permissions and warehouse
 * memberships are never taken from client input or cached claims. Handlers
 * call requirePermission() as their first statement; repositories apply
 * the actor's scope inside their queries.
 */

/**
 * Build the ActorContext for the current request, or null when there is no
 * valid session. A user whose account is no longer ACTIVE (suspended or
 * deactivated after login) resolves to null — their existing cookie stops
 * working immediately (docs/security-architecture.md §2, Scenario 17).
 */
export async function getActorContext(): Promise<ActorContext | null> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return null;

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

  if (!user || user.status !== "ACTIVE") return null;

  const roles: RoleCode[] = [];
  const permissions = new Set<string>();
  for (const userRole of user.roles) {
    if (!userRole.role.isActive) continue;
    roles.push(userRole.role.code as RoleCode);
    for (const rp of userRole.role.permissions) {
      permissions.add(rp.permission.code);
    }
  }

  // Phase 3 scope links: the vendor organisation (via an active
  // VendorUser row on an active vendor) and the customer record linked
  // to this login. Resolved from the database on every request, never
  // from client input (security doc §3.3).
  // P3-4: the vendor link resolves only while the vendor is APPROVED —
  // a suspended / rejected / not-yet-approved vendor's users keep their
  // login and roles but lose all vendor portal data immediately.
  const [vendorLink, customerProfile, driverProfile] = await Promise.all([
    prisma.vendorUser.findFirst({
      where: {
        userId: user.id,
        isActive: true,
        vendor: { isActive: true, verificationStatus: "APPROVED" },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.customer.findUnique({ where: { userId: user.id } }),
    // Phase 5: the operational Driver profile (1:1 with the user).
    // Resolved regardless of employment status — the services decide
    // what a suspended/inactive driver may still see (their history),
    // while assignment checks enforce employment + availability.
    prisma.driver.findUnique({
      where: { userId: user.id },
      select: { id: true },
    }),
  ]);

  return {
    userId: user.id,
    email: user.email,
    fullName: user.fullName,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    roles,
    primaryRole: primaryRoleFor(roles),
    permissions,
    warehouseIds: user.memberships.map((m) => m.warehouseId),
    membershipRoles: user.memberships.map((m) => ({
      warehouseId: m.warehouseId,
      roleCode: m.role.code as RoleCode,
    })),
    vendorId: vendorLink?.vendorId ?? null,
    vendorRole: vendorLink?.vendorRole ?? null,
    driverId: driverProfile?.id ?? null,
    customerId: customerProfile?.id ?? null,
    landingPath: landingPathForRoles(roles),
  };
}

/** Like getActorContext, but throws AuthenticationError when signed out. */
export async function requireActor(): Promise<ActorContext> {
  const actor = await getActorContext();
  if (!actor) throw new AuthenticationError();
  return actor;
}

/**
 * requireActor + the mustChangePassword gate (Phase 2 review P2-3):
 * flagged accounts are refused everywhere except the password-change
 * and sign-out paths, not just on dashboard pages.
 */
export async function requireUnflaggedActor(): Promise<ActorContext> {
  const actor = await requireActor();
  requireUnflagged(actor);
  return actor;
}
