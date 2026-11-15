import { getDriverSelfReport } from "@/server/services/reports";
import { reportJson } from "../../shared";

/** GET /api/reports/drivers/self — the signed-in driver's own
 *  performance and COD report (report.read_self). The driver is taken
 *  from the actor, never from the query string. */
export async function GET(request: Request) {
  return reportJson(request, (actor, filters) => getDriverSelfReport(actor, filters));
}
