import "server-only";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import type { ActorContext } from "@/lib/auth/actor";
import { pageArgs, pageMeta, requirePermAudited } from "@/server/services/scoping";
import { accountBalancePaisa } from "@/server/services/finance-ledger";
import { invoicePaidComponents } from "@/server/services/invoices";

/**
 * Finance dashboard reads (Phase 7): account balances and the
 * journal view. Every figure is computed from ledger entries and
 * source records at read time — nothing here reads a stored balance
 * or a cached total.
 */

export type AccountBalanceView = {
  id: string;
  code: string;
  name: string;
  kind: string;
  ownerType: string;
  balancePaisa: string;
};

export async function listAccountBalances(actor: ActorContext): Promise<AccountBalanceView[]> {
  await requirePermAudited(actor, "finance.read", "FinancialAccount");
  const accounts = await prisma.financialAccount.findMany({
    where: { isActive: true },
    orderBy: [{ ownerType: "asc" }, { code: "asc" }],
  });
  const views: AccountBalanceView[] = [];
  for (const account of accounts) {
    const balance = await accountBalancePaisa(prisma, account.id, account.kind);
    views.push({
      id: account.id,
      code: account.code,
      name: account.name,
      kind: account.kind,
      ownerType: account.ownerType,
      balancePaisa: balance.toString(),
    });
  }
  return views;
}

export type FinanceOverview = {
  accounts: AccountBalanceView[];
  openInvoices: { count: number; outstandingPaisa: string };
  remittancesAwaitingVerification: number;
  remittancesInDiscrepancy: number;
  settlementsPending: { count: number; netPayablePaisa: string };
  settlementsApprovedUnpaid: { count: number; netPayablePaisa: string };
  refundsRequested: number;
  adjustmentsRequested: number;
};

export async function getFinanceOverview(actor: ActorContext): Promise<FinanceOverview> {
  await requirePermAudited(actor, "finance.read", "FinancialAccount");
  const accounts = await listAccountBalances(actor);

  const openInvoices = await prisma.invoice.findMany({
    where: { status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
    select: { id: true, totalPaisa: true },
  });
  let outstanding = BigInt(0);
  for (const invoice of openInvoices) {
    const paid = await invoicePaidComponents(prisma, invoice.id);
    outstanding += invoice.totalPaisa - paid.totalPaidPaisa;
  }

  const [
    awaitingVerification,
    inDiscrepancy,
    pendingSettlements,
    approvedSettlements,
    refundsRequested,
    adjustmentsRequested,
  ] = await Promise.all([
    prisma.codRemittance.count({ where: { status: { in: ["SUBMITTED", "UNDER_VERIFICATION"] } } }),
    prisma.codRemittance.count({ where: { status: "DISCREPANCY" } }),
    prisma.vendorSettlement.findMany({
      where: { status: "PENDING" },
      select: { netPayablePaisa: true },
    }),
    prisma.vendorSettlement.findMany({
      where: { status: "APPROVED" },
      select: { netPayablePaisa: true },
    }),
    prisma.refund.count({ where: { status: "REQUESTED" } }),
    prisma.financialAdjustment.count({ where: { status: "REQUESTED" } }),
  ]);

  return {
    accounts,
    openInvoices: { count: openInvoices.length, outstandingPaisa: outstanding.toString() },
    remittancesAwaitingVerification: awaitingVerification,
    remittancesInDiscrepancy: inDiscrepancy,
    settlementsPending: {
      count: pendingSettlements.length,
      netPayablePaisa: pendingSettlements.reduce((s, r) => s + r.netPayablePaisa, BigInt(0)).toString(),
    },
    settlementsApprovedUnpaid: {
      count: approvedSettlements.length,
      netPayablePaisa: approvedSettlements.reduce((s, r) => s + r.netPayablePaisa, BigInt(0)).toString(),
    },
    refundsRequested,
    adjustmentsRequested,
  };
}

export type LedgerEntryView = {
  id: string;
  reference: string;
  journalRef: string;
  accountCode: string;
  accountName: string;
  direction: string;
  amountPaisa: string;
  type: string;
  occurredAt: string;
  createdAt: string;
  invoiceId: string | null;
  paymentId: string | null;
  settlementId: string | null;
  remittanceId: string | null;
  codCollectionId: string | null;
  reversalOfId: string | null;
};

/** Read-only journal view: entries newest first, filterable by
 * journal, account and type. There is deliberately no write path
 * here — the ledger is append-only. */
export async function listLedgerEntries(
  actor: ActorContext,
  filters: {
    journalRef?: string;
    accountCode?: string;
    type?: string;
    page?: number;
    pageSize?: number;
  } = {},
) {
  await requirePermAudited(actor, "finance.read", "LedgerTransaction");
  const { skip, take, page, pageSize } = pageArgs(filters.page ?? 1, filters.pageSize ?? 50);
  const conditions: Prisma.LedgerTransactionWhereInput[] = [];
  if (filters.journalRef) conditions.push({ journalRef: filters.journalRef });
  if (filters.type) conditions.push({ type: filters.type });
  if (filters.accountCode) conditions.push({ account: { code: filters.accountCode } });
  const where: Prisma.LedgerTransactionWhereInput = conditions.length ? { AND: conditions } : {};
  const [total, rows] = await Promise.all([
    prisma.ledgerTransaction.count({ where }),
    prisma.ledgerTransaction.findMany({
      where,
      include: { account: { select: { code: true, name: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
  ]);
  const items: LedgerEntryView[] = rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    journalRef: row.journalRef,
    accountCode: row.account.code,
    accountName: row.account.name,
    direction: row.direction,
    amountPaisa: row.amountPaisa.toString(),
    type: row.type,
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    invoiceId: row.invoiceId,
    paymentId: row.paymentId,
    settlementId: row.settlementId,
    remittanceId: row.remittanceId,
    codCollectionId: row.codCollectionId,
    reversalOfId: row.reversalOfId,
  }));
  return { items, meta: pageMeta(total, page, pageSize) };
}

/** Vendor directory for finance forms (generate invoice / prepare
 * settlement pickers). Finance staff are global; this returns id +
 * business name only, gated on a finance write permission. */
export async function listFinanceVendors(actor: ActorContext) {
  if (actor.permissions.has("invoice.create")) {
    await requirePermAudited(actor, "invoice.create", "Vendor");
  } else {
    await requirePermAudited(actor, "settlement.prepare", "Vendor");
  }
  const vendors = await prisma.vendor.findMany({
    where: { verificationStatus: "APPROVED" },
    select: { id: true, businessName: true },
    orderBy: { businessName: "asc" },
    take: 200,
  });
  return vendors;
}

/** Balance check for one journal: debits − credits (always 0 for a
 * posted journal; exposed so the UI can show the invariant). */
export async function getJournalBalance(actor: ActorContext, journalRef: string) {
  await requirePermAudited(actor, "finance.read", "LedgerTransaction");
  const grouped = await prisma.ledgerTransaction.groupBy({
    by: ["direction"],
    where: { journalRef },
    _sum: { amountPaisa: true },
  });
  let debits = BigInt(0);
  let credits = BigInt(0);
  for (const row of grouped) {
    if (row.direction === "DEBIT") debits = row._sum.amountPaisa ?? BigInt(0);
    else credits = row._sum.amountPaisa ?? BigInt(0);
  }
  return {
    journalRef,
    debitsPaisa: debits.toString(),
    creditsPaisa: credits.toString(),
    balanced: debits === credits,
  };
}
