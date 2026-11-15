import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import {
  scanBackPackage,
  type ScanBackInput,
} from "@/server/services/deliveries";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** POST /api/deliveries/scan-back — warehouse receives an
 *  undelivered package back from a rider (package.receive, in
 *  scope): custody and inventory reopen, and an open return
 *  advances to RECEIVED in the same transaction. */
export async function POST(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const body = (await request.json().catch(() => ({}))) as ScanBackInput;
    return NextResponse.json(await scanBackPackage(actor, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
