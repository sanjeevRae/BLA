import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    // Integration suites run against a real database (with bcrypt work in
    // the auth/delivery paths) on a small shared-CPU VM; the 5s default
    // timed out heavy journey tests under full-suite parallel load while
    // the same suites passed standalone. 60s still fails a genuinely
    // hung test.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
