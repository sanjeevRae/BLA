import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import {
  confirmPickupCollection,
  type ConfirmPickupCollectionInput,
} from "@/server/services/deliveries";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/deliveries/batches/[id]/collect — the assigned pickup
 *  rider confirms vendor-pickup collection for the scanned set.
 *  Taken packages move PICKUP_ASSIGNED → PICKED_UP with custody
 *  sender → rider (no OTP); unscanned assignments are returned as
 *  explicit shortages and stay PENDING. Sibling of the delivery
 *  handout route (/pickup), which is left untouched. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as ConfirmPickupCollectionInput;
    return NextResponse.json(await confirmPickupCollection(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
