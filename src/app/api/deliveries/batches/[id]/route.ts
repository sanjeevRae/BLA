import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { getDeliveryBatch } from "@/server/services/deliveries";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/deliveries/batches/[id] — batch + assignment states
 *  (dispatcher view; recipient contact details are NOT included —
 *  those exist only in the rider's own view). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    return NextResponse.json(await getDeliveryBatch(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
