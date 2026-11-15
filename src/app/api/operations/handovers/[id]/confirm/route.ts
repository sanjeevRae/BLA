import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { confirmHandoverPackage } from "@/server/services/custody";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/**
 * POST /api/operations/handovers/{id}/confirm — the receiver confirms
 * one package of the batch: the old custody closes and the new one
 * opens atomically for that package.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const { id } = await params;
  try {
    requireUnflagged(actor); // P2-3 gate
    const body = (await request.json()) as {
      packageId: string;
      condition?: "GOOD" | "DAMAGED";
    };
    const batch = await confirmHandoverPackage(actor, {
      batchId: id,
      packageId: body.packageId,
      condition: body.condition ?? "GOOD",
    });
    return NextResponse.json(batch);
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
