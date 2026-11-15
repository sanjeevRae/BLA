import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import {
  inspectReturn,
  type InspectReturnInput,
} from "@/server/services/returns";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/returns/[id]/inspect — record the inspection condition
 *  of a RECEIVED return (package.inspect, in scope); deterioration
 *  since initiation raises the DAMAGED exception. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as InspectReturnInput;
    return NextResponse.json(await inspectReturn(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
