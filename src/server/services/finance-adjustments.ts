import "server-only";

import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import type { ActorContext } from "@/lib/auth/actor";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import {
  ADJUSTMENT_APPLIABLE_TARGETS,
  ADJUSTMENT_TARGET_TYPES,
  cashAccountForMethod,
} from "@/lib/finance/domain";
import { pageArgs, pageMeta, parse, requirePermAudited } from "@/server/services/scoping";
import { auditOps } from "@/server/services/warehouse-ops-shared";
import {
  companyAccount,
  driverCashAccount,
  postJournal,
  vendorPayableAccount,
} from "@/server/services/finance-ledger";
import {
  invoicePaidComponents,
  recomputeInvoiceStatus,
  recomputeOrderPaymentStatus,
} from "@/server/services/invoices";

/**
 * Refunds + financial adjustments (Phase 7;
 * docs/financial-workflow.md §5–§6).
 *
 * Refunds move through request → approve (four-eyes) → process;
 * processing posts the mirror journal, reduces the payment's
 * allocations (newest first) and re-derives invoice/order statuses —
 * the original payment is never edited. Adjustments are the only
 * legal way to change a financial outcome after the fact: they are
 * approved by someone other than their creator and apply as new
 * ledger entries against the target, never as edits. Phase 7
 * applies INVOICE credit notes and COD_COLLECTION shortfall
 * write-offs (against the COD_DISCREPANCY suspense account).
 */

type Tx = Prisma.TransactionClient;

const moneyString = z
  .string()
  .regex(/^\d+$/, "Amounts are integer paisa")
  .transform((v) => BigInt(v));

export const requestRefundSchema = z.object({
  paymentId: z.string().uuid(),
  amountPaisa: moneyString,
  reason: z.string().trim().min(3).max(500),
});

export const createAdjustmentSchema = z.object({
  targetType: z.enum(ADJUSTMENT_TARGET_TYPES),
  targetId: z.string().uuid(),
  amountPaisa: moneyString,
  reason: z.string().trim().min(3).max(500),
});

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

async function refundableRemaining(tx: Tx | typeof prisma, paymentId: string): Promise<bigint> {
  const payment = await tx.payment.findUnique({
    where: { id: paymentId },
    select: { amountPaisa: true },
  });
  if (!payment) throw new NotFoundError("Payment not found");
  const committed = await tx.refund.aggregate({
    where: { paymentId, status: { in: ["REQUESTED", "APPROVED", "PROCESSED"] } },
    _sum: { amountPaisa: true },
  });
  return payment.amountPaisa - (committed._sum.amountPaisa ?? BigInt(0));
}

export async function requestRefund(actor: ActorContext, input: unknown) {
  await requirePermAudited(actor, "refund.process", "Refund");
  const data = parse(requestRefundSchema, input);
  if (data.amountPaisa <= BigInt(0)) throw new DomainValidationError("Refund amount must be positive");
  const refund = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "app"."Payment" WHERE "id" = ${data.paymentId} FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundError("Payment not found");
    const payment = await tx.payment.findUnique({
      where: { id: data.paymentId },
      select: { payerType: true },
    });
    if (!payment) throw new NotFoundError("Payment not found");
    // Settlement payouts are company money governed by the
    // settlement itself (Phase 7 review F7): the generic refund
    // mirror would debit the wrong account and never re-open the
    // vendor's payable. Corrections go through a settlement-aware
    // reversal or a financial adjustment instead.
    if (payment.payerType === "COMPANY") {
      throw new DomainValidationError(
        "Company payments (settlement payouts) cannot be refunded through the generic refund path — correct them through a settlement-aware reversal or a financial adjustment",
      );
    }
    const remaining = await refundableRemaining(tx, data.paymentId);
    if (data.amountPaisa > remaining) {
      throw new DomainValidationError(
        `Refund of ${data.amountPaisa} exceeds the un-refunded remainder ${remaining} of this payment`,
      );
    }
    const created = await tx.refund.create({
      data: {
        paymentId: data.paymentId,
        amountPaisa: data.amountPaisa,
        reason: data.reason,
        requestedById: actor.userId,
      },
    });
    await auditOps(actor, "refund.requested", "Refund", created.id, {
      after: { paymentId: data.paymentId, amountPaisa: data.amountPaisa.toString() },
    });
    return created;
  });
  return serializeRefund(refund);
}

