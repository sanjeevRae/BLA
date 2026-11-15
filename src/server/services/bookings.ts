import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import { AuthorizationError, type ActorContext } from "@/lib/auth/actor";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import {
  PACKAGE_CATEGORIES,
  PAYMENT_METHODS,
  PICKUP_METHODS,
  VENDOR_BOOKING_ROLES,
} from "@/lib/bookings/domain";
import {
  CANCELLABLE_STATUSES,
  EDITABLE_STATUSES,
} from "@/lib/bookings/lifecycle";
import { generateTrackingId } from "@/lib/bookings/tracking";
import { splitPaisa } from "@/lib/bookings/pricing-math";
import {
  auditAccessDenied,
  isUniqueViolationOn,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import { findOrCreateCustomer } from "@/server/services/customers";
import { resolvePricing, parcelWeights } from "@/server/services/pricing";
import {
  initialisePackage,
  transitionPackage,
  toPackageView,
  packageInclude,
  type PackageView,
} from "@/server/services/package-lifecycle";

/**
 * Booking flow (docs/business-requirements.md §6; roadmap Phase 3).
 * One chain only: Order → Shipment → Packages (one package per booked
 * unit). The destination district routes the shipment to its serving
 * warehouse; a district with no serving warehouse leaves the shipment
 * UNROUTED — held in a visible state, never silently misrouted.
 * Vendor-submitted bookings land in the approval queue (PENDING);
 * staff-created bookings are approved by default (roadmap Phase 3).
 */

const orderInclude = {
  items: { orderBy: { createdAt: "asc" } },
  shipments: {
    orderBy: { createdAt: "asc" },
    include: { packages: { include: packageInclude, orderBy: { createdAt: "asc" } } },
  },
  vendor: { select: { businessName: true } },
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export interface BookingView {
  id: string;
  orderNumber: string;
  vendorId: string | null;
  vendorName: string | null;
  customerId: string | null;
  senderName: string;
  senderPhone: string;
  originWarehouseId: string | null;
  destinationDistrict: string;
  approvalStatus: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  pickupMethod: string;
  deliveryInstructions: string | null;
  notes: string | null;
  scheduledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  items: {
    id: string;
    description: string;
    quantity: number;
    unitPricePaisa: string | null;
    weightKg: string | null;
  }[];
  shipments: {
    id: string;
    shipmentNumber: string;
    kind: string;
    routeKind: string;
    originWarehouseId: string;
    destinationWarehouseId: string | null;
    shippingChargePaisa: string;
    codAmountPaisa: string;
    status: string;
    packages: PackageView[];
  }[];
}

export function toBookingView(o: OrderRow): BookingView {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    vendorId: o.vendorId,
    vendorName: o.vendor?.businessName ?? null,
    customerId: o.customerId,
    senderName: o.senderName,
    senderPhone: o.senderPhone,
    originWarehouseId: o.originWarehouseId,
    destinationDistrict: o.destinationDistrict,
    approvalStatus: o.approvalStatus,
    status: o.status,
    paymentMethod: o.paymentMethod,
    paymentStatus: o.paymentStatus,
    pickupMethod: o.pickupMethod,
    deliveryInstructions: o.deliveryInstructions,
    notes: o.notes,
    scheduledAt: o.scheduledAt?.toISOString() ?? null,
    cancelReason: o.cancelReason,
    createdAt: o.createdAt.toISOString(),
    items: o.items.map((i) => ({
      id: i.id,
      description: i.description,
      quantity: i.quantity,
      unitPricePaisa: i.unitPricePaisa?.toString() ?? null,
      weightKg: i.weightKg?.toString() ?? null,
    })),
    shipments: o.shipments.map((s) => ({
      id: s.id,
      shipmentNumber: s.shipmentNumber,
      kind: s.kind,
      routeKind: s.routeKind,
      originWarehouseId: s.originWarehouseId,
      destinationWarehouseId: s.destinationWarehouseId,
      shippingChargePaisa: s.shippingChargePaisa.toString(),
      codAmountPaisa: s.codAmountPaisa.toString(),
      status: s.status,
      packages: s.packages.map(toPackageView),
    })),
  };
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

const moneyString = z
  .union([z.string().regex(/^\d+$/, "Amount must be integer paisa"), z.number().int().nonnegative()])
  .transform((v) => BigInt(v));

export const createBookingSchema = z.object({
  vendorId: z.string().uuid().optional().nullable(),
  sender: z
    .object({
      name: z.string().min(2).max(160),
      phone: z.string().min(7).max(24),
      email: z.string().email().max(254).optional().nullable(),
    })
    .optional()
    .nullable(),
  recipient: z.object({
    name: z.string().min(2).max(160),
    phone: z.string().min(7).max(24),
    altPhone: z.string().max(24).optional().nullable(),
    email: z.string().email().max(254).optional().nullable(),
    addressLine: z.string().min(3).max(300),
    city: z.string().min(2).max(120),
    district: z.string().min(2).max(120),
    province: z.string().min(2).max(120).optional().nullable(),
    municipality: z.string().max(120).optional().nullable(),
    wardNumber: z.string().max(16).optional().nullable(),
    landmark: z.string().max(200).optional().nullable(),
  }),
  pickup: z.object({
    method: z.enum(PICKUP_METHODS),
    vendorAddressId: z.string().uuid().optional().nullable(),
    originWarehouseId: z.string().uuid().optional().nullable(),
  }),
  shippingServiceCode: z.string().min(2).max(40).default("STANDARD"),
  paymentMethod: z.enum(PAYMENT_METHODS).default("CASH"),
  codAmountPaisa: moneyString.default(BigInt(0)),
  deliveryInstructions: z.string().max(1000).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  scheduledAt: z.string().datetime().optional().nullable(),
  items: z
    .array(
      z.object({
        description: z.string().min(2).max(300),
        quantity: z.number().int().min(1).max(200),
        weightKg: z.number().positive().max(10000),
        unitPricePaisa: moneyString.optional().nullable(),
        sku: z.string().max(80).optional().nullable(),
        lengthCm: z.number().positive().max(1000).optional().nullable(),
        widthCm: z.number().positive().max(1000).optional().nullable(),
        heightCm: z.number().positive().max(1000).optional().nullable(),
        category: z.enum(PACKAGE_CATEGORIES).default("PACKAGE"),
        isFragile: z.boolean().default(false),
        handlingInstructions: z.string().max(500).optional().nullable(),
        restrictedGoodsDeclared: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(20),
});
export type CreateBookingInput = z.input<typeof createBookingSchema>;
type ParsedBooking = z.output<typeof createBookingSchema>;

function dec(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value.toFixed(3));
}

async function createBookingOnce(
  actor: ActorContext,
  data: ParsedBooking,
): Promise<BookingView> {
  // --- Resolve the vendor / sender -----------------------------------
  let vendor: Prisma.VendorGetPayload<object> | null = null;
  const vendorId = actor.vendorId ?? data.vendorId ?? null;
  if (actor.vendorId) {
    if (data.vendorId && data.vendorId !== actor.vendorId) {
      await auditAccessDenied(actor, "Order", { reason: "vendor_booking_for_other_vendor" });
      throw new AuthorizationError("Vendor users can only book for their own organisation");
    }
    if (!actor.vendorRole || !VENDOR_BOOKING_ROLES.includes(actor.vendorRole)) {
      await auditAccessDenied(actor, "Order", {
        reason: `vendor_role_cannot_book:${actor.vendorRole ?? "none"}`,
      });
      throw new AuthorizationError(
        "Your vendor role cannot create bookings (Accounts Staff have no booking access)",
      );
    }
  }
  if (vendorId) {
    vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
    if (!vendor) throw new NotFoundError("Vendor not found");
    if (!vendor.isActive || vendor.verificationStatus !== "APPROVED") {
      throw new ConflictError(
        `Vendor ${vendor.businessName} is not approved for booking (status: ${vendor.verificationStatus})`,
      );
    }
  } else if (!data.sender) {
    throw new DomainValidationError(
      "Walk-in bookings need sender details (or a vendor) — sender is required",
    );
  }

  const service = await prisma.shippingService.findUnique({
    where: { code: data.shippingServiceCode },
  });
  if (!service || !service.isActive) {
    throw new DomainValidationError(`Unknown or inactive shipping service: ${data.shippingServiceCode}`);
  }

  const vendorSubmitted = Boolean(actor.vendorId);
  const totalParcels = data.items.reduce((sum, i) => sum + i.quantity, 0);
  const codSplit = splitPaisa(data.codAmountPaisa, totalParcels);

  // Drop-off scope is validated before the transaction opens so the
  // denial audit never depends on transaction state.
  if (data.pickup.method === "WAREHOUSE_DROPOFF" && data.pickup.originWarehouseId) {
    if (
      actor.warehouseIds.length > 0 &&
      !actor.permissions.has("booking.read_all") &&
      !actor.warehouseIds.includes(data.pickup.originWarehouseId)
    ) {
      await auditAccessDenied(actor, "Order", {
        warehouseId: data.pickup.originWarehouseId,
        reason: "dropoff_warehouse_out_of_scope",
      });
      throw new AuthorizationError("Drop-off warehouse is outside your membership scope");
    }
  }

  const view = await prisma.$transaction(async (tx) => {
    // --- People: duplicate-aware customer records ---------------------
    const recipientCustomer = await findOrCreateCustomer(
      tx,
      {
        fullName: data.recipient.name,
        phone: data.recipient.phone,
        email: data.recipient.email ?? null,
      },
      actor.userId,
    );
    let senderCustomerId: string | null = null;
    let senderName: string;
    let senderPhone: string;
    let senderEmail: string | null;
    if (vendor) {
      senderName = vendor.contactName;
      senderPhone = vendor.phone;
      senderEmail = vendor.email;
    } else {
      const senderCustomer = await findOrCreateCustomer(
        tx,
        {
          fullName: data.sender!.name,
          phone: data.sender!.phone,
          email: data.sender!.email ?? null,
        },
        actor.userId,
      );
      senderCustomerId = senderCustomer.id;
      senderName = data.sender!.name;
      senderPhone = data.sender!.phone;
      senderEmail = data.sender!.email ?? null;
    }

    // --- Origin warehouse ----------------------------------------------
    let originWarehouseId: string;
    let pickupVendorAddressId: string | null = null;
    if (data.pickup.method === "RIDER_PICKUP") {
      if (!vendor) {
        throw new DomainValidationError("Rider pickup is available for vendor bookings");
      }
      if (!data.pickup.vendorAddressId) {
        throw new DomainValidationError("A pickup address is required for rider pickup");
      }
      const address = await tx.vendorAddress.findUnique({
        where: { id: data.pickup.vendorAddressId },
      });
      if (!address || address.vendorId !== vendor.id || address.kind !== "PICKUP") {
        throw new DomainValidationError("Pickup address does not belong to this vendor");
      }
      if (!address.isApproved) {
        throw new DomainValidationError(
          "Pickup address is not approved yet — an administrator must approve it before rider pickup bookings",
        );
      }
      pickupVendorAddressId = address.id;
      const area = await tx.serviceArea.findFirst({
        where: { district: address.district, isActive: true },
        orderBy: { name: "asc" },
      });
      if (area) {
        originWarehouseId = area.servingWarehouseId;
      } else {
        const assignment = await tx.vendorWarehouseAssignment.findFirst({
          where: { vendorId: vendor.id, kind: "ORIGIN", isActive: true },
          orderBy: { createdAt: "asc" },
        });
        if (!assignment) {
          throw new DomainValidationError(
            "No warehouse serves the pickup district and the vendor has no assigned origin warehouse",
          );
        }
        originWarehouseId = assignment.warehouseId;
      }
    } else {
      if (!data.pickup.originWarehouseId) {
        throw new DomainValidationError("Choose the warehouse the parcel is dropped off at");
      }
      originWarehouseId = data.pickup.originWarehouseId;
      const warehouse = await tx.warehouse.findUnique({ where: { id: originWarehouseId } });
      if (!warehouse || warehouse.status !== "ACTIVE") {
        throw new DomainValidationError("Drop-off warehouse is not an active warehouse");
      }
    }

    // --- Destination routing by district --------------------------------
    const destAreas = await tx.serviceArea.findMany({
      where: { district: data.recipient.district, isActive: true },
      orderBy: { name: "asc" },
    });
    const destArea =
      destAreas.find(
        (a) => a.city && a.city.toLowerCase() === data.recipient.city.toLowerCase(),
      ) ?? destAreas[0] ?? null;
    let destinationWarehouseId: string | null = destArea?.servingWarehouseId ?? null;
    if (!destinationWarehouseId) {
      const districtWarehouse = await tx.warehouse.findFirst({
        where: { district: data.recipient.district, status: "ACTIVE" },
        orderBy: { code: "asc" },
      });
      destinationWarehouseId = districtWarehouse?.id ?? null;
    }
    const routeKind = !destinationWarehouseId
      ? "UNROUTED"
      : destinationWarehouseId === originWarehouseId
        ? "LAST_MILE"
        : "INTER_WAREHOUSE";

    const originArea = await tx.serviceArea.findFirst({
      where: { servingWarehouseId: originWarehouseId, isActive: true },
      orderBy: { name: "asc" },
    });

    // --- Pricing snapshot ------------------------------------------------
    const declaredTotal = data.items.reduce(
      (sum, i) => sum.plus(dec(i.weightKg).mul(i.quantity)),
      new Prisma.Decimal(0),
    );
    const pricing = await resolvePricing(tx, {
      shippingServiceId: service.id,
      originServiceAreaId: originArea?.id ?? null,
      destinationServiceAreaId: destArea?.id ?? null,
      totalBillableWeightKg: declaredTotal,
    });
    let totalBillable = new Prisma.Decimal(0);
    const parcelPlans = data.items.map((item) => {
      const weights = parcelWeights({
        declaredWeightKg: dec(item.weightKg),
        lengthCm: item.lengthCm ? dec(item.lengthCm) : null,
        widthCm: item.widthCm ? dec(item.widthCm) : null,
        heightCm: item.heightCm ? dec(item.heightCm) : null,
        volumetricDivisor: pricing.rule.volumetricDivisor,
      });
      totalBillable = totalBillable.plus(weights.billableKg.mul(item.quantity));
      return { item, weights };
    });
    const shippingChargePaisa =
      pricing.rule.baseRatePaisa +
      BigInt(
        new Prisma.Decimal(pricing.rule.perKgRatePaisa.toString())
          .mul(totalBillable)
          .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
          .toString(),
      );

    // --- Business numbers --------------------------------------------------
    const [orderSeq] = await tx.$queryRaw<{ nextval: bigint }[]>`
      SELECT nextval('app.order_number_seq') AS nextval`;
    const [shipmentSeq] = await tx.$queryRaw<{ nextval: bigint }[]>`
      SELECT nextval('app.shipment_number_seq') AS nextval`;

    const order = await tx.order.create({
      data: {
        orderNumber: `ORD-${orderSeq.nextval.toString()}`,
        vendorId: vendor?.id ?? null,
        customerId: senderCustomerId,
        createdById: actor.userId,
        createdByRole: actor.primaryRole ?? "UNKNOWN",
        senderName,
        senderPhone,
        senderEmail,
        originWarehouseId,
        destinationDistrict: data.recipient.district,
        destinationServiceAreaId: destArea?.id ?? null,
        approvalStatus: vendorSubmitted ? "PENDING" : "APPROVED",
        approvedById: vendorSubmitted ? null : actor.userId,
        approvedAt: vendorSubmitted ? null : new Date(),
        status: vendorSubmitted ? "SUBMITTED" : "CONFIRMED",
        paymentMethod: data.paymentMethod,
        pickupMethod: data.pickup.method,
        pickupVendorAddressId,
        deliveryInstructions: data.deliveryInstructions ?? null,
        notes: data.notes ?? null,
        scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null,
      },
    });
    // Items are created one by one so each package plan maps to its
    // OrderItem by position, never by matching descriptions.
    const createdItems: { id: string }[] = [];
    for (const i of data.items) {
      const row = await tx.orderItem.create({
        data: {
          orderId: order.id,
          description: i.description,
          quantity: i.quantity,
          unitPricePaisa: i.unitPricePaisa ?? null,
          weightKg: dec(i.weightKg),
          sku: i.sku ?? null,
        },
      });
      createdItems.push(row);
    }

    const expectedDeliveryAt =
      service.estimatedDaysMax != null
        ? new Date(Date.now() + service.estimatedDaysMax * 24 * 60 * 60 * 1000)
        : null;

    const shipment = await tx.shipment.create({
      data: {
        shipmentNumber: `SHP-${shipmentSeq.nextval.toString()}`,
        orderId: order.id,
        kind: "FORWARD",
        originWarehouseId,
        destinationWarehouseId,
        destinationServiceAreaId: destArea?.id ?? null,
        routeKind,
        shippingServiceId: service.id,
        pricingRuleId: pricing.rule.id,
        shippingChargePaisa,
        codAmountPaisa: data.codAmountPaisa,
        expectedDeliveryAt,
        totalWeightKg: totalBillable,
      },
    });

    // --- Packages: one per booked unit ------------------------------------
    let parcelIndex = 0;
    for (const [planIndex, plan] of parcelPlans.entries()) {
      const orderItem = createdItems[planIndex];
      for (let unit = 0; unit < plan.item.quantity; unit++) {
        const cod = codSplit[parcelIndex] ?? BigInt(0);
        parcelIndex++;
        await initialisePackage(tx, {
          trackingId: generateTrackingId(),
          shipmentId: shipment.id,
          orderId: order.id,
          recipientName: data.recipient.name,
          recipientPhone: data.recipient.phone,
          recipientAltPhone: data.recipient.altPhone ?? null,
          recipientEmail: data.recipient.email ?? null,
          recipientCustomerId: recipientCustomer.id,
          deliveryAddress: data.recipient.addressLine,
          deliveryCity: data.recipient.city,
          deliveryDistrict: data.recipient.district,
          municipality: data.recipient.municipality ?? null,
          wardNumber: data.recipient.wardNumber ?? null,
          landmark: data.recipient.landmark ?? null,
          declaredWeightKg: dec(plan.item.weightKg),
          volumetricWeightKg: plan.weights.volumetricKg,
          billableWeightKg: plan.weights.billableKg,
          lengthCm: plan.item.lengthCm ? dec(plan.item.lengthCm) : null,
          widthCm: plan.item.widthCm ? dec(plan.item.widthCm) : null,
          heightCm: plan.item.heightCm ? dec(plan.item.heightCm) : null,
          declaredValuePaisa: plan.item.unitPricePaisa ?? null,
          description: plan.item.description,
          category: plan.item.category,
          isFragile: plan.item.isFragile,
          handlingInstructions: plan.item.handlingInstructions ?? null,
          restrictedGoodsDeclared: plan.item.restrictedGoodsDeclared,
          codAmountPaisa: cod,
          currentWarehouseId: originWarehouseId,
          actorId: actor.userId,
          actorRole: actor.primaryRole,
          orderItemId: orderItem?.id ?? null,
          packageItemDescription: plan.item.description,
          packageItemDeclaredValuePaisa: plan.item.unitPricePaisa ?? null,
        });
      }
    }

    const full = await tx.order.findUniqueOrThrow({
      where: { id: order.id },
      include: orderInclude,
    });
    return { view: toBookingView(full), routeKind, orderId: order.id, orderNumber: order.orderNumber };
  });

  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: view.routeKind === "UNROUTED" ? "booking.create_unrouted" : "booking.create",
      entityType: "Order",
      entityId: view.orderId,
      warehouseId: view.view.originWarehouseId,
      after: {
        orderNumber: view.orderNumber,
        routeKind: view.routeKind,
        destinationDistrict: view.view.destinationDistrict,
        packages: view.view.shipments.reduce((n, s) => n + s.packages.length, 0),
      },
    },
  });
  return view.view;
}

export async function createBooking(
  actor: ActorContext,
  input: CreateBookingInput,
): Promise<BookingView> {
  await requirePermAudited(actor, "booking.create", "Order");
  const data = parse(createBookingSchema, input);
  // Tracking IDs are random + check-digited and DB-unique; a collision
  // (astronomically unlikely) retries the whole creation with fresh IDs.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await createBookingOnce(actor, data);
    } catch (error) {
      if (isUniqueViolationOn(error, "trackingId") && attempt < 2) continue;
      throw error;
    }
  }
  throw new ConflictError("Could not allocate unique tracking IDs — please retry");
}

