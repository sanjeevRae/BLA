import "server-only";

import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { AuthorizationError, type ActorContext } from "@/lib/auth/actor";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import { PAYMENT_METHODS, cashAccountForMethod } from "@/lib/finance/domain";
import {
  auditAccessDenied,
  isUniqueViolation,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import { auditOps } from "@/server/services/warehouse-ops-shared";
import {
  notifyUsersInTx,
  vendorUserIds,
} from "@/server/services/notifications";
import {
  accountBalancePaisa,
  companyAccount,
  nextFinanceSequence,
  postJournal,
  vendorPayableAccount,
} from "@/server/services/finance-ledger";
import {
  invoicePaidComponents,
  invoiceReservedPaisa,
  recomputeInvoiceStatus,
  recomputeOrderPaymentStatus,
} from "@/server/services/invoices";

/**
 * Vendor settlements (Phase 7; docs/cod-reconciliation.md §4,
 * docs/financial-workflow.md §4).
 *
 * A settlement pays the vendor: verified COD held for them − their
 * unpaid invoiced shipping charges − explicit deduction lines.
 * Preparation gathers only obligations that are fully verified and
 * not already settled or reserved; approval freezes the figure;
 * paying posts one balanced journal, marks the covered invoices
 * paid-by-settlement and moves the packages to COD_SETTLED. Items
 * in discrepancy never enter a settlement — they stay pending,
 * visible, and un-netted.
 */

type Tx = Prisma.TransactionClient;

const moneyString = z
  .string()
  .regex(/^\d+$/, "Amounts are integer paisa")
  .transform((v) => BigInt(v));

export const prepareSettlementSchema = z.object({
  vendorId: z.string().uuid(),
  deductions: z
    .array(
      z.object({
        amountPaisa: moneyString,
        description: z.string().trim().min(3).max(300),
      }),
    )
    .max(20)
    .default([]),
  notes: z.string().trim().max(500).optional(),
});

export const paySettlementSchema = z.object({
  method: z.enum(PAYMENT_METHODS),
  transactionRef: z.string().trim().min(1).max(120).optional(),
});

export const cancelSettlementSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type SettlementView = {
  id: string;
  settlementNumber: string;
  vendorId: string;
  vendorName: string | null;
  grossCodPaisa: string;
  shippingChargesPaisa: string;
  otherDeductionsPaisa: string;
  netPayablePaisa: string;
  status: string;
  periodStart: string;
  periodEnd: string;
  settledAt: string | null;
  createdAt: string;
};

type SettlementRow = Prisma.VendorSettlementGetPayload<{
  include: { vendor: { select: { businessName: true } } };
}>;

function toSettlementView(row: SettlementRow): SettlementView {
  return {
    id: row.id,
    settlementNumber: row.settlementNumber,
    vendorId: row.vendorId,
    vendorName: row.vendor.businessName,
    grossCodPaisa: row.grossCodPaisa.toString(),
    shippingChargesPaisa: row.shippingChargesPaisa.toString(),
    otherDeductionsPaisa: row.otherDeductionsPaisa.toString(),
    netPayablePaisa: row.netPayablePaisa.toString(),
    status: row.status,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Prepare / approve / pay / cancel
// ---------------------------------------------------------------------------

export async function prepareSettlement(actor: ActorContext, input: unknown) {
  await requirePermAudited(actor, "settlement.prepare", "VendorSettlement");
  const data = parse(prepareSettlementSchema, input);

  try {
    const settlement = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "app"."Vendor" WHERE "id" = ${data.vendorId} FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundError("Vendor not found");

      // Verified COD not yet settled: remittance VERIFIED, or CLOSED
      // with the counted amount accepted; per-line verified amounts
      // only (discrepancy tails never enter — §3.5).
      const codLines = await tx.codRemittanceLine.findMany({
        where: {
          verifiedPaisa: { gt: BigInt(0) },
          codCollection: {
            settlementLines: { none: {} },
            shipment: { order: { vendorId: data.vendorId } },
          },
          OR: [
            { remittance: { status: "VERIFIED" } },
            { remittance: { status: "CLOSED", resolution: "ACCEPTED_COUNTED" } },
          ],
        },
        include: { codCollection: { select: { collectedAt: true } } },
        orderBy: { createdAt: "asc" },
      });

      const vendorInvoices = await tx.invoice.findMany({
        where: { vendorId: data.vendorId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
        orderBy: { issuedAt: "asc" },
      });
      const chargeLines: { invoice: (typeof vendorInvoices)[number]; outstanding: bigint }[] = [];
      for (const invoice of vendorInvoices) {
        const paid = await invoicePaidComponents(tx, invoice.id);
        const reserved = await invoiceReservedPaisa(tx, invoice.id);
        // Charges already claimed by an open settlement (PENDING /
        // RECONCILED / APPROVED) are reserved by that settlement
        // (Phase 7 review F5): a second settlement must not claim
        // the same invoice's charges again. SETTLED coverage is
        // already netted through invoicePaidComponents; CANCELLED
        // settlements release their lines at cancellation (F6).
        const openClaim = await tx.vendorSettlementLine.findFirst({
          where: {
            invoiceId: invoice.id,
            kind: "SHIPPING_CHARGE",
            settlement: { status: { in: ["PENDING", "RECONCILED", "APPROVED"] } },
          },
          select: { id: true },
        });
        const outstanding = invoice.totalPaisa - paid.totalPaidPaisa;
        if (outstanding > BigInt(0) && reserved === BigInt(0) && !openClaim) {
          chargeLines.push({ invoice, outstanding });
        }
      }

      if (codLines.length === 0 && chargeLines.length === 0 && data.deductions.length === 0) {
        throw new DomainValidationError("Nothing to settle for this vendor");
      }

      const gross = codLines.reduce((s, l) => s + (l.verifiedPaisa ?? BigInt(0)), BigInt(0));
      const charges = chargeLines.reduce((s, l) => s + l.outstanding, BigInt(0));
      const deductionsTotal = data.deductions.reduce((s, d) => s + d.amountPaisa, BigInt(0));
      for (const deduction of data.deductions) {
        if (deduction.amountPaisa <= BigInt(0)) {
          throw new DomainValidationError("Deduction amounts must be positive");
        }
      }
      const net = gross - charges - deductionsTotal;

      const seq = await nextFinanceSequence(tx, "settlement_number_seq");
      const settlementNumber = `SET-${seq.toString()}`;
      const periodStart =
        codLines.length > 0
          ? codLines.reduce(
              (min, l) => (l.codCollection.collectedAt < min ? l.codCollection.collectedAt : min),
              codLines[0]!.codCollection.collectedAt,
            )
          : new Date();

      const created = await tx.vendorSettlement.create({
        data: {
          settlementNumber,
          vendorId: data.vendorId,
          periodStart,
          periodEnd: new Date(),
          grossCodPaisa: gross,
          shippingChargesPaisa: charges,
          otherDeductionsPaisa: deductionsTotal,
          netPayablePaisa: net,
          status: "PENDING",
          preparedById: actor.userId,
          notes: data.notes ?? null,
          lines: {
            create: [
              ...codLines.map((line) => ({
                kind: "COD_CREDIT",
                codCollectionId: line.codCollectionId,
                amountPaisa: line.verifiedPaisa ?? BigInt(0),
                description: "Verified COD held for vendor",
              })),
              ...chargeLines.map(({ invoice, outstanding }) => ({
                kind: "SHIPPING_CHARGE",
                invoiceId: invoice.id,
                amountPaisa: outstanding,
                description: `Shipping charges — invoice ${invoice.invoiceNumber}`,
              })),
              ...data.deductions.map((d) => ({
                kind: "DEDUCTION",
                amountPaisa: d.amountPaisa,
                description: d.description,
              })),
            ],
          },
        },
        include: { vendor: { select: { businessName: true } } },
      });

      await auditOps(actor, "settlement.prepared", "VendorSettlement", created.id, {
        after: {
          settlementNumber,
          vendorId: data.vendorId,
          grossCodPaisa: gross.toString(),
          shippingChargesPaisa: charges.toString(),
          otherDeductionsPaisa: deductionsTotal.toString(),
          netPayablePaisa: net.toString(),
        },
      });
      return created;
    });
    return toSettlementView(settlement);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("A COD collection in this settlement was already settled by another settlement");
    }
    throw error;
  }
}

async function lockSettlement(tx: Tx, settlementId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "app"."VendorSettlement" WHERE "id" = ${settlementId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Settlement not found");
  const settlement = await tx.vendorSettlement.findUnique({
    where: { id: settlementId },
    include: { lines: true },
  });
  if (!settlement) throw new NotFoundError("Settlement not found");
  return settlement;
}

export async function approveSettlement(actor: ActorContext, settlementId: string) {
  await requirePermAudited(actor, "settlement.approve", "VendorSettlement");
  const updated = await prisma.$transaction(async (tx) => {
    const settlement = await lockSettlement(tx, settlementId);
    if (settlement.status !== "PENDING" && settlement.status !== "RECONCILED") {
      throw new ConflictError(`Settlement is ${settlement.status} and cannot be approved`);
    }
    if (settlement.netPayablePaisa < BigInt(0)) {
      throw new DomainValidationError(
        "Settlement net is negative — the vendor owes more than the COD held; collect the balance as a payment instead",
      );
    }
    const approved = await tx.vendorSettlement.update({
      where: { id: settlementId },
      data: { status: "APPROVED", approvedById: actor.userId, approvedAt: new Date() },
      include: { vendor: { select: { businessName: true } } },
    });
    await auditOps(actor, "settlement.approved", "VendorSettlement", settlementId, {
      after: { netPayablePaisa: settlement.netPayablePaisa.toString() },
    });
    return approved;
  });
  return toSettlementView(updated);
}

/**
 * Pay an APPROVED settlement: one balanced journal clears the
 * vendor payable (net + withheld deductions) against the payout
 * account and deductions income; covered invoices become
 * paid-by-settlement and the packages reach COD_SETTLED.
 */
export async function paySettlement(actor: ActorContext, settlementId: string, input: unknown) {
  await requirePermAudited(actor, "settlement.pay", "VendorSettlement");
  const data = parse(paySettlementSchema, input);

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const settlement = await lockSettlement(tx, settlementId);
      if (settlement.status !== "APPROVED") {
        throw new ConflictError(`Settlement is ${settlement.status}; only an APPROVED settlement can be paid`);
      }
      if (settlement.netPayablePaisa < BigInt(0)) {
        throw new DomainValidationError("Settlement net is negative and cannot be paid out");
      }
      const vendorLock = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "app"."Vendor" WHERE "id" = ${settlement.vendorId} FOR UPDATE`;
      if (vendorLock.length === 0) throw new NotFoundError("Vendor not found");

      // Re-verify the world still matches the approved figure.
      for (const line of settlement.lines) {
        if (line.kind === "SHIPPING_CHARGE" && line.invoiceId) {
          const invoice = await tx.invoice.findUnique({ where: { id: line.invoiceId } });
          if (!invoice) throw new NotFoundError("Invoice on settlement not found");
          const paid = await invoicePaidComponents(tx, invoice.id);
          const outstanding = invoice.totalPaisa - paid.totalPaidPaisa;
          if (outstanding < line.amountPaisa) {
            throw new ConflictError(
              `Invoice ${invoice.invoiceNumber} changed since approval — cancel and re-prepare this settlement`,
            );
          }
        }
      }

      // A zero-net settlement (charges exactly offset the COD held)
      // moves no cash: no Payment row (amounts are positive by
      // CHECK) and no journal.
      const payment =
        settlement.netPayablePaisa > BigInt(0)
          ? await tx.payment.create({
              data: {
                payerType: "COMPANY",
                amountPaisa: settlement.netPayablePaisa,
                method: data.method,
                status: "PAID",
                transactionRef: data.transactionRef ?? null,
                paidAt: new Date(),
                recordedById: actor.userId,
              },
            })
          : null;

      if (settlement.netPayablePaisa + settlement.otherDeductionsPaisa > BigInt(0)) {
        const payable = await vendorPayableAccount(tx, settlement.vendorId);
        const legs: Parameters<typeof postJournal>[1]["legs"] = [
          {
            accountCode: payable.code,
            direction: "DEBIT",
            amountPaisa: settlement.netPayablePaisa + settlement.otherDeductionsPaisa,
            type: "COD_SETTLED",
            settlementId: settlement.id,
            paymentId: payment?.id ?? null,
            paymentMethod: data.method,
          },
        ];
        if (settlement.netPayablePaisa > BigInt(0)) {
          const payoutAccount = await companyAccount(tx, cashAccountForMethod(data.method));
          legs.push({
            accountCode: payoutAccount.code,
            direction: "CREDIT",
            amountPaisa: settlement.netPayablePaisa,
            type: "COD_SETTLED",
            settlementId: settlement.id,
            paymentId: payment?.id ?? null,
            paymentMethod: data.method,
          });
        }
        if (settlement.otherDeductionsPaisa > BigInt(0)) {
          const deductionsIncome = await companyAccount(tx, "DEDUCTIONS_INCOME");
          legs.push({
            accountCode: deductionsIncome.code,
            direction: "CREDIT",
            amountPaisa: settlement.otherDeductionsPaisa,
            type: "COD_SETTLED",
            settlementId: settlement.id,
            paymentId: payment?.id ?? null,
            paymentMethod: data.method,
          });
        }
        await postJournal(tx, {
          journalRef: settlement.settlementNumber,
          actorId: actor.userId,
          legs,
        });
      }

      const settled = await tx.vendorSettlement.update({
        where: { id: settlementId },
        data: {
          status: "SETTLED",
          settledAt: new Date(),
          paymentId: payment?.id ?? null,
          paymentRef: data.transactionRef ?? null,
        },
        include: { vendor: { select: { businessName: true } } },
      });

      const orderIds = new Set<string>();
      for (const line of settlement.lines) {
        if (line.kind === "SHIPPING_CHARGE" && line.invoiceId) {
          const invoice = await recomputeInvoiceStatus(tx, line.invoiceId);
          if (invoice.orderId) orderIds.add(invoice.orderId);
          const lineOrders = await tx.invoiceLine.findMany({
            where: { invoiceId: line.invoiceId, orderId: { not: null } },
            select: { orderId: true },
            distinct: ["orderId"],
          });
          for (const l of lineOrders) if (l.orderId) orderIds.add(l.orderId);
        }
        if (line.kind === "COD_CREDIT" && line.codCollectionId) {
          const collection = await tx.deliveryCodCollection.findUnique({
            where: { id: line.codCollectionId },
            select: { packageId: true },
          });
          if (collection) {
            await tx.package.updateMany({
              where: { id: collection.packageId, paymentStatus: "COD_REMITTED" },
              data: { paymentStatus: "COD_SETTLED" },
            });
          }
        }
      }
      for (const orderId of orderIds) await recomputeOrderPaymentStatus(tx, orderId);

      await auditOps(actor, "settlement.paid", "VendorSettlement", settlementId, {
        after: {
          netPayablePaisa: settlement.netPayablePaisa.toString(),
          method: data.method,
          paymentId: payment?.id ?? null,
        },
      });
      // Phase 8 trigger: the vendor's users are notified that the
      // settlement was paid, inside the payment transaction.
      await notifyUsersInTx(tx, await vendorUserIds(tx, settlement.vendorId), {
        category: "SETTLEMENT_PAID",
        title: `Settlement ${settlement.settlementNumber} paid`,
        body: `Your settlement ${settlement.settlementNumber} has been paid (net ${settlement.netPayablePaisa.toString()} paisa).`,
        entityType: "VendorSettlement",
        entityId: settlementId,
        dedupeKey: `settlement-paid:${settlementId}`,
      });
      return settled;
    });
    return toSettlementView(updated);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("A COD collection in this settlement was already settled by another settlement");
    }
    throw error;
  }
}

export async function cancelSettlement(actor: ActorContext, settlementId: string, input: unknown) {
  await requirePermAudited(actor, "settlement.prepare", "VendorSettlement");
  const data = parse(cancelSettlementSchema, input);
  const updated = await prisma.$transaction(async (tx) => {
    const settlement = await lockSettlement(tx, settlementId);
    if (settlement.status !== "PENDING" && settlement.status !== "APPROVED") {
      throw new ConflictError(`Settlement is ${settlement.status} and cannot be cancelled`);
    }
    // Release the settlement's claims (Phase 7 review F6): the
    // lines are deleted inside this locked transaction so the COD
    // collections and invoice charges become preparable again —
    // otherwise the one-settlement-per-collection unique index
    // would strand them under the cancelled settlement forever.
    // The header (with its frozen figures) and this audit row
    // remain the record of the cancelled settlement.
    await tx.vendorSettlementLine.deleteMany({ where: { settlementId } });
    const cancelled = await tx.vendorSettlement.update({
      where: { id: settlementId },
      data: { status: "CANCELLED", notes: data.reason },
      include: { vendor: { select: { businessName: true } } },
    });
    await auditOps(actor, "settlement.cancelled", "VendorSettlement", settlementId, {
      before: { status: settlement.status },
      after: { status: "CANCELLED", reason: data.reason },
    });
    return cancelled;
  });
  return toSettlementView(updated);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listSettlements(
  actor: ActorContext,
  filters: { vendorId?: string; status?: string; page?: number; pageSize?: number } = {},
) {
  await requirePermAudited(actor, "settlement.read", "VendorSettlement");
  if (actor.vendorId && filters.vendorId && filters.vendorId !== actor.vendorId) {
    await auditAccessDenied(actor, "VendorSettlement", {
      entityId: null,
      reason: "vendor_scope_other_vendor_list",
    });
    throw new AuthorizationError("Vendors can only list their own settlements");
  }
  const { skip, take, page, pageSize } = pageArgs(filters.page ?? 1, filters.pageSize ?? 25);
  const conditions: Prisma.VendorSettlementWhereInput[] = [];
  if (actor.vendorId) conditions.push({ vendorId: actor.vendorId });
  if (filters.vendorId) conditions.push({ vendorId: filters.vendorId });
  if (filters.status) conditions.push({ status: filters.status });
  const where: Prisma.VendorSettlementWhereInput = conditions.length ? { AND: conditions } : {};
  const [total, rows] = await Promise.all([
    prisma.vendorSettlement.count({ where }),
    prisma.vendorSettlement.findMany({
      where,
      include: { vendor: { select: { businessName: true } } },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
  ]);
  return { items: rows.map(toSettlementView), meta: pageMeta(total, page, pageSize) };
}

export type SettlementDetailView = SettlementView & {
  lines: {
    id: string;
    kind: string;
    amountPaisa: string;
    description: string | null;
    codCollectionId: string | null;
    invoiceId: string | null;
    invoiceNumber: string | null;
  }[];
  notes: string | null;
  paymentRef: string | null;
};

export async function getSettlement(actor: ActorContext, settlementId: string): Promise<SettlementDetailView> {
  await requirePermAudited(actor, "settlement.read", "VendorSettlement");
  const settlement = await prisma.vendorSettlement.findUnique({
    where: { id: settlementId },
    include: {
      vendor: { select: { businessName: true } },
      lines: {
        orderBy: { createdAt: "asc" },
        include: { invoice: { select: { invoiceNumber: true } } },
      },
    },
  });
  if (!settlement) throw new NotFoundError("Settlement not found");
  if (actor.vendorId && settlement.vendorId !== actor.vendorId) {
    await auditAccessDenied(actor, "VendorSettlement", {
      entityId: settlementId,
      reason: "vendor_scope_other_vendor_settlement",
    });
    throw new AuthorizationError("Vendors can only view their own settlements");
  }
  const base = toSettlementView(settlement);
  return {
    ...base,
    lines: settlement.lines.map((line) => ({
      id: line.id,
      kind: line.kind,
      amountPaisa: line.amountPaisa.toString(),
      description: line.description,
      codCollectionId: line.codCollectionId,
      invoiceId: line.invoiceId,
      invoiceNumber: line.invoice?.invoiceNumber ?? null,
    })),
    notes: settlement.notes,
    paymentRef: settlement.paymentRef,
  };
}

/** Vendor statement: the derived payable position plus what is
 * still open — every figure computed from source records. */
export async function getVendorStatement(actor: ActorContext, vendorId: string) {
  await requirePermAudited(actor, "settlement.read", "VendorSettlement");
  if (actor.vendorId && actor.vendorId !== vendorId) {
    await auditAccessDenied(actor, "VendorSettlement", {
      entityId: null,
      reason: "vendor_scope_other_vendor_statement",
    });
    throw new AuthorizationError("Vendors can only view their own statement");
  }
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { id: true, businessName: true },
  });
  if (!vendor) throw new NotFoundError("Vendor not found");

  const account = await prisma.financialAccount.findUnique({
    where: { code: `VENDOR_PAYABLE:${vendorId}` },
    select: { id: true, kind: true },
  });
  const payableBalance = account ? await accountBalancePaisa(prisma, account.id, account.kind) : BigInt(0);

  const openInvoices = await prisma.invoice.findMany({
    where: { vendorId, status: { in: ["ISSUED", "PARTIALLY_PAID"] } },
    select: { id: true, totalPaisa: true },
  });
  let openInvoiceTotal = BigInt(0);
  for (const invoice of openInvoices) {
    const paid = await invoicePaidComponents(prisma, invoice.id);
    openInvoiceTotal += invoice.totalPaisa - paid.totalPaidPaisa;
  }

  const unsettledCod = await prisma.codRemittanceLine.aggregate({
    where: {
      verifiedPaisa: { gt: BigInt(0) },
      codCollection: {
        settlementLines: { none: {} },
        shipment: { order: { vendorId } },
      },
      OR: [
        { remittance: { status: "VERIFIED" } },
        { remittance: { status: "CLOSED", resolution: "ACCEPTED_COUNTED" } },
      ],
    },
    _sum: { verifiedPaisa: true },
  });

  return {
    vendorId,
    vendorName: vendor.businessName,
    payableBalancePaisa: payableBalance.toString(),
    openInvoicesPaisa: openInvoiceTotal.toString(),
    unsettledVerifiedCodPaisa: (unsettledCod._sum.verifiedPaisa ?? BigInt(0)).toString(),
  };
}