/** Lock a Refund row inside a transaction and re-read it — the
 * approve/reject pair must serialize on the row so a racing
 * decision can never overwrite the other (Phase 7 review F3). */
async function lockRefund(tx: Tx, refundId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "app"."Refund" WHERE "id" = ${refundId} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Refund not found");
  const refund = await tx.refund.findUnique({ where: { id: refundId } });
  if (!refund) throw new NotFoundError("Refund not found");
  return refund;
}

export async function approveRefund(actor: ActorContext, refundId: string) {
  await requirePermAudited(actor, "refund.process", "Refund");
  const updated = await prisma.$transaction(async (tx) => {
    const refund = await lockRefund(tx, refundId);
    if (refund.status !== "REQUESTED") {
      throw new ConflictError(`Refund is ${refund.status} and cannot be approved`);
    }
    if (refund.requestedById === actor.userId) {
      throw new DomainValidationError("A refund must be approved by someone other than its requester");
    }
    const row = await tx.refund.update({
      where: { id: refundId },
      data: { status: "APPROVED", approvedById: actor.userId },
    });
    await auditOps(actor, "refund.approved", "Refund", refundId, {});
    return row;
  });
  return serializeRefund(updated);
}

export async function rejectRefund(actor: ActorContext, refundId: string) {
  await requirePermAudited(actor, "refund.process", "Refund");
  const updated = await prisma.$transaction(async (tx) => {
    const refund = await lockRefund(tx, refundId);
    if (refund.status !== "REQUESTED" && refund.status !== "APPROVED") {
      throw new ConflictError(`Refund is ${refund.status} and cannot be rejected`);
    }
    const row = await tx.refund.update({
      where: { id: refundId },
      data: { status: "REJECTED" },
    });
    await auditOps(actor, "refund.rejected", "Refund", refundId, {});
    return row;
  });
  return serializeRefund(updated);
}

