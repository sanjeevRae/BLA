import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

import { getFinanceOverview } from "@/server/services/finance-overview";

/** GET /api/finance/overview — dashboard figures, all computed from
 * ledger entries and source records (finance.read). */
export async function GET() {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    return NextResponse.json(await getFinanceOverview(actor));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
