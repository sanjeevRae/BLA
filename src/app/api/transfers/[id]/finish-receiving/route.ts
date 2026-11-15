import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { finishReceiving } from "@/server/services/transfers";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/transfers/[id]/finish-receiving — declare unloading
 *  finished: unreceived items are marked MISSING (exception raised,
 *  packages stay in driver custody), the trip completes, and the
 *  transfer moves to RECONCILIATION_PENDING. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const { id } = await params;
  try {
    requireAccessGranted(actor);
    return NextResponse.json(await finishReceiving(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
