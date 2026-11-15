import { NextResponse, type NextRequest } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { listVendors } from "@/server/services/vendors";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/**
 * GET /api/vendors — paginated vendor list. Vendor actors only ever
 * receive their own organisation (service-side force-scoping).
 */
export async function GET(request: NextRequest) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const params = request.nextUrl.searchParams;
  try {
    requireAccessGranted(actor); // P2-3 gate
    const result = await listVendors(actor, {
      page: Number(params.get("page") ?? 1) || 1,
      pageSize: Number(params.get("pageSize") ?? 20) || 20,
      status: params.get("status") ?? undefined,
      search: params.get("search") ?? undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
