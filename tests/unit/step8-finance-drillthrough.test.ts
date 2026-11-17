import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PERMISSION_CODES } from "@/lib/permissions/catalog";

/**
 * Step 8 Finance home drill-through contract: every href the
 * finance home emits must land on a route that exists, every
 * permission code the console model gates on must exist in the
 * catalog (Step 4 LOW-1 lesson: a gating code that is not in the
 * catalog silently hides the action), and no href may carry a
 * query string — the finance module pages read no searchParams,
 * so a filter query would be a fabrication.
 */

const ROOT = join(__dirname, "..", "..");
const view = readFileSync(
  join(ROOT, "src/components/finance-home/FinanceHomeView.tsx"),
  "utf8",
);
const model = readFileSync(
  join(ROOT, "src/server/services/finance-home.ts"),
  "utf8",
);
const page = readFileSync(
  join(ROOT, "src/app/(dashboards)/finance/page.tsx"),
  "utf8",
);
const financePages = readFileSync(
  join(ROOT, "src/components/finance/pages.tsx"),
  "utf8",
);

function financeRouteExists(path: string): boolean {
  const seg = path.replace(/\/$/, "");
  if (seg.endsWith("/X")) {
    return existsSync(
      join(ROOT, `src/app/(dashboards)/finance${seg.slice(0, -2)}/[id]/page.tsx`),
    );
  }
  return existsSync(join(ROOT, `src/app/(dashboards)/finance${seg}/page.tsx`));
}

/** Distinct /finance/… paths the view links to (query stripped,
 *  `${…id}` templates normalised to X). */
function viewPaths(): string[] {
  const found = new Set<string>();
  for (const m of view.matchAll(/\/finance(\/[a-z0-9\-/?=&.${}[\]]*)/gi)) {
    found.add(m[1].replace(/\$\{[^}]*\}/g, "X").split("?")[0]);
  }
  return [...found];
}

describe("Step 8 FinanceHome drill-through contract", () => {
  it("every finance path the view links to exists as a route", () => {
    const paths = viewPaths();
    expect(paths.length).toBeGreaterThan(6);
    for (const p of paths) {
      expect(financeRouteExists(p), `finance ${p}`).toBe(true);
    }
  });

  it("detail links use the [id] routes (invoices and remittances)", () => {
    expect(view).toContain("/finance/invoices/${row.id}");
    expect(view).toContain("/finance/remittances/${row.id}");
    expect(financeRouteExists("/invoices/X")).toBe(true);
    expect(financeRouteExists("/remittances/X")).toBe(true);
  });

  it("no finance link carries a query string (module pages read no searchParams)", () => {
    const queried = [...view.matchAll(/\/finance\/[a-z0-9\-/]*\?/gi)].map((m) => m[0]);
    expect(queried).toEqual([]);
    // Evidence: the finance list/detail pages declare no
    // searchParams at all. (The reports page is the one exception —
    // it reads report-range filters — and the home still links it
    // bare, never with a fabricated filter.)
    for (const seg of ["invoices", "remittances", "settlements", "ledger", "adjustments"]) {
      const target = readFileSync(
        join(ROOT, `src/app/(dashboards)/finance/${seg}/page.tsx`),
        "utf8",
      );
      expect(target, seg).not.toContain("searchParams");
    }
  });

  it("every permission code the console gates on exists in the catalog", () => {
    const codes = new Set<string>();
    for (const m of model.matchAll(/hasPermission\(actor, "([^"]+)"\)/g)) {
      codes.add(m[1]);
    }
    // The console's can map: createInvoice, recordPayment,
    // viewLedger, codRemittances, settlements, reports.
    expect(codes.size).toBeGreaterThanOrEqual(6);
    for (const code of [
      "invoice.create",
      "finance.record_payment",
      "finance.read",
      "cod.read",
      "settlement.read",
      "report.read_all",
    ]) {
      expect(codes.has(code), code).toBe(true);
    }
    for (const code of codes) {
      expect(PERMISSION_CODES.has(code), code).toBe(true);
    }
  });

  it("the page is a thin wrapper on the console model", () => {
    expect(page).toContain("getFinanceConsole(actor)");
    expect(page).toContain("FinanceHomeView");
    expect(page).not.toContain("FinanceHomePage");
    expect(page).not.toContain("getFinanceHome");
  });

  it("the old inline FinanceHomePage is gone from the finance pages module", () => {
    expect(financePages).not.toContain("FinanceHomePage");
    expect(financePages).not.toContain("getFinanceHome");
    // The shared helpers the other finance pages use survive.
    expect(financePages).toContain("function FinanceNav");
    expect(financePages).toContain("function StatTile");
    expect(financePages).toContain("InvoicesListPage");
    expect(financePages).toContain("SettlementsListPage");
  });

  it("the view is link-only for approvals: no forms and no decision buttons", () => {
    expect(view).not.toContain("<form");
    expect(view.toLowerCase()).not.toContain("<button");
    expect(view).toContain("Approval sits with Admin / Super Admin — Finance prepares and reviews.");
  });
});
