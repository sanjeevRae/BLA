import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

import { generateVendorInvoice, listInvoices } from "@/server/services/invoices";

/** GET /api/finance/invoices — invoice list (invoice.read; vendors
 * and customers are scoped to their own invoices in the service). */
export async function GET(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
    return NextResponse.json(
      await listInvoices(actor, {
        vendorId: url.searchParams.get("vendorId") ?? undefined,
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

/** POST /api/finance/invoices — generate a vendor invoice from
 * delivered shipments' snapshotted charges (invoice.create).
 * Idempotent: { invoice: null } when nothing new is billable. */
export async function POST(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const body = (await request.json().catch(() => ({}))) as { vendorId?: string; dueInDays?: number };
    const invoice = await generateVendorInvoice(actor, body);
    return NextResponse.json({ invoice }, { status: invoice ? 201 : 200 });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
