import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import {
  recordPickupAttempt,
  type RecordPickupAttemptInput,
} from "@/server/services/deliveries";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/deliveries/assignments/[id]/pickup-attempt — the
 *  assigned pickup rider records a failed vendor pickup (reason
 *  required). The assignment ends FAILED and the package stays
 *  PICKUP_ASSIGNED with exception PICKUP_FAILED for WA reschedule. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as RecordPickupAttemptInput;
    return NextResponse.json(await recordPickupAttempt(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
