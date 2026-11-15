import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

import { resolveRemittance } from "@/server/services/cod-remittances";

/** POST /api/finance/remittances/[id]/resolve — finance decision on
 * a discrepancy (cod.verify): ACCEPTED_COUNTED with a mandatory
 * note, or REJECTED (collections return to the rider). */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await resolveRemittance(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
