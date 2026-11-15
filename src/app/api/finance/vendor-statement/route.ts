import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

import { getVendorStatement } from "@/server/services/settlements";

/** GET /api/finance/vendor-statement?vendorId= — derived payable
 * position for one vendor (settlement.read; vendors pinned to
 * themselves). */
export async function GET(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const url = new URL(request.url);
    const vendorId = url.searchParams.get("vendorId") ?? actor.vendorId ?? undefined;
    if (!vendorId) {
      return NextResponse.json(
        { error: { code: "VALIDATION", message: "vendorId is required" } },
        { status: 400 },
      );
    }
    return NextResponse.json(await getVendorStatement(actor, vendorId));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
