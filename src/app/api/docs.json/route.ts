import { NextResponse } from "next/server";

import { evaluateDocsAccess } from "@/lib/openapi/gate";
import spec from "@/lib/openapi/spec.json";

/**
 * GET /api/docs.json — the committed OpenAPI 3.0 specification for the
 * whole API (generated from the route tree by
 * scripts/generate-openapi.ts; see docs/api-docs.md).
 *
 * Gated exactly like the /api/docs UI: SUPER_ADMIN or ADMIN session
 * only, and in production only when API_DOCS_ENABLED=true. Refusals
 * use the standard API error envelope (see /api/me).
 */
export async function GET() {
  const access = await evaluateDocsAccess();
  if (!access.allowed) {
    if (access.reason === "disabled") {
      return NextResponse.json(
        { error: { code: "NOT_FOUND", message: "API documentation is not enabled" } },
        { status: 404 },
      );
    }
    if (access.reason === "unauthenticated") {
      return NextResponse.json(
        { error: { code: "UNAUTHENTICATED", message: "Authentication required" } },
        { status: 401 },
      );
    }
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "API documentation requires an admin role" } },
      { status: 403 },
    );
  }

  return NextResponse.json(spec);
}
