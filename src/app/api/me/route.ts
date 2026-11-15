import { NextResponse } from "next/server";

import {
  AuthorizationError,
  getActorContext,
  requirePermission,
  requireUnflagged,
} from "@/lib/auth/permissions";

/**
 * GET /api/me — returns the current ActorContext.
 *
 * This is the reference pattern for every protected Route Handler and
 * Server Action in the rebuild: build the actor context from the session
 * + database, then requirePermission() before doing any work
 * (docs/security-architecture.md §3.3).
 */
export async function GET() {
  const actor = await getActorContext();
  if (!actor) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "Authentication required" } },
      { status: 401 },
    );
  }

  try {
    // P2-3: flagged (mustChangePassword) accounts are refused here too,
    // not only redirected on pages.
    requireUnflagged(actor);
    requirePermission(actor, "profile.update_own");
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: error.message } },
        { status: 403 },
      );
    }
    throw error;
  }

  return NextResponse.json({
    user: {
      id: actor.userId,
      email: actor.email,
      fullName: actor.fullName,
      status: actor.status,
    },
    roles: actor.roles,
    primaryRole: actor.primaryRole,
    permissions: [...actor.permissions].sort(),
    warehouseIds: actor.warehouseIds,
    vendorId: actor.vendorId,
    driverId: actor.driverId,
    customerId: actor.customerId,
    landingPath: actor.landingPath,
  });
}
