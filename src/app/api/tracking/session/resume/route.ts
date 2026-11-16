import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { resumeTrackingSession } from "@/server/services/tracking";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/tracking/session/resume — resume the actor's own
 *  paused tracking session (owner driver only,
 *  tracking.manage_own). Body: { trackingSessionId }. */
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
    return NextResponse.json(await resumeTrackingSession(actor, trackingSessionId));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
