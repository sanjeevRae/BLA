// Stub for the Next.js virtual "server-only" module.
//
// Service modules start with `import "server-only"` — a marker
// Next.js resolves inside its own bundler; the package is not
// installed in node_modules, so a standalone tsx run (the cron
// scripts) cannot resolve it. scripts/tsconfig.json maps the
// specifier here for script runs only; the app build keeps using
// the root tsconfig and Next's own handling. The marker has no
// runtime behaviour to reproduce.
export {};
