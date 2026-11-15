import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

import { voidInvoice } from "@/server/services/invoices";

/** POST /api/finance/invoices/[id]/void — void via compensating
 * reversal entries (invoice.create); never a delete. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { reason?: string };
    return NextResponse.json(await voidInvoice(actor, id, body));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
