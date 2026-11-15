import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { AuthorizationError, type ActorContext } from "@/lib/auth/actor";
import { DomainValidationError } from "@/lib/errors";
import { bigintToString, resolveReportRange, type ReportRange } from "@/lib/reports/domain";
import { invoicePaidComponents } from "@/server/services/invoices";
import {
  auditAccessDenied,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import { reportFiltersSchema, type ReportFilters } from "@/server/services/reports";

/**
 * Financial reporting (Phase 9): the finance report (api-reference
 * §16, permission finance.read) and the detailed COD report.
 *
 * Every figure derives from the Phase 7 records — invoices and their
 * paid components (the same invoicePaidComponents derivation the
 * finance dashboard uses), payments, remittances and their lines,
 * settlements, refunds, adjustments and the ledger itself. COD is a
 * liability until settled, never revenue (rule F0): it appears here
 * as expected / collected / remitted / outstanding, reconciling to
 * the paisa by construction:
 *
 *   expected − collected            = Σ (expected − collected) per collection
 *   collected − verifiedRemitted    = outstanding with riders
 *   outstanding                     = awaitingRemittance + inOpenRemittance
 *
 * COD scoping mirrors the Phase 7 F2 law (cod-remittances.ts):
 * FINANCE / ADMIN / SUPER_ADMIN read company-wide; a vendor reads
 * only collections on their own shipments; a rider reads only their
 * own collections; a warehouse-scoped reader reads only collections
 * delivered from their warehouses (batch attribution) and riders
 * homed there.
 */

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
// Finance report (GET /api/reports/finance)
// ---------------------------------------------------------------------------

export interface FinanceReport {
  range: { from: string; to: string; timeZone: string };
  generatedAt: string;
  invoiced: {
    count: number;
    totalPaisa: string;
    byStatus: { status: string; count: number; totalPaisa: string }[];
  };
  paymentsReceived: {
    count: number;
    totalPaisa: string;
    byMethod: { method: string; count: number; totalPaisa: string }[];
  };
  ledgerShippingRevenuePaisa: string;
  outstanding: {
    openInvoices: number;
    outstandingPaisa: string;
    ageing: {
      notDuePaisa: string;
      overdue1to30Paisa: string;
      overdue31to60Paisa: string;
      overdue61to90Paisa: string;
      overdueOver90Paisa: string;
    };
  };
  settlements: {
    byStatus: { status: string; count: number; netPayablePaisa: string }[];
    paidOut: { count: number; netPayablePaisa: string };
  };
  refunds: { processedCount: number; processedPaisa: string; requestedOpen: number };
  adjustments: { appliedCount: number; appliedPaisa: string; requestedOpen: number };
  codReconciliation: {
    expectedPaisa: string;
    collectedPaisa: string;
    mismatchCollections: number;
    remittancesByStatus: {
      status: string;
      count: number;
      declaredPaisa: string;
      countedPaisa: string;
    }[];
    openDiscrepancies: { count: number; discrepancyPaisa: string };
  };
}

export async function getFinanceReport(
  actor: ActorContext,
  input: unknown,
): Promise<FinanceReport> {
  await requirePermAudited(actor, "finance.read", "Report");
  const filters = parseFilters(input);
  const range = parseRange(filters);
  const span = inRange(range);
  const vendorScope = filters.vendorId ? { vendorId: filters.vendorId } : {};

  const [
    invoicedGroups,
    paymentGroups,
    refundsAgg,
    refundsRequested,
    adjustmentsAgg,
    adjustmentsRequested,
    settlementGroups,
    settlementsPaidAgg,
    codAgg,
    codMismatch,
    remittanceGroups,
    openInvoices,
    discrepancyRows,
  ] = await Promise.all([
    prisma.invoice.groupBy({
      by: ["status"],
      where: { issuedAt: span, ...vendorScope },
      _sum: { totalPaisa: true },
      _count: { _all: true },
      orderBy: { status: "asc" },
    }),
    prisma.payment.groupBy({
      by: ["method"],
      where: {
        AND: [
          { createdAt: span },
          { status: "PAID" },
          ...(filters.vendorId ? [{ payerVendorId: filters.vendorId }] : []),
        ],
      },
      _sum: { amountPaisa: true },
      _count: { _all: true },
      orderBy: { method: "asc" },
    }),
    prisma.refund.aggregate({
      where: {
        AND: [
          { status: "PROCESSED" },
          { processedAt: span },
          ...(filters.vendorId
            ? [{ payment: { payerVendorId: filters.vendorId } }]
            : []),
        ],
      },
      _sum: { amountPaisa: true },
      _count: { _all: true },
    }),
    prisma.refund.count({
      where: {
        AND: [
          { status: "REQUESTED" },
          ...(filters.vendorId
            ? [{ payment: { payerVendorId: filters.vendorId } }]
            : []),
        ],
      },
    }),
    prisma.financialAdjustment.aggregate({
      where: { status: "APPLIED", appliedAt: span },
      _sum: { amountPaisa: true },
      _count: { _all: true },
    }),
    prisma.financialAdjustment.count({ where: { status: "REQUESTED" } }),
    prisma.vendorSettlement.groupBy({
      by: ["status"],
      where: { createdAt: span, ...vendorScope },
      _sum: { netPayablePaisa: true },
      _count: { _all: true },
      orderBy: { status: "asc" },
    }),
    prisma.vendorSettlement.aggregate({
      where: { status: "SETTLED", settledAt: span, ...vendorScope },
      _sum: { netPayablePaisa: true },
      _count: { _all: true },
    }),
    prisma.deliveryCodCollection.aggregate({
      where: {
        AND: [
          { collectedAt: span },
          ...(filters.vendorId
            ? [{ shipment: { order: { vendorId: filters.vendorId } } }]
            : []),
        ],
      },
      _sum: { expectedPaisa: true, collectedPaisa: true },
    }),
    prisma.deliveryCodCollection.count({
      where: {
        AND: [
          { collectedAt: span },
          { status: "MISMATCH" },
          ...(filters.vendorId
            ? [{ shipment: { order: { vendorId: filters.vendorId } } }]
            : []),
        ],
      },
    }),
    prisma.codRemittance.groupBy({
      by: ["status"],
      where: { submittedAt: span },
      _sum: { declaredAmountPaisa: true, countedAmountPaisa: true },
      _count: { _all: true },
      orderBy: { status: "asc" },
    }),
    prisma.invoice.findMany({
      where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] }, ...vendorScope },
      select: { id: true, totalPaisa: true, dueAt: true },
    }),
    prisma.codRemittance.findMany({
      where: { status: "DISCREPANCY" },
      select: { discrepancyPaisa: true },
    }),
  ]);

  // Ledger shipping revenue for the period: credits − debits on the
  // SHIPPING_REVENUE account, straight from the append-only ledger.
  const revenueAccount = await prisma.financialAccount.findUnique({
    where: { code: "SHIPPING_REVENUE" },
    select: { id: true },
  });
  let ledgerRevenue = BigInt(0);
  if (revenueAccount) {
    const ledgerGroups = await prisma.ledgerTransaction.groupBy({
      by: ["direction"],
      where: { accountId: revenueAccount.id, createdAt: span },
      _sum: { amountPaisa: true },
    });
    for (const group of ledgerGroups) {
      const amount = group._sum.amountPaisa ?? BigInt(0);
      ledgerRevenue += group.direction === "CREDIT" ? amount : -amount;
    }
  }

  // Outstanding + ageing (snapshot): outstanding per invoice is the
  // Phase 7 derivation; the bucket is set by its due date against now.
  const now = new Date();
  const DAY = 24 * 60 * 60 * 1000;
  let outstandingTotal = BigInt(0);
  const ageing = {
    notDue: BigInt(0),
    d1to30: BigInt(0),
    d31to60: BigInt(0),
    d61to90: BigInt(0),
    over90: BigInt(0),
  };
  for (const invoice of openInvoices) {
    const paid = await invoicePaidComponents(prisma, invoice.id);
    const due = invoice.totalPaisa - paid.totalPaidPaisa;
    if (due <= BigInt(0)) continue;
    outstandingTotal += due;
    if (!invoice.dueAt || invoice.dueAt >= now) ageing.notDue += due;
    else {
      const days = Math.floor((now.getTime() - invoice.dueAt.getTime()) / DAY);
      if (days <= 30) ageing.d1to30 += due;
      else if (days <= 60) ageing.d31to60 += due;
      else if (days <= 90) ageing.d61to90 += due;
      else ageing.over90 += due;
    }
  }

  let openDiscrepancyTotal = BigInt(0);
  for (const row of discrepancyRows) {
    const value = row.discrepancyPaisa ?? BigInt(0);
    openDiscrepancyTotal += value < BigInt(0) ? -value : value;
  }

  const invoicedTotal = invoicedGroups.reduce(
    (sum, g) => sum + (g._sum.totalPaisa ?? BigInt(0)),
    BigInt(0),
  );
  const invoicedCount = invoicedGroups.reduce((sum, g) => sum + g._count._all, 0);
  const paymentsTotal = paymentGroups.reduce(
    (sum, g) => sum + (g._sum.amountPaisa ?? BigInt(0)),
    BigInt(0),
  );
  const paymentsCount = paymentGroups.reduce((sum, g) => sum + g._count._all, 0);

  return {
    range: rangeEcho(range),
    generatedAt: new Date().toISOString(),
    invoiced: {
      count: invoicedCount,
      totalPaisa: invoicedTotal.toString(),
      byStatus: invoicedGroups.map((g) => ({
        status: g.status,
        count: g._count._all,
        totalPaisa: bigintToString(g._sum.totalPaisa),
      })),
    },
    paymentsReceived: {
      count: paymentsCount,
      totalPaisa: paymentsTotal.toString(),
      byMethod: paymentGroups.map((g) => ({
        method: g.method,
        count: g._count._all,
        totalPaisa: bigintToString(g._sum.amountPaisa),
      })),
    },
    ledgerShippingRevenuePaisa: ledgerRevenue.toString(),
    outstanding: {
      openInvoices: openInvoices.length,
      outstandingPaisa: outstandingTotal.toString(),
      ageing: {
        notDuePaisa: ageing.notDue.toString(),
        overdue1to30Paisa: ageing.d1to30.toString(),
        overdue31to60Paisa: ageing.d31to60.toString(),
        overdue61to90Paisa: ageing.d61to90.toString(),
        overdueOver90Paisa: ageing.over90.toString(),
      },
    },
    settlements: {
      byStatus: settlementGroups.map((g) => ({
        status: g.status,
        count: g._count._all,
        netPayablePaisa: bigintToString(g._sum.netPayablePaisa),
      })),
      paidOut: {
        count: settlementsPaidAgg._count._all,
        netPayablePaisa: bigintToString(settlementsPaidAgg._sum.netPayablePaisa),
      },
    },
    refunds: {
      processedCount: refundsAgg._count._all,
      processedPaisa: bigintToString(refundsAgg._sum.amountPaisa),
      requestedOpen: refundsRequested,
    },
    adjustments: {
      appliedCount: adjustmentsAgg._count._all,
      appliedPaisa: bigintToString(adjustmentsAgg._sum.amountPaisa),
      requestedOpen: adjustmentsRequested,
    },
    codReconciliation: {
      expectedPaisa: bigintToString(codAgg._sum.expectedPaisa),
      collectedPaisa: bigintToString(codAgg._sum.collectedPaisa),
      mismatchCollections: codMismatch,
      remittancesByStatus: remittanceGroups.map((g) => ({
        status: g.status,
        count: g._count._all,
        declaredPaisa: bigintToString(g._sum.declaredAmountPaisa),
        countedPaisa: bigintToString(g._sum.countedAmountPaisa),
      })),
      openDiscrepancies: {
        count: discrepancyRows.length,
        discrepancyPaisa: openDiscrepancyTotal.toString(),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// COD report (detailed — per rider and per warehouse)
// ---------------------------------------------------------------------------

export interface CodReportRow {
  key: string;
  label: string;
  collections: number;
  expectedPaisa: string;
  collectedPaisa: string;
  differencePaisa: string;
  mismatchCollections: number;
  remittedVerifiedPaisa: string;
  awaitingRemittancePaisa: string;
  inOpenRemittancePaisa: string;
  outstandingPaisa: string;
}

export interface CodReport {
  range: { from: string; to: string; timeZone: string };
  generatedAt: string;
  totals: CodReportRow;
  riders: CodReportRow[];
  warehouses: CodReportRow[];
}

const GLOBAL_COD_ROLES: readonly string[] = ["FINANCE", "ADMIN", "SUPER_ADMIN"];

interface CodAccumulator {
  collections: number;
  expected: bigint;
  collected: bigint;
  difference: bigint;
  mismatches: number;
  verified: bigint;
  awaiting: bigint;
  inOpen: bigint;
}

function newAccumulator(): CodAccumulator {
  return {
    collections: 0,
    expected: BigInt(0),
    collected: BigInt(0),
    difference: BigInt(0),
    mismatches: 0,
    verified: BigInt(0),
    awaiting: BigInt(0),
    inOpen: BigInt(0),
  };
}

function toRow(key: string, label: string, acc: CodAccumulator): CodReportRow {
  return {
    key,
    label,
    collections: acc.collections,
    expectedPaisa: acc.expected.toString(),
    collectedPaisa: acc.collected.toString(),
    differencePaisa: acc.difference.toString(),
    mismatchCollections: acc.mismatches,
    remittedVerifiedPaisa: acc.verified.toString(),
    awaitingRemittancePaisa: acc.awaiting.toString(),
    inOpenRemittancePaisa: acc.inOpen.toString(),
    outstandingPaisa: (acc.collected - acc.verified).toString(),
  };
}

export async function getCodReport(
  actor: ActorContext,
  input: unknown,
): Promise<CodReport> {
  await requirePermAudited(actor, "cod.read", "DeliveryCodCollection");
  const filters = parseFilters(input);
  const range = parseRange(filters);
  const span = inRange(range);

  const isGlobal = actor.roles.some((role) => GLOBAL_COD_ROLES.includes(role));
  const where: Prisma.DeliveryCodCollectionWhereInput = { AND: [{ collectedAt: span }] };
  const and = where.AND as Prisma.DeliveryCodCollectionWhereInput[];

  if (actor.vendorId) {
    // Vendor scope (F2): collections on their own shipments only.
    if (filters.vendorId && filters.vendorId !== actor.vendorId) {
      await auditAccessDenied(actor, "DeliveryCodCollection", {
        entityId: filters.vendorId,
        reason: "vendor_scope_other_vendor_cod_report",
      });
      throw new AuthorizationError("Vendors can only read their own COD report");
    }
    and.push({ shipment: { order: { vendorId: actor.vendorId } } });
  } else if (filters.vendorId) {
    and.push({ shipment: { order: { vendorId: filters.vendorId } } });
  }

  if (actor.driverId) {
    // Rider scope: own collections only.
    if (filters.driverId && filters.driverId !== actor.driverId) {
      await auditAccessDenied(actor, "DeliveryCodCollection", {
        entityId: filters.driverId,
        reason: "rider_scope_other_driver_cod_report",
      });
      throw new AuthorizationError("Riders can only read their own COD report");
    }
    and.push({ assignment: { driverId: actor.driverId } });
  } else if (filters.driverId) {
    and.push({ assignment: { driverId: filters.driverId } });
  }

  let warehouseScope: string[] | null = null;
  if (!isGlobal && !actor.vendorId && !actor.driverId) {
    // Warehouse-scoped reader: collections delivered from their own
    // warehouses (batch attribution), per the F2 warehouse law.
    if (filters.warehouseId && !actor.warehouseIds.includes(filters.warehouseId)) {
      await auditAccessDenied(actor, "DeliveryCodCollection", {
        warehouseId: filters.warehouseId,
        reason: "warehouse_scope_other_warehouse_cod_report",
      });
      throw new AuthorizationError("COD reports cover only your own warehouses");
    }
    warehouseScope = filters.warehouseId ? [filters.warehouseId] : [...actor.warehouseIds];
    and.push({ batch: { warehouseId: { in: warehouseScope } } });
  } else if (filters.warehouseId) {
    and.push({ batch: { warehouseId: filters.warehouseId } });
  }

  const collections = await prisma.deliveryCodCollection.findMany({
    where,
    select: {
      expectedPaisa: true,
      collectedPaisa: true,
      status: true,
      collectedById: true,
      assignment: { select: { driverId: true } },
      batch: { select: { warehouseId: true } },
      shipment: { select: { destinationWarehouseId: true } },
      remittanceLines: {
        select: {
          collectedPaisa: true,
          verifiedPaisa: true,
          remittance: { select: { status: true, resolution: true } },
        },
      },
    },
  });

  const totals = newAccumulator();
  const byRider = new Map<string, CodAccumulator>();
  const byWarehouse = new Map<string, CodAccumulator>();

  for (const collection of collections) {
    const line = collection.remittanceLines[0];
    const isVerified =
      line !== undefined &&
      (line.remittance.status === "VERIFIED" ||
        (line.remittance.status === "CLOSED" &&
          line.remittance.resolution === "ACCEPTED_COUNTED"));
    const verified = isVerified ? (line.verifiedPaisa ?? BigInt(0)) : BigInt(0);
    let awaiting = BigInt(0);
    let inOpen = BigInt(0);
    if (!line) {
      awaiting = collection.collectedPaisa;
    } else if (isVerified) {
      const tail = collection.collectedPaisa - verified;
      if (tail > BigInt(0)) inOpen = tail;
    } else if (line.remittance.status !== "CLOSED") {
      inOpen = line.collectedPaisa;
    } else {
      awaiting = collection.collectedPaisa;
    }

    const accumulate = (acc: CodAccumulator) => {
      acc.collections += 1;
      acc.expected += collection.expectedPaisa;
      acc.collected += collection.collectedPaisa;
      acc.difference += collection.expectedPaisa - collection.collectedPaisa;
      if (collection.status === "MISMATCH") acc.mismatches += 1;
      acc.verified += verified;
      acc.awaiting += awaiting;
      acc.inOpen += inOpen;
    };
    accumulate(totals);

    const riderKey = collection.assignment.driverId;
    if (!byRider.has(riderKey)) byRider.set(riderKey, newAccumulator());
    accumulate(byRider.get(riderKey)!);

    const warehouseKey =
      collection.batch?.warehouseId ?? collection.shipment.destinationWarehouseId;
    if (warehouseKey) {
      if (!byWarehouse.has(warehouseKey)) byWarehouse.set(warehouseKey, newAccumulator());
      accumulate(byWarehouse.get(warehouseKey)!);
    }
  }

  // Labels: rider names via their driver profiles, warehouse codes.
  const riderIds = [...byRider.keys()];
  const drivers = riderIds.length
    ? await prisma.driver.findMany({
        where: { id: { in: riderIds } },
        select: { id: true, user: { select: { fullName: true } } },
      })
    : [];
  const driverNames = new Map(drivers.map((d) => [d.id, d.user.fullName]));
  const warehouseIds = [...byWarehouse.keys()];
  const warehouses = warehouseIds.length
    ? await prisma.warehouse.findMany({
        where: { id: { in: warehouseIds } },
        select: { id: true, code: true, name: true },
      })
    : [];
  const warehouseLabels = new Map(
    warehouses.map((w) => [w.id, `${w.code} — ${w.name}`]),
  );

  // A warehouse-scoped reader's per-rider rows cover only riders
  // homed at their warehouses (F2) — the rows are selected from the
  // scoped cohort AND the rider home scope, both server-side.
  let riderRows = [...byRider.entries()];
  if (warehouseScope) {
    const homed = await prisma.driver.findMany({
      where: { id: { in: riderIds }, homeWarehouseId: { in: warehouseScope } },
      select: { id: true },
    });
    const homedIds = new Set(homed.map((d) => d.id));
    riderRows = riderRows.filter(([driverId]) => homedIds.has(driverId));
  }

  return {
    range: rangeEcho(range),
    generatedAt: new Date().toISOString(),
    totals: toRow("total", "All collections in scope", totals),
    riders: riderRows
      .map(([driverId, acc]) =>
        toRow(driverId, driverNames.get(driverId) ?? "Unknown rider", acc),
      )
      .sort((a, b) => a.label.localeCompare(b.label)),
    warehouses: [...byWarehouse.entries()]
      .map(([warehouseId, acc]) =>
        toRow(warehouseId, warehouseLabels.get(warehouseId) ?? warehouseId, acc),
      )
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}
