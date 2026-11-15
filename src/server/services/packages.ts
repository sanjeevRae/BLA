import "server-only";

import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { AuthorizationError, type ActorContext } from "@/lib/auth/actor";
import { NotFoundError } from "@/lib/errors";
import { publicStatusLabel } from "@/lib/bookings/lifecycle";
import { normalizePhone } from "@/lib/bookings/phone";
import { isValidTrackingId } from "@/lib/bookings/tracking";
import {
  TRACKING_DETAIL_LOCK_MS,
  TRACKING_DETAIL_MAX_FAILURES,
} from "@/lib/deliveries/domain";
import { auditAccessDenied, pageArgs, pageMeta } from "@/server/services/scoping";
import {
  isTrackingIpBudgetExceeded,
  type TrackingRequestMeta,
} from "@/server/services/tracking-access";
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

export async function getPublicTracking(
  trackingId: string,
  meta?: TrackingRequestMeta,
): Promise<PublicTrackingView> {
  // A malformed or mistyped code is rejected before any lookup.
  if (!isValidTrackingId(trackingId)) {
    throw new NotFoundError("Tracking code not found");
  }
  // Phase 10 (P3-2 / P6-R6 remainder): the per-IP failure budget
  // (security doc §7). An exhausted IP gets the SAME denial as an
  // unknown code, and the limiter's own denial writes no row.
  if (await isTrackingIpBudgetExceeded(meta?.ipAddress)) {
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
  if (!pkg) {
    // A well-formed but unknown code is a failed attempt: recorded
    // (with the caller IP) so enumeration consumes the per-IP
    // budget. Successful lookups are NOT recorded — the basic view
    // stays write-free for legitimate traffic.
    await prisma.trackingAccessAttempt.create({
      data: {
        trackingId,
        phoneHash: "",
        succeeded: false,
        ipAddress: meta?.ipAddress ?? null,
      },
    });
    throw new NotFoundError("Tracking code not found");
  }
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

// ---------------------------------------------------------------------------
// Detailed public tracking — SECOND FACTOR (security-architecture §7,
// roadmap Phase 6). The basic projection above stays available with
// the tracking code alone. The DETAILED timeline additionally
// requires the recipient phone number on the package record (exact
// match after the same normalisation used at booking). Every failure
// mode — unknown code, wrong phone, locked — throws the SAME
// NotFoundError so the responses are indistinguishable. Failure
// bookkeeping is deliberately minimal on this unauthenticated
// surface (Phase 6 review P6-R6, detailed at the function): only a
// phone mismatch against a real package writes both a
// TrackingAccessAttempt and an audit row. After
// TRACKING_DETAIL_MAX_FAILURES failures inside the cooling window
// the detailed view locks for that tracking code.
// No financial data (COD amounts, charges) is ever exposed here.
// ---------------------------------------------------------------------------

export interface DetailedTrackingView extends PublicTrackingView {
  recipientName: string;
  timeline: {
    status: string;
    label: string;
    occurredAt: string;
    warehouseCity: string | null;
  }[];
  proofOfDelivery: {
    deliveredAt: string;
    receivedByName: string | null;
    method: string;
  } | null;
  /**
   * The CURRENT delivery code for an OUT_FOR_DELIVERY package
   * (Phase 8, P6-R1 closure). This phone-verified view is the ONLY
   * surface that ever exposes the code: the caller has just proven
   * possession of the very phone number the code protects. It is
   * present only while a valid, unexpired, unlocked, unverified
   * OTP exists on the active assignment; otherwise null.
   */
  deliveryCode: string | null;
}

const DETAILED_TRACKING_DENIAL =
  "Tracking details are not available for this tracking code and phone number";

export async function getDetailedTracking(
  trackingId: string,
  phone: string,
  meta?: TrackingRequestMeta,
): Promise<DetailedTrackingView> {
  const normalized = normalizePhone(typeof phone === "string" ? phone : "");
  const phoneHash = createHash("sha256").update(normalized).digest("hex");
  const ipAddress = meta?.ipAddress ?? null;

  // Phase 6 review P6-R6 — the denial bookkeeping is deliberately
  // asymmetric, because this endpoint is unauthenticated:
  //  - a MALFORMED tracking code (or an unusable phone) writes
  //    NOTHING at all: no attempt row, no audit row. Attackers
  //    could otherwise grow both tables without bound.
  //  - a LOCKED code writes nothing either: previously every
  //    denial — including "already locked" — appended a fresh
  //    failure row inside the cooling window, so the lock
  //    refreshed itself forever (and a legitimate customer
  //    retrying with the CORRECT phone kept extending their own
  //    lockout). The lock now simply expires with the window.
  //  - an UNKNOWN (well-formed) code records the failed attempt
  //    (keyed by the code, so the lockout can still engage) but
  //    no audit row.
  //  - a phone mismatch on a REAL package records both the
  //    attempt and the audit row — that is the case with a
  //    genuine probing signal against a genuine parcel.
  // Every path throws the identical NotFoundError.
  if (!isValidTrackingId(trackingId) || normalized.length === 0) {
    throw new NotFoundError(DETAILED_TRACKING_DENIAL);
  }

  // Phase 10 (P3-2 / P6-R6 remainder): the per-IP failure budget is
  // checked alongside the per-code lockout below. An exhausted IP
  // gets the identical denial and — like the locked-code path —
  // writes nothing, so the budget decays with its window.
  if (await isTrackingIpBudgetExceeded(ipAddress)) {
    throw new NotFoundError(DETAILED_TRACKING_DENIAL);
  }

  const failures = await prisma.trackingAccessAttempt.count({
    where: {
      trackingId,
      succeeded: false,
      createdAt: { gt: new Date(Date.now() - TRACKING_DETAIL_LOCK_MS) },
    },
  });
  if (failures >= TRACKING_DETAIL_MAX_FAILURES) {
    throw new NotFoundError(DETAILED_TRACKING_DENIAL);
  }

  const pkg = await prisma.package.findUnique({
    where: { trackingId },
    select: {
      id: true,
      trackingId: true,
      operationalStatus: true,
      deliveryCity: true,
      deliveryDistrict: true,
      recipientName: true,
      recipientPhone: true,
      createdAt: true,
      updatedAt: true,
      shipment: {
        select: { originWarehouse: { select: { city: true } } },
      },
    },
  });
  if (!pkg) {
    await prisma.trackingAccessAttempt.create({
      data: { trackingId, phoneHash, succeeded: false, ipAddress },
    });
    throw new NotFoundError(DETAILED_TRACKING_DENIAL);
  }
  if (normalizePhone(pkg.recipientPhone) !== normalized) {
    await prisma.trackingAccessAttempt.create({
      data: { trackingId, phoneHash, succeeded: false, ipAddress },
    });
    await prisma.auditLog.create({
      data: {
        actorId: null,
        actorRole: null,
        action: "tracking.detailed_access_denied",
        entityType: "Package",
        entityId: pkg.id,
        after: { trackingId, reason: "phone_mismatch" },
      },
    });
    throw new NotFoundError(DETAILED_TRACKING_DENIAL);
  }

  // Success clears the code's prior failure rows (P6-R6): a
  // customer who mistyped, then verified, starts clean instead of
  // sitting one failure away from a lockout.
  await prisma.trackingAccessAttempt.deleteMany({
    where: { trackingId, succeeded: false },
  });
  await prisma.trackingAccessAttempt.create({
    data: { trackingId, phoneHash, succeeded: true, ipAddress },
  });
  const [events, pod] = await Promise.all([
    prisma.trackingEvent.findMany({
      where: { packageId: pkg.id },
      orderBy: { occurredAt: "asc" },
      select: {
        newStatus: true,
        occurredAt: true,
        warehouse: { select: { city: true } },
      },
    }),
    prisma.proofOfDelivery.findFirst({
      where: { packageId: pkg.id, supersededById: null },
      orderBy: { deliveredAt: "desc" },
      select: { deliveredAt: true, receivedByName: true, method: true },
    }),
  ]);

  // P6-R1 closure: after phone verification, the recipient — and
  // only the recipient — can read back the current delivery code
  // from their DELIVERY_OTP notification while the package is out
  // for delivery and the OTP is live. The code is never derived
  // from the assignment (only its hash lives there); the
  // recipient-addressed notification IS the delivery record.
  let deliveryCode: string | null = null;
  if (pkg.operationalStatus === "OUT_FOR_DELIVERY") {
    const assignment = await prisma.deliveryAssignment.findFirst({
      where: { packageId: pkg.id, kind: "DELIVERY", status: "IN_PROGRESS" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        otpCodeHash: true,
        otpExpiresAt: true,
        otpLockedAt: true,
        otpVerifiedAt: true,
      },
    });
    if (
      assignment?.otpCodeHash &&
      !assignment.otpLockedAt &&
      !assignment.otpVerifiedAt &&
      assignment.otpExpiresAt &&
      assignment.otpExpiresAt.getTime() > Date.now()
    ) {
      const note = await prisma.notification.findFirst({
        where: {
          category: "DELIVERY_OTP",
          channel: "TRACKING",
          entityType: "DeliveryAssignment",
          entityId: assignment.id,
          recipientPhone: normalized,
        },
        orderBy: { createdAt: "desc" },
        select: { payload: true },
      });
      const payload = note?.payload as { otpCode?: unknown } | null;
      if (payload && typeof payload.otpCode === "string") {
        deliveryCode = payload.otpCode;
      }
    }
  }
  return {
    trackingId: pkg.trackingId,
    status: pkg.operationalStatus,
    statusLabel: publicStatusLabel(pkg.operationalStatus),
    originCity: pkg.shipment.originWarehouse.city,
    destinationCity: pkg.deliveryCity,
    destinationDistrict: pkg.deliveryDistrict,
    bookedAt: pkg.createdAt.toISOString(),
    lastUpdateAt: pkg.updatedAt.toISOString(),
    recipientName: pkg.recipientName,
    timeline: events
      .filter((e) => e.newStatus)
      .map((e) => ({
        status: e.newStatus as string,
        label: publicStatusLabel(e.newStatus as string),
        occurredAt: e.occurredAt.toISOString(),
        warehouseCity: e.warehouse?.city ?? null,
      })),
    proofOfDelivery: pod
      ? {
          deliveredAt: pod.deliveredAt.toISOString(),
          receivedByName: pod.receivedByName,
          method: pod.method,
        }
      : null,
    deliveryCode,
  };
}
