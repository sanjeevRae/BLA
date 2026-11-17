import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Step 5 Warehouse Admin console drill-through contract: every href
 * the WarehouseConsole emits must land on a route that exists in the
 * warehouse tree, and any query filter it carries must be a
 * parameter the target page actually reads (asserted against the
 * target pages' own searchParams handling). Most warehouse pages
 * read NO filter params — the console's links to them must therefore
 * carry none; the only parameterised drills are the reports view
 * (from/to/warehouseId) and transfer creation (origin).
 */

const ROOT = join(__dirname, "..", "..");
const console_ = readFileSync(
  join(ROOT, "src/components/warehouse-home/WarehouseConsole.tsx"),
  "utf8",
);
const page = readFileSync(
  join(ROOT, "src/app/(dashboards)/warehouse/page.tsx"),
  "utf8",
);
const reportsPages = readFileSync(
  join(ROOT, "src/components/reports/pages.tsx"),
  "utf8",
);
const transferNewPage = readFileSync(
  join(ROOT, "src/app/(dashboards)/warehouse/transfers/new/page.tsx"),
  "utf8",
);
const warehouseOpsPages = readFileSync(
  join(ROOT, "src/components/warehouse-ops/pages.tsx"),
  "utf8",
);
const catalog = readFileSync(
  join(ROOT, "src/lib/permissions/catalog.ts"),
  "utf8",
);

function routeExists(path: string): boolean {
  const seg = path.replace(/\/$/, "");
  if (seg.endsWith("/X")) {
    return existsSync(
      join(ROOT, `src/app/(dashboards)/warehouse${seg.slice(0, -2)}/[id]/page.tsx`),
    );
  }
  return existsSync(join(ROOT, `src/app/(dashboards)/warehouse${seg}/page.tsx`));
}

/** Distinct /warehouse/… paths the console links to (query stripped,
 *  `${…id}` templates normalised to X). */
function consolePaths(): string[] {
  const found = new Set<string>();
  for (const m of console_.matchAll(/\/warehouse(\/[a-z0-9\-/?=&.${}[\]]*)/gi)) {
    found.add(m[1].replace(/\$\{[^}]*\}/g, "X").split("?")[0]);
  }
  return [...found];
}

describe("Step 5 WarehouseConsole drill-through contract", () => {
  it("every console path exists as a route in the warehouse tree", () => {
    const paths = consolePaths();
    expect(paths.length).toBeGreaterThan(8);
    for (const p of paths) {
      expect(routeExists(p), `warehouse ${p}`).toBe(true);
    }
  });

  it("the only query parameters used are ones the targets read", () => {
    // Reports: the warehouse reports page builds its filters from
    // searchParams via filtersFromSearchParams, which picks exactly
    // these keys.
    expect(reportsPages).toContain('from: pick("from")');
    expect(reportsPages).toContain('to: pick("to")');
    expect(reportsPages).toContain('warehouseId: pick("warehouseId")');
    expect(console_).toContain("/warehouse/reports?from=${data.today}&to=${data.today}");
    expect(console_).toContain("&warehouseId=${scopeWarehouseId}");
    // Transfer creation reads `origin` from searchParams.
    expect(transferNewPage).toContain("origin?: string");
    expect(console_).toContain("/warehouse/transfers/new?origin=${scopeWarehouseId}");
    // No other console link carries a query string.
    const queried = [...console_.matchAll(/\/warehouse\/[a-z0-9\-/]*\?([a-z=&${}]+)/gi)].map(
      (m) => m[0],
    );
    for (const q of queried) {
      expect(
        q.startsWith("/warehouse/reports?") || q.startsWith("/warehouse/transfers/new?"),
        `unexpected query in ${q}`,
      ).toBe(true);
    }
  });

  it("the primary action lands on the real receiving flow", () => {
    expect(console_).toContain("Receive Package");
    expect(console_).toContain('href="/warehouse/operations"');
    // The operations page hosts the receiving form (package.receive).
    expect(warehouseOpsPages).toContain("Receive a parcel (scan or type the tracking ID)");
    expect(routeExists("/operations")).toBe(true);
  });

  it("detail links use the [id] routes", () => {
    expect(console_).toContain("/warehouse/transfers/${row.id}");
    expect(console_).toContain("/warehouse/incidents/${i.id}");
    expect(console_).toContain("/warehouse/transfers/${d.id}");
    expect(console_).toContain("/warehouse/tasks/${t.id}");
    expect(routeExists("/transfers/X")).toBe(true);
    expect(routeExists("/incidents/X")).toBe(true);
    expect(routeExists("/tasks/X")).toBe(true);
  });

  it("Create Return stays omitted: no create link to the returns list", () => {
    // (The words appear in the file's header comment documenting the
    // omission — what must not exist is a rendered link or label.)
    expect(console_).not.toContain(">Create Return<");
    expect(console_).not.toContain('href="/warehouse/returns"');
    expect(console_).not.toContain("`/warehouse/returns`");
  });

  it("every permission code the console gates on exists in the catalog", () => {
    const codes = new Set<string>();
    for (const m of console_.matchAll(/can\("([a-z0-9._]+)"\)/g)) codes.add(m[1]);
    expect(codes.size).toBeGreaterThan(5);
    for (const code of codes) {
      expect(catalog, `catalog has ${code}`).toContain(`P("${code}"`);
    }
    // KPI href gates use hasPermission(actor, "…") literals too.
    const hrefCodes = new Set<string>();
    for (const m of console_.matchAll(/can\("([a-z0-9._]+)"\)/g)) hrefCodes.add(m[1]);
    for (const m of console_.matchAll(/hasPermission\(actor, "([a-z0-9._]+)"/g)) {
      hrefCodes.add(m[1]);
    }
    for (const code of hrefCodes) {
      expect(catalog, `catalog has ${code}`).toContain(`P("${code}"`);
    }
  });

  it("the page resolves the requested scope and keeps the administration content", () => {
    expect(page).toContain("getRequestedWarehouseScope");
    expect(page).toContain("getWarehouseConsole");
    // Administration content kept below the console.
    expect(page).toContain("WarehouseInfoCard");
    expect(page).toContain("MembersPanel");
    expect(page).toContain("ZonesPanel");
    expect(page).toContain("WarehouseOpsHomePanel");
    expect(page).toContain("TransfersHomePanel");
    expect(page).toContain("DeliveriesHomePanel");
    expect(page).toContain("WarehouseBookingsPanel");
    // The no-warehouse empty state is kept.
    expect(page).toContain("No warehouse assigned");
  });
});
