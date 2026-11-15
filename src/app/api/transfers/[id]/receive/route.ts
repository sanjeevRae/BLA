import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { scanDestinationPackage } from "@/server/services/transfers";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/transfers/[id]/receive — destination arrival scan.
 *  Manifested packages enter destination receiving (inventory +
 *  custody + RECEIVING_INSPECTION); wrong-warehouse packages take
 *  the misroute path and are never stocked; duplicates idempotent. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const { id } = await params;
  try {
    requireAccessGranted(actor);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await scanDestinationPackage(actor, id, {
      trackingId: String(body.trackingId ?? ""),
      idempotencyKey:
        typeof body.idempotencyKey === "string" ? body.idempotencyKey : null,
      capacityOverrideReason:
        typeof body.capacityOverrideReason === "string"
          ? body.capacityOverrideReason
          : null,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
