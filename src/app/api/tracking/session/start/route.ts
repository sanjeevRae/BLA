import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { startTrackingSession } from "@/server/services/tracking";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/tracking/session/start — the assigned driver starts a
 *  GPS tracking session for their active trip or delivery batch
 *  (tracking.manage_own; explicit permission acknowledgement
 *  required). */
export async function POST(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const body: unknown = await request.json().catch(() => ({}));
    return NextResponse.json(await startTrackingSession(actor, body), {
      status: 201,
    });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
