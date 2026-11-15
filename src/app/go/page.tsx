import { redirect } from "next/navigation";

import { getActorContext } from "@/lib/auth/permissions";

/**
 * Post-login router. The landing decision is made server-side from the
 * current database roles (docs/security-architecture.md §2) — never from
 * client-side state like the legacy localStorage routing.
 */
export default async function GoPage() {
  const actor = await getActorContext();
  if (!actor) redirect("/login");
  if (actor.mustChangePassword) redirect("/set-password");
  // Phase 10 (F13): MFA obligations route before the role landing.
  if (actor.mfaEnrolmentRequired) redirect("/mfa-setup");
  if (actor.mfaPending) redirect("/login/mfa");
  redirect(actor.landingPath);
}
