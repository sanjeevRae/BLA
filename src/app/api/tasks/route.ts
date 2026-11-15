import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { createTask, listTasks } from "@/server/services/tasks";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/tasks — task board for the caller's scope (assignee /
 *  creator / manager queues; overdue is derived, never stored). */
export async function GET(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
    return NextResponse.json(
      await listTasks(actor, {
        page: Number.isFinite(page) ? page : 1,
        pageSize: Number.isFinite(pageSize) ? pageSize : 25,
        status: (url.searchParams.get("status") as never) ?? undefined,
        priority: (url.searchParams.get("priority") as never) ?? undefined,
        warehouseId: url.searchParams.get("warehouseId") ?? undefined,
        queue: (url.searchParams.get("queue") as never) ?? "all",
        overdueOnly: url.searchParams.get("overdueOnly") === "true",
      }),
    );
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

/** POST /api/tasks — create + assign a task (task.create). */
export async function POST(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const body = await request.json();
    return NextResponse.json(await createTask(actor, body), { status: 201 });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