export async function processRefund(actor: ActorContext, refundId: string) {
  await requirePermAudited(actor, "refund.process", "Refund");
  const updated = await prisma.$transaction(async (tx) => {
    const refundRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "app"."Refund" WHERE "id" = ${refundId} FOR UPDATE`;
    if (refundRows.length === 0) throw new NotFoundError("Refund not found");
    const refund = await tx.refund.findUnique({ where: { id: refundId } });
    if (!refund) throw new NotFoundError("Refund not found");
    if (refund.status !== "APPROVED") {
      throw new ConflictError(`Refund is ${refund.status}; only an APPROVED refund can be processed`);
    }
    const paymentRows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "app"."Payment" WHERE "id" = ${refund.paymentId} FOR UPDATE`;
    if (paymentRows.length === 0) throw new NotFoundError("Payment not found");
    const payment = await tx.payment.findUnique({ where: { id: refund.paymentId } });
    if (!payment) throw new NotFoundError("Payment not found");
    // Backstop for F7: even a refund row created before the guard
    // (or by another path) must never process against a company
    // settlement payout.
    if (payment.payerType === "COMPANY") {
      throw new DomainValidationError(
        "Company payments (settlement payouts) cannot be refunded through the generic refund path — correct them through a settlement-aware reversal or a financial adjustment",
      );
    }

    const processed = await tx.refund.aggregate({
      where: { paymentId: payment.id, status: "PROCESSED" },
      _sum: { amountPaisa: true },
    });
    const alreadyRefunded = processed._sum.amountPaisa ?? BigInt(0);
    if (alreadyRefunded + refund.amountPaisa > payment.amountPaisa) {
      throw new DomainValidationError("Refund exceeds the payment's un-refunded remainder");
    }

    // Mirror journal: the original credit side is debited back and
    // the cash account credited (money leaves the company again).
    const cashAccount = await companyAccount(tx, cashAccountForMethod(payment.method));
    const creditAccount = payment.payerVendorId
      ? await vendorPayableAccount(tx, payment.payerVendorId)
      : await companyAccount(tx, "ACCOUNTS_RECEIVABLE");
    const journalRef = `REF-${refund.id}`;
    await postJournal(tx, {
      journalRef,
      actorId: actor.userId,
      legs: [
        {
          accountCode: creditAccount.code,
          direction: "DEBIT",
          amountPaisa: refund.amountPaisa,
          type: "REFUND",
          paymentId: payment.id,
          paymentMethod: payment.method,
        },
        {
          accountCode: cashAccount.code,
          direction: "CREDIT",
          amountPaisa: refund.amountPaisa,
          type: "REFUND",
          paymentId: payment.id,
          paymentMethod: payment.method,
        },
      ],
    });

    // Reduce allocations newest-first; invoices re-derive from what
    // remains allocated.
    let remainingToReduce = refund.amountPaisa;
    const allocations = await tx.paymentAllocation.findMany({
      where: { paymentId: payment.id },
      orderBy: { createdAt: "desc" },
    });
    const affectedInvoices = new Set<string>();
    for (const allocation of allocations) {
      if (remainingToReduce <= BigInt(0)) break;
      affectedInvoices.add(allocation.invoiceId);
      if (allocation.amountPaisa <= remainingToReduce) {
        remainingToReduce -= allocation.amountPaisa;
        await tx.paymentAllocation.delete({ where: { id: allocation.id } });
      } else {
        await tx.paymentAllocation.update({
          where: { id: allocation.id },
          data: { amountPaisa: allocation.amountPaisa - remainingToReduce },
        });
        remainingToReduce = BigInt(0);
      }
    }

    const totalRefunded = alreadyRefunded + refund.amountPaisa;
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: totalRefunded >= payment.amountPaisa ? "REFUNDED" : "PARTIALLY_REFUNDED" },
    });

    const orderIds = new Set<string>();
    for (const invoiceId of affectedInvoices) {
      const invoice = await recomputeInvoiceStatus(tx, invoiceId);
      if (invoice.orderId) orderIds.add(invoice.orderId);
      const lineOrders = await tx.invoiceLine.findMany({
        where: { invoiceId, orderId: { not: null } },
        select: { orderId: true },
        distinct: ["orderId"],
      });
      for (const l of lineOrders) if (l.orderId) orderIds.add(l.orderId);
    }
    if (payment.orderId) orderIds.add(payment.orderId);
    for (const orderId of orderIds) await recomputeOrderPaymentStatus(tx, orderId);

    const done = await tx.refund.update({
      where: { id: refundId },
      data: {
        status: "PROCESSED",
        processedById: actor.userId,
        processedAt: new Date(),
        ledgerJournalRef: journalRef,
      },
    });
    await auditOps(actor, "refund.processed", "Refund", refundId, {
      after: { amountPaisa: refund.amountPaisa.toString(), journalRef },
    });
    return done;
  });
  return serializeRefund(updated);
}

function serializeRefund(refund: {
  id: string;
  paymentId: string;
  amountPaisa: bigint;
  reason: string;
  status: string;
  ledgerJournalRef: string | null;
  createdAt: Date;
}) {
  return {
    id: refund.id,
    paymentId: refund.paymentId,
    amountPaisa: refund.amountPaisa.toString(),
    reason: refund.reason,
    status: refund.status,
    ledgerJournalRef: refund.ledgerJournalRef,
    createdAt: refund.createdAt.toISOString(),
  };
}

export async function listRefunds(
  actor: ActorContext,
  filters: { status?: string; page?: number; pageSize?: number } = {},
) {
  await requirePermAudited(actor, "finance.read", "Refund");
  const { skip, take, page, pageSize } = pageArgs(filters.page ?? 1, filters.pageSize ?? 25);
  const where: Prisma.RefundWhereInput = filters.status ? { status: filters.status } : {};
  const [total, rows] = await Promise.all([
    prisma.refund.count({ where }),
    prisma.refund.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
  ]);
  return { items: rows.map(serializeRefund), meta: pageMeta(total, page, pageSize) };
}

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------

