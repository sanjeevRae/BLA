import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import {
  confirmDelivery,
  type ConfirmDeliveryInput,
} from "@/server/services/deliveries";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/deliveries/assignments/[id]/deliver — the assigned
 *  rider confirms delivery: recipient name + OTP verification +
 *  exact COD amounts. Writes the ProofOfDelivery, the COD
 *  collection event (MATCHED/MISMATCH), the DELIVERED transition
 *  and the custody close in one transaction. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as ConfirmDeliveryInput;
    return NextResponse.json(await confirmDelivery(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
