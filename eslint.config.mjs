import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Legacy applications live in this repo until their Phase 10 removal;
    // the new app lints only its own code.
    "admin-dashboard/**",
    "backend/**",
    "customer-tracking/**",
    "driver-app/**",
    "vendor-portal/**",
    "db/**",
    "docs/**",
    "prisma/migrations/**",
  ]),
]);

export default eslintConfig;
