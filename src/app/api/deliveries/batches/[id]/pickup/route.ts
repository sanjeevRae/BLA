import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import {
  confirmPickup,
  type ConfirmPickupInput,
} from "@/server/services/deliveries";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/deliveries/batches/[id]/pickup — the assigned rider
 *  confirms the scanned set. Taken packages move to
 *  OUT_FOR_DELIVERY with custody warehouse → rider; unscanned
 *  assignments are returned as explicit shortages. The response
 *  carries each taken package's one-time delivery code (transitional
 *  hand-off until Phase 8 recipient notifications). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as ConfirmPickupInput;
    return NextResponse.json(await confirmPickup(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
