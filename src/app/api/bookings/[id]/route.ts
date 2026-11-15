import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { getBooking } from "@/server/services/bookings";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/bookings/[id] — one booking with its shipments and
 *  packages, force-scoped by BookingService (cross-tenant = 404). */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const { id } = await params;
  try {
    requireUnflagged(actor); // P2-3 gate
    return NextResponse.json(await getBooking(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
