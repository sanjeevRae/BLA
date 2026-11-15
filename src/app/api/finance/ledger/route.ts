import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

import { getJournalBalance, listLedgerEntries } from "@/server/services/finance-overview";

/** GET /api/finance/ledger — read-only journal view (finance.read).
 * ?balanceFor=<journalRef> returns that journal's balance check. */
export async function GET(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const url = new URL(request.url);
    const balanceFor = url.searchParams.get("balanceFor");
    if (balanceFor) return NextResponse.json(await getJournalBalance(actor, balanceFor));
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 50);
    return NextResponse.json(
      await listLedgerEntries(actor, {
        journalRef: url.searchParams.get("journalRef") ?? undefined,
        accountCode: url.searchParams.get("accountCode") ?? undefined,
        type: url.searchParams.get("type") ?? undefined,
        page: Number.isFinite(page) ? page : 1,
        pageSize: Number.isFinite(pageSize) ? pageSize : 50,
      }),
    );
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
