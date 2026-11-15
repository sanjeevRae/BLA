import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import {
  recordDeliveryAttempt,
  type RecordAttemptInput,
} from "@/server/services/deliveries";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/deliveries/assignments/[id]/attempt — the assigned
 *  rider records a failed attempt (reason vocabulary enforced;
 *  refusal / attempt-limit / RETURN_TO_SENDER initiates the return
 *  flow in the same transaction). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as RecordAttemptInput;
    return NextResponse.json(await recordDeliveryAttempt(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
