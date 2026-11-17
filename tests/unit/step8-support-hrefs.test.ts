import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PERMISSION_CODES } from "@/lib/permissions/catalog";

/**
 * Step 8 Support console drill-through contract: every href the
 * view emits must land on a route that exists; drill-throughs are
 * BARE links (the tickets inbox reads no filter params — verified
 * against its page below), so no href may carry a query string;
 * and every permission code the console's `can` flags use must
 * exist in the catalog (Step 4 LOW-1 lesson: gating on a code that
 * does not exist silently hides the action).
 */

const ROOT = join(__dirname, "..", "..");
const view = readFileSync(
  join(ROOT, "src/components/support-home/SupportHomeView.tsx"),
  "utf8",
);
const page = readFileSync(
  join(ROOT, "src/app/(dashboards)/support/page.tsx"),
  "utf8",
);
const service = readFileSync(
  join(ROOT, "src/server/services/support-home.ts"),
  "utf8",
);
const ticketsInboxPage = readFileSync(
  join(ROOT, "src/app/(dashboards)/support/tickets/page.tsx"),
  "utf8",
);

function routeExists(appPath: string): boolean {
  return existsSync(join(ROOT, "src/app", appPath));
}

describe("Step 8 SupportHome drill-through contract", () => {
  it("every static href in the view exists as a real route", () => {
    expect(view).toContain('href="/support/tickets"');
    expect(routeExists("(dashboards)/support/tickets/page.tsx")).toBe(true);
    expect(view).toContain('href="/support/incidents"');
    expect(routeExists("(dashboards)/support/incidents/page.tsx")).toBe(true);
    expect(view).toContain('href="/support/tasks"');
    expect(routeExists("(dashboards)/support/tasks/page.tsx")).toBe(true);
    expect(view).toContain('href="/track"');
    expect(routeExists("(public)/track/page.tsx")).toBe(true);
  });

  it("every dynamic href lands on a real [id] / [trackingId] route", () => {
    expect(view).toContain("/support/tickets/${ticket.id}");
    expect(routeExists("(dashboards)/support/tickets/[id]/page.tsx")).toBe(true);
    expect(view).toContain("/support/incidents/${incident.id}");
    expect(routeExists("(dashboards)/support/incidents/[id]/page.tsx")).toBe(true);
    expect(view).toContain("/support/tasks/${task.id}");
    expect(routeExists("(dashboards)/support/tasks/[id]/page.tsx")).toBe(true);
    expect(view).toContain("/track/${item.trackingId}");
    expect(routeExists("(public)/track/[trackingId]/page.tsx")).toBe(true);
  });

  it("no href carries a query string — drill-throughs are bare links", () => {
    const queried = [...view.matchAll(/href=\{?["'`][^"'`}]*\?/g)].map((m) => m[0]);
    expect(queried).toEqual([]);
    expect(view).not.toContain("?status=");
    expect(view).not.toContain("?page=");
  });

  it("the tickets inbox reads no filter params (the reason links stay bare)", () => {
    // Evidence: the inbox page's own searchParams surface carries
    // no ticket filter the home could honestly pass.
    expect(ticketsInboxPage).not.toContain("searchParams");
  });

  it("every can() permission code exists in the catalog", () => {
    for (const code of ["support.ticket.manage", "incident.manage", "task.update_own"]) {
      expect(PERMISSION_CODES.has(code), code).toBe(true);
      expect(service).toContain(`"${code}"`);
    }
    expect(service).toContain("viewTickets: hasPermission(actor, \"support.ticket.manage\")");
    expect(service).toContain("incidents: hasPermission(actor, \"incident.manage\")");
    expect(service).toContain("tasks: hasPermission(actor, \"task.update_own\")");
  });

  it("the console gate is the home's support.ticket.manage gate", () => {
    expect(service).toContain("getSupportConsole");
    expect(service).toContain(
      'requirePermAudited(actor, "support.ticket.manage", "SupportTicket")',
    );
  });

  it("the page is a thin wrapper on the read model", () => {
    expect(page).toContain("getSupportConsole(actor)");
    expect(page).toContain("SupportHomeView");
    expect(page).not.toContain("getSupportHome(");
    expect(page).not.toContain("listTickets");
    expect(page).not.toContain("listTasks");
  });

  it("the old support pages module is gone", () => {
    expect(existsSync(join(ROOT, "src/components/support/pages.tsx"))).toBe(false);
  });
});
