import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { listTickets, raiseTicket } from "@/server/services/support-tickets";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/support/tickets — staff inbox (support.ticket.manage)
 *  or the caller's own tickets (vendor org / customer). */
export async function GET(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
    return NextResponse.json(
      await listTickets(actor, {
        page: Number.isFinite(page) ? page : 1,
        pageSize: Number.isFinite(pageSize) ? pageSize : 25,
        status: (url.searchParams.get("status") as never) ?? undefined,
        category: (url.searchParams.get("category") as never) ?? undefined,
        openOnly: url.searchParams.get("openOnly") === "true",
        assignedToMe: url.searchParams.get("assignedToMe") === "true",
      }),
    );
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

/** POST /api/support/tickets — raise a ticket about the caller's
 *  OWN orders/packages (ownership enforced in the service). */
export async function POST(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const body = await request.json();
    return NextResponse.json(await raiseTicket(actor, body), { status: 201 });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
