import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Step 4 drill-through contract: every href the ExecutiveHome emits
 * must land on a route that exists in BOTH dashboard trees, and any
 * query filter it carries must be a parameter the target page
 * actually reads (asserted against the target pages' own
 * searchParams handling — the V2 lesson: the bookings list's
 * `status` filters ORDER status, the reports view's `status`
 * filters operational status; the home uses each accordingly).
 */

const ROOT = join(__dirname, "..", "..");
const home = readFileSync(
  join(ROOT, "src/components/dashboards/ExecutiveHome.tsx"),
  "utf8",
);
const reportsPage = readFileSync(
  join(ROOT, "src/components/reports/pages.tsx"),
  "utf8",
);
const bookingsPage = readFileSync(
  join(ROOT, "src/app/(dashboards)/admin/bookings/page.tsx"),
  "utf8",
);
const catalog = readFileSync(
  join(ROOT, "src/lib/permissions/catalog.ts"),
  "utf8",
);

/** Distinct `${basePath}/…` path templates used by the home. */
function homePaths(): string[] {
  const found = new Set<string>();
  for (const m of home.matchAll(/\$\{basePath\}(\/[a-z0-9\-/?=&.${}[\]]*)/gi)) {
    found.add(m[1].replace(/\$\{[^}]*\}/g, "X").split("?")[0]);
  }
  return [...found];
}

function routeExists(base: string, path: string): boolean {
  const seg = path.replace(/\/$/, "");
  // A trailing "X" is the extractor's stand-in for a `${...id}` —
  // the route for it is the [id] segment page.
  if (seg.endsWith("/X")) {
    return existsSync(
      join(ROOT, `src/app/(dashboards)/${base}${seg.slice(0, -2)}/[id]/page.tsx`),
    );
  }
  return existsSync(join(ROOT, `src/app/(dashboards)/${base}${seg}/page.tsx`));
}

describe("Step 4 ExecutiveHome drill-through contract", () => {
  it("every home path exists as a route in the dashboard trees", () => {
    const paths = homePaths();
    expect(paths.length).toBeGreaterThan(8);
    for (const p of paths) {
      // /settings exists only in the Super Admin tree — the home
      // renders that tile only for the super-admin variant.
      if (p !== "/settings") {
        expect(routeExists("admin", p), `admin ${p}`).toBe(true);
      }
      expect(routeExists("super-admin", p), `super-admin ${p}`).toBe(true);
    }
    expect(routeExists("admin", "/settings")).toBe(false);
  });

  it("package-state KPIs drill to the reports view, whose status filter is operational", () => {
    // The reports page parses `status` from searchParams and the
    // report service applies it as an operationalStatus filter.
    expect(reportsPage).toContain('status: pick("status")');
    expect(home).toContain("/reports?status=OUT_FOR_DELIVERY");
    expect(home).toContain("/reports?status=DELIVERED");
  });

  it("Total Bookings drills to the bookings list, which reads an order-status filter", () => {
    expect(bookingsPage).toContain("status?: string");
    expect(home).toContain("`${basePath}/bookings`");
  });

  it("Open Exceptions drills to the incidents queue (open incidents lead that page)", () => {
    expect(home).toContain("`${basePath}/incidents`");
    expect(routeExists("admin", "/incidents")).toBe(true);
  });

  it("omitted brief actions stay omitted: no transfer-create or receive links", () => {
    // (The words appear in the file's header comment documenting the
    // omission — what must not exist is a rendered link or label.)
    expect(home).not.toContain("/transfers/new");
    expect(home).not.toContain("/receive");
    expect(home).not.toContain(">Create Transfer<");
    expect(home).not.toContain(">Receive Package<");
  });

  it("every permission code the home gates on exists in the catalog", () => {
    // Regression guard for the Step 4 security review's LOW-1: the
    // home originally gated Add Vendor / Add Customer on
    // vendor.create / customer.create, which do not exist — the
    // actions silently never rendered. Every can("…") literal in
    // the component must be a real catalog code.
    const codes = new Set<string>();
    for (const m of home.matchAll(/can\("([a-z0-9._]+)"\)/g)) codes.add(m[1]);
    expect(codes.size).toBeGreaterThan(6);
    for (const code of codes) {
      expect(catalog, `catalog has ${code}`).toContain(`P("${code}"`);
    }
    expect(codes.has("vendor.manage")).toBe(true);
    expect(codes.has("customer.manage")).toBe(true);
  });

  it("activity and attention detail links use the [id] routes", () => {
    expect(home).toContain("/incidents/${inc.id}");
    expect(home).toContain("/tasks/${task.id}");
    expect(routeExists("admin", "/incidents")).toBe(true);
    expect(routeExists("admin", "/tasks")).toBe(true);
  });
});