// ---------------------------------------------------------------------------
// Reads (force-scoped)
// ---------------------------------------------------------------------------

/** Resolve read access to one order, or throw with an audit row.
 *  Cross-tenant access (vendor/customer) is hidden as 404. */
async function requireBookingReadable(actor: ActorContext, orderId: string): Promise<OrderRow> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) throw new NotFoundError("Booking not found");
  if (actor.permissions.has("booking.read_all")) return order;
  if (actor.vendorId) {
    if (order.vendorId === actor.vendorId) return order;
    await auditAccessDenied(actor, "Order", { entityId: orderId, reason: "cross_vendor_booking_read" });
    throw new NotFoundError("Booking not found");
  }
  if (actor.customerId) {
    const isSender = order.customerId === actor.customerId;
    const isRecipient = order.shipments.some((s) =>
      s.packages.some((p) => p.recipientCustomerId === actor.customerId),
    );
    if (isSender || isRecipient) return order;
    await auditAccessDenied(actor, "Order", { entityId: orderId, reason: "cross_customer_booking_read" });
    throw new NotFoundError("Booking not found");
  }
  if (actor.warehouseIds.length > 0) {
    const inScope =
      (order.originWarehouseId && actor.warehouseIds.includes(order.originWarehouseId)) ||
      order.shipments.some(
        (s) => s.destinationWarehouseId && actor.warehouseIds.includes(s.destinationWarehouseId),
      );
    if (inScope) return order;
    await auditAccessDenied(actor, "Order", {
      entityId: orderId,
      warehouseId: order.originWarehouseId,
      reason: "booking_outside_warehouse_scope",
    });
    throw new AuthorizationError("Booking is outside your warehouse scope");
  }
  await auditAccessDenied(actor, "Order", { entityId: orderId, reason: "no_booking_read_scope" });
  throw new AuthorizationError("You do not have access to bookings");
}

