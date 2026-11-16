import { NextResponse, type NextRequest } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import {
  createBulkBookings,
  type CreateBulkBookingsInput,
} from "@/server/services/bookings";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/**
 * POST /api/bookings/bulk — Phase 7 vendor bulk booking: 1–50
 * bookings in one submission, created all-or-nothing inside a single
 * transaction by BookingService (see createBulkBookings). Mirrors the
 * POST /api/bookings auth + error-envelope pattern exactly.
 */
export async function POST(request: NextRequest) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor); // P2-3 gate
    const body = (await request.json().catch(() => ({}))) as CreateBulkBookingsInput;
    const bookings = await createBulkBookings(actor, body);
    return NextResponse.json({ bookings }, { status: 201 });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
