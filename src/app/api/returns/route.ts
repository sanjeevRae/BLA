import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import {
  initiateReturn,
  listReturns,
  type InitiateReturnInput,
} from "@/server/services/returns";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/returns — scoped return list (vendor: own shipments;
 *  warehouse staff: own warehouses; unscoped: all), search composed
 *  with scope under explicit AND (P3-1). */
export async function GET(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
    return NextResponse.json(
      await listReturns(actor, {
        warehouseId: url.searchParams.get("warehouseId") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        search: url.searchParams.get("search") ?? undefined,
        page: Number.isFinite(page) ? page : 1,
        pageSize: Number.isFinite(pageSize) ? pageSize : 25,
      }),
    );
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

/** POST /api/returns — open a return for a package
 *  (package.return_initiate; vendor/rider/warehouse scope enforced
 *  in the service). */
export async function POST(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const body = (await request.json().catch(() => ({}))) as InitiateReturnInput;
    return NextResponse.json(await initiateReturn(actor, body), { status: 201 });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
