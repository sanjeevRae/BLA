import { NextResponse, type NextRequest } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { listInventory } from "@/server/services/inventory";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/**
 * GET /api/operations/inventory — open inventory records, force-scoped
 * to the actor's warehouses inside the service query.
 */
export async function GET(request: NextRequest) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const params = request.nextUrl.searchParams;
  try {
    requireUnflagged(actor); // P2-3 gate
    const result = await listInventory(actor, {
      warehouseId: params.get("warehouseId") ?? undefined,
      zoneKind: params.get("zoneKind") ?? undefined,
      status: params.get("status") ?? undefined,
      search: params.get("search") ?? undefined,
      page: Number(params.get("page") ?? 1) || 1,
      pageSize: Number(params.get("pageSize") ?? 25) || 25,
    });
    return NextResponse.json(result);
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
