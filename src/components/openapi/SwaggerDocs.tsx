"use client";

import dynamic from "next/dynamic";

import "swagger-ui-react/swagger-ui.css";

/**
 * Swagger UI for /api/docs, pointed at the gated /api/docs.json on the
 * same origin. The viewer's session cookie travels with its requests
 * (same-origin), so "Try it out" exercises the API as the signed-in
 * admin — there is no token to paste anywhere. The stylesheet is
 * imported here, JS-side, on purpose: a CSS @import of a package
 * inside globals.css breaks Turbopack resolution on Windows
 * (see commit 0840bf3).
 */
const SwaggerUI = dynamic(() => import("swagger-ui-react"), {
  ssr: false,
  loading: () => <p style={{ padding: "1rem" }}>Loading API documentation…</p>,
});

export function SwaggerDocs() {
  return (
    <SwaggerUI
      url="/api/docs.json"
      docExpansion="list"
      defaultModelsExpandDepth={0}
      tryItOutEnabled
      requestInterceptor={(request) => {
        request.credentials = "same-origin";
        return request;
      }}
    />
  );
}
