import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { dispatchTransfer } from "@/server/services/transfers";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/transfers/[id]/dispatch — hand the fully loaded truck
 *  to the assigned driver: packages → DISPATCHED, origin inventory
 *  released, custody warehouse → driver, one transaction. A partial
 *  load is refused with the unscanned tracking IDs named. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const { id } = await params;
  try {
    requireAccessGranted(actor);
    return NextResponse.json(await dispatchTransfer(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
