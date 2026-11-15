import { getVendorReport } from "@/server/services/reports";
import { reportJson } from "../shared";

/** GET /api/reports/vendors — vendor performance and statements
 *  (report.read_all for staff; a vendor actor is pinned to their own
 *  row via report.read_vendor). */
export async function GET(request: Request) {
  return reportJson(request, (actor, filters) => getVendorReport(actor, filters));
}
