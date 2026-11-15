import { NextResponse } from "next/server";

import { getPublicTracking } from "@/server/services/packages";
import { apiErrorResponse } from "@/server/api-errors";

/**
 * GET /api/track/[trackingId] — the PUBLIC tracking projection
 * (docs/security-architecture.md §7). Unauthenticated by design; the
 * service returns an exact minimal field set (status, public timeline,
 * destination district) — never receiver phone, full address or COD.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ trackingId: string }> },
) {
  const { trackingId } = await params;
  try {
    return NextResponse.json(await getPublicTracking(trackingId));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
