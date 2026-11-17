import { NextResponse } from "next/server";

import { getActorContext, requireAccessGranted } from "@/lib/auth/permissions";
import { apiErrorResponse, unauthenticatedResponse } from "@/server/api-errors";
import type { ActorContext } from "@/lib/auth/actor";
import {
  ROLE_TO_DASHBOARD,
  type DashboardId,
} from "@/lib/navigation/registry";
import { isValidTrackingId } from "@/lib/bookings/tracking";
import { getPackageByTrackingId, listPackages } from "@/server/services/packages";
import { listBookings } from "@/server/services/bookings";
import { listVendors } from "@/server/services/vendors";
import { listCustomers } from "@/server/services/customers";
import { listWarehouses } from "@/server/services/warehouses";
import { listDrivers } from "@/server/services/drivers";

/**
 * GET /api/search?q=<text> — record search behind the V3 command menu
 * (docs/ui-design-system.md §8).
 *
 * PERMISSION RULE (non-negotiable, DS §8): filtering happens HERE,
 * server-side. Every group below is produced by an existing list
 * service that force-scopes its rows to the actor, and a service is
 * only called when the actor plausibly holds that domain's read
 * access — the gate mirrors the service's own scoping branches, so
 * an out-of-scope actor never triggers the call (which also avoids
 * the access-denied audit rows some services write when called out
 * of scope) and never receives a single byte of the record. Groups
 * the actor may not see are omitted from the response entirely —
 * never sent and hidden client-side.
 *
 * Per-entity gates (service branch → gate used here):
 * - packages: listPackages scopes by `package.read_all`, else the
 *   actor's vendor link, else the actor's customer link, else the
 *   actor's warehouse memberships (and audits + throws otherwise).
 *   Gate = exactly those four branches, EXCEPT that a driver-primary
 *   actor (RIDER / LINEHAUL_DRIVER) never qualifies through the
 *   warehouse-membership branch: listPackages has no driver-
 *   assignment branch, so a rider who also holds a warehouse
 *   membership would otherwise search every package at that
 *   warehouse. Driver-primary actors qualify only via read_all /
 *   vendor / customer. The tracking-ID fallback applies the same
 *   rule (no existence oracle via the warehouse branch either).
 * - bookings: listBookings scopes by `booking.read_all`, else
 *   vendor link, else customer link, else warehouse memberships
 *   (audits + throws otherwise). Gate = those branches AND the
 *   actor's dashboard tree must have a bookings detail route to
 *   link to (admin / super-admin / staff / warehouse / vendor);
 *   trees without one (customer, finance, support, rider,
 *   transport-driver) omit the group — there is no honest href.
 * - vendors: listVendors serves `vendor.read_all`/`vendor.manage`
 *   holders (or a vendor actor's own organisation). Vendor detail
 *   routes exist only in the admin / super-admin trees, so the gate
 *   is tree ∈ {admin, super-admin} AND (vendor.read_all OR
 *   vendor.manage); every other tree omits the group.
 * - customers: listCustomers requires `customer.read` OR
 *   `customer.manage` (and audits + throws otherwise). Customer
 *   detail routes exist only in the admin / super-admin trees
 *   (SUPPORT holds customer.read but its tree has no customers
 *   route), so gate = tree ∈ {admin, super-admin} AND that
 *   permission pair.
 * - warehouses: listWarehouses requires `warehouse.read_all` OR
 *   `warehouse.read_assigned` (audits + throws otherwise) and scopes
 *   assigned-only actors to their memberships. Warehouse detail AND
 *   list routes exist only in the admin / super-admin trees, so
 *   gate = tree ∈ {admin, super-admin} AND that permission pair.
 * - drivers: listDrivers requires `driver.manage` OR
 *   `driver.assign` OR `driver.read_self` (audits + throws
 *   otherwise). Driver detail routes exist in the admin /
 *   super-admin / warehouse trees, so gate = tree ∈ {admin,
 *   super-admin, warehouse} AND that permission triple (riders hold
 *   driver.read_self but their tree has no drivers route → omitted).
 *
 * Hrefs always point into the ACTOR'S OWN dashboard tree
 * (ROLE_TO_DASHBOARD of the actor's primary role). Packages link to
 * the owning booking's detail page in trees that have one, and fall
 * back to the public tracking page (/track/<trackingId>) in trees
 * that do not — the same surface the V2 header search used.
 */

