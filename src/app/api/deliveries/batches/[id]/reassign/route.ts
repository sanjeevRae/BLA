import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import {
  reassignBatch,
  type ReassignBatchInput,
} from "@/server/services/deliveries";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/deliveries/batches/[id]/reassign — whole-batch rider
 *  swap: every active assignment (PENDING / ACCEPTED / IN_PROGRESS)
 *  moves to the new rider in one transaction, with custody and a
 *  fresh recipient OTP for collected packages, the old rider's
 *  tracking session ended (REASSIGNED), and the old batch closed
 *  in-transaction when nothing — including delivered-COD close-out —
 *  remains pending on it. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as ReassignBatchInput;
    return NextResponse.json(await reassignBatch(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
