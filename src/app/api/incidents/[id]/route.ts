import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { getIncident } from "@/server/services/incidents";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/incidents/[id] — incident detail with its append-only
 *  investigation thread (visibility enforced in the service). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    return NextResponse.json(await getIncident(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
