import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

import { verifyRemittance } from "@/server/services/cod-remittances";

/** POST /api/finance/remittances/[id]/verify — finance counts the
 * handover (cod.verify). Exact counts verify; anything else parks
 * the remittance in DISCREPANCY. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await verifyRemittance(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
