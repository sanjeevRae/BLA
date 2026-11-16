import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { getLiveOperationDetail } from "@/server/services/live-operations";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/live-operations/[trackingSessionId] — one session's live
 *  item plus its packages (tracking ids + statuses only; no
 *  recipient data, no per-package COD). Out-of-scope sessions are
 *  audited and refused inside the service. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ trackingSessionId: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const { trackingSessionId } = await params;
  try {
    requireAccessGranted(actor);
    return NextResponse.json(
      await getLiveOperationDetail(actor, trackingSessionId),
    );
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
