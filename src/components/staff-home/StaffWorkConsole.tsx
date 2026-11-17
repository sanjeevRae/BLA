import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { getStaffWorkConsole } from "@/server/services/home-dashboards";
import {
  StaffWorkConsoleView,
  staffHomeActions,
} from "./StaffWorkConsoleView";

/**
 * Warehouse Staff work console container (V3 Step 5, brief §8):
 * owns the read (`getStaffWorkConsole` — the finance-free composition
 * over `getStaffMyWork` + the warehouse-home aggregate) and resolves
 * the floor-action permission flags, then hands both to the pure
 * view. Action gating uses the real catalog codes the underlying
 * flows themselves require: receiving/scanning is the operations
 * receiving form (`package.receive`), inspection is the operations
 * inspection queue (`package.inspect`), issue reporting is the
 * incidents queue (`incident.report`).
 */
export async function StaffWorkConsole({ actor }: { actor: ActorContext }) {
  const data = await getStaffWorkConsole(actor);
  const actions = staffHomeActions({
    canReceive: hasPermission(actor, "package.receive"),
    canInspect: hasPermission(actor, "package.inspect"),
    canReportIssue: hasPermission(actor, "incident.report"),
  });
  return (
    <StaffWorkConsoleView data={data} actorName={actor.fullName} actions={actions} />
  );
}
