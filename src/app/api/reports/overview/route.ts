import { getOverviewReport } from "@/server/services/reports";
import { reportJson } from "../shared";

/** GET /api/reports/overview — company overview (report.read_all;
 *  finance-only readers are denied, matrix footnote 32). */
export async function GET(request: Request) {
  return reportJson(request, (actor, filters) => getOverviewReport(actor, filters));
}
