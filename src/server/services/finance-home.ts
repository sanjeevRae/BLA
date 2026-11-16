import "server-only";

import { prisma } from "@/lib/db/prisma";
import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import {
  addDays,
  kathmanduDayStartUtc,
  kathmanduToday,
  resolveReportRange,
} from "@/lib/reports/domain";
import { requirePermAudited } from "@/server/services/scoping";
import { getFinanceOverview } from "@/server/services/finance-overview";

/**
 * Finance home read (V2 Phase 6, audit-driven rebuild of the finance
 * dashboard). One scoped read behind the universal home pattern:
 * needs-attention → current operations → metrics → recent activity.
 *
 * Every figure is computed from the Phase 7 finance records at read
 * time — the same derivations the reports use. Nothing here writes:
 * finance never touches custody, and settlement approval stays with
 * ADMIN / SUPER_ADMIN by policy, so settlements are surfaced
 * read-only (no approval affordance is exposed to a FINANCE actor).
 *
 * Four-eyes honesty: adjustments and refunds in REQUESTED state
 * carry their creator/requester id and an explicit `awaiting`
 * discriminator. An item the actor created is
 * `AWAITING_ANOTHER_APPROVER` (the actor can never decide their own
 * item — the decision services enforce creator ≠ approver); an item
 * created by someone else is `ACTIONABLE_BY_ACTOR` only when the
 * actor actually holds the deciding permission.
 */

export interface FinanceAttentionAdjustment {
  id: string;
  targetType: string;
  targetId: string;
  amountPaisa: string;
  reason: string;
  createdById: string;
  creatorName: string | null;
  isOwn: boolean;
  awaiting: "AWAITING_ANOTHER_APPROVER" | "ACTIONABLE_BY_ACTOR" | "AWAITING_APPROVER";
  createdAt: string;
}

export interface FinanceAttentionRefund {
  id: string;
  paymentId: string;
  amountPaisa: string;
  reason: string;
  requestedById: string;
  requesterName: string | null;
  isOwn: boolean;
  awaiting: "AWAITING_ANOTHER_APPROVER" | "ACTIONABLE_BY_ACTOR" | "AWAITING_APPROVER";
  createdAt: string;
}

export interface FinanceHome {
  /** Kathmandu calendar day the "today" figures cover. */
  today: string;
  attention: {
    remittancesAwaitingVerification: {
      count: number;
      items: {
        id: string;
        remittanceNumber: string;
        declaredAmountPaisa: string;
        status: string;
        submittedAt: string;
      }[];
    };
    remittancesInDiscrepancy: {
      count: number;
      items: {
        id: string;
        remittanceNumber: string;
        declaredAmountPaisa: string;
        discrepancyPaisa: string | null;
        submittedAt: string;
      }[];
    };
    adjustmentsRequested: { count: number; items: FinanceAttentionAdjustment[] };
    refundsRequested: { count: number; items: FinanceAttentionRefund[] };
    /** Read-only for Finance: approval is ADMIN / SUPER_ADMIN policy. */
    settlementsAwaitingAdminApproval: { count: number; netPayablePaisa: string };
  };
  operationsToday: {
    invoicesIssued: { count: number; totalPaisa: string };
    paymentsReceived: { count: number; totalPaisa: string };
    settlementsPending: { count: number; netPayablePaisa: string };
    settlementsApprovedUnpaid: { count: number; netPayablePaisa: string };
  };
  metrics: {
    /** Ledger SHIPPING_REVENUE (credits − debits), last 30 Kathmandu days. */
    revenueLast30DaysPaisa: string;
    revenueRange: { from: string; to: string };
    outstandingReceivablesPaisa: string;
    openInvoicesCount: number;
    codCollectedPaisa: string;
    codHeldByRidersPaisa: string;
    codRemittedVerifiedPaisa: string;
    vendorPayablePaisa: string;
  };
  recentLedger: {
    id: string;
    reference: string;
    journalRef: string;
    accountCode: string;
    direction: string;
    amountPaisa: string;
    type: string;
    occurredAt: string;
  }[];
  recentPayments: {
    id: string;
    amountPaisa: string;
    method: string;
    status: string;
    createdAt: string;
  }[];
  accounts: { id: string; code: string; kind: string; ownerType: string; balancePaisa: string }[];
}

