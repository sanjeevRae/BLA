import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import {
  receivePackage,
  type ReceivePackageInput,
} from "@/server/services/inventory";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/**
 * POST /api/operations/receive — the receiving scan (scanner/mobile
 * clients post here; the dashboard uses the equivalent Server Action).
 * Duplicate scans return 200 with `alreadyReceived: true`; a fresh
 * intake returns 201. Scope, capacity and misroute rules live in the
 * service; denials are audit-logged there.
 */
export async function POST(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor); // P2-3 gate
    const body = (await request.json()) as ReceivePackageInput;
    const result = await receivePackage(actor, body);
    const status = result.alreadyReceived || result.misrouted ? 200 : 201;
    return NextResponse.json(result, { status });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
