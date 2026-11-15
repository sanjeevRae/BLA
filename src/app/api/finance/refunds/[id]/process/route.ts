import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

import { processRefund } from "@/server/services/finance-adjustments";

/** POST /api/finance/refunds/[id]/process — refund lifecycle step
 * (refund.process). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const { id } = await params;
    return NextResponse.json(await processRefund(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
