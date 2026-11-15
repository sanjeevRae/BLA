import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import {
  completeReturn,
  type CompleteReturnInput,
} from "@/server/services/returns";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/returns/[id]/complete — hand an INSPECTED return back
 *  to the vendor (custody.handover, in scope): inventory releases
 *  with reason RETURN, custody moves warehouse → vendor user, and
 *  the package becomes RETURNED_TO_SENDER. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as CompleteReturnInput;
    return NextResponse.json(await completeReturn(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
