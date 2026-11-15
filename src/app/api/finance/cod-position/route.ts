import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

import { getRiderCodPosition } from "@/server/services/cod-remittances";

/** GET /api/finance/cod-position — a rider's COD obligations:
 * collections awaiting remittance, amounts in open remittances,
 * verified totals and the ledger-derived amount still owed
 * (cod.read; riders are pinned to themselves). */
export async function GET(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const url = new URL(request.url);
    return NextResponse.json(
      await getRiderCodPosition(actor, url.searchParams.get("driverId") ?? undefined),
    );
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
