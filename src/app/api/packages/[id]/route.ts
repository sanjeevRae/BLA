import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { getPackage } from "@/server/services/packages";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/packages/[id] — one package, force-scoped by
 *  PackageService (cross-tenant = 404, out-of-warehouse-scope = 403,
 *  both audit-logged). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const { id } = await params;
  try {
    requireAccessGranted(actor); // P2-3 gate
    return NextResponse.json(await getPackage(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