interface SearchResultItem {
  id: string;
  label: string;
  hint: string;
  href: string;
}

interface SearchGroup {
  id: "packages" | "bookings" | "vendors" | "customers" | "warehouses" | "drivers";
  label: string;
  results: SearchResultItem[];
}

const PAGE_SIZE = 5;
const MAX_QUERY_LENGTH = 64;

/** Trees that own a bookings/[id] detail route today. */
const BOOKING_DETAIL_TREES: ReadonlySet<DashboardId> = new Set([
  "admin",
  "super-admin",
  "staff",
  "warehouse",
  "vendor",
]);

/** Trees that own vendors/[id], customers/[id] and warehouses/[id]. */
const ADMIN_TREES: ReadonlySet<DashboardId> = new Set(["admin", "super-admin"]);

/** Trees that own a drivers/[id] detail route today. */
const DRIVER_DETAIL_TREES: ReadonlySet<DashboardId> = new Set([
  "admin",
  "super-admin",
  "warehouse",
]);

function treeFor(actor: ActorContext): DashboardId | null {
  return actor.primaryRole ? ROLE_TO_DASHBOARD[actor.primaryRole] : null;
}

/** Driver-primary actors never inherit warehouse package scope (F1). */
function isDriverPrimary(actor: ActorContext): boolean {
  return actor.primaryRole === "RIDER" || actor.primaryRole === "LINEHAUL_DRIVER";
}

/** The branches listPackages / listBookings themselves scope by. */
function hasRecordScope(actor: ActorContext): boolean {
  const driverPrimary = isDriverPrimary(actor);
  return Boolean(
    actor.vendorId ||
      actor.customerId ||
      (!driverPrimary && actor.warehouseIds.length > 0),
  );
}

async function packageGroup(
  actor: ActorContext,
  q: string,
  tree: DashboardId | null,
): Promise<SearchGroup | null> {
  if (!actor.permissions.has("package.read_all") && !hasRecordScope(actor)) {
    return null;
  }
  const { packages } = await listPackages(actor, { search: q, pageSize: PAGE_SIZE });
  const rows = [...packages];
  // Exact tracking-ID lookup: listPackages' search already matches
  // trackingId by substring, but a full valid tracking ID deserves
  // the exact read so it always surfaces first. getPackageByTrackingId
  // enforces readability itself (auditing + throwing for out-of-scope
  // packages), so EVERY error is swallowed to "no result" — this path
  // must never become an existence oracle for packages the actor may
  // not see.
  const trackingCandidate = q.toUpperCase();
  // F1: for driver-primary actors the exact lookup is attempted only
  // when they qualify via read_all / vendor / customer — never via a
  // warehouse membership — so it cannot become an existence oracle.
  const trackingAllowed =
    !isDriverPrimary(actor) ||
    actor.permissions.has("package.read_all") ||
    Boolean(actor.vendorId || actor.customerId);
  if (trackingAllowed && isValidTrackingId(trackingCandidate)) {
    try {
      const exact = await getPackageByTrackingId(actor, trackingCandidate);
      if (!rows.some((pkg) => pkg.id === exact.id)) rows.unshift(exact);
    } catch {
      // Not found, or not readable by this actor — no result.
    }
  }
  const results = rows.slice(0, PAGE_SIZE).map((pkg) => ({
    id: pkg.id,
    label: pkg.trackingId,
    hint: [pkg.recipientName, pkg.deliveryCity || pkg.deliveryDistrict]
      .filter(Boolean)
      .join(" · "),
    href:
      tree && BOOKING_DETAIL_TREES.has(tree)
        ? `/${tree}/bookings/${pkg.orderId}`
        : `/track/${encodeURIComponent(pkg.trackingId)}`,
  }));
  return results.length > 0
    ? { id: "packages", label: "Packages", results }
    : null;
}

async function bookingGroup(
  actor: ActorContext,
  q: string,
  tree: DashboardId | null,
): Promise<SearchGroup | null> {
  if (!tree || !BOOKING_DETAIL_TREES.has(tree)) return null;
  if (!actor.permissions.has("booking.read_all") && !hasRecordScope(actor)) {
    return null;
  }
  const { bookings } = await listBookings(actor, { search: q, pageSize: PAGE_SIZE });
  const results = bookings.map((booking) => ({
    id: booking.id,
    label: booking.orderNumber,
    hint: [booking.senderName, booking.destinationDistrict]
      .filter(Boolean)
      .join(" · "),
    href: `/${tree}/bookings/${booking.id}`,
  }));
  return results.length > 0
    ? { id: "bookings", label: "Bookings", results }
    : null;
}

