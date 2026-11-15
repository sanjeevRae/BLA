import { getWarehouseReport } from "@/server/services/reports";
import { reportJson } from "../shared";

/** GET /api/reports/warehouses — per-warehouse operational report
 *  (report.read_all, or report.read_warehouse scoped to the actor's
 *  memberships; a foreign warehouseId is an audited denial). */
export async function GET(request: Request) {
  return reportJson(request, (actor, filters) => getWarehouseReport(actor, filters));
}
