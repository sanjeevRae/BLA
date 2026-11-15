import { NextResponse } from "next/server";

import { getDetailedTracking } from "@/server/services/packages";
import { apiErrorResponse } from "@/server/api-errors";

/**
 * POST /api/track/[trackingId]/details — the DETAILED public
 * tracking view (security-architecture §7, roadmap Phase 6).
 * Unauthenticated, but gated by the second factor: the recipient
 * phone number on the package record must match exactly after
 * normalisation. Wrong phone, unknown tracking code and the
 * post-cap lockout all return the identical 404 envelope; failures
 * are audit-logged and rate-capped per tracking code.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ trackingId: string }> },
) {
  const { trackingId } = await params;
  try {
    const body = (await request.json().catch(() => ({}))) as { phone?: unknown };
    const phone = typeof body.phone === "string" ? body.phone : "";
    return NextResponse.json(await getDetailedTracking(trackingId, phone));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
