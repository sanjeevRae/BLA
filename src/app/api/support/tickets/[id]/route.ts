import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { getTicket } from "@/server/services/support-tickets";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/support/tickets/[id] — ticket detail. INTERNAL staff
 *  notes are filtered out in the service query for non-staff. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    return NextResponse.json(await getTicket(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
