import { requireActor } from "@/lib/auth/permissions";
import { getFinanceConsole } from "@/server/services/finance-home";
import { FinanceHomeView } from "@/components/finance-home/FinanceHomeView";

/**
 * Finance home (V3 Step 8): a thin wrapper over the Step 8 read
 * model (`getFinanceConsole`) and the presentational
 * FinanceHomeView. The model enforces the finance.read gate; every
 * figure the view renders is composed inside it from the finance
 * services.
 */
export default async function Page() {
  const actor = await requireActor();
  const data = await getFinanceConsole(actor);
  return <FinanceHomeView data={data} />;
}
