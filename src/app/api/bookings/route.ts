import { NextResponse, type NextRequest } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { createBooking, listBookings, type CreateBookingInput } from "@/server/services/bookings";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/**
 * GET /api/bookings — force-scoped booking list (vendor: own only;
 * warehouse staff: routed to their warehouses; company readers: all).
 * POST /api/bookings — create a booking; packages + tracking IDs are
 * generated inside the booking transaction by BookingService.
 */
export async function GET(request: NextRequest) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const params = request.nextUrl.searchParams;
  try {
    requireAccessGranted(actor); // P2-3 gate
    const result = await listBookings(actor, {
      page: Number(params.get("page") ?? 1) || 1,
      pageSize: Number(params.get("pageSize") ?? 20) || 20,
      status: params.get("status") ?? undefined,
      approvalStatus: params.get("approvalStatus") ?? undefined,
      vendorId: params.get("vendorId") ?? undefined,
      search: params.get("search") ?? undefined,
    });
    return NextResponse.json(result);
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor); // P2-3 gate
    const body = (await request.json()) as CreateBookingInput;
    const booking = await createBooking(actor, body);
    return NextResponse.json(booking, { status: 201 });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
