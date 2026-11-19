import { notFound, redirect } from "next/navigation";

import { evaluateDocsAccess } from "@/lib/openapi/gate";
import { SwaggerDocs } from "@/components/openapi/SwaggerDocs";

// The gate depends on the caller's session — never prerender.
export const dynamic = "force-dynamic";

/**
 * /api/docs — Swagger UI for the BLA API.
 *
 * Gated like the admin dashboards (src/lib/auth/page-guards.ts):
 * anonymous visitors go to sign-in, signed-in users without an admin
 * role go to their own dashboard, and in production the page does not
 * exist at all unless API_DOCS_ENABLED=true.
 */
export default async function ApiDocsPage() {
  const access = await evaluateDocsAccess();
  if (!access.allowed) {
    if (access.reason === "disabled") notFound();
    if (access.reason === "unauthenticated" || !access.actor) {
      redirect("/login?callbackUrl=/api/docs");
    }
    const actor = access.actor;
    if (actor.mustChangePassword) redirect("/set-password");
    if (actor.mfaEnrolmentRequired) redirect("/mfa-setup");
    if (actor.mfaPending) redirect("/login/mfa");
    redirect(actor.landingPath);
  }

  return <SwaggerDocs />;
}
