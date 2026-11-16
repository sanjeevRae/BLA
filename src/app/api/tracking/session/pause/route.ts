import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { pauseTrackingSession } from "@/server/services/tracking";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/tracking/session/pause — pause the actor's own
 *  tracking session (owner driver only, tracking.manage_own).
 *  Body: { trackingSessionId }. Pings are refused while PAUSED. */
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
    return NextResponse.json(await pauseTrackingSession(actor, trackingSessionId));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
