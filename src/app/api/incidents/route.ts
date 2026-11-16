import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import {
  createIncident,
  listIncidents,
} from "@/server/services/incidents";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";

/** GET /api/incidents — the caller's incident queue (scope composed
 *  server-side: role/category/warehouse rules, vendor/customer own
 *  packages only). */
export async function GET(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const url = new URL(request.url);
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 25);
    return NextResponse.json(
      await listIncidents(actor, {
        page: Number.isFinite(page) ? page : 1,
        pageSize: Number.isFinite(pageSize) ? pageSize : 25,
        status: (url.searchParams.get("status") as never) ?? undefined,
        category: (url.searchParams.get("category") as never) ?? undefined,
        severity: (url.searchParams.get("severity") as never) ?? undefined,
        warehouseId: url.searchParams.get("warehouseId") ?? undefined,
        mine: url.searchParams.get("mine") === "true",
        openOnly: url.searchParams.get("openOnly") === "true",
      }),
    );
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

/** POST /api/incidents — manual incident report (incident.report;
 *  links validated against the reporter's scope). */
export async function POST(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await createIncident(actor, body), { status: 201 });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
