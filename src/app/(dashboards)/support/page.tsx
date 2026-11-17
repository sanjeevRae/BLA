import { requireActor } from "@/lib/auth/permissions";
import { getSupportConsole } from "@/server/services/support-home";
import { SupportHomeView } from "@/components/support-home/SupportHomeView";

/**
 * Support home (V3 Step 8): a thin wrapper over the Step 8 read
 * model (`getSupportConsole`) and the presentational
 * SupportHomeView — the vendor page pattern. The model is gated on
 * support.ticket.manage inside getSupportHome; every figure the
 * view renders comes from the model's field-mapped composition.
 */
export default async function Page() {
  const actor = await requireActor();
  const data = await getSupportConsole(actor);
  return <SupportHomeView data={data} />;
}