export async function getBooking(actor: ActorContext, orderId: string): Promise<BookingView> {
  return toBookingView(await requireBookingReadable(actor, orderId));
}

export interface BookingListItem {
  id: string;
  orderNumber: string;
  vendorId: string | null;
  vendorName: string | null;
  senderName: string;
  destinationDistrict: string;
  approvalStatus: string;
  status: string;
  originWarehouseId: string | null;
  routeKind: string | null;
  destinationWarehouseId: string | null;
  packageCount: number;
  codAmountPaisa: string;
  shippingChargePaisa: string;
  createdAt: string;
}

export async function listBookings(
  actor: ActorContext,
  query: {
    search?: string;
    status?: string;
    approvalStatus?: string;
    vendorId?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<{ bookings: BookingListItem[]; meta: ReturnType<typeof pageMeta> }> {
  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  let scope: Prisma.OrderWhereInput;
  if (actor.permissions.has("booking.read_all")) {
    scope = query.vendorId ? { vendorId: query.vendorId } : {};
  } else if (actor.vendorId) {
    scope = { vendorId: actor.vendorId };
  } else if (actor.customerId) {
    scope = {
      OR: [
        { customerId: actor.customerId },
        { packages: { some: { recipientCustomerId: actor.customerId } } },
      ],
    };
  } else if (actor.warehouseIds.length > 0) {
    scope = {
      OR: [
        { originWarehouseId: { in: actor.warehouseIds } },
        { shipments: { some: { destinationWarehouseId: { in: actor.warehouseIds } } } },
      ],
    };
  } else {
    await auditAccessDenied(actor, "Order", { reason: "no_booking_read_scope" });
    throw new AuthorizationError("You do not have access to bookings");
  }
  const where: Prisma.OrderWhereInput = {
    ...scope,
    ...(query.status ? { status: query.status } : {}),
    ...(query.approvalStatus ? { approvalStatus: query.approvalStatus } : {}),
    ...(query.search
      ? {
          OR: [
            { orderNumber: { contains: query.search, mode: "insensitive" } },
            { senderName: { contains: query.search, mode: "insensitive" } },
            { packages: { some: { trackingId: { contains: query.search, mode: "insensitive" } } } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: {
        vendor: { select: { businessName: true } },
        shipments: {
          select: {
            routeKind: true,
            destinationWarehouseId: true,
            codAmountPaisa: true,
            shippingChargePaisa: true,
            _count: { select: { packages: true } },
          },
        },
      },
    }),
    prisma.order.count({ where }),
  ]);
  return {
    bookings: rows.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      vendorId: o.vendorId,
      vendorName: o.vendor?.businessName ?? null,
      senderName: o.senderName,
      destinationDistrict: o.destinationDistrict,
      approvalStatus: o.approvalStatus,
      status: o.status,
      originWarehouseId: o.originWarehouseId,
      routeKind: o.shipments[0]?.routeKind ?? null,
      destinationWarehouseId: o.shipments[0]?.destinationWarehouseId ?? null,
      packageCount: o.shipments.reduce((n, s) => n + s._count.packages, 0),
      codAmountPaisa: o.shipments.reduce((n, s) => n + s.codAmountPaisa, BigInt(0)).toString(),
      shippingChargePaisa: o.shipments
        .reduce((n, s) => n + s.shippingChargePaisa, BigInt(0))
        .toString(),
      createdAt: o.createdAt.toISOString(),
    })),
    meta: pageMeta(total, page, pageSize),
  };
}

