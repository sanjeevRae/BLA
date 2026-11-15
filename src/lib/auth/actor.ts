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
  roles: RoleCode[];
  primaryRole: RoleCode | null;
  permissions: ReadonlySet<string>;
  /** Warehouses the actor is an active member of (scope for W-grants). */
  warehouseIds: string[];
  /** Resolved in Phase 3 (VendorUser) — null until then. */
  vendorId: string | null;
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
