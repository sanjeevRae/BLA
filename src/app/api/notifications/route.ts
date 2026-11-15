import { NextResponse } from "next/server";

import { getActorContext, requireUnflagged } from "@/lib/auth/permissions";
import {
  listMyNotifications,
  markAllMyNotificationsRead,
} from "@/server/services/notifications";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/notifications — the caller's own in-app notifications
 *  (recipient-addressed rows are never listed here). */
export async function GET(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 20);
    return NextResponse.json(
      await listMyNotifications(actor, {
        page: Number.isFinite(page) ? page : 1,
        pageSize: Number.isFinite(pageSize) ? pageSize : 20,
        unreadOnly: url.searchParams.get("unreadOnly") === "true",
        category: (url.searchParams.get("category") as never) ?? undefined,
      }),
    );
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

/** POST /api/notifications — mark all of the caller's notifications read. */
export async function POST() {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireUnflagged(actor);
    return NextResponse.json(await markAllMyNotificationsRead(actor));
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
