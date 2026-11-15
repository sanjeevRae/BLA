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
  /** Phase 10 (F13): the account has completed TOTP enrolment. */
  mfaEnrolled?: boolean;
  /** Phase 10 (F13): a privileged account (SUPER_ADMIN/ADMIN) that has
   *  not yet enrolled while the SystemSetting policy requires MFA.
   *  Such an actor is restricted to the enrolment flow — dashboard
   *  guards redirect to /mfa-setup and requireAccessGranted refuses
   *  every action/API call. Optional: service-level test fixtures
   *  built by hand predate the field and are never MFA-gated. */
  mfaEnrolmentRequired?: boolean;
  /** Phase 10 (F13): the account is MFA-enrolled but THIS session has
   *  not yet passed the TOTP challenge (Session.mfaVerifiedAt null).
   *  Restricted to the challenge flow — guards redirect to
   *  /login/mfa and requireAccessGranted refuses everything else. */
  mfaPending?: boolean;
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
  /** Resolved from the actor's Driver profile (Phase 5, 1:1 with the
   *  user) — the assignment identity for riders and line-haul drivers. */
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

/**
 * Throws AuthorizationError while a privileged actor's MFA obligation
 * is unsatisfied (Phase 10 gate F13) — either enrolment is required
 * but not completed, or this session has not passed the TOTP
 * challenge. The MFA flows themselves (enrolment, challenge,
 * password change, sign-out) are exempt, exactly like the
 * mustChangePassword exemptions in P2-3: they resolve the actor with
 * getActorContext() and never pass through this gate.
 */
export function requireMfaSatisfied(actor: ActorContext): void {
  if (actor.mfaEnrolmentRequired) {
    throw new AuthorizationError(
      "MFA enrolment required: set up an authenticator before continuing",
    );
  }
  if (actor.mfaPending) {
    throw new AuthorizationError(
      "MFA verification required: complete the authenticator challenge before continuing",
    );
  }
}

/**
 * The full access gate every Server Action wrapper and Route Handler
 * runs after resolving the actor: the P2-3 mustChangePassword check
 * plus the Phase 10 MFA check. (This superseded the bare
 * requireUnflagged call at every wrapper in Phase 10; requireUnflagged
 * remains for the few paths that are MFA-exempt by design.)
 */
export function requireAccessGranted(actor: ActorContext): void {
  requireUnflagged(actor);
  requireMfaSatisfied(actor);
}
