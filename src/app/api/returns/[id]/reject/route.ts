import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import {
  rejectReturn,
  type RejectReturnInput,
} from "@/server/services/returns";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/returns/[id]/reject — reject a return request with a
 *  recorded reason; the package's return flags are cleared and it
 *  resumes the normal flow. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as RejectReturnInput;
    return NextResponse.json(await rejectReturn(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
