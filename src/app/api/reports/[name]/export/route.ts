import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";
import { buildReportCsv } from "@/server/services/reports-export";
import { reportFiltersFrom } from "../../shared";

/** GET /api/reports/[name]/export?format=csv — authorized export of
 *  the same scoped data the named report returns (the export builder
 *  calls the report service itself; permission and scope are the
 *  report's own). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ name: string }> },
) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
    const { name } = await params;
    const { filename, csv } = await buildReportCsv(
      actor,
      name,
      reportFiltersFrom(request),
    );
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
