import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { getTransfer } from "@/server/services/transfers";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/transfers/[id] — one transfer with items, manifest,
 *  reconciliation summary; read scope enforced in service. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  const { id } = await params;
  try {
    requireAccessGranted(actor);
    return NextResponse.json(await getTransfer(actor, id));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
