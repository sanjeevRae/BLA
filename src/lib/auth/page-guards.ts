import "server-only";

import { redirect } from "next/navigation";

import { getActorContext, type ActorContext } from "@/lib/auth/permissions";
import type { RoleCode } from "@/lib/permissions/catalog";

/**
 * Page/layout gate for the role dashboard groups. Unauthenticated users go
 * to /login; authenticated users without one of the allowed roles are sent
 * to their OWN dashboard — another role's page is never rendered for them.
 */
export async function requireDashboardActor(allowedRoles: RoleCode[]): Promise<ActorContext> {
  const actor = await getActorContext();
  if (!actor) redirect("/login");
  // A flagged account sets a new password before any dashboard renders
  // (docs/security-architecture.md §2/§4).
  if (actor.mustChangePassword) redirect("/set-password");
  if (!actor.roles.some((role) => allowedRoles.includes(role))) {
    redirect(actor.landingPath);
  }
  return actor;
}
