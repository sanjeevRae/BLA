import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { getMyUnreadCount } from "@/server/services/notifications";
import { apiErrorResponse } from "@/server/api-errors";

/** GET /api/notifications/unread-count — bell badge count for the
 *  signed-in user (0 for roles without a notification inbox).
 *  The full access gate is applied like every other route (Phase 8
 *  review, minor): a flagged account must change its password — and
 *  a restricted privileged account must satisfy MFA (Phase 10) —
 *  before any surface, even this count-only chrome read, works. */
export async function GET() {
  const actor = await getActorContext();
  if (!actor) return NextResponse.json({ count: 0 });
  try {
    requireAccessGranted(actor);
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
  return NextResponse.json(await getMyUnreadCount(actor));
}
