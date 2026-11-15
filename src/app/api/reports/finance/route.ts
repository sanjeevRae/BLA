import { getFinanceReport } from "@/server/services/reports-finance";
import { reportJson } from "../shared";

/** GET /api/reports/finance — revenue, collections, ageing,
 *  settlements, refunds and COD reconciliation state (finance.read). */
export async function GET(request: Request) {
  return reportJson(request, (actor, filters) => getFinanceReport(actor, filters));
}