// ---------------------------------------------------------------------------
// Approval queue (roadmap Phase 3: vendor submissions need approval)
// ---------------------------------------------------------------------------

export async function approveBooking(
  actor: ActorContext,
  orderId: string,
  note?: string | null,
): Promise<BookingView> {
  await requirePermAudited(actor, "booking.approve", "Order");
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new NotFoundError("Booking not found");
  if (order.approvalStatus !== "PENDING") {
    throw new ConflictError(`Booking is ${order.approvalStatus}, not PENDING`);
  }
  await prisma.order.update({
    where: { id: orderId },
    data: {
      approvalStatus: "APPROVED",
      approvedById: actor.userId,
      approvedAt: new Date(),
      approvalNote: note ?? null,
      status: "CONFIRMED",
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "booking.approve",
      entityType: "Order",
      entityId: orderId,
      after: { approvalStatus: "APPROVED", note: note ?? null },
    },
  });
  const full = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
  return toBookingView(full);
}

export async function rejectBooking(
  actor: ActorContext,
  orderId: string,
  reason: string,
): Promise<BookingView> {
  await requirePermAudited(actor, "booking.approve", "Order");
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) throw new NotFoundError("Booking not found");
  if (order.approvalStatus !== "PENDING") {
    throw new ConflictError(`Booking is ${order.approvalStatus}, not PENDING`);
  }
  for (const shipment of order.shipments) {
    for (const pkg of shipment.packages) {
      if (pkg.operationalStatus === "BOOKED") {
        await transitionPackage(actor, pkg.id, "CANCELLED", {
          notes: `Booking rejected: ${reason}`,
        });
      }
    }
  }
  await prisma.order.update({
    where: { id: orderId },
    data: {
      approvalStatus: "REJECTED",
      approvalNote: reason,
      status: "CANCELLED",
      cancelReason: reason,
      cancelledAt: new Date(),
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "booking.reject",
      entityType: "Order",
      entityId: orderId,
      after: { approvalStatus: "REJECTED", reason },
    },
  });
  const full = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: orderInclude });
  return toBookingView(full);
}

