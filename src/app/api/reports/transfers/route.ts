import { getTransferReport } from "@/server/services/reports";
import { reportJson } from "../shared";

/** GET /api/reports/transfers — line-haul routes: volume, receiving
 *  outcome, discrepancies, transit time (report.read_all or
 *  report.read_warehouse scoped to transfers touching the actor's
 *  warehouses). */
export async function GET(request: Request) {
  return reportJson(request, (actor, filters) => getTransferReport(actor, filters));
}
