import { NextResponse } from "next/server";

import {
  AuthorizationError,
  getActorContext,
  requireUnflagged,
} from "@/lib/auth/permissions";
import { NotFoundError } from "@/lib/errors";
import { getWarehouse } from "@/server/services/warehouses";

/**
 * GET /api/warehouses/{id} — one warehouse. Out-of-scope access by a
 * warehouse-scoped actor is denied with 403 and audit-logged by the
 * service (docs/security-architecture.md §3.4, spec Scenario 11);
 * unknown ids return 404.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "Authentication required" } },
      { status: 401 },
    );
  }
  const { id } = await params;
  try {
    requireUnflagged(actor); // P2-3
    const warehouse = await getWarehouse(actor, id);
    return NextResponse.json({ warehouse });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: error.message } },
        { status: 403 },
      );
    }
    if (error instanceof NotFoundError) {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: error.message } },
        { status: 404 },
      );
    }
    throw error;
  }
}