// ---------------------------------------------------------------------------
// Cancellation (rule T9: only before physical custody)
// ---------------------------------------------------------------------------

async function requireBookingWritable(actor: ActorContext, orderId: string): Promise<OrderRow> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (!order) throw new NotFoundError("Booking not found");
  if (actor.permissions.has("booking.read_all")) return order;
  if (actor.vendorId && order.vendorId === actor.vendorId) return order;
  await auditAccessDenied(actor, "Order", {
    entityId: orderId,
    reason: "booking_write_out_of_scope",
  });
  if (actor.vendorId || actor.customerId) throw new NotFoundError("Booking not found");
  throw new AuthorizationError("Booking is outside your scope");
}

export async function cancelBooking(
  actor: ActorContext,
  orderId: string,
  reason: string,
): Promise<BookingView> {
  await requirePermAudited(actor, "booking.cancel", "Order");
  const order = await requireBookingWritable(actor, orderId);
  if (order.status === "CANCELLED") throw new ConflictError("Booking is already cancelled");
  const packages = order.shipments.flatMap((s) => s.packages);
  const blocking = packages.find((p) => !CANCELLABLE_STATUSES.includes(p.operationalStatus));
  if (blocking) {
    throw new ConflictError(
      `Package ${blocking.trackingId} is ${blocking.operationalStatus} — cancellation is only possible before pickup (DRAFT / BOOKED / PICKUP_ASSIGNED)`,
    );
  }
  for (const pkg of packages) {
    await transitionPackage(actor, pkg.id, "CANCELLED", { notes: reason });
  }
  await prisma.order.update({
    where: { id: orderId },
    data: {
      status: "CANCELLED",
      cancelRequestedById: actor.userId,
      cancelApprovedById: actor.permissions.has("booking.approve") ? actor.userId : null,
      cancelReason: reason,
      cancelStage: packages[0]?.operationalStatus ?? null,
      cancelledAt: new Date(),
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "booking.cancel",
      entityType: "Order",
      entityId: orderId,
      after: { reason, packagesCancelled: packages.length },
    },
  });
  return getBooking(actor, orderId);
}

