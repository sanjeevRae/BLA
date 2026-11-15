import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  hasPermission,
  type ActorContext,
} from "@/lib/auth/actor";
import { DomainValidationError, NotFoundError } from "@/lib/errors";
import {
  INCIDENT_OPEN_STATUSES,
  TICKET_OPEN_STATUSES,
} from "@/lib/operations/domain";
import {
  bigintToString,
  enumerateDays,
  percent,
  resolveReportRange,
  type ReportRange,
} from "@/lib/reports/domain";
import { accountBalancePaisa } from "@/server/services/finance-ledger";
import { invoicePaidComponents } from "@/server/services/invoices";
import {
  auditAccessDenied,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";

/**
 * ReportingService (Phase 9 — docs/implementation-roadmap.md Phase 9,
 * docs/api-reference.md §16). Every figure is an aggregation over the
 * real operational tables written by Phases 3–8 — no cached totals,
 * no mock numbers. Definitions are fixed here so the dashboards, the
 * API and the CSV export can never disagree:
 *
 *  - Bookings/packages are attributed to the ORIGIN warehouse
 *    (Shipment.originWarehouseId); deliveries and their COD to the
 *    DELIVERY warehouse (DeliveryBatch.warehouseId); a rider's COD to
 *    the collecting rider (DeliveryCodCollection.collectedById).
 *  - "Delivered" always means a live ProofOfDelivery row
 *    (supersededById IS NULL) and its deliveredAt timestamp.
 *  - A failed attempt is a DeliveryAttempt with result <> DELIVERED.
 *  - Return rate = return requests created in the period ÷ packages
 *    delivered in the period. Vendor delivery success rate =
 *    delivered ÷ (delivered + completed returns) of the period.
 *  - Date ranges are Asia/Kathmandu days, both ends inclusive
 *    (src/lib/reports/domain.ts).
 *
 * Scope law (matrix §4): the scope predicate is composed INTO every
 * query (Prisma where / SQL WHERE), never applied to results in
 * memory. A warehouse filter outside the actor's memberships is an
 * audited denial, not an empty report. Finance holders of
 * report.read_all see FINANCIAL reports only (matrix footnote 32) —
 * operational reports deny them, audited.
 */

// ---------------------------------------------------------------------------
// Filters + range
// ---------------------------------------------------------------------------

export const reportFiltersSchema = z.object({
  from: z.string().max(10).optional().nullable(),
  to: z.string().max(10).optional().nullable(),
  warehouseId: z.string().uuid().optional().nullable(),
  vendorId: z.string().uuid().optional().nullable(),
  driverId: z.string().uuid().optional().nullable(),
  serviceId: z.string().uuid().optional().nullable(),
  district: z.string().max(120).optional().nullable(),
  status: z.string().max(40).optional().nullable(),
  paymentStatus: z.string().max(40).optional().nullable(),
});
export type ReportFiltersInput = z.input<typeof reportFiltersSchema>;
export type ReportFilters = z.output<typeof reportFiltersSchema>;

function parseFilters(input: unknown): ReportFilters {
  return parse(reportFiltersSchema, input ?? {});
}

function parseRange(filters: ReportFilters): ReportRange {
  try {
    return resolveReportRange(filters.from, filters.to);
  } catch (error) {
    throw new DomainValidationError(
      error instanceof Error ? error.message : "Invalid report range",
    );
  }
}

function inRange(range: ReportRange): { gte: Date; lt: Date } {
  return { gte: range.fromUtc, lt: range.toUtc };
}

function rangeEcho(range: ReportRange) {
  return { from: range.fromDate, to: range.toDate, timeZone: "Asia/Kathmandu" };
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/** Finance-only holders of report.read_all (matrix footnote 32). */
export function isFinanceOnlyReader(actor: ActorContext): boolean {
  return (
    actor.roles.includes("FINANCE") &&
    !actor.roles.includes("ADMIN") &&
    !actor.roles.includes("SUPER_ADMIN")
  );
}

async function requireOperationalReportAll(
  actor: ActorContext,
  entityType: string,
): Promise<void> {
  await requirePermAudited(actor, "report.read_all", entityType);
  if (isFinanceOnlyReader(actor)) {
    await auditAccessDenied(actor, entityType, {
      reason: "finance_reports_only",
    });
    throw new AuthorizationError(
      "Finance accounts can read financial reports only",
    );
  }
}

/**
 * Resolve the warehouse set a report may cover.
 * Returns null for "no warehouse restriction" (company-wide readers),
 * otherwise the explicit warehouse id list (possibly empty).
 */
async function resolveWarehouseScope(
  actor: ActorContext,
  requestedId: string | null | undefined,
  entityType: string,
): Promise<string[] | null> {
  if (hasPermission(actor, "report.read_all") && !isFinanceOnlyReader(actor)) {
    return requestedId ? [requestedId] : null;
  }
  if (hasPermission(actor, "report.read_warehouse")) {
    if (requestedId) {
      if (!actor.warehouseIds.includes(requestedId)) {
        await auditAccessDenied(actor, entityType, {
          warehouseId: requestedId,
          reason: "warehouse_scope_other_warehouse_report",
        });
        throw new AuthorizationError(
          "Warehouse reports cover only your own warehouses",
        );
      }
      return [requestedId];
    }
    return [...actor.warehouseIds];
  }
  // Neither permission: audited denial via the standard helper.
  await requirePermAudited(actor, "report.read_warehouse", entityType);
  return null; // unreachable — requirePermAudited threw
}

/** Vendor scope: a vendor actor is pinned to their own vendor id. */
async function resolveVendorScope(
  actor: ActorContext,
  requestedId: string | null | undefined,
  entityType: string,
): Promise<string | null> {
  if (actor.vendorId) {
    if (requestedId && requestedId !== actor.vendorId) {
      await auditAccessDenied(actor, entityType, {
        entityId: requestedId,
        reason: "vendor_scope_other_vendor_report",
      });
      throw new AuthorizationError("Vendors can only read their own reports");
    }
    return actor.vendorId;
  }
  return requestedId ?? null;
}

async function warehouseNames(ids: string[]): Promise<Map<string, { code: string; name: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.warehouse.findMany({
    where: { id: { in: ids } },
    select: { id: true, code: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, { code: r.code, name: r.name }]));
}

// ---------------------------------------------------------------------------
// Overview (api-reference §16: GET /api/reports/overview)
// ---------------------------------------------------------------------------

export interface OverviewReport {
  range: { from: string; to: string; timeZone: string };
  generatedAt: string;
  bookings: number;
  packagesBooked: number;
  delivered: number;
  deliveryAttempts: number;
  failedAttempts: number;
  avgDeliveryMinutes: number | null;
  deliveredWithExpected: number;
  lateDeliveries: number;
  onTimePercent: number | null;
  returnsCreated: number;
  returnRatePercent: number | null;
  packagesByStatus: { status: string; count: number }[];
  dailySeries: { date: string; bookings: number; delivered: number }[];
  invoiced: { count: number; totalPaisa: string };
  paymentsReceived: { count: number; totalPaisa: string };
  outstanding: { openInvoices: number; outstandingPaisa: string };
  cod: {
    expectedPaisa: string;
    collectedPaisa: string;
    outstandingWithRidersPaisa: string;
  };
  incidents: { created: number; open: number; byCategory: { category: string; count: number }[] };
  tickets: { created: number; open: number; byCategory: { category: string; count: number }[] };
}

/**
 * Run `fn` over `items` in small sequential batches. Report
 * row-builders fan out ~10-16 parallel queries per row; an unbounded
 * Promise.all over every vendor/warehouse/driver starves the Prisma
 * connection pool once the row count grows (observed as pool-timeout
 * failures in the vendor report). Batches of 2 bound the in-flight
 * queries while keeping the results identical and in input order.
 */
async function mapInBatches<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    out.push(...(await Promise.all(batch.map(fn))));
  }
  return out;
}

