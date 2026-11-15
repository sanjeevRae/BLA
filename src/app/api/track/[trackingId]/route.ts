import { NextResponse } from "next/server";

import { getClientIp } from "@/lib/auth/client-ip";
import { getPublicTracking } from "@/server/services/packages";
import { apiErrorResponse } from "@/server/api-errors";

/**
 * GET /api/track/[trackingId] — the PUBLIC tracking projection
 * (docs/security-architecture.md §7). Unauthenticated by design; the
 * service returns an exact minimal field set (status, public timeline,
 * destination district) — never receiver phone, full address or COD.
 * The client IP (trusted-header derivation) feeds the per-IP failure
 * budget enforced in the service (Phase 10, security doc §7).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ trackingId: string }> },
) {
  const { trackingId } = await params;
  try {
    return NextResponse.json(
      await getPublicTracking(trackingId, { ipAddress: getClientIp(request.headers) }),
    );
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
