import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { AuthorizationError, type ActorContext } from "@/lib/auth/actor";
import { NotFoundError } from "@/lib/errors";
import { publicStatusLabel } from "@/lib/bookings/lifecycle";
import { isValidTrackingId } from "@/lib/bookings/tracking";
import { auditAccessDenied, pageArgs, pageMeta } from "@/server/services/scoping";
import {
  packageInclude,
  toPackageView,
  type PackageView,
} from "@/server/services/package-lifecycle";

/**
 * Package reads (docs/security-architecture.md §3.3–§3.4, §7). Every
 * read is force-scoped server-side: company readers see all, vendors
 * see their own organisation's parcels, warehouse staff see parcels at
 * or routed through their warehouses, customers see parcels addressed
 * to their linked record. Cross-tenant reads are hidden as 404 with an
 * access.denied audit row.
 *
 * The public tracking projection is a separate, unauthenticated read
 * with an exact, minimal field set — never the package row.
 */

type PackageRow = Prisma.PackageGetPayload<{ include: typeof packageInclude }>;

async function requirePackageReadable(actor: ActorContext, pkg: PackageRow): Promise<void> {
  if (actor.permissions.has("package.read_all")) return;
  if (actor.vendorId) {
    if (pkg.order.vendorId === actor.vendorId) return;
    await auditAccessDenied(actor, "Package", {
      entityId: pkg.id,
      reason: "cross_vendor_package_read",
    });
    throw new NotFoundError("Package not found");
  }
  if (actor.customerId) {
    if (pkg.recipientCustomerId === actor.customerId) return;
    await auditAccessDenied(actor, "Package", {
      entityId: pkg.id,
      reason: "cross_customer_package_read",
    });
    throw new NotFoundError("Package not found");
  }
  if (actor.warehouseIds.length > 0) {
    const shipment = await prisma.shipment.findUnique({
      where: { id: pkg.shipmentId },
      select: { originWarehouseId: true, destinationWarehouseId: true },
    });
    const inScope =
      (pkg.currentWarehouseId && actor.warehouseIds.includes(pkg.currentWarehouseId)) ||
      (shipment && actor.warehouseIds.includes(shipment.originWarehouseId)) ||
      (shipment?.destinationWarehouseId &&
        actor.warehouseIds.includes(shipment.destinationWarehouseId));
    if (inScope) return;
    await auditAccessDenied(actor, "Package", {
      entityId: pkg.id,
      warehouseId: pkg.currentWarehouseId,
      reason: "package_outside_warehouse_scope",
    });
    throw new AuthorizationError("Package is outside your warehouse scope");
  }
  await auditAccessDenied(actor, "Package", { entityId: pkg.id, reason: "no_package_read_scope" });
  throw new AuthorizationError("You do not have access to packages");
}

async function loadPackage(where: Prisma.PackageWhereUniqueInput): Promise<PackageRow> {
  const pkg = await prisma.package.findUnique({ where, include: packageInclude });
  if (!pkg) throw new NotFoundError("Package not found");
  return pkg;
}

export async function getPackage(actor: ActorContext, packageId: string): Promise<PackageView> {
  const pkg = await loadPackage({ id: packageId });
  await requirePackageReadable(actor, pkg);
  return toPackageView(pkg);
}

export async function getPackageByTrackingId(
  actor: ActorContext,
  trackingId: string,
): Promise<PackageView> {
  const pkg = await loadPackage({ trackingId });
  await requirePackageReadable(actor, pkg);
  return toPackageView(pkg);
}

export async function listPackages(
  actor: ActorContext,
  query: {
    search?: string;
    status?: string;
    warehouseId?: string;
    vendorId?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<{ packages: PackageView[]; meta: ReturnType<typeof pageMeta> }> {
  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  let scope: Prisma.PackageWhereInput;
  if (actor.permissions.has("package.read_all")) {
    scope = query.vendorId ? { order: { vendorId: query.vendorId } } : {};
  } else if (actor.vendorId) {
    scope = { order: { vendorId: actor.vendorId } };
  } else if (actor.customerId) {
    scope = { recipientCustomerId: actor.customerId };
  } else if (actor.warehouseIds.length > 0) {
    if (query.warehouseId && !actor.warehouseIds.includes(query.warehouseId)) {
      await auditAccessDenied(actor, "Package", {
        warehouseId: query.warehouseId,
        reason: "package_list_warehouse_out_of_scope",
      });
      throw new AuthorizationError("Warehouse is outside your membership scope");
    }
    const ids = query.warehouseId ? [query.warehouseId] : actor.warehouseIds;
    scope = {
      OR: [
        { currentWarehouseId: { in: ids } },
        { shipment: { originWarehouseId: { in: ids } } },
        { shipment: { destinationWarehouseId: { in: ids } } },
      ],
    };
  } else {
    await auditAccessDenied(actor, "Package", { reason: "no_package_read_scope" });
    throw new AuthorizationError("You do not have access to packages");
  }
  // P3-1: scope and filters are composed with AND, never spread into
  // one object — the warehouse scope is an OR clause, and a spread
  // search OR would overwrite it, silently dropping the tenant filter
  // and leaking every tenant's packages.
  const where: Prisma.PackageWhereInput = {
    AND: [
      scope,
      ...(query.status ? [{ operationalStatus: query.status }] : []),
      ...(query.search
        ? [
            {
              OR: [
                { trackingId: { contains: query.search, mode: "insensitive" } },
                { recipientName: { contains: query.search, mode: "insensitive" } },
              ],
            } as Prisma.PackageWhereInput,
          ]
        : []),
    ],
  };
  const [rows, total] = await Promise.all([
    prisma.package.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, include: packageInclude }),
    prisma.package.count({ where }),
  ]);
  return { packages: rows.map(toPackageView), meta: pageMeta(total, page, pageSize) };
}

