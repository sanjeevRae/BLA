import { NextResponse } from "next/server";

import { getClientIp } from "@/lib/auth/client-ip";
import { raiseTrackingComplaint } from "@/server/services/support-tickets";
import { apiErrorResponse } from "@/server/api-errors";

/**
 * POST /api/public/track/[trackingId]/complaint — a recipient
 * raises a support ticket from the public tracking page. Verified
 * by the recipient phone number (the detailed-tracking second
 * factor); every failure returns the identical 404 envelope.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ trackingId: string }> },
) {
  const { trackingId } = await params;
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(
      await raiseTrackingComplaint(trackingId, body, {
        ipAddress: getClientIp(request.headers),
      }),
      { status: 201 },
    );
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
