import { NextResponse } from "next/server";

import {
  getActorContext,
  requireUnflagged,
  type ActorContext,
} from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/**
 * Shared plumbing for the Phase 9 report routes (api-reference §16):
 * session actor, mustChangePassword gate, and the §1 filter set read
 * from the query string. The services re-validate everything with
 * Zod and enforce permission + scope server-side.
 */
export function reportFiltersFrom(request: Request) {
  const url = new URL(request.url);
  const get = (key: string) => url.searchParams.get(key) ?? undefined;
  return {
    from: get("from"),
    to: get("to"),
    warehouseId: get("warehouseId"),
    vendorId: get("vendorId"),
    driverId: get("driverId"),
    serviceId: get("serviceId"),
    district: get("district"),
    status: get("status"),
    paymentStatus: get("paymentStatus"),
  };
}

export async function reportJson<T>(
  request: Request,
  run: (actor: ActorContext, filters: ReturnType<typeof reportFiltersFrom>) => Promise<T>,
): Promise<NextResponse> {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    return NextResponse.json(await run(actor, reportFiltersFrom(request)));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
