import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { arriveTrip } from "@/server/services/trips";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/trips/[id]/arrive — arrival at the destination
 *  warehouse: packages → ARRIVED_AT_DESTINATION, transfer → ARRIVED.
 *  Receiving itself is a separate warehouse action; the driver never
 *  receives. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const { id } = await params;
  try {
    requireAccessGranted(actor);
    return NextResponse.json(await arriveTrip(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