export async function createAdjustment(actor: ActorContext, input: unknown) {
  await requirePermAudited(actor, "finance.adjust", "FinancialAdjustment");
  const data = parse(createAdjustmentSchema, input);
  if (data.amountPaisa <= BigInt(0)) throw new DomainValidationError("Adjustment amount must be positive");
  if (!ADJUSTMENT_APPLIABLE_TARGETS.includes(data.targetType as (typeof ADJUSTMENT_APPLIABLE_TARGETS)[number])) {
    throw new DomainValidationError(
      `Adjustments against ${data.targetType} are not applied by Phase 7 finance — only INVOICE credit notes and COD_COLLECTION write-offs are`,
    );
  }

  const adjustment = await prisma.$transaction(async (tx) => {
    if (data.targetType === "INVOICE") {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "app"."Invoice" WHERE "id" = ${data.targetId} FOR UPDATE`;
      if (rows.length === 0) throw new NotFoundError("Invoice not found");
      const invoice = await tx.invoice.findUnique({ where: { id: data.targetId } });
      if (!invoice) throw new NotFoundError("Invoice not found");
      if (invoice.status === "CANCELLED") {
        throw new DomainValidationError("A cancelled invoice cannot be adjusted");
      }
      if (data.amountPaisa > invoice.totalPaisa) {
        throw new DomainValidationError("A credit note cannot exceed the invoice total");
      }
    } else {
      // COD_COLLECTION write-off: bounded by the collection's
      // still-unverified shortfall.
      const collection = await tx.deliveryCodCollection.findUnique({
        where: { id: data.targetId },
        include: { remittanceLines: { select: { verifiedPaisa: true } } },
      });
      if (!collection) throw new NotFoundError("COD collection not found");
      const verified = collection.remittanceLines.reduce((s, l) => s + (l.verifiedPaisa ?? BigInt(0)), BigInt(0));
      const priorWriteOffs = await tx.financialAdjustment.aggregate({
        where: { targetType: "COD_COLLECTION", targetId: data.targetId, status: "APPLIED" },
        _sum: { amountPaisa: true },
      });
      const shortfall = collection.collectedPaisa - verified - (priorWriteOffs._sum.amountPaisa ?? BigInt(0));
      if (data.amountPaisa > shortfall) {
        throw new DomainValidationError(
          `Write-off of ${data.amountPaisa} exceeds the collection's unverified shortfall ${shortfall}`,
        );
      }
    }
    const created = await tx.financialAdjustment.create({
      data: {
        targetType: data.targetType,
        targetId: data.targetId,
        amountPaisa: data.amountPaisa,
        reason: data.reason,
        createdById: actor.userId,
      },
    });
    await auditOps(actor, "finance.adjustment_created", "FinancialAdjustment", created.id, {
      after: {
        targetType: data.targetType,
        targetId: data.targetId,
        amountPaisa: data.amountPaisa.toString(),
      },
    });
    return created;
  });
  return serializeAdjustment(adjustment);
}

/** Approve + apply in one step (four-eyes: approver ≠ creator).
 * Applying posts the adjustment's ledger journal; the target's own
 * amounts are never edited. */
