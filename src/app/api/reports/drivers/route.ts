import { getDriverReport } from "@/server/services/reports";
import { reportJson } from "../shared";

/** GET /api/reports/drivers — driver performance (report.read_all,
 *  or report.read_warehouse for riders homed at the actor's
 *  warehouses). A driver's own view is /api/reports/drivers/self via
 *  the rider dashboard (report.read_self). */
export async function GET(request: Request) {
  return reportJson(request, (actor, filters) => getDriverReport(actor, filters));
}
