import { NextResponse, type NextRequest } from "next/server";

/**
 * First gate for the dashboard route groups: requests without a session
 * cookie are redirected to /login before any page code runs.
 *
 * Sessions are database-backed (Auth.js), so the cookie carries only the
 * session token; this check is intentionally presence-only. The
 * authoritative validation — session lookup, account status, role check —
 * happens server-side in each dashboard layout via getActorContext()
 * (docs/security-architecture.md §2–§3), which runs on every request.
 */
const SESSION_COOKIES = ["authjs.session-token", "__Secure-authjs.session-token"];

export function middleware(request: NextRequest) {
  const hasSession = SESSION_COOKIES.some((name) => request.cookies.has(name));
  if (hasSession) return NextResponse.next();

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("callbackUrl", request.nextUrl.pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/go",
    "/super-admin/:path*",
    "/admin/:path*",
    "/warehouse/:path*",
    "/staff/:path*",
    "/rider/:path*",
    "/transport-driver/:path*",
    "/vendor/:path*",
    "/customer/:path*",
    "/finance/:path*",
    "/support/:path*",
  ],
};
