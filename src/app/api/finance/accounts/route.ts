import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

import { listAccountBalances } from "@/server/services/finance-overview";

/** GET /api/finance/accounts — chart of accounts with balances
 * derived from ledger entries (finance.read). */
export async function GET() {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    return NextResponse.json(await listAccountBalances(actor));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
