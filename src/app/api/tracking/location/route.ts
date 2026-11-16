import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { postLocationPing } from "@/server/services/tracking";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/tracking/location — the driver reports one GPS fix for
 *  their ACTIVE tracking session (tracking.manage_own). Idempotent
 *  replays (duplicate sequence / identical coordinates) also return
 *  200 with `deduplicated: true`. */
export async function POST(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const body: unknown = await request.json().catch(() => ({}));
    return NextResponse.json(await postLocationPing(actor, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
