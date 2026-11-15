import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import {
  addBatchPackages,
  type AddBatchPackagesInput,
} from "@/server/services/deliveries";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/deliveries/batches/[id]/assignments — assign packages
 *  to the batch. Per-package results: added assignments plus an
 *  explicit rejection list with reasons (never silent). The service
 *  wires READY_FOR_DELIVERY and enforces one open assignment per
 *  package under the Package row lock. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as AddBatchPackagesInput;
    return NextResponse.json(await addBatchPackages(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
