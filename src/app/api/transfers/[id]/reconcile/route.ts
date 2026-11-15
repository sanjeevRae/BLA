import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { reconcileTransfer } from "@/server/services/transfers";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/transfers/[id]/reconcile — destination-side
 *  reconciliation: recounts item rows (never a stored counter);
 *  clean only when every manifested package is accounted for,
 *  otherwise the transfer moves to EXCEPTION with the unaccounted
 *  tracking IDs named. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const { id } = await params;
  try {
    requireAccessGranted(actor);
    return NextResponse.json(await reconcileTransfer(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
