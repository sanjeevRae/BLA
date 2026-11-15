import { NextResponse, type NextRequest } from "next/server";

import {
  AuthorizationError,
  getActorContext,
  requireAccessGranted,
} from "@/lib/auth/permissions";
import { listWarehouses } from "@/server/services/warehouses";

/**
 * GET /api/warehouses — paginated warehouse list. Scoped actors only
 * ever receive their own memberships' warehouses; the scope is applied
 * inside the service query (docs/security-architecture.md §3.3).
 */
export async function GET(request: NextRequest) {
  const actor = await getActorContext();
  if (!actor) {
    return NextResponse.json(
      { error: { code: "UNAUTHENTICATED", message: "Authentication required" } },
      { status: 401 },
    );
  }
  const params = request.nextUrl.searchParams;
  try {
    requireAccessGranted(actor); // P2-3: flagged accounts are refused, not just redirected
    const result = await listWarehouses(actor, {
      page: Number(params.get("page") ?? 1) || 1,
      pageSize: Number(params.get("pageSize") ?? 20) || 20,
      status: params.get("status") ?? undefined,
      search: params.get("search") ?? undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return NextResponse.json(
        { error: { code: "FORBIDDEN", message: error.message } },
        { status: 403 },
      );
    }
    throw error;
  }
}
