import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

import { paySettlement } from "@/server/services/settlements";

/** POST /api/finance/settlements/[id]/pay — pay an APPROVED
 * settlement (settlement.pay); posts the balanced payout journal. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await paySettlement(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
