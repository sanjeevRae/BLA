import { NextResponse, type NextRequest } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { listCustody } from "@/server/services/custody";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/**
 * GET /api/operations/custody?warehouseId=… — the open custody rows at
 * one warehouse: what the warehouse itself holds plus what its staff
 * members hold of the stock there.
 */
export async function GET(request: NextRequest) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const params = request.nextUrl.searchParams;
  try {
    requireAccessGranted(actor); // P2-3 gate
    const warehouseId = params.get("warehouseId");
    if (!warehouseId) {
      return NextResponse.json(
        { error: { code: "VALIDATION", message: "warehouseId is required" } },
        { status: 400 },
      );
    }
    const holderType = params.get("holderType");
    const result = await listCustody(actor, {
      warehouseId,
      holderType:
        holderType === "WAREHOUSE" || holderType === "USER" ? holderType : undefined,
      userId: params.get("userId") ?? undefined,
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
