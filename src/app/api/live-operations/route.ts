import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { listLiveOperations } from "@/server/services/live-operations";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/live-operations — the live board: ACTIVE / PAUSED
 *  tracking sessions plus sessions ended inside the recent window,
 *  each with its latest DriverCurrentLocation snapshot and a
 *  read-time freshness state. Scope (operations.live_view +
 *  warehouse membership) is applied inside the service; the optional
 *  `warehouseId` param only ever narrows it. */
export async function GET(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const url = new URL(request.url);
    return NextResponse.json(
      await listLiveOperations(actor, {
        warehouseId: url.searchParams.get("warehouseId") ?? undefined,
        search: url.searchParams.get("search") ?? undefined,
      }),
    );
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
