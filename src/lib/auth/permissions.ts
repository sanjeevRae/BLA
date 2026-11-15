import "server-only";

import { cookies } from "next/headers";

import { auth } from "@/auth";
import { prisma } from "@/lib/db/prisma";
import {
  landingPathForRoles,
  primaryRoleFor,
  type RoleCode,
} from "@/lib/permissions/catalog";
import {
  AuthenticationError,
  requireAccessGranted,
  type ActorContext,
} from "@/lib/auth/actor";
import { sessionCookieName } from "@/lib/auth/session-cookie";
import { applySessionPolicy } from "@/lib/auth/session-enforcement";
import {
  isMfaPrivilegedRoleSet,
  isMfaRequiredForPrivileged,
} from "@/server/services/system-settings";

export {
  AuthenticationError,
  AuthorizationError,
  hasPermission,
  requireAccessGranted,
  requireMfaSatisfied,
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

  // Phase 10 session-row policy (hard gates F8 + F13), enforced on
  // the SAME database session Auth.js just resolved — the cookie in
  // this request names it (session-cookie.ts mirrors the Auth.js
  // cookie contract). See session-enforcement.ts.
  let mfaPending = false;
  let sessionToken: string | undefined;
  try {
    sessionToken = (await cookies()).get(sessionCookieName())?.value;
  } catch {
    // Outside a request scope there is no cookie to read (the
    // service-level suites drive getActorContext directly against a
    // stubbed Auth.js session). The resolved session then stands on
    // its own — there is no request session row to enforce against.
    // Inside a real request cookies() never throws.
    sessionToken = undefined;
  }
  if (sessionToken) {
    const outcome = await applySessionPolicy(sessionToken, user.id, roles, user.mfaEnabled);
    if (outcome.expired) return null;
    mfaPending = outcome.mfaPending;
  }
  const mfaEnrolmentRequired =
    isMfaPrivilegedRoleSet(roles) &&
    !user.mfaEnabled &&
    (await isMfaRequiredForPrivileged());

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
    mfaEnrolled: user.mfaEnabled,
    mfaEnrolmentRequired,
    mfaPending,
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
 * requireActor + the full access gate: the mustChangePassword check
 * (Phase 2 review P2-3) and the Phase 10 MFA check (gate F13).
 * Restricted accounts are refused everywhere except the exempt
 * resolution paths (password change, MFA enrolment/challenge,
 * sign-out), not just on dashboard pages.
 */
export async function requireUnflaggedActor(): Promise<ActorContext> {
  const actor = await requireActor();
  requireAccessGranted(actor);
  return actor;
}
