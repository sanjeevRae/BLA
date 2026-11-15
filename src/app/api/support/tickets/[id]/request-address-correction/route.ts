import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { requestAddressCorrection } from "@/server/services/support-tickets";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/support/tickets/[id]/request-address-correction —
 *  support records an address-correction request on the ticket
 *  (Part 4.10); operations applies it through its own services. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    const body = await request.json();
    return NextResponse.json(await requestAddressCorrection(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
