import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import {
  approveReturn,
  type ApproveReturnInput,
} from "@/server/services/returns";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/returns/[id]/approve — authorise a return (Warehouse
 *  Admin of the return warehouse; the charge decision is recorded
 *  with the approval). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as ApproveReturnInput;
    return NextResponse.json(await approveReturn(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
