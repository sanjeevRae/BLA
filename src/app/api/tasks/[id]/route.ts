import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { getTask } from "@/server/services/tasks";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/tasks/[id] — task detail with its comment thread. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    return NextResponse.json(await getTask(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
