import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { completePackageReceiving } from "@/server/services/transfers";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/transfers/[id]/complete-receiving — finish one scanned
 *  package's destination receiving: condition recorded (damage is
 *  quarantined), package → RECEIVED_AT_DESTINATION. */
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
    const transfer = await completePackageReceiving(actor, id, {
      packageId: String(body.packageId ?? ""),
      condition:
        body.condition === "DAMAGED" ||
        body.condition === "SUSPECTED_DAMAGE" ||
        body.condition === "PACKAGING_COMPROMISED"
          ? body.condition
          : "GOOD",
      notes: typeof body.notes === "string" ? body.notes : null,
    });
    return NextResponse.json(transfer);
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
