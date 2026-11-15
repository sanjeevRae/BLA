import { NextResponse } from "next/server";

import { getActorContext } from "@/lib/auth/permissions";
import { getMyUnreadCount } from "@/server/services/notifications";

/** GET /api/notifications/unread-count — bell badge count for the
 *  signed-in user (0 for roles without a notification inbox). */
export async function GET() {
  const actor = await getActorContext();
  if (!actor) return NextResponse.json({ count: 0 });
  return NextResponse.json(await getMyUnreadCount(actor));
}