export async function approveAdjustment(actor: ActorContext, adjustmentId: string) {
  await requirePermAudited(actor, "finance.approve_adjustment", "FinancialAdjustment");
  const updated = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "app"."FinancialAdjustment" WHERE "id" = ${adjustmentId} FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundError("Adjustment not found");
    const adjustment = await tx.financialAdjustment.findUnique({ where: { id: adjustmentId } });
    if (!adjustment) throw new NotFoundError("Adjustment not found");
    if (adjustment.status !== "REQUESTED") {
      throw new ConflictError(`Adjustment is ${adjustment.status} and cannot be approved`);
    }
    if (adjustment.createdById === actor.userId) {
      throw new DomainValidationError("An adjustment must be approved by someone other than its creator (four-eyes)");
    }

    // Cumulative bound re-check under the target's row lock
    // (Phase 7 review F4): creation bounded a single adjustment,
    // but several REQUESTED adjustments are created independently —
    // without re-checking here, two credit notes that each fit the
    // invoice could both apply past its total (and likewise for
    // COD write-offs past the collection's shortfall).
    if (adjustment.targetType === "INVOICE") {
      const targetRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "app"."Invoice" WHERE "id" = ${adjustment.targetId} FOR UPDATE`;
      if (targetRows.length === 0) throw new NotFoundError("Invoice not found");
      const invoice = await tx.invoice.findUnique({ where: { id: adjustment.targetId } });
      if (!invoice) throw new NotFoundError("Invoice not found");
      if (invoice.status === "CANCELLED") {
        throw new DomainValidationError("A cancelled invoice cannot be adjusted");
      }
      const paid = await invoicePaidComponents(tx, invoice.id);
      const remaining = invoice.totalPaisa - paid.totalPaidPaisa;
      if (adjustment.amountPaisa > remaining) {
        throw new DomainValidationError(
          `Credit note of ${adjustment.amountPaisa} exceeds the invoice's remaining bound ${remaining} (total minus allocations, settlement coverage and applied credit notes)`,
        );
      }
    } else if (adjustment.targetType === "COD_COLLECTION") {
      const targetRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "app"."DeliveryCodCollection" WHERE "id" = ${adjustment.targetId} FOR UPDATE`;
      if (targetRows.length === 0) throw new NotFoundError("COD collection not found");
      const collection = await tx.deliveryCodCollection.findUnique({
        where: { id: adjustment.targetId },
        include: { remittanceLines: { select: { verifiedPaisa: true } } },
      });
      if (!collection) throw new NotFoundError("COD collection not found");
      const verified = collection.remittanceLines.reduce(
        (s, l) => s + (l.verifiedPaisa ?? BigInt(0)),
        BigInt(0),
      );
      const priorWriteOffs = await tx.financialAdjustment.aggregate({
        where: { targetType: "COD_COLLECTION", targetId: adjustment.targetId, status: "APPLIED" },
        _sum: { amountPaisa: true },
      });
      const shortfall =
        collection.collectedPaisa - verified - (priorWriteOffs._sum.amountPaisa ?? BigInt(0));
      if (adjustment.amountPaisa > shortfall) {
        throw new DomainValidationError(
          `Write-off of ${adjustment.amountPaisa} exceeds the collection's remaining unverified shortfall ${shortfall}`,
        );
      }
    }

    const journalRef = `ADJ-${adjustment.id}`;
    // Mark APPLIED first: the invoice status recompute below counts
    // this adjustment among the invoice's paid components.
    const applied = await tx.financialAdjustment.update({
      where: { id: adjustmentId },
      data: {
        status: "APPLIED",
        approvedById: actor.userId,
        appliedAt: new Date(),
        ledgerJournalRef: journalRef,
      },
    });
    if (adjustment.targetType === "INVOICE") {
      const invoice = await tx.invoice.findUnique({ where: { id: adjustment.targetId } });
      if (!invoice) throw new NotFoundError("Invoice not found");
      const revenue = await companyAccount(tx, "SHIPPING_REVENUE");
      const creditAccount = invoice.vendorId
        ? await vendorPayableAccount(tx, invoice.vendorId)
        : await companyAccount(tx, "ACCOUNTS_RECEIVABLE");
      await postJournal(tx, {
        journalRef,
        actorId: actor.userId,
        approvedById: actor.userId,
        legs: [
          {
            accountCode: revenue.code,
            direction: "DEBIT",
            amountPaisa: adjustment.amountPaisa,
            type: "ADJUSTMENT",
            invoiceId: invoice.id,
            orderId: invoice.orderId,
            adjustmentId: adjustment.id,
          },
          {
            accountCode: creditAccount.code,
            direction: "CREDIT",
            amountPaisa: adjustment.amountPaisa,
            type: "ADJUSTMENT",
            invoiceId: invoice.id,
            orderId: invoice.orderId,
            adjustmentId: adjustment.id,
          },
        ],
      });
      const refreshed = await recomputeInvoiceStatus(tx, invoice.id);
      if (refreshed.orderId) await recomputeOrderPaymentStatus(tx, refreshed.orderId);
    } else if (adjustment.targetType === "COD_COLLECTION") {
      const collection = await tx.deliveryCodCollection.findUnique({
        where: { id: adjustment.targetId },
        select: { id: true, packageId: true, collectedById: true },
      });
      if (!collection) throw new NotFoundError("COD collection not found");
      const driver = await tx.driver.findUnique({
        where: { userId: collection.collectedById },
        select: { id: true },
      });
      if (!driver) throw new NotFoundError("Driver for collection not found");
      const driverAccount = await driverCashAccount(tx, driver.id);
      const suspense = await companyAccount(tx, "COD_DISCREPANCY");
      await postJournal(tx, {
        journalRef,
        actorId: actor.userId,
        approvedById: actor.userId,
        legs: [
          {
            accountCode: suspense.code,
            direction: "DEBIT",
            amountPaisa: adjustment.amountPaisa,
            type: "ADJUSTMENT",
            codCollectionId: collection.id,
            packageId: collection.packageId,
            adjustmentId: adjustment.id,
          },
          {
            accountCode: driverAccount.code,
            direction: "CREDIT",
            amountPaisa: adjustment.amountPaisa,
            type: "ADJUSTMENT",
            codCollectionId: collection.id,
            packageId: collection.packageId,
            adjustmentId: adjustment.id,
          },
        ],
      });
    }

    await auditOps(actor, "finance.adjustment_applied", "FinancialAdjustment", adjustmentId, {
      after: { amountPaisa: adjustment.amountPaisa.toString(), journalRef },
    });
    return applied;
  });
  return serializeAdjustment(updated);
}

