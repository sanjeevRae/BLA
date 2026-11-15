import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { requestRedelivery } from "@/server/services/support-tickets";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/support/tickets/[id]/request-redelivery — support
 *  records a redelivery request on the ticket (Part 4.10); the
 *  warehouse performs the work through its own services. */
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
    return NextResponse.json(await requestRedelivery(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
