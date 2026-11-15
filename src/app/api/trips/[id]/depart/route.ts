import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { departTrip } from "@/server/services/trips";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/trips/[id]/depart — the assigned driver (or origin
 *  oversight) records departure: packages → IN_TRANSIT, transfer →
 *  IN_TRANSIT. */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const { id } = await params;
  try {
    requireAccessGranted(actor);
    return NextResponse.json(await departTrip(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
