import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { stopTrackingSession } from "@/server/services/tracking";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/tracking/session/stop — stop a tracking session: the
 *  owning driver (tracking.manage_own) or a supervisor with
 *  operations.live_view inside the session's warehouse scope.
 *  Body: { trackingSessionId }. */
export async function POST(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const body: unknown = await request.json().catch(() => ({}));
    const trackingSessionId =
      body !== null &&
      typeof body === "object" &&
      "trackingSessionId" in body &&
      typeof (body as { trackingSessionId: unknown }).trackingSessionId === "string"
        ? (body as { trackingSessionId: string }).trackingSessionId
        : "";
    return NextResponse.json(await stopTrackingSession(actor, trackingSessionId));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