// ---------------------------------------------------------------------------
// Label (schema doc §5 PackageLabel): regeneration never changes the
// tracking ID; printing is counted, not a status change.
// ---------------------------------------------------------------------------

export interface PackageLabelView {
  packageId: string;
  trackingId: string;
  labelCode: string;
  qrPayload: string;
  orderNumber: string;
  senderName: string;
  senderPhone: string;
  recipientName: string;
  recipientCity: string;
  recipientDistrict: string;
  deliveryAddress: string;
  landmark: string | null;
  description: string;
  weightKg: string;
  codAmountPaisa: string;
  isFragile: boolean;
  originWarehouseCode: string | null;
  destinationWarehouseCode: string | null;
  printCount: number;
}

export async function getPackageLabel(
  actor: ActorContext,
  packageId: string,
  baseUrl: string,
): Promise<PackageLabelView> {
  const pkg = await loadPackage({ id: packageId });
  await requirePackageReadable(actor, pkg);
  const [order, shipment, label] = await Promise.all([
    prisma.order.findUnique({
      where: { id: pkg.orderId },
      select: { senderName: true, senderPhone: true, orderNumber: true },
    }),
    prisma.shipment.findUnique({
      where: { id: pkg.shipmentId },
      select: {
        originWarehouse: { select: { code: true } },
        destinationWarehouse: { select: { code: true } },
      },
    }),
    prisma.packageLabel.findFirst({ where: { packageId }, orderBy: { createdAt: "asc" } }),
  ]);
  if (!label) throw new NotFoundError("Package label not found");
  const updated = await prisma.packageLabel.update({
    where: { id: label.id },
    data: { printCount: { increment: 1 }, lastPrintedAt: new Date(), lastPrintedById: actor.userId },
  });
  return {
    packageId: pkg.id,
    trackingId: pkg.trackingId,
    labelCode: label.labelCode,
    qrPayload: `${baseUrl.replace(/\/$/, "")}${label.qrPayload}`,
    orderNumber: order?.orderNumber ?? "",
    senderName: order?.senderName ?? "",
    senderPhone: order?.senderPhone ?? "",
    recipientName: pkg.recipientName,
    recipientCity: pkg.deliveryCity,
    recipientDistrict: pkg.deliveryDistrict,
    deliveryAddress: pkg.deliveryAddress,
    landmark: pkg.landmark,
    description: pkg.description,
    weightKg: pkg.declaredWeightKg.toString(),
    codAmountPaisa: pkg.codAmountPaisa.toString(),
    isFragile: pkg.isFragile,
    originWarehouseCode: shipment?.originWarehouse.code ?? null,
    destinationWarehouseCode: shipment?.destinationWarehouse?.code ?? null,
    printCount: updated.printCount,
  };
}

// ---------------------------------------------------------------------------
// Public tracking (security doc §7): unauthenticated, exact field set.
// NO receiver phone, NO full address, NO COD, NO actor names, NO
// internal notes — the timeline exposes public milestone labels only.
// ---------------------------------------------------------------------------

export interface PublicTrackingView {
  trackingId: string;
  status: string;
  statusLabel: string;
  originCity: string;
  destinationCity: string;
  destinationDistrict: string;
  bookedAt: string;
  lastUpdateAt: string;
  timeline: { status: string; label: string; occurredAt: string }[];
}

export async function getPublicTracking(trackingId: string): Promise<PublicTrackingView> {
  // A malformed or mistyped code is rejected before any lookup.
  if (!isValidTrackingId(trackingId)) {
    throw new NotFoundError("Tracking code not found");
  }
  const pkg = await prisma.package.findUnique({
    where: { trackingId },
    select: {
      id: true,
      trackingId: true,
      operationalStatus: true,
      deliveryCity: true,
      deliveryDistrict: true,
      createdAt: true,
      updatedAt: true,
      shipment: {
        select: { originWarehouse: { select: { city: true } } },
      },
    },
  });
  if (!pkg) throw new NotFoundError("Tracking code not found");
  const events = await prisma.trackingEvent.findMany({
    where: { packageId: pkg.id },
    orderBy: { occurredAt: "asc" },
    select: { newStatus: true, occurredAt: true },
  });
  return {
    trackingId: pkg.trackingId,
    status: pkg.operationalStatus,
    statusLabel: publicStatusLabel(pkg.operationalStatus),
    originCity: pkg.shipment.originWarehouse.city,
    destinationCity: pkg.deliveryCity,
    destinationDistrict: pkg.deliveryDistrict,
    bookedAt: pkg.createdAt.toISOString(),
    lastUpdateAt: pkg.updatedAt.toISOString(),
    timeline: events
      .filter((e) => e.newStatus)
      .map((e) => ({
        status: e.newStatus as string,
        label: publicStatusLabel(e.newStatus as string),
        occurredAt: e.occurredAt.toISOString(),
      })),
  };
}
