# API documentation (Swagger / OpenAPI)

BLA ships an OpenAPI 3.0 description of its whole HTTP API plus a
Swagger UI to browse it. The spec is **generated from the route tree**
— it is never edited by hand.

## Opening the docs locally

1. Start the app: `npm run dev`
2. Sign in at <http://localhost:3000/login> with a **Super Admin** or
   **Admin** account (complete the MFA step if prompted).
3. Open <http://localhost:3000/api/docs>

The raw spec is at <http://localhost:3000/api/docs.json>.

**Try it out works as you.** Authentication is the app's own session
cookie (Auth.js database sessions — there is no JWT and no API key).
Because the UI is served from the same origin, the browser sends your
existing session cookie with every Try-it-out request; there is no
token to paste anywhere. If you are not signed in, you are reading
this file instead of the UI for a reason (see gating below).

## Gating

Both `/api/docs` and `/api/docs.json` share one gate
(`src/lib/openapi/gate.ts`):

- **Roles:** a signed-in `SUPER_ADMIN` or `ADMIN` session is required.
  - Anonymous: the page redirects to sign-in; the JSON route answers
    `401` with the standard error envelope.
  - Signed in with any other role: the page redirects to that user's
    own dashboard; the JSON route answers `403`.
  - Admins who still owe a password change or an MFA step are sent to
    complete it first, exactly like the dashboards.
- **Production:** with `NODE_ENV=production` the docs are **off**
  (the page 404s, the JSON route answers `404`) unless the server is
  started with `API_DOCS_ENABLED=true`.

## The spec

- File: `src/lib/openapi/spec.json` (committed; served as-is).
- Coverage: **114 operations across 100 paths** (GET 52, POST 62) —
  every exported handler in `src/app/api/**/route.ts`, including the
  Auth.js handlers and this document's own endpoint. The `/api/docs`
  page itself is a UI page, not an API operation, so it is not in the
  spec.
- Summaries come from the route files' own doc comments; where a
  route's service function validates input, the operation names the
  Zod schema (traced from the code — 53 operations carry such a note).
  Payload field lists are not invented: response bodies are described
  by the shared `Error` envelope component for failures and left
  unspecified for successes beyond their status code.
- Public operations (`/api/auth/*`, `/api/public/*`, `/api/track/*`)
  are marked with an empty security requirement; everything else
  inherits the `sessionCookie` scheme (`authjs.session-token`,
  `__Secure-`-prefixed on HTTPS).

## Regenerating

After adding, removing or renaming any route:

```bash
npm run openapi:generate
```

This rewrites `src/lib/openapi/spec.json` from the tree. Commit the
regenerated file with your route change: `tests/unit/openapi-spec.test.ts`
re-derives the operation set from the tree and fails the suite on any
drift, and `tests/unit/openapi-gate.test.ts` covers the gate.