async function vendorGroup(
  actor: ActorContext,
  q: string,
  tree: DashboardId | null,
): Promise<SearchGroup | null> {
  if (!tree || !ADMIN_TREES.has(tree)) return null;
  if (
    !actor.permissions.has("vendor.read_all") &&
    !actor.permissions.has("vendor.manage")
  ) {
    return null;
  }
  const { vendors } = await listVendors(actor, { search: q, pageSize: PAGE_SIZE });
  const results = vendors.map((vendor) => ({
    id: vendor.id,
    label: vendor.businessName,
    hint: vendor.contactName,
    href: `/${tree}/vendors/${vendor.id}`,
  }));
  return results.length > 0 ? { id: "vendors", label: "Vendors", results } : null;
}

async function customerGroup(
  actor: ActorContext,
  q: string,
  tree: DashboardId | null,
): Promise<SearchGroup | null> {
  if (!tree || !ADMIN_TREES.has(tree)) return null;
  if (
    !actor.permissions.has("customer.read") &&
    !actor.permissions.has("customer.manage")
  ) {
    return null;
  }
  const { customers } = await listCustomers(actor, { search: q, pageSize: PAGE_SIZE });
  const results = customers.map((customer) => ({
    id: customer.id,
    label: customer.fullName,
    hint: customer.phone,
    href: `/${tree}/customers/${customer.id}`,
  }));
  return results.length > 0
    ? { id: "customers", label: "Customers", results }
    : null;
}

async function warehouseGroup(
  actor: ActorContext,
  q: string,
  tree: DashboardId | null,
): Promise<SearchGroup | null> {
  if (!tree || !ADMIN_TREES.has(tree)) return null;
  if (
    !actor.permissions.has("warehouse.read_all") &&
    !actor.permissions.has("warehouse.read_assigned")
  ) {
    return null;
  }
  const { items } = await listWarehouses(actor, { search: q, pageSize: PAGE_SIZE });
  const results = items.map((warehouse) => ({
    id: warehouse.id,
    label: warehouse.name,
    hint: [warehouse.code, warehouse.city].filter(Boolean).join(" · "),
    href: `/${tree}/warehouses/${warehouse.id}`,
  }));
  return results.length > 0
    ? { id: "warehouses", label: "Warehouses", results }
    : null;
}

async function driverGroup(
  actor: ActorContext,
  q: string,
  tree: DashboardId | null,
): Promise<SearchGroup | null> {
  if (!tree || !DRIVER_DETAIL_TREES.has(tree)) return null;
  if (
    !actor.permissions.has("driver.manage") &&
    !actor.permissions.has("driver.assign") &&
    !actor.permissions.has("driver.read_self")
  ) {
    return null;
  }
  const { items } = await listDrivers(actor, { search: q, pageSize: PAGE_SIZE });
  const results = items.map((driver) => ({
    id: driver.id,
    label: driver.fullName,
    hint: `Home warehouse ${driver.homeWarehouseCode}`,
    href: `/${tree}/drivers/${driver.id}`,
  }));
  return results.length > 0 ? { id: "drivers", label: "Drivers", results } : null;
}

/** One failing domain omits its group — it never 500s the palette. */
async function safely(
  build: () => Promise<SearchGroup | null>,
): Promise<SearchGroup | null> {
  try {
    return await build();
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const actor = await getActorContext();
  if (!actor) return unauthenticatedResponse();
  try {
    requireAccessGranted(actor);
  } catch (error) {
    const response = apiErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  if (q.length < 2) {
    return NextResponse.json({ groups: [] as SearchGroup[] });
  }

  const tree = treeFor(actor);
  const groups = await Promise.all([
    safely(() => packageGroup(actor, q, tree)),
    safely(() => bookingGroup(actor, q, tree)),
    safely(() => vendorGroup(actor, q, tree)),
    safely(() => customerGroup(actor, q, tree)),
    safely(() => warehouseGroup(actor, q, tree)),
    safely(() => driverGroup(actor, q, tree)),
  ]);
  return NextResponse.json({
    groups: groups.filter((group): group is SearchGroup => group !== null),
  });
}
