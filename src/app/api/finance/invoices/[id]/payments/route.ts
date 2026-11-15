import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

import { recordPayment } from "@/server/services/invoices";

/** POST /api/finance/invoices/[id]/payments — record a payment
 * allocated to this invoice (finance.record_payment). Body:
 * { amountPaisa, method, transactionRef?, idempotencyKey?, paidAt? }
 * — amounts are integer-paisa strings. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      amountPaisa?: string;
      allocationPaisa?: string;
    };
    const allocation = body.allocationPaisa ?? body.amountPaisa;
    return NextResponse.json(
      await recordPayment(actor, {
        ...body,
        allocations: [{ invoiceId: id, amountPaisa: allocation }],
      }),
      { status: 201 },
    );
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
