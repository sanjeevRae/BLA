import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { closeHandoverBatch } from "@/server/services/custody";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/**
 * POST /api/operations/handovers/{id}/close — close a batch short.
 * Unconfirmed packages are marked MISSING and the batch goes
 * DISPUTED (audit + TrackingEvent per package); a short batch can
 * never be silently completed.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const { id } = await params;
  try {
    requireUnflagged(actor); // P2-3 gate
    const batch = await closeHandoverBatch(actor, id);
    return NextResponse.json(batch);
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
