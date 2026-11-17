import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Step 7 Vendor home drill-through contract: every href the vendor
 * home emits must land on a route that exists, and any query filter
 * it carries must be a parameter the target page actually reads
 * (asserted against the target pages' own searchParams handling).
 *
 * The vendor bookings list reads page/search/status — and its
 * `status` filters ORDER status (SUBMITTED / CONFIRMED / CANCELLED),
 * not the package operational statuses behind the KPI cards — so
 * the home links the bare list and never fabricates a filter. The
 * only parameterised href is the report CSV export (from/to), whose
 * keys the reports filter parser reads verbatim.
 */

const ROOT = join(__dirname, "..", "..");
const view = readFileSync(
  join(ROOT, "src/components/vendor-home/VendorHomeView.tsx"),
  "utf8",
);
const page = readFileSync(
  join(ROOT, "src/app/(dashboards)/vendor/page.tsx"),
  "utf8",
);
const bookingsListPage = readFileSync(
  join(ROOT, "src/app/(dashboards)/vendor/bookings/page.tsx"),
  "utf8",
);
const reportsPages = readFileSync(
  join(ROOT, "src/components/reports/pages.tsx"),
  "utf8",
);
const operationsPages = readFileSync(
  join(ROOT, "src/components/operations/pages.tsx"),
  "utf8",
);

function vendorRouteExists(path: string): boolean {
  const seg = path.replace(/\/$/, "");
  if (seg.endsWith("/X")) {
    return existsSync(
      join(ROOT, `src/app/(dashboards)/vendor${seg.slice(0, -2)}/[id]/page.tsx`),
    );
  }
  return existsSync(join(ROOT, `src/app/(dashboards)/vendor${seg}/page.tsx`));
}

/** Distinct /vendor/… paths the view links to (query stripped,
 *  `${…id}` templates normalised to X). */
function viewPaths(): string[] {
  const found = new Set<string>();
  for (const m of view.matchAll(/\/vendor(\/[a-z0-9\-/?=&.${}[\]]*)/gi)) {
    found.add(m[1].replace(/\$\{[^}]*\}/g, "X").split("?")[0]);
  }
  return [...found];
}

describe("Step 7 VendorHome drill-through contract", () => {
  it("every vendor path the view links to exists as a route in the vendor tree", () => {
    const paths = viewPaths();
    expect(paths.length).toBeGreaterThan(6);
    for (const p of paths) {
      expect(vendorRouteExists(p), `vendor ${p}`).toBe(true);
    }
    // The utility tracking link lands on the public track page.
    expect(view).toContain('href: "/track"');
    expect(existsSync(join(ROOT, "src/app/(public)/track/page.tsx"))).toBe(true);
  });

  it("booking detail links use the [id] route (shipments live inside bookings)", () => {
    expect(view).toContain("/vendor/bookings/${row.orderId}");
    expect(view).toContain("/vendor/bookings/${booking.id}");
    expect(vendorRouteExists("/bookings/X")).toBe(true);
  });

  it("the bookings list reads page/search/status — and the home fabricates none of them", () => {
    // Evidence: the target page's own searchParams declaration.
    expect(bookingsListPage).toContain("page?: string");
    expect(bookingsListPage).toContain("search?: string");
    expect(bookingsListPage).toContain("status?: string");
    expect(bookingsListPage).toContain("status={params.status}");
    // The list's status is the ORDER status; the KPI cards measure
    // package operational statuses, so no card may pass a status
    // filter the list would misapply — every bookings link is bare.
    expect(view).not.toContain("/vendor/bookings?");
    expect(view).not.toContain("?status=");
    expect(view).not.toContain("&status=");
  });

  it("no vendor link carries a query string at all", () => {
    const queried = [...view.matchAll(/\/vendor\/[a-z0-9\-/]*\?/gi)].map((m) => m[0]);
    expect(queried).toEqual([]);
  });

  it("the only parameterised href is the report export, whose from/to the reports parser reads", () => {
    expect(view).toContain("/api/reports/vendors/export?from=${metrics.range.from}&to=${metrics.range.to}");
    // The reports pages build filters from exactly these keys…
    expect(reportsPages).toContain('from: pick("from")');
    expect(reportsPages).toContain('to: pick("to")');
    // …the vendor reports page wires the same export for "vendors"…
    expect(reportsPages).toContain('exportHref("vendors", filters)');
    // …and the export route itself exists.
    expect(
      existsSync(join(ROOT, "src/app/api/reports/[name]/export/route.ts")),
    ).toBe(true);
  });

  it("Create booking is gated on the approval status only — the gate the old page had", () => {
    expect(view).toContain('vendor.verificationStatus === "APPROVED"');
    expect(view).toContain('href="/vendor/bookings/new"');
    expect(vendorRouteExists("/bookings/new")).toBe(true);
    expect(view).toContain('href="/vendor/bookings/bulk"');
    expect(vendorRouteExists("/bookings/bulk")).toBe(true);
  });

  it("no new permission gating: neither the view nor the page calls a permission check", () => {
    // (Step 4 LOW-1 lesson: gating on a code that does not exist in
    // the catalog silently hides the action. This home gates on the
    // vendor approval status only, so there is nothing to pin
    // against the catalog — assert the absence instead.)
    expect(view).not.toContain("hasPermission");
    expect(page).not.toContain("hasPermission");
    expect(view).not.toContain("can(");
  });

  it("the COD figure is the payable ledger balance, never labelled collected", () => {
    expect(view).toContain('label="COD payable to you"');
    expect(view).toContain("Vendor-payable ledger balance");
    expect(view).toContain("metrics.codPayablePaisa");
    expect(view).not.toContain("COD collected");
  });

  it("Create support ticket is real: the tickets page raises tickets for non-staff actors", () => {
    // Evidence: TicketsInboxPage renders the raise form when the
    // actor is not support staff (a vendor holds no ticket-manage
    // grant, so vendors get the form).
    expect(operationsPages).toContain('title="Raise a ticket"');
    expect(operationsPages).toContain("<RaiseTicketForm />");
    expect(view).toContain('label: "Create support ticket", href: "/vendor/tickets"');
    expect(vendorRouteExists("/tickets")).toBe(true);
  });

  it("attention drills land on the incidents and tickets queues", () => {
    expect(view).toContain('href="/vendor/incidents"');
    expect(view).toContain('href="/vendor/tickets"');
    expect(vendorRouteExists("/incidents")).toBe(true);
  });

  it("the page is a thin wrapper on the read model and keeps the unlinked branch", () => {
    expect(page).toContain("getVendorHome(actor)");
    expect(page).toContain("if (!actor.vendorId)");
    expect(page).toContain("EmptyState");
    expect(page).toContain("not linked to a vendor organisation yet");
    // The model is the page's only data source — the old inline
    // service composition is gone.
    expect(page).not.toContain("getVendorReport");
    expect(page).not.toContain("listBookings");
    expect(page).not.toContain("listPackages");
  });

  it("the header carries the assigned warehouses and never invents a primary one", () => {
    expect(view).toContain("vendor.warehouses");
    expect(view).toContain("No warehouse assigned yet");
    expect(view.toLowerCase()).not.toContain("primary warehouse");
  });
});
