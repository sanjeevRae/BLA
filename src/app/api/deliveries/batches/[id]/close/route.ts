import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { closeBatch } from "@/server/services/deliveries";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/deliveries/batches/[id]/close — end-of-day closure.
 *  The service recounts assignment rows inside the transaction
 *  under the batch row lock; unaccounted packages block closure and
 *  are named in the error. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const { id } = await params;
    return NextResponse.json(await closeBatch(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
