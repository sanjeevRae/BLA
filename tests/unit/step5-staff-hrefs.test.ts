import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Step 5 drill-through contract: every href the Staff work console
 * emits must land on a route that exists in the staff tree, every
 * permission code the container gates on must exist in the catalog
 * (the Step 4 LOW-1 lesson), and the floor actions must carry the
 * ≥48px field touch target (DS §9).
 */

const ROOT = join(__dirname, "..", "..");
const view = readFileSync(
  join(ROOT, "src/components/staff-home/StaffWorkConsoleView.tsx"),
  "utf8",
);
const container = readFileSync(
  join(ROOT, "src/components/staff-home/StaffWorkConsole.tsx"),
  "utf8",
);
const page = readFileSync(
  join(ROOT, "src/app/(dashboards)/staff/page.tsx"),
  "utf8",
);
const catalog = readFileSync(
  join(ROOT, "src/lib/permissions/catalog.ts"),
  "utf8",
);

function routeExists(staffPath: string): boolean {
  return existsSync(
    join(ROOT, `src/app/(dashboards)/staff${staffPath}/page.tsx`),
  );
}

/** Distinct literal "/staff/…" hrefs in the view (routes table +
 *  any inline literal). */
function viewStaffPaths(): string[] {
  const found = new Set<string>();
  for (const m of view.matchAll(/"(\/staff\/[a-z-]+)"/g)) found.add(m[1]);
  return [...found];
}

describe("Step 5 StaffWorkConsole drill-through contract", () => {
  it("every literal staff href in the view exists as a staff-tree route", () => {
    const paths = viewStaffPaths();
    expect(paths.length).toBeGreaterThanOrEqual(7);
    for (const p of paths) {
      expect(routeExists(p.replace(/^\/staff/, "")), `staff route ${p}`).toBe(true);
    }
  });

  it("task rows link to the [id] task detail route", () => {
    expect(view).toContain("/staff/tasks/${id}");
    expect(
      existsSync(join(ROOT, "src/app/(dashboards)/staff/tasks/[id]/page.tsx")),
    ).toBe(true);
    expect(routeExists("/tasks")).toBe(true);
  });

  it("scan actions map to the operations flow — no invented scan route", () => {
    // The mapping is documented in the view header and the Scan
    // button's hint says it is the same receiving flow.
    expect(view).toContain("no standalone scan page");
    expect(view).toContain("Same receiving flow");
    expect(routeExists("/operations")).toBe(true);
    expect(routeExists("/scan")).toBe(false);
  });

  it("floor actions and queue chips carry ≥48px touch targets", () => {
    const occurrences = view.match(/min-h-\[48px\]/g) ?? [];
    // 1 action-strip base class + task rows + 5 per-warehouse chips.
    expect(occurrences.length).toBeGreaterThanOrEqual(6);
    expect(view).toContain('const ACTION_BASE =\n  "flex min-h-[48px]');
  });

  it("every permission code the container gates on exists in the catalog", () => {
    const codes = new Set<string>();
    for (const m of container.matchAll(/hasPermission\(actor, "([a-z0-9._]+)"\)/g)) {
      codes.add(m[1]);
    }
    expect([...codes].sort()).toEqual([
      "incident.report",
      "package.inspect",
      "package.receive",
    ]);
    for (const code of codes) {
      expect(catalog, `catalog has ${code}`).toContain(`P("${code}"`);
    }
  });

  it("the staff page renders the work console and nothing finance-shaped", () => {
    expect(page).toContain("StaffWorkConsole");
    // The replaced V2 home may be NAMED in the page's doc comment;
    // what must not exist is an import or a render of it.
    expect(page).not.toContain("import { StaffMyWorkHome }");
    expect(page).not.toContain("<StaffMyWorkHome");
    const consoleSurface = view + container;
    expect(consoleSurface).not.toMatch(/formatPaisa|NPR|paisa|\bCOD\b|codAmount/i);
  });
});
