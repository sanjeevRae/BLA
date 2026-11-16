import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { getOwnTrackingState } from "@/server/services/tracking";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/tracking/session/current — the actor's OWN tracking
 *  state for the driver panel: latest session (any state),
 *  assignments eligible to start, last accepted fix + freshness,
 *  and the client cadence config. Identity comes from the
 *  authenticated session only; the response contains no other
 *  driver's data and no recipient PII. */
export async function GET() {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    return NextResponse.json(await getOwnTrackingState(actor));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
