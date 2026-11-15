import type { NextConfig } from "next";

/**
 * Global security headers (docs/security-architecture.md §7), applied to
 * every route. The old backend set none of these.
 *
 * CSP notes: the policy is 'self' plus the two external origins the app
 * actually uses — MapTiler (map tiles + geocoding API) and Cloudinary
 * (delivery-proof / document media). 'unsafe-inline' appears only in
 * script-src/style-src: Next.js App Router injects inline bootstrap and
 * RSC payload scripts, and React renders inline style attributes; without
 * a nonce pipeline those require it. No 'unsafe-eval' anywhere.
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://res.cloudinary.com https://api.maptiler.com",
  "media-src 'self' https://res.cloudinary.com",
  "connect-src 'self' https://api.maptiler.com",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains",
  },
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Camera (proof-of-delivery capture) and geolocation (driver GPS) are
  // legitimate app features, restricted to the app itself; the microphone
  // is never used and is disabled outright.
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=(self)",
  },
];

const nextConfig: NextConfig = {
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
