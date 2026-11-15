import { getCodReport } from "@/server/services/reports-finance";
import { reportJson } from "../shared";

/** GET /api/reports/cod — COD expected / collected / remitted /
 *  outstanding per rider and per warehouse, reconciling to the paisa
 *  (cod.read with the Phase 7 F2 scoping law). */
export async function GET(request: Request) {
  return reportJson(request, (actor, filters) => getCodReport(actor, filters));
}