// ---------------------------------------------------------------------------
// Corrections (booking stage only — lifecycle doc §5)
// ---------------------------------------------------------------------------

export const updateBookingSchema = z.object({
  recipientName: z.string().min(2).max(160).optional(),
  recipientPhone: z.string().min(7).max(24).optional(),
  deliveryAddress: z.string().min(3).max(300).optional(),
  deliveryCity: z.string().min(2).max(120).optional(),
  landmark: z.string().max(200).optional().nullable(),
  deliveryInstructions: z.string().max(1000).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  scheduledAt: z.string().datetime().optional().nullable(),
});
export type UpdateBookingInput = z.infer<typeof updateBookingSchema>;

export async function updateBooking(
  actor: ActorContext,
  orderId: string,
  input: UpdateBookingInput,
): Promise<BookingView> {
  await requirePermAudited(actor, "booking.update", "Order");
  const data = parse(updateBookingSchema, input);
  const order = await requireBookingWritable(actor, orderId);
  const packages = order.shipments.flatMap((s) => s.packages);
  const blocking = packages.find((p) => !EDITABLE_STATUSES.includes(p.operationalStatus));
  if (blocking) {
    throw new ConflictError(
      `Package ${blocking.trackingId} is ${blocking.operationalStatus} — booking corrections are only possible before pickup`,
    );
  }
  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: {
        ...(data.deliveryInstructions !== undefined
          ? { deliveryInstructions: data.deliveryInstructions }
          : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        ...(data.scheduledAt !== undefined
          ? { scheduledAt: data.scheduledAt ? new Date(data.scheduledAt) : null }
          : {}),
      },
    });
    if (
      data.recipientName !== undefined ||
      data.recipientPhone !== undefined ||
      data.deliveryAddress !== undefined ||
      data.deliveryCity !== undefined ||
      data.landmark !== undefined
    ) {
      await tx.package.updateMany({
        where: { orderId },
        data: {
          ...(data.recipientName !== undefined ? { recipientName: data.recipientName } : {}),
          ...(data.recipientPhone !== undefined ? { recipientPhone: data.recipientPhone } : {}),
          ...(data.deliveryAddress !== undefined ? { deliveryAddress: data.deliveryAddress } : {}),
          ...(data.deliveryCity !== undefined ? { deliveryCity: data.deliveryCity } : {}),
          ...(data.landmark !== undefined ? { landmark: data.landmark } : {}),
        },
      });
    }
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "booking.update",
      entityType: "Order",
      entityId: orderId,
      after: { fields: Object.keys(data) },
    },
  });
  return getBooking(actor, orderId);
}
