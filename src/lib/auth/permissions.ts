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
  type ActorContext,
} from "@/lib/auth/actor";

export {
  AuthenticationError,
  AuthorizationError,
  hasPermission,
  requirePermission,
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
      memberships: { where: { revokedAt: null } },
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
    vendorId: null,
    driverId: null,
    customerId: null,
    landingPath: landingPathForRoles(roles),
  };
}

/** Like getActorContext, but throws AuthenticationError when signed out. */
export async function requireActor(): Promise<ActorContext> {
  const actor = await getActorContext();
  if (!actor) throw new AuthenticationError();
  return actor;
}
