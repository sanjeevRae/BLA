import { getDailyReport } from "@/server/services/reports";
import { reportJson } from "../shared";

/** GET /api/reports/daily?date=YYYY-MM-DD — daily operational summary
 *  for one Asia/Kathmandu day (report.read_all or the actor's own
 *  warehouses via report.read_warehouse). Also the data source of the
 *  daily-report notification. `date` is the canonical parameter;
 *  `from` is accepted as an alias. */
export async function GET(request: Request) {
  return reportJson(request, (actor, filters) => {
    const date = new URL(request.url).searchParams.get("date") ?? filters.from;
    return getDailyReport(actor, { ...filters, from: date ?? undefined });
  });
}