function awaitingFor(
  isOwn: boolean,
  canDecide: boolean,
): FinanceAttentionAdjustment["awaiting"] {
  if (isOwn) return "AWAITING_ANOTHER_APPROVER";
  return canDecide ? "ACTIONABLE_BY_ACTOR" : "AWAITING_APPROVER";
}

export async function getFinanceHome(actor: ActorContext): Promise<FinanceHome> {
  await requirePermAudited(actor, "finance.read", "FinancialAccount");
  const overview = await getFinanceOverview(actor);

  const today = kathmanduToday();
  const todaySpan = { gte: kathmanduDayStartUtc(today), lt: kathmanduDayStartUtc(addDays(today, 1)) };
  const revenueRange = resolveReportRange(null, null);

  const canDecideAdjustments = hasPermission(actor, "finance.approve_adjustment");
  const canDecideRefunds = hasPermission(actor, "refund.process");

  const [
    remittanceAwaitingRows,
    remittanceDiscrepancyRows,
    adjustmentRows,
    refundRows,
    invoicesTodayAgg,
    paymentsTodayAgg,
    revenueGroups,
    ledgerRows,
    paymentRows,
    collections,
  ] = await Promise.all([
    prisma.codRemittance.findMany({
      where: { status: { in: ["SUBMITTED", "UNDER_VERIFICATION"] } },
      orderBy: { submittedAt: "asc" },
      take: 5,
      select: { id: true, remittanceNumber: true, declaredAmountPaisa: true, status: true, submittedAt: true },
    }),
    prisma.codRemittance.findMany({
      where: { status: "DISCREPANCY" },
      orderBy: { submittedAt: "asc" },
      take: 5,
      select: {
        id: true,
        remittanceNumber: true,
        declaredAmountPaisa: true,
        discrepancyPaisa: true,
        submittedAt: true,
      },
    }),
    prisma.financialAdjustment.findMany({
      where: { status: "REQUESTED" },
      orderBy: { createdAt: "asc" },
      take: 10,
      include: { createdBy: { select: { fullName: true } } },
    }),
    prisma.refund.findMany({
      where: { status: "REQUESTED" },
      orderBy: { createdAt: "asc" },
      take: 10,
      include: { requestedBy: { select: { fullName: true } } },
    }),
    prisma.invoice.aggregate({
      where: { issuedAt: todaySpan, status: { not: "CANCELLED" } },
      _sum: { totalPaisa: true },
      _count: { _all: true },
    }),
    prisma.payment.aggregate({
      where: { createdAt: todaySpan, status: "PAID" },
      _sum: { amountPaisa: true },
      _count: { _all: true },
    }),
    // Ledger shipping revenue for the period (same derivation as
    // reports-finance): credits − debits on SHIPPING_REVENUE.
    (async () => {
      const account = await prisma.financialAccount.findUnique({
        where: { code: "SHIPPING_REVENUE" },
        select: { id: true },
      });
      if (!account) return [];
      return prisma.ledgerTransaction.groupBy({
        by: ["direction"],
        where: {
          accountId: account.id,
          createdAt: { gte: revenueRange.fromUtc, lt: revenueRange.toUtc },
        },
        _sum: { amountPaisa: true },
      });
    })(),
    prisma.ledgerTransaction.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      include: { account: { select: { code: true } } },
    }),
    prisma.payment.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, amountPaisa: true, method: true, status: true, createdAt: true },
    }),
    // COD position (all-time snapshot, cod-reconciliation §3.5
    // derivation — the same verified-line rule as getCodReport):
    // a collection counts as remitted only when its remittance line
    // is VERIFIED, or CLOSED with resolution ACCEPTED_COUNTED.
    prisma.deliveryCodCollection.findMany({
      select: {
        collectedPaisa: true,
        remittanceLines: {
          select: {
            verifiedPaisa: true,
            remittance: { select: { status: true, resolution: true } },
          },
        },
      },
    }),
  ]);

  let revenue = BigInt(0);
  for (const group of revenueGroups) {
    const amount = group._sum.amountPaisa ?? BigInt(0);
    revenue += group.direction === "CREDIT" ? amount : -amount;
  }

  let codCollected = BigInt(0);
  let codVerified = BigInt(0);
  for (const collection of collections) {
    codCollected += collection.collectedPaisa;
    const line = collection.remittanceLines[0];
    const isVerified =
      line !== undefined &&
      (line.remittance.status === "VERIFIED" ||
        (line.remittance.status === "CLOSED" && line.remittance.resolution === "ACCEPTED_COUNTED"));
    if (isVerified) codVerified += line.verifiedPaisa ?? BigInt(0);
  }

  const vendorPayable =
    BigInt(overview.settlementsPending.netPayablePaisa) +
    BigInt(overview.settlementsApprovedUnpaid.netPayablePaisa);

  return {
    today,
    attention: {
      remittancesAwaitingVerification: {
        count: overview.remittancesAwaitingVerification,
        items: remittanceAwaitingRows.map((row) => ({
          id: row.id,
          remittanceNumber: row.remittanceNumber,
          declaredAmountPaisa: row.declaredAmountPaisa.toString(),
          status: row.status,
          submittedAt: row.submittedAt.toISOString(),
        })),
      },
      remittancesInDiscrepancy: {
        count: overview.remittancesInDiscrepancy,
        items: remittanceDiscrepancyRows.map((row) => ({
          id: row.id,
          remittanceNumber: row.remittanceNumber,
          declaredAmountPaisa: row.declaredAmountPaisa.toString(),
          discrepancyPaisa: row.discrepancyPaisa?.toString() ?? null,
          submittedAt: row.submittedAt.toISOString(),
        })),
      },
      adjustmentsRequested: {
        count: overview.adjustmentsRequested,
        items: adjustmentRows.map((row) => {
          const isOwn = row.createdById === actor.userId;
          return {
            id: row.id,
            targetType: row.targetType,
            targetId: row.targetId,
            amountPaisa: row.amountPaisa.toString(),
            reason: row.reason,
            createdById: row.createdById,
            creatorName: row.createdBy?.fullName ?? null,
            isOwn,
            awaiting: awaitingFor(isOwn, canDecideAdjustments),
            createdAt: row.createdAt.toISOString(),
          };
        }),
      },
      refundsRequested: {
        count: overview.refundsRequested,
        items: refundRows.map((row) => {
          const isOwn = row.requestedById === actor.userId;
          return {
            id: row.id,
            paymentId: row.paymentId,
            amountPaisa: row.amountPaisa.toString(),
            reason: row.reason,
            requestedById: row.requestedById,
            requesterName: row.requestedBy?.fullName ?? null,
            isOwn,
            awaiting: awaitingFor(isOwn, canDecideRefunds),
            createdAt: row.createdAt.toISOString(),
          };
        }),
      },
      settlementsAwaitingAdminApproval: {
        count: overview.settlementsPending.count,
        netPayablePaisa: overview.settlementsPending.netPayablePaisa,
      },
    },
    operationsToday: {
      invoicesIssued: {
        count: invoicesTodayAgg._count._all,
        totalPaisa: (invoicesTodayAgg._sum.totalPaisa ?? BigInt(0)).toString(),
      },
      paymentsReceived: {
        count: paymentsTodayAgg._count._all,
        totalPaisa: (paymentsTodayAgg._sum.amountPaisa ?? BigInt(0)).toString(),
      },
      settlementsPending: overview.settlementsPending,
      settlementsApprovedUnpaid: overview.settlementsApprovedUnpaid,
    },
    metrics: {
      revenueLast30DaysPaisa: revenue.toString(),
      revenueRange: { from: revenueRange.fromDate, to: revenueRange.toDate },
      outstandingReceivablesPaisa: overview.openInvoices.outstandingPaisa,
      openInvoicesCount: overview.openInvoices.count,
      codCollectedPaisa: codCollected.toString(),
      codHeldByRidersPaisa: (codCollected - codVerified).toString(),
      codRemittedVerifiedPaisa: codVerified.toString(),
      vendorPayablePaisa: vendorPayable.toString(),
    },
    recentLedger: ledgerRows.map((row) => ({
      id: row.id,
      reference: row.reference,
      journalRef: row.journalRef,
      accountCode: row.account.code,
      direction: row.direction,
      amountPaisa: row.amountPaisa.toString(),
      type: row.type,
      occurredAt: row.occurredAt.toISOString(),
    })),
    recentPayments: paymentRows.map((row) => ({
      id: row.id,
      amountPaisa: row.amountPaisa.toString(),
      method: row.method,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    })),
    accounts: overview.accounts.map((account) => ({
      id: account.id,
      code: account.code,
      kind: account.kind,
      ownerType: account.ownerType,
      balancePaisa: account.balancePaisa,
    })),
  };
}