export async function rejectAdjustment(actor: ActorContext, adjustmentId: string) {
  await requirePermAudited(actor, "finance.approve_adjustment", "FinancialAdjustment");
  // Transactional with a row lock + in-transaction status re-check
  // (Phase 7 review F3): a reject racing an approve must fail with
  // a conflict once the approval has committed — never overwrite an
  // APPLIED adjustment whose journal already stands.
  const updated = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "app"."FinancialAdjustment" WHERE "id" = ${adjustmentId} FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundError("Adjustment not found");
    const adjustment = await tx.financialAdjustment.findUnique({ where: { id: adjustmentId } });
    if (!adjustment) throw new NotFoundError("Adjustment not found");
    if (adjustment.status !== "REQUESTED") {
      throw new ConflictError(`Adjustment is ${adjustment.status} and cannot be rejected`);
    }
    const row = await tx.financialAdjustment.update({
      where: { id: adjustmentId },
      data: { status: "REJECTED", approvedById: actor.userId },
    });
    await auditOps(actor, "finance.adjustment_rejected", "FinancialAdjustment", adjustmentId, {});
    return row;
  });
  return serializeAdjustment(updated);
}

function serializeAdjustment(adjustment: {
  id: string;
  targetType: string;
  targetId: string;
  amountPaisa: bigint;
  reason: string;
  status: string;
  ledgerJournalRef: string | null;
  createdAt: Date;
}) {
  return {
    id: adjustment.id,
    targetType: adjustment.targetType,
    targetId: adjustment.targetId,
    amountPaisa: adjustment.amountPaisa.toString(),
    reason: adjustment.reason,
    status: adjustment.status,
    ledgerJournalRef: adjustment.ledgerJournalRef,
    createdAt: adjustment.createdAt.toISOString(),
  };
}

export async function listAdjustments(
  actor: ActorContext,
  filters: { status?: string; page?: number; pageSize?: number } = {},
) {
  await requirePermAudited(actor, "finance.read", "FinancialAdjustment");
  const { skip, take, page, pageSize } = pageArgs(filters.page ?? 1, filters.pageSize ?? 25);
  const where: Prisma.FinancialAdjustmentWhereInput = filters.status ? { status: filters.status } : {};
  const [total, rows] = await Promise.all([
    prisma.financialAdjustment.count({ where }),
    prisma.financialAdjustment.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
  ]);
  return { items: rows.map(serializeAdjustment), meta: pageMeta(total, page, pageSize) };
}
