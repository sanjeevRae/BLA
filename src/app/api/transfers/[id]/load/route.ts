import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { loadTransferPackage } from "@/server/services/transfers";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/transfers/[id]/load — scan one package onto the truck.
 *  Verifies manifest membership + origin location + TRANSFER_ASSIGNED
 *  state in the service; duplicate scans are idempotent. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const { id } = await params;
  try {
    requireUnflagged(actor);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await loadTransferPackage(actor, id, {
      trackingId: String(body.trackingId ?? ""),
      idempotencyKey:
        typeof body.idempotencyKey === "string" ? body.idempotencyKey : null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
