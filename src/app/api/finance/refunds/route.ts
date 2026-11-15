import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

import { listRefunds, requestRefund } from "@/server/services/finance-adjustments";

/** GET /api/finance/refunds — refund list (finance.read). */
export async function GET(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
    return NextResponse.json(
      await listRefunds(actor, {
        status: url.searchParams.get("status") ?? undefined,
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

/** POST /api/finance/refunds — request a refund against a payment
 * (refund.process). */
export async function POST(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await requestRefund(actor, body), { status: 201 });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
