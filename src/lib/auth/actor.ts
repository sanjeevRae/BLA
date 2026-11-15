import type { RoleCode } from "@/lib/permissions/catalog";

/**
 * ActorContext and the pure permission checks (docs/security-architecture.md
 * §3.3). This module has no server imports so it is unit-testable; the
 * database-backed construction lives in permissions.ts.
 */

export class AuthenticationError extends Error {
  readonly status = 401;
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends Error {
  readonly status = 403;
  constructor(message = "Not authorized") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export interface ActorContext {
  userId: string;
  email: string;
  fullName: string;
  status: string;
  /** True while the account is flagged to set a new password; dashboard
   *  page guards redirect to /set-password before rendering anything. */
  mustChangePassword: boolean;
  roles: RoleCode[];
  primaryRole: RoleCode | null;
  permissions: ReadonlySet<string>;
  /** Warehouses the actor is an active member of (scope for W-grants). */
  warehouseIds: string[];
  /** The actor's membership role per warehouse (Phase 2 review P2-4):
   *  scoped mutations in a warehouse require the WAREHOUSE_ADMIN
   *  membership role IN THAT warehouse, not merely membership presence
   *  plus a global WA role earned elsewhere. Additive: warehouseIds
   *  keeps its Phase 1 meaning (presence-based read scope). */
  membershipRoles: { warehouseId: string; roleCode: RoleCode }[];
  /** Resolved from the actor's active VendorUser link (Phase 3). */
  vendorId: string | null;
  /** The actor's intra-vendor role (OWNER / MANAGER / BOOKING_STAFF /
   *  ACCOUNTS_STAFF) inside `vendorId`'s organisation — refines which
   *  vendor modules respond (matrix §5.4). Null for non-vendor actors. */
  vendorRole: string | null;
  /** Resolved when the Driver profile lands (Phase 6) — null until then. */
  driverId: string | null;
  /** Resolved when the Customer profile lands (Phase 3) — null until then. */
  customerId: string | null;
  landingPath: string;
}

export function hasPermission(actor: ActorContext, permission: string): boolean {
  return actor.permissions.has(permission);
}

/** Throws AuthorizationError unless the actor holds the permission. */
export function requirePermission(actor: ActorContext, permission: string): void {
  if (!hasPermission(actor, permission)) {
    throw new AuthorizationError(`Missing required permission: ${permission}`);
  }
}

/**
 * Throws AuthorizationError while the account is flagged
 * mustChangePassword (Phase 2 review P2-3). The flag was previously
 * enforced only by page guards, so a flagged account — whose temporary
 * password is known to whoever set it — could call every Server Action
 * and API route directly. Action wrappers and route handlers run this
 * check centrally; the password-change and sign-out paths are exempt.
 */
export function requireUnflagged(actor: ActorContext): void {
  if (actor.mustChangePassword) {
    throw new AuthorizationError(
      "Password change required: set a new password before continuing",
    );
  }
}
