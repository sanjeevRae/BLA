import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import {
  initiateHandover,
  type InitiateHandoverInput,
} from "@/server/services/custody";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/**
 * POST /api/operations/handovers — initiate a custody handover batch
 * with an expected package set. Custody moves only when the receiver
 * confirms each package (see /handovers/[id]/confirm).
 */
export async function POST(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor); // P2-3 gate
    const body = (await request.json()) as InitiateHandoverInput;
    const batch = await initiateHandover(actor, body);
    return NextResponse.json(batch, { status: 201 });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
