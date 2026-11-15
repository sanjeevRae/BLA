import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import {
  createDeliveryBatch,
  listDeliveryBatches,
  type CreateDeliveryBatchInput,
} from "@/server/services/deliveries";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/deliveries/batches — scoped batch list (warehouse scope,
 *  or the rider's own batches), search composed with scope under
 *  explicit AND (P3-1). */
export async function GET(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
    return NextResponse.json(
      await listDeliveryBatches(actor, {
        warehouseId: url.searchParams.get("warehouseId") ?? undefined,
        riderUserId: url.searchParams.get("riderUserId") ?? undefined,
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

/** POST /api/deliveries/batches — create a rider's batch at a
 *  warehouse (delivery.assign; rider eligibility enforced in the
 *  service). */
export async function POST(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const body = (await request.json().catch(() => ({}))) as CreateDeliveryBatchInput;
    return NextResponse.json(await createDeliveryBatch(actor, body), { status: 201 });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