export async function getOverviewReport(
  actor: ActorContext,
  input: unknown,
): Promise<OverviewReport> {
  await requireOperationalReportAll(actor, "Report");
  const filters = parseFilters(input);
  const range = parseRange(filters);
  const span = inRange(range);

  // Booking-side scope: origin warehouse / vendor / service / district.
  const orderWhere: Prisma.OrderWhereInput = {
    AND: [
      { createdAt: span },
      ...(filters.warehouseId ? [{ originWarehouseId: filters.warehouseId }] : []),
      ...(filters.vendorId ? [{ vendorId: filters.vendorId }] : []),
      ...(filters.district ? [{ destinationDistrict: filters.district }] : []),
    ],
  };
  const shipmentScope: Prisma.ShipmentWhereInput = {
    AND: [
      ...(filters.warehouseId ? [{ originWarehouseId: filters.warehouseId }] : []),
      ...(filters.serviceId ? [{ shippingServiceId: filters.serviceId }] : []),
      ...(filters.vendorId || filters.district
        ? [
            {
              order: {
                AND: [
                  ...(filters.vendorId ? [{ vendorId: filters.vendorId }] : []),
                  ...(filters.district
                    ? [{ destinationDistrict: filters.district }]
                    : []),
                ],
              },
            },
          ]
        : []),
    ],
  };
  const packageScope: Prisma.PackageWhereInput =
    shipmentScope.AND && (shipmentScope.AND as unknown[]).length > 0
      ? { shipment: shipmentScope }
      : {};

  // Delivery-side scope: delivery warehouse (batch) / driver.
  const assignmentScope: Prisma.DeliveryAssignmentWhereInput = {
    AND: [
      ...(filters.driverId ? [{ driverId: filters.driverId }] : []),
      ...(filters.warehouseId ? [{ batch: { warehouseId: filters.warehouseId } }] : []),
    ],
  };
  const attemptWhere: Prisma.DeliveryAttemptWhereInput = {
    AND: [
      { attemptedAt: span },
      ...(Object.keys(packageScope).length > 0 ? [{ package: packageScope }] : []),
      ...((assignmentScope.AND as unknown[]).length > 0
        ? [{ assignment: assignmentScope }]
        : []),
    ],
  };

  const [
    bookings,
    packagesBooked,
    attempts,
    failedAttempts,
    returnsCreated,
    statusGroups,
    invoicedAgg,
    paymentsAgg,
    openInvoices,
    codAgg,
    incidentsCreated,
    incidentsOpen,
    incidentGroups,
    ticketsCreated,
    ticketsOpen,
    ticketGroups,
  ] = await Promise.all([
    prisma.order.count({ where: orderWhere }),
    prisma.package.count({
      where: { AND: [{ createdAt: span }, ...(Object.keys(packageScope).length > 0 ? [packageScope] : [])] },
    }),
    prisma.deliveryAttempt.count({ where: attemptWhere }),
    prisma.deliveryAttempt.count({
      where: { AND: [attemptWhere, { result: { not: "DELIVERED" } }] },
    }),
    prisma.returnRequest.count({
      where: {
        AND: [
          { createdAt: span },
          ...(filters.warehouseId ? [{ warehouseId: filters.warehouseId }] : []),
          ...(filters.vendorId ? [{ order: { vendorId: filters.vendorId } }] : []),
        ],
      },
    }),
    prisma.package.groupBy({
      by: ["operationalStatus"],
      where: {
        AND: [
          ...(filters.status ? [{ operationalStatus: filters.status }] : []),
          ...(filters.warehouseId ? [{ currentWarehouseId: filters.warehouseId }] : []),
          ...(Object.keys(packageScope).length > 0 ? [packageScope] : []),
        ],
      },
      _count: { _all: true },
      orderBy: { operationalStatus: "asc" },
    }),
    prisma.invoice.aggregate({
      where: {
        AND: [
          { issuedAt: span },
          { status: { not: "CANCELLED" } },
          ...(filters.vendorId ? [{ vendorId: filters.vendorId }] : []),
        ],
      },
      _sum: { totalPaisa: true },
      _count: { _all: true },
    }),
    prisma.payment.aggregate({
      where: {
        AND: [
          { createdAt: span },
          { status: "PAID" },
          ...(filters.vendorId ? [{ payerVendorId: filters.vendorId }] : []),
        ],
      },
      _sum: { amountPaisa: true },
      _count: { _all: true },
    }),
    prisma.invoice.findMany({
      where: {
        AND: [
          { status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
          ...(filters.vendorId ? [{ vendorId: filters.vendorId }] : []),
        ],
      },
      select: { id: true, totalPaisa: true },
    }),
    prisma.deliveryCodCollection.aggregate({
      where: {
        AND: [
          { collectedAt: span },
          ...(filters.vendorId ? [{ shipment: { order: { vendorId: filters.vendorId } } }] : []),
          ...(filters.driverId
            ? [{ assignment: { driverId: filters.driverId } }]
            : []),
          ...(filters.warehouseId ? [{ batch: { warehouseId: filters.warehouseId } }] : []),
          ...(filters.paymentStatus
            ? [{ package: { paymentStatus: filters.paymentStatus } }]
            : []),
        ],
      },
      _sum: { expectedPaisa: true, collectedPaisa: true },
    }),
    prisma.incident.count({ where: { createdAt: span } }),
    prisma.incident.count({ where: { status: { in: [...INCIDENT_OPEN_STATUSES] } } }),
    prisma.incident.groupBy({
      by: ["category"],
      where: { createdAt: span },
      _count: { _all: true },
      orderBy: { category: "asc" },
    }),
    prisma.supportTicket.count({ where: { createdAt: span } }),
    prisma.supportTicket.count({ where: { status: { in: [...TICKET_OPEN_STATUSES] } } }),
    prisma.supportTicket.groupBy({
      by: ["category"],
      where: { createdAt: span },
      _count: { _all: true },
      orderBy: { category: "asc" },
    }),
  ]);

  // Outstanding (snapshot): the Phase 7 derivation, reused verbatim so
  // the dashboard can never disagree with the finance records.
  let outstandingPaisa = BigInt(0);
  for (const invoice of openInvoices) {
    const paid = await invoicePaidComponents(prisma, invoice.id);
    const due = invoice.totalPaisa - paid.totalPaidPaisa;
    if (due > BigInt(0)) outstandingPaisa += due;
  }

  // Delivery performance (delivered / late / average book-to-door
  // minutes) in one SQL aggregation — the scope predicates are bound
  // parameters inside the WHERE, exactly like the Prisma queries.
  const conditions: Prisma.Sql[] = [
    Prisma.sql`pod."supersededById" IS NULL`,
    Prisma.sql`pod."deliveredAt" >= ${range.fromUtc}`,
    Prisma.sql`pod."deliveredAt" < ${range.toUtc}`,
  ];
  if (filters.vendorId) conditions.push(Prisma.sql`o."vendorId" = ${filters.vendorId}`);
  if (filters.district) conditions.push(Prisma.sql`o."destinationDistrict" = ${filters.district}`);
  if (filters.warehouseId) {
    // Deliveries attribute to the DELIVERY (batch) warehouse only —
    // the stated rule in the header. Also pushing the origin
    // warehouse made the overview's delivered count disagree with
    // the warehouse report and with this payload's own COD section
    // under a warehouse filter (Phase 9 review P9-R6).
    conditions.push(Prisma.sql`b."warehouseId" = ${filters.warehouseId}`);
  }
  if (filters.serviceId) conditions.push(Prisma.sql`s."shippingServiceId" = ${filters.serviceId}`);
  if (filters.driverId) conditions.push(Prisma.sql`a."driverId" = ${filters.driverId}`);
  const perfRows = await prisma.$queryRaw<
    {
      delivered: number;
      with_expected: number;
      late: number;
      avg_minutes: number | null;
    }[]
  >`
    SELECT
      count(*)::int AS delivered,
      count(*) FILTER (WHERE s."expectedDeliveryAt" IS NOT NULL)::int AS with_expected,
      count(*) FILTER (
        WHERE s."expectedDeliveryAt" IS NOT NULL AND pod."deliveredAt" > s."expectedDeliveryAt"
      )::int AS late,
      (AVG(EXTRACT(EPOCH FROM (pod."deliveredAt" - p."createdAt"))) / 60.0)::float8 AS avg_minutes
    FROM "app"."ProofOfDelivery" pod
    JOIN "app"."Package" p ON p."id" = pod."packageId"
    JOIN "app"."Shipment" s ON s."id" = p."shipmentId"
    JOIN "app"."Order" o ON o."id" = p."orderId"
    JOIN "app"."DeliveryAssignment" a ON a."id" = pod."assignmentId"
    LEFT JOIN "app"."DeliveryBatch" b ON b."id" = a."batchId"
    WHERE ${Prisma.join(conditions, " AND ")}
  `;
  const perf = perfRows[0] ?? { delivered: 0, with_expected: 0, late: 0, avg_minutes: null };
  const delivered = perf.delivered;

  // Daily series (Kathmandu days, zero-filled): two grouped SQL
  // queries merged by date string. Bucketing (Phase 9 review
  // P9-R1): the timestamp columns are naive TIMESTAMP(3) holding
  // UTC wall-clock, so the Kathmandu day is the double conversion
  // (ts AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kathmandu' — a
  // single AT TIME ZONE on a naive value INTERPRETS it as Kathmandu
  // time instead of converting, shifting everything booked or
  // delivered between 00:00 and 11:30 NPT onto the previous day.
  const bookingSeries = await prisma.$queryRaw<{ day: string; n: number }[]>`
    SELECT to_char(date_trunc('day', ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kathmandu'), 'YYYY-MM-DD') AS day,
           count(*)::int AS n
    FROM "app"."Order"
    WHERE "createdAt" >= ${range.fromUtc} AND "createdAt" < ${range.toUtc}
      ${filters.warehouseId ? Prisma.sql`AND "originWarehouseId" = ${filters.warehouseId}` : Prisma.empty}
      ${filters.vendorId ? Prisma.sql`AND "vendorId" = ${filters.vendorId}` : Prisma.empty}
      ${filters.district ? Prisma.sql`AND "destinationDistrict" = ${filters.district}` : Prisma.empty}
    GROUP BY 1
  `;
  const deliveredSeries = await prisma.$queryRaw<{ day: string; n: number }[]>`
    SELECT to_char(date_trunc('day', (pod."deliveredAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kathmandu'), 'YYYY-MM-DD') AS day,
           count(*)::int AS n
    FROM "app"."ProofOfDelivery" pod
    JOIN "app"."Package" p ON p."id" = pod."packageId"
    JOIN "app"."Shipment" s ON s."id" = p."shipmentId"
    JOIN "app"."Order" o ON o."id" = p."orderId"
    JOIN "app"."DeliveryAssignment" a ON a."id" = pod."assignmentId"
    LEFT JOIN "app"."DeliveryBatch" b ON b."id" = a."batchId"
    WHERE ${Prisma.join(conditions, " AND ")}
    GROUP BY 1
  `;
  const bookingsByDay = new Map(bookingSeries.map((r) => [r.day, r.n]));
  const deliveredByDay = new Map(deliveredSeries.map((r) => [r.day, r.n]));
  const dailySeries = enumerateDays(range.fromDate, range.toDate).map((date) => ({
    date,
    bookings: bookingsByDay.get(date) ?? 0,
    delivered: deliveredByDay.get(date) ?? 0,
  }));

  // COD still owed by riders (snapshot): collected minus the portion
  // finance has verified into clearing — the same derivation as the
  // Phase 7 rider position, summed over every collection.
  const allCollections = await prisma.deliveryCodCollection.findMany({
    where: {
      AND: [
        ...(filters.vendorId ? [{ shipment: { order: { vendorId: filters.vendorId } } }] : []),
        ...(filters.driverId ? [{ assignment: { driverId: filters.driverId } }] : []),
        ...(filters.warehouseId ? [{ batch: { warehouseId: filters.warehouseId } }] : []),
      ],
    },
    select: {
      collectedPaisa: true,
      remittanceLines: {
        select: {
          verifiedPaisa: true,
          remittance: { select: { status: true, resolution: true } },
        },
      },
    },
  });
  let outstandingWithRiders = BigInt(0);
  for (const collection of allCollections) {
    const line = collection.remittanceLines[0];
    const verified =
      line &&
      (line.remittance.status === "VERIFIED" ||
        (line.remittance.status === "CLOSED" &&
          line.remittance.resolution === "ACCEPTED_COUNTED"))
        ? (line.verifiedPaisa ?? BigInt(0))
        : BigInt(0);
    outstandingWithRiders += collection.collectedPaisa - verified;
  }

  return {
    range: rangeEcho(range),
    generatedAt: new Date().toISOString(),
    bookings,
    packagesBooked,
    delivered,
    deliveryAttempts: attempts,
    failedAttempts,
    avgDeliveryMinutes:
      perf.avg_minutes === null ? null : Math.round(perf.avg_minutes * 10) / 10,
    deliveredWithExpected: perf.with_expected,
    lateDeliveries: perf.late,
    onTimePercent: percent(perf.with_expected - perf.late, perf.with_expected),
    returnsCreated,
    returnRatePercent: percent(returnsCreated, delivered),
    packagesByStatus: statusGroups.map((g) => ({
      status: g.operationalStatus,
      count: g._count._all,
    })),
    dailySeries,
    invoiced: {
      count: invoicedAgg._count._all,
      totalPaisa: bigintToString(invoicedAgg._sum.totalPaisa),
    },
    paymentsReceived: {
      count: paymentsAgg._count._all,
      totalPaisa: bigintToString(paymentsAgg._sum.amountPaisa),
    },
    outstanding: {
      openInvoices: openInvoices.length,
      outstandingPaisa: outstandingPaisa.toString(),
    },
    cod: {
      expectedPaisa: bigintToString(codAgg._sum.expectedPaisa),
      collectedPaisa: bigintToString(codAgg._sum.collectedPaisa),
      outstandingWithRidersPaisa: outstandingWithRiders.toString(),
    },
    incidents: {
      created: incidentsCreated,
      open: incidentsOpen,
      byCategory: incidentGroups.map((g) => ({ category: g.category, count: g._count._all })),
    },
    tickets: {
      created: ticketsCreated,
      open: ticketsOpen,
      byCategory: ticketGroups.map((g) => ({ category: g.category, count: g._count._all })),
    },
  };
}

// ---------------------------------------------------------------------------
// Daily operational summary (GET /api/reports/daily?date=)
// ---------------------------------------------------------------------------

export interface DailyReport {
  date: string;
  timeZone: string;
  bookings: number;
  packagesReceived: number;
  transfersDispatched: number;
  packagesDispatched: number;
  delivered: number;
  failedAttempts: number;
  returnsRequested: number;
  codCollectedPaisa: string;
  /** Present only for company-wide readers — invoices carry no
   *  warehouse attribution, so a warehouse-scoped daily omits them. */
  invoicedTotalPaisa: string | null;
}

export async function getDailyReport(
  actor: ActorContext,
  input: unknown,
): Promise<DailyReport> {
  const filters = parseFilters(input);
  const date = filters.from ?? filters.to ?? undefined;
  let range: ReportRange;
  try {
    range = resolveReportRange(date ?? null, date ?? null);
  } catch (error) {
    throw new DomainValidationError(
      error instanceof Error ? error.message : "Invalid date",
    );
  }
  const warehouseIds = await resolveWarehouseScope(actor, filters.warehouseId, "Report");
  const span = inRange(range);
  const warehouseIn = warehouseIds ? { in: warehouseIds } : undefined;

  const [
    bookings,
    packagesReceived,
    transfersDispatched,
    packagesDispatched,
    delivered,
    failedAttempts,
    returnsRequested,
    codAgg,
    invoicedAgg,
  ] = await Promise.all([
    prisma.order.count({
      where: {
        AND: [
          { createdAt: span },
          ...(warehouseIds ? [{ originWarehouseId: warehouseIn }] : []),
        ],
      },
    }),
    prisma.inventoryRecord.count({
      where: {
        AND: [
          { receivedAt: span },
          ...(warehouseIds ? [{ warehouseId: warehouseIn }] : []),
        ],
      },
    }),
    prisma.transfer.count({
      where: {
        AND: [
          { dispatchedAt: span },
          ...(warehouseIds ? [{ originWarehouseId: warehouseIn }] : []),
        ],
      },
    }),
    prisma.transferItem.count({
      where: {
        transfer: {
          AND: [
            { dispatchedAt: span },
            ...(warehouseIds ? [{ originWarehouseId: warehouseIn }] : []),
          ],
        },
      },
    }),
    prisma.proofOfDelivery.count({
      where: {
        AND: [
          { deliveredAt: span },
          { supersededById: null },
          ...(warehouseIds
            ? [{ assignment: { batch: { warehouseId: warehouseIn } } }]
            : []),
        ],
      },
    }),
    prisma.deliveryAttempt.count({
      where: {
        AND: [
          { attemptedAt: span },
          { result: { not: "DELIVERED" } },
          ...(warehouseIds
            ? [{ assignment: { batch: { warehouseId: warehouseIn } } }]
            : []),
        ],
      },
    }),
    prisma.returnRequest.count({
      where: {
        AND: [
          { createdAt: span },
          ...(warehouseIds ? [{ warehouseId: warehouseIn }] : []),
        ],
      },
    }),
    prisma.deliveryCodCollection.aggregate({
      where: {
        AND: [
          { collectedAt: span },
          ...(warehouseIds ? [{ batch: { warehouseId: warehouseIn } }] : []),
        ],
      },
      _sum: { collectedPaisa: true },
    }),
    warehouseIds === null
      ? prisma.invoice.aggregate({
          where: { AND: [{ issuedAt: span }, { status: { not: "CANCELLED" } }] },
          _sum: { totalPaisa: true },
        })
      : Promise.resolve(null),
  ]);

  return {
    date: range.fromDate,
    timeZone: "Asia/Kathmandu",
    bookings,
    packagesReceived,
    transfersDispatched,
    packagesDispatched,
    delivered,
    failedAttempts,
    returnsRequested,
    codCollectedPaisa: bigintToString(codAgg._sum.collectedPaisa),
    invoicedTotalPaisa: invoicedAgg
      ? bigintToString(invoicedAgg._sum.totalPaisa)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Warehouse reports (Part 18.2)
// ---------------------------------------------------------------------------

export interface WarehouseReportRow {
  warehouseId: string;
  code: string;
  name: string;
  received: number;
  transfersDispatched: number;
  packagesDispatched: number;
  transfersArrived: number;
  delivered: number;
  failedAttempts: number;
  currentInventory: number;
  capacityPackages: number | null;
  capacityUtilisationPercent: number | null;
  aging: { days0to2: number; days3to7: number; days8to14: number; over14: number };
  damagedInStock: number;
  receivingDiscrepancies: number;
  returnsRequested: number;
  incidentsCreated: number;
  staffReceiving: { userId: string; fullName: string; received: number }[];
}

export interface WarehouseReport {
  range: { from: string; to: string; timeZone: string };
  generatedAt: string;
  rows: WarehouseReportRow[];
}

export async function getWarehouseReport(
  actor: ActorContext,
  input: unknown,
): Promise<WarehouseReport> {
  const filters = parseFilters(input);
  const range = parseRange(filters);
  const span = inRange(range);
  const scopeIds = await resolveWarehouseScope(actor, filters.warehouseId, "Warehouse");

  const warehouses = await prisma.warehouse.findMany({
    where: scopeIds ? { id: { in: scopeIds } } : {},
    select: { id: true, code: true, name: true, capacityPackages: true },
    orderBy: { code: "asc" },
  });

  const now = new Date();
  const ageStart = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  const staffNameIds = new Set<string>();
  const rows = await mapInBatches(warehouses, 2, async (warehouse) => {
      const w = warehouse.id;
      const [
        received,
        transfersDispatched,
        packagesDispatched,
        transfersArrived,
        delivered,
        failedAttempts,
        currentInventory,
        aging0to2,
        aging3to7,
        aging8to14,
        agingOver14,
        damagedInStock,
        receivingDiscrepancies,
        returnsRequested,
        incidentsCreated,
        staffGroups,
      ] = await Promise.all([
        prisma.inventoryRecord.count({ where: { warehouseId: w, receivedAt: span } }),
        prisma.transfer.count({
          where: { originWarehouseId: w, dispatchedAt: span },
        }),
        prisma.transferItem.count({
          where: { transfer: { originWarehouseId: w, dispatchedAt: span } },
        }),
        prisma.transfer.count({
          where: { destinationWarehouseId: w, arrivedAt: span },
        }),
        prisma.proofOfDelivery.count({
          where: {
            deliveredAt: span,
            supersededById: null,
            assignment: { batch: { warehouseId: w } },
          },
        }),
        prisma.deliveryAttempt.count({
          where: {
            attemptedAt: span,
            result: { not: "DELIVERED" },
            assignment: { batch: { warehouseId: w } },
          },
        }),
        prisma.inventoryRecord.count({ where: { warehouseId: w, releasedAt: null } }),
        prisma.inventoryRecord.count({
          where: { warehouseId: w, releasedAt: null, receivedAt: { gte: ageStart(2) } },
        }),
        prisma.inventoryRecord.count({
          where: {
            warehouseId: w,
            releasedAt: null,
            receivedAt: { gte: ageStart(7), lt: ageStart(2) },
          },
        }),
        prisma.inventoryRecord.count({
          where: {
            warehouseId: w,
            releasedAt: null,
            receivedAt: { gte: ageStart(14), lt: ageStart(7) },
          },
        }),
        prisma.inventoryRecord.count({
          where: { warehouseId: w, releasedAt: null, receivedAt: { lt: ageStart(14) } },
        }),
        prisma.inventoryRecord.count({
          where: { warehouseId: w, releasedAt: null, package: { condition: "DAMAGED" } },
        }),
        prisma.transferItem.count({
          where: {
            itemStatus: { in: ["MISSING", "DAMAGED"] },
            receivedAt: span,
            transfer: { destinationWarehouseId: w },
          },
        }),
        prisma.returnRequest.count({ where: { warehouseId: w, createdAt: span } }),
        prisma.incident.count({ where: { warehouseId: w, createdAt: span } }),
        prisma.inventoryRecord.groupBy({
          by: ["receivedById"],
          where: { warehouseId: w, receivedAt: span },
          _count: { _all: true },
          orderBy: { receivedById: "asc" },
        }),
      ]);
      for (const group of staffGroups) staffNameIds.add(group.receivedById);
      return {
        warehouse,
        received,
        transfersDispatched,
        packagesDispatched,
        transfersArrived,
        delivered,
        failedAttempts,
        currentInventory,
        aging: {
          days0to2: aging0to2,
          days3to7: aging3to7,
          days8to14: aging8to14,
          over14: agingOver14,
        },
        damagedInStock,
        receivingDiscrepancies,
        returnsRequested,
        incidentsCreated,
        staffGroups,
      };
    });

  const staffNames = new Map<string, string>();
  if (staffNameIds.size > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: [...staffNameIds] } },
      select: { id: true, fullName: true },
    });
    for (const user of users) staffNames.set(user.id, user.fullName);
  }

  return {
    range: rangeEcho(range),
    generatedAt: new Date().toISOString(),
    rows: rows.map((row) => ({
      warehouseId: row.warehouse.id,
      code: row.warehouse.code,
      name: row.warehouse.name,
      received: row.received,
      transfersDispatched: row.transfersDispatched,
      packagesDispatched: row.packagesDispatched,
      transfersArrived: row.transfersArrived,
      delivered: row.delivered,
      failedAttempts: row.failedAttempts,
      currentInventory: row.currentInventory,
      capacityPackages: row.warehouse.capacityPackages,
      capacityUtilisationPercent:
        row.warehouse.capacityPackages && row.warehouse.capacityPackages > 0
          ? percent(row.currentInventory, row.warehouse.capacityPackages)
          : null,
      aging: row.aging,
      damagedInStock: row.damagedInStock,
      receivingDiscrepancies: row.receivingDiscrepancies,
      returnsRequested: row.returnsRequested,
      incidentsCreated: row.incidentsCreated,
      staffReceiving: row.staffGroups.map((g) => ({
        userId: g.receivedById,
        fullName: staffNames.get(g.receivedById) ?? "Unknown user",
        received: g._count._all,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Driver reports (Part 18.3)
// ---------------------------------------------------------------------------

export interface DriverReportRow {
  driverId: string;
  fullName: string;
  homeWarehouseId: string;
  assigned: number;
  completed: number;
  failed: number;
  attempts: number;
  failedAttempts: number;
  delivered: number;
  lateDeliveries: number;
  onTimePercent: number | null;
  avgDeliveryMinutes: number | null;
  pickupAssigned: number;
  pickupCompleted: number;
  pickupCompletionPercent: number | null;
  codExpectedPaisa: string;
  codCollectedPaisa: string;
  codRemittedVerifiedPaisa: string;
  codOutstandingPaisa: string;
  returnsCreated: number;
  trips: number;
  tripsCompleted: number;
}

export interface DriverReport {
  range: { from: string; to: string; timeZone: string };
  generatedAt: string;
  rows: DriverReportRow[];
}

const VERIFIED_REMITTANCE_WHERE: Prisma.CodRemittanceWhereInput = {
  OR: [
    { status: "VERIFIED" },
    { status: "CLOSED", resolution: "ACCEPTED_COUNTED" },
  ],
};

async function buildDriverRows(
  range: ReportRange,
  drivers: { id: string; userId: string; homeWarehouseId: string }[],
): Promise<DriverReportRow[]> {
  const span = inRange(range);
  const driverIds = drivers.map((d) => d.id);
  if (driverIds.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { id: { in: drivers.map((d) => d.userId) } },
    select: { id: true, fullName: true },
  });
  const nameByUser = new Map(users.map((u) => [u.id, u.fullName]));

  // One grouped SQL pass for delivered / late / average rider time
  // (assignment start → proof of delivery) across all drivers.
  const perfRows = await prisma.$queryRaw<
    {
      driver_id: string;
      delivered: number;
      with_expected: number;
      late: number;
      avg_minutes: number | null;
    }[]
  >`
    SELECT a."driverId" AS driver_id,
           count(*)::int AS delivered,
           count(*) FILTER (WHERE s."expectedDeliveryAt" IS NOT NULL)::int AS with_expected,
           count(*) FILTER (
             WHERE s."expectedDeliveryAt" IS NOT NULL AND pod."deliveredAt" > s."expectedDeliveryAt"
           )::int AS late,
           (AVG(EXTRACT(EPOCH FROM (pod."deliveredAt" - COALESCE(a."startedAt", a."assignedAt")))) / 60.0)::float8 AS avg_minutes
    FROM "app"."ProofOfDelivery" pod
    JOIN "app"."DeliveryAssignment" a ON a."id" = pod."assignmentId"
    JOIN "app"."Package" p ON p."id" = pod."packageId"
    JOIN "app"."Shipment" s ON s."id" = p."shipmentId"
    WHERE pod."supersededById" IS NULL
      AND pod."deliveredAt" >= ${range.fromUtc}
      AND pod."deliveredAt" < ${range.toUtc}
      AND a."driverId" IN (${Prisma.join(driverIds)})
    GROUP BY a."driverId"
  `;
  const perfByDriver = new Map(perfRows.map((r) => [r.driver_id, r]));

  return mapInBatches(drivers, 2, async (driver) => {
      const [
        deliveryGroups,
        pickupGroups,
        attempts,
        failedAttempts,
        codAgg,
        verifiedAgg,
        returnsCreated,
        tripGroups,
      ] = await Promise.all([
        prisma.deliveryAssignment.groupBy({
          by: ["status"],
          where: { driverId: driver.id, kind: "DELIVERY", assignedAt: span },
          _count: { _all: true },
        }),
        prisma.deliveryAssignment.groupBy({
          by: ["status"],
          where: { driverId: driver.id, kind: "PICKUP", assignedAt: span },
          _count: { _all: true },
        }),
        prisma.deliveryAttempt.count({
          where: { assignment: { driverId: driver.id }, attemptedAt: span },
        }),
        prisma.deliveryAttempt.count({
          where: {
            assignment: { driverId: driver.id },
            attemptedAt: span,
            result: { not: "DELIVERED" },
          },
        }),
        prisma.deliveryCodCollection.aggregate({
          where: { collectedById: driver.userId, collectedAt: span },
          _sum: { expectedPaisa: true, collectedPaisa: true },
        }),
        prisma.codRemittanceLine.aggregate({
          where: {
            remittance: VERIFIED_REMITTANCE_WHERE,
            codCollection: { collectedById: driver.userId, collectedAt: span },
          },
          _sum: { verifiedPaisa: true },
        }),
        prisma.returnRequest.count({
          where: {
            createdAt: span,
            package: {
              deliveryAssignments: {
                some: { driverId: driver.id, status: "COMPLETED" },
              },
            },
          },
        }),
        prisma.trip.groupBy({
          by: ["status"],
          where: { driverId: driver.id, createdAt: span },
          _count: { _all: true },
        }),
      ]);
      const sumStatus = (
        groups: { status: string; _count: { _all: number } }[],
        status: string,
      ) => groups.find((g) => g.status === status)?._count._all ?? 0;
      const sumAll = (groups: { _count: { _all: number } }[]) =>
        groups.reduce((sum, g) => sum + g._count._all, 0);

      const assigned = sumAll(deliveryGroups);
      const completed = sumStatus(deliveryGroups, "COMPLETED");
      const failed = sumStatus(deliveryGroups, "FAILED");
      const pickupAssigned = sumAll(pickupGroups);
      const pickupCompleted = sumStatus(pickupGroups, "COMPLETED");
      const perf = perfByDriver.get(driver.id);
      const collected = codAgg._sum.collectedPaisa ?? BigInt(0);
      const verified = verifiedAgg._sum.verifiedPaisa ?? BigInt(0);

      return {
        driverId: driver.id,
        fullName: nameByUser.get(driver.userId) ?? "Unknown driver",
        homeWarehouseId: driver.homeWarehouseId,
        assigned,
        completed,
        failed,
        attempts,
        failedAttempts,
        delivered: perf?.delivered ?? 0,
        lateDeliveries: perf?.late ?? 0,
        onTimePercent: perf
          ? percent(perf.with_expected - perf.late, perf.with_expected)
          : null,
        avgDeliveryMinutes:
          perf?.avg_minutes === null || perf?.avg_minutes === undefined
            ? null
            : Math.round(perf.avg_minutes * 10) / 10,
        pickupAssigned,
        pickupCompleted,
        pickupCompletionPercent: percent(pickupCompleted, pickupAssigned),
        codExpectedPaisa: bigintToString(codAgg._sum.expectedPaisa),
        codCollectedPaisa: collected.toString(),
        codRemittedVerifiedPaisa: verified.toString(),
        codOutstandingPaisa: (collected - verified).toString(),
        returnsCreated,
        trips: sumAll(tripGroups),
        tripsCompleted: sumStatus(tripGroups, "COMPLETED"),
      };
    });
}

export async function getDriverReport(
  actor: ActorContext,
  input: unknown,
): Promise<DriverReport> {
  const filters = parseFilters(input);
  const range = parseRange(filters);
  // Finance-only readers are denied operational reports outright
  // (footnote 32) — before any branch can treat their report.read_all
  // as a pass.
  if (isFinanceOnlyReader(actor) && !hasPermission(actor, "report.read_warehouse")) {
    await requireOperationalReportAll(actor, "Driver");
  }

  let drivers: { id: string; userId: string; homeWarehouseId: string }[];
  if (hasPermission(actor, "report.read_all") && !isFinanceOnlyReader(actor)) {
    drivers = await prisma.driver.findMany({
      where: {
        AND: [
          ...(filters.driverId ? [{ id: filters.driverId }] : []),
          ...(filters.warehouseId ? [{ homeWarehouseId: filters.warehouseId }] : []),
        ],
      },
      select: { id: true, userId: true, homeWarehouseId: true },
      orderBy: { createdAt: "asc" },
    });
  } else if (hasPermission(actor, "report.read_warehouse")) {
    if (filters.warehouseId && !actor.warehouseIds.includes(filters.warehouseId)) {
      await auditAccessDenied(actor, "Driver", {
        warehouseId: filters.warehouseId,
        reason: "warehouse_scope_other_warehouse_report",
      });
      throw new AuthorizationError("Driver reports cover only your own warehouses");
    }
    const homeIds = filters.warehouseId ? [filters.warehouseId] : actor.warehouseIds;
    drivers = await prisma.driver.findMany({
      where: {
        AND: [
          { homeWarehouseId: { in: homeIds } },
          ...(filters.driverId ? [{ id: filters.driverId }] : []),
        ],
      },
      select: { id: true, userId: true, homeWarehouseId: true },
      orderBy: { createdAt: "asc" },
    });
  } else {
    await requirePermAudited(actor, "report.read_all", "Driver");
    drivers = []; // unreachable
  }

  return {
    range: rangeEcho(range),
    generatedAt: new Date().toISOString(),
    rows: await buildDriverRows(range, drivers),
  };
}

/** A driver's own performance report (report.read_self). The driver
 *  id is taken from the actor — a filter naming another driver is an
 *  audited denial. */
export async function getDriverSelfReport(
  actor: ActorContext,
  input: unknown,
): Promise<DriverReport> {
  await requirePermAudited(actor, "report.read_self", "Driver");
  const filters = parseFilters(input);
  const range = parseRange(filters);
  if (!actor.driverId) {
    throw new NotFoundError("No driver profile is linked to your account");
  }
  if (filters.driverId && filters.driverId !== actor.driverId) {
    await auditAccessDenied(actor, "Driver", {
      entityId: filters.driverId,
      reason: "driver_self_report_other_driver",
    });
    throw new AuthorizationError("You can only read your own performance report");
  }
  const driver = await prisma.driver.findUnique({
    where: { id: actor.driverId },
    select: { id: true, userId: true, homeWarehouseId: true },
  });
  if (!driver) throw new NotFoundError("Driver profile not found");
  return {
    range: rangeEcho(range),
    generatedAt: new Date().toISOString(),
    rows: await buildDriverRows(range, [driver]),
  };
}

// ---------------------------------------------------------------------------
// Vendor reports (Part 18.4)
// ---------------------------------------------------------------------------

export interface VendorReportRow {
  vendorId: string;
  businessName: string;
  bookings: number;
  packages: number;
  delivered: number;
  returnsCreated: number;
  returnsCompleted: number;
  deliverySuccessPercent: number | null;
  returnRatePercent: number | null;
  chargesInvoicedPaisa: string;
  invoicesIssued: number;
  outstandingPaisa: string;
  codExpectedPaisa: string;
  codCollectedPaisa: string;
  codSettledPaisa: string;
  settlementsPaid: number;
  settlementsPaidPaisa: string;
  payableBalancePaisa: string;
}

export interface VendorReport {
  range: { from: string; to: string; timeZone: string };
  generatedAt: string;
  rows: VendorReportRow[];
}

export async function getVendorReport(
  actor: ActorContext,
  input: unknown,
): Promise<VendorReport> {
  const filters = parseFilters(input);
  const range = parseRange(filters);
  const span = inRange(range);

  let vendorIds: string[];
  if (actor.vendorId) {
    await requirePermAudited(actor, "report.read_vendor", "Vendor");
    const own = await resolveVendorScope(actor, filters.vendorId, "Vendor");
    vendorIds = own ? [own] : [];
  } else {
    await requireOperationalReportAll(actor, "Vendor");
    if (filters.vendorId) {
      vendorIds = [filters.vendorId];
    } else {
      const all = await prisma.vendor.findMany({ select: { id: true } });
      vendorIds = all.map((v) => v.id);
    }
  }

  const vendors = await prisma.vendor.findMany({
    where: { id: { in: vendorIds } },
    select: { id: true, businessName: true },
    orderBy: { businessName: "asc" },
  });

  const rows = await mapInBatches(vendors, 2, async (vendor) => {
      const v = vendor.id;
      const [
        bookings,
        packages,
        delivered,
        returnsCreated,
        returnsCompleted,
        invoicedAgg,
        openInvoices,
        codAgg,
        settledCodAgg,
        settlementsAgg,
      ] = await Promise.all([
        prisma.order.count({ where: { vendorId: v, createdAt: span } }),
        prisma.package.count({
          where: { order: { vendorId: v }, createdAt: span },
        }),
        prisma.proofOfDelivery.count({
          where: {
            deliveredAt: span,
            supersededById: null,
            package: { order: { vendorId: v } },
          },
        }),
        prisma.returnRequest.count({
          where: { order: { vendorId: v }, createdAt: span },
        }),
        prisma.returnRequest.count({
          where: { order: { vendorId: v }, status: "COMPLETED", completedAt: span },
        }),
        prisma.invoice.aggregate({
          where: { vendorId: v, issuedAt: span, status: { not: "CANCELLED" } },
          _sum: { totalPaisa: true },
          _count: { _all: true },
        }),
        prisma.invoice.findMany({
          where: { vendorId: v, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
          select: { id: true, totalPaisa: true },
        }),
        prisma.deliveryCodCollection.aggregate({
          where: { shipment: { order: { vendorId: v } }, collectedAt: span },
          _sum: { expectedPaisa: true, collectedPaisa: true },
        }),
        prisma.vendorSettlementLine.aggregate({
          where: {
            kind: "COD_CREDIT",
            settlement: { vendorId: v, status: "SETTLED", settledAt: span },
          },
          _sum: { amountPaisa: true },
        }),
        prisma.vendorSettlement.aggregate({
          where: { vendorId: v, status: "SETTLED", settledAt: span },
          _sum: { netPayablePaisa: true },
          _count: { _all: true },
        }),
      ]);

      let outstanding = BigInt(0);
      for (const invoice of openInvoices) {
        const paid = await invoicePaidComponents(prisma, invoice.id);
        const due = invoice.totalPaisa - paid.totalPaidPaisa;
        if (due > BigInt(0)) outstanding += due;
      }

      const account = await prisma.financialAccount.findUnique({
        where: { code: `VENDOR_PAYABLE:${v}` },
        select: { id: true, kind: true },
      });
      const payableBalance = account
        ? await accountBalancePaisa(prisma, account.id, account.kind)
        : BigInt(0);

      return {
        vendorId: v,
        businessName: vendor.businessName,
        bookings,
        packages,
        delivered,
        returnsCreated,
        returnsCompleted,
        deliverySuccessPercent: percent(delivered, delivered + returnsCompleted),
        returnRatePercent: percent(returnsCreated, bookings),
        chargesInvoicedPaisa: bigintToString(invoicedAgg._sum.totalPaisa),
        invoicesIssued: invoicedAgg._count._all,
        outstandingPaisa: outstanding.toString(),
        codExpectedPaisa: bigintToString(codAgg._sum.expectedPaisa),
        codCollectedPaisa: bigintToString(codAgg._sum.collectedPaisa),
        codSettledPaisa: bigintToString(settledCodAgg._sum.amountPaisa),
        settlementsPaid: settlementsAgg._count._all,
        settlementsPaidPaisa: bigintToString(settlementsAgg._sum.netPayablePaisa),
        payableBalancePaisa: payableBalance.toString(),
      };
    });

  return { range: rangeEcho(range), generatedAt: new Date().toISOString(), rows };
}

// ---------------------------------------------------------------------------
// Transfer / line-haul summary (Part 18.1 transfer performance)
// ---------------------------------------------------------------------------

export interface TransferReportRow {
  originWarehouseId: string;
  originCode: string;
  destinationWarehouseId: string;
  destinationCode: string;
  transfers: number;
  byStatus: { status: string; count: number }[];
  items: number;
  itemsReceived: number;
  itemsDiscrepant: number;
  avgTransitMinutes: number | null;
}

export interface TransferReport {
  range: { from: string; to: string; timeZone: string };
  generatedAt: string;
  rows: TransferReportRow[];
}

export async function getTransferReport(
  actor: ActorContext,
  input: unknown,
): Promise<TransferReport> {
  const filters = parseFilters(input);
  const range = parseRange(filters);
  const scopeIds = await resolveWarehouseScope(actor, filters.warehouseId, "Transfer");

  const conditions: Prisma.Sql[] = [
    Prisma.sql`t."createdAt" >= ${range.fromUtc}`,
    Prisma.sql`t."createdAt" < ${range.toUtc}`,
  ];
  if (scopeIds) {
    // Scope predicate: the transfer touches one of the actor's
    // warehouses on either leg — composed inside the query under AND
    // with the range (never a post-filter). A membership-less scoped
    // actor matches nothing: Prisma.join throws on an empty list, so
    // the empty scope is a FALSE condition instead — the same empty
    // report the other scoped reports return (Phase 9 review P9-R5).
    conditions.push(
      scopeIds.length === 0
        ? Prisma.sql`FALSE`
        : Prisma.sql`(t."originWarehouseId" IN (${Prisma.join(scopeIds)}) OR t."destinationWarehouseId" IN (${Prisma.join(scopeIds)}))`,
    );
  }
  const routeRows = await prisma.$queryRaw<
    {
      origin: string;
      destination: string;
      transfers: number;
      items: number;
      items_received: number;
      items_discrepant: number;
      avg_transit_minutes: number | null;
    }[]
  >`
    SELECT t."originWarehouseId" AS origin,
           t."destinationWarehouseId" AS destination,
           count(DISTINCT t."id")::int AS transfers,
           count(ti."id")::int AS items,
           count(ti."id") FILTER (WHERE ti."itemStatus" = 'RECEIVED')::int AS items_received,
           count(ti."id") FILTER (WHERE ti."itemStatus" IN ('MISSING', 'DAMAGED'))::int AS items_discrepant,
           (AVG(EXTRACT(EPOCH FROM (t."arrivedAt" - t."dispatchedAt")))
             FILTER (WHERE t."arrivedAt" IS NOT NULL AND t."dispatchedAt" IS NOT NULL) / 60.0)::float8 AS avg_transit_minutes
    FROM "app"."Transfer" t
    LEFT JOIN "app"."TransferItem" ti ON ti."transferId" = t."id"
    WHERE ${Prisma.join(conditions, " AND ")}
    GROUP BY t."originWarehouseId", t."destinationWarehouseId"
    ORDER BY t."originWarehouseId", t."destinationWarehouseId"
  `;

  const statusWhere: Prisma.TransferWhereInput = {
    AND: [
      { createdAt: inRange(range) },
      ...(scopeIds
        ? [
            {
              OR: [
                { originWarehouseId: { in: scopeIds } },
                { destinationWarehouseId: { in: scopeIds } },
              ],
            },
          ]
        : []),
    ],
  };
  const statusGroups = await prisma.transfer.groupBy({
    by: ["originWarehouseId", "destinationWarehouseId", "status"],
    where: statusWhere,
    _count: { _all: true },
  });
  const statusByRoute = new Map<string, { status: string; count: number }[]>();
  for (const group of statusGroups) {
    const key = `${group.originWarehouseId}→${group.destinationWarehouseId}`;
    const list = statusByRoute.get(key) ?? [];
    list.push({ status: group.status, count: group._count._all });
    statusByRoute.set(key, list);
  }

  const names = await warehouseNames([
    ...new Set(routeRows.flatMap((r) => [r.origin, r.destination])),
  ]);

  return {
    range: rangeEcho(range),
    generatedAt: new Date().toISOString(),
    rows: routeRows.map((row) => ({
      originWarehouseId: row.origin,
      originCode: names.get(row.origin)?.code ?? row.origin,
      destinationWarehouseId: row.destination,
      destinationCode: names.get(row.destination)?.code ?? row.destination,
      transfers: row.transfers,
      byStatus: statusByRoute.get(`${row.origin}→${row.destination}`) ?? [],
      items: row.items,
      itemsReceived: row.items_received,
      itemsDiscrepant: row.items_discrepant,
      avgTransitMinutes:
        row.avg_transit_minutes === null
          ? null
          : Math.round(row.avg_transit_minutes * 10) / 10,
    })),
  };
}
