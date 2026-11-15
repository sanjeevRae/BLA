import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { regenerateOtp } from "@/server/services/deliveries";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/deliveries/assignments/[id]/regenerate-otp — issue a
 *  fresh delivery code (assigned rider, or warehouse staff in
 *  scope). Resets the failure counter and lock; the new code is
 *  returned once, like at pickup. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    return NextResponse.json(await regenerateOtp(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
