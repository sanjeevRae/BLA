import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import {
  createTransfer,
  listTransfers,
} from "@/server/services/transfers";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/transfers — scoped list (origin/destination membership,
 *  assigned driver, or transfer.read_all), search composed with the
 *  scope under explicit AND (P3-1). */
export async function GET(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
    return NextResponse.json(
      await listTransfers(actor, {
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

/** POST /api/transfers — create a DRAFT transfer at the origin
 *  warehouse (transfer.create; origin scope enforced in service). */
export async function POST(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const transfer = await createTransfer(actor, {
      originWarehouseId: String(body.originWarehouseId ?? ""),
      destinationWarehouseId: String(body.destinationWarehouseId ?? ""),
      instructions: (body.instructions as string | null | undefined) ?? null,
      expectedArrivalAt: (body.expectedArrivalAt as string | null | undefined) ?? null,
    });
    return NextResponse.json(transfer, { status: 201 });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
