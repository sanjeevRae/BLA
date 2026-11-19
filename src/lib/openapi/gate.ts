import "server-only";

import { getActorContext, type ActorContext } from "@/lib/auth/permissions";
import type { RoleCode } from "@/lib/permissions/catalog";

/**
 * Access gate for the API documentation surfaces (/api/docs and
 * /api/docs.json). The docs expose the full API surface, so they are
 * restricted to the two organisation-wide admin roles and, in
 * production, are off entirely unless API_DOCS_ENABLED=true
 * (mirroring the Bodhisattva platform's posture).
 *
 * Both surfaces share this one evaluation; they differ only in how a
 * refusal is rendered — the page redirects like the dashboard layouts
 * (src/lib/auth/page-guards.ts), the JSON route answers with the API
 * error envelope like /api/me.
 */

export const DOCS_ADMIN_ROLES: RoleCode[] = ["SUPER_ADMIN", "ADMIN"];

export type DocsAccess =
  | { allowed: true; actor: ActorContext }
  | {
      allowed: false;
      reason: "disabled" | "unauthenticated" | "forbidden";
      actor: ActorContext | null;
    };

/** True when the docs may be served at all in this environment. */
export function docsEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.API_DOCS_ENABLED === "true";
}

export async function evaluateDocsAccess(): Promise<DocsAccess> {
  if (!docsEnabled()) {
    return { allowed: false, reason: "disabled", actor: null };
  }

  const actor = await getActorContext();
  if (!actor) {
    return { allowed: false, reason: "unauthenticated", actor: null };
  }

  // Same pre-dashboard obligations as the page guards: a flagged
  // password change or an outstanding MFA step must be completed
  // before any privileged surface — the docs included — is served.
  if (actor.mustChangePassword || actor.mfaEnrolmentRequired || actor.mfaPending) {
    return { allowed: false, reason: "forbidden", actor };
  }

  if (!actor.roles.some((role) => DOCS_ADMIN_ROLES.includes(role))) {
    return { allowed: false, reason: "forbidden", actor };
  }

  return { allowed: true, actor };
}
