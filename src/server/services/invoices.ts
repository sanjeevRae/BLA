import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db/prisma";
import { AuthorizationError, type ActorContext } from "@/lib/auth/actor";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import { PAYMENT_METHODS, cashAccountForMethod } from "@/lib/finance/domain";
import {
  auditAccessDenied,
  isUniqueViolationOn,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import { auditOps } from "@/server/services/warehouse-ops-shared";
import {
  companyAccount,
  nextFinanceSequence,
  postJournal,
  reverseJournal,
  vendorPayableAccount,
  type LedgerLeg,
} from "@/server/services/finance-ledger";

/**
 * Invoices + payments (Phase 7; docs/financial-workflow.md §2–§3,
 * docs/database-schema.md §9).
 *
 * Generation bills DELIVERED shipments at their SNAPSHOTTED charge
 * (Shipment.shippingChargePaisa, frozen at booking — pricing rules
 * are never re-read) and is idempotent: the vendor row is locked for
 * the whole run, already-billed shipments are excluded by query, and
 * partial unique indexes on InvoiceLine are the DB backstop.
 * Invoice status is recomputed from its paid components (payment
 * allocations + SETTLED settlement coverage + applied credit-note
 * adjustments) — never edited by hand. OVERDUE is derived at read.
 */

type Tx = Prisma.TransactionClient;

/** Read filter value for the generation query (a delivered package
 * is one whose lifecycle status — written only by
 * PackageLifecycleService — reads DELIVERED). */
const DELIVERED_STATUS = "DELIVERED";

const moneyString = z
  .string()
  .regex(/^\d+$/, "Amounts are integer paisa")
  .transform((v) => BigInt(v));

export const generateInvoicesSchema = z.object({
  vendorId: z.string().uuid(),
  dueInDays: z.number().int().min(0).max(90).default(14),
});

export const recordPaymentSchema = z.object({
  amountPaisa: moneyString,
  method: z.enum(PAYMENT_METHODS),
  transactionRef: z.string().trim().min(1).max(120).optional(),
  idempotencyKey: z.string().trim().min(1).max(120).optional(),
  paidAt: z.coerce.date().optional(),
  allocations: z
    .array(z.object({ invoiceId: z.string().uuid(), amountPaisa: moneyString }))
    .min(1)
    .max(50),
});

export const voidInvoiceSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

// ---------------------------------------------------------------------------
// Paid components / status derivation
// ---------------------------------------------------------------------------

export type InvoicePaidComponents = {
  allocationsPaisa: bigint;
  settlementCoveragePaisa: bigint;
  adjustmentCreditsPaisa: bigint;
  totalPaidPaisa: bigint;
};

/** Everything that counts as "paid" against an invoice, derived
 * from the underlying records — never a stored figure. */
export async function invoicePaidComponents(
  db: Tx | typeof prisma,
  invoiceId: string,
): Promise<InvoicePaidComponents> {
  const [allocations, settlementLines, adjustments] = await Promise.all([
    // Phase 10 slice 2 (F12e): allocations are never shrunk by
    // refunds any more — the refunded portion is tracked on the row
    // and netted here, so paid derivation stays exact while the
    // original allocation history survives.
    db.paymentAllocation.aggregate({
      where: { invoiceId },
      _sum: { amountPaisa: true, refundedPaisa: true },
    }),
    db.vendorSettlementLine.aggregate({
      where: { invoiceId, kind: "SHIPPING_CHARGE", settlement: { status: "SETTLED" } },
      _sum: { amountPaisa: true },
    }),
    db.financialAdjustment.aggregate({
      where: { targetType: "INVOICE", targetId: invoiceId, status: "APPLIED" },
      _sum: { amountPaisa: true },
    }),
  ]);
  const allocationsPaisa =
    (allocations._sum.amountPaisa ?? BigInt(0)) -
    (allocations._sum.refundedPaisa ?? BigInt(0));
  const settlementCoveragePaisa = settlementLines._sum.amountPaisa ?? BigInt(0);
  const adjustmentCreditsPaisa = adjustments._sum.amountPaisa ?? BigInt(0);
  return {
    allocationsPaisa,
    settlementCoveragePaisa,
    adjustmentCreditsPaisa,
    totalPaidPaisa: allocationsPaisa + settlementCoveragePaisa + adjustmentCreditsPaisa,
  };
}

/** Amount of an invoice reserved by APPROVED (not yet paid)
 * settlements — unavailable for direct payment until the settlement
 * is paid or cancelled. */
export async function invoiceReservedPaisa(
  db: Tx | typeof prisma,
  invoiceId: string,
): Promise<bigint> {
  const reserved = await db.vendorSettlementLine.aggregate({
    where: { invoiceId, kind: "SHIPPING_CHARGE", settlement: { status: "APPROVED" } },
    _sum: { amountPaisa: true },
  });
  return reserved._sum.amountPaisa ?? BigInt(0);
}

export async function invoiceOutstandingPaisa(
  db: Tx | typeof prisma,
  invoice: { id: string; totalPaisa: bigint },
): Promise<bigint> {
  const paid = await invoicePaidComponents(db, invoice.id);
  const outstanding = invoice.totalPaisa - paid.totalPaidPaisa;
  return outstanding > BigInt(0) ? outstanding : BigInt(0);
}

/** Recompute an invoice's stored status from its paid components.
 * Terminal states (CANCELLED, REFUNDED-with-nothing-left is derived
 * below) are respected; OVERDUE is never stored. */
export async function recomputeInvoiceStatus(tx: Tx, invoiceId: string) {
  const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new NotFoundError("Invoice not found");
  if (invoice.status === "CANCELLED") return invoice;
  const paid = await invoicePaidComponents(tx, invoiceId);
  let next: string;
  if (paid.totalPaidPaisa >= invoice.totalPaisa) next = "PAID";
  else if (paid.totalPaidPaisa > BigInt(0)) next = "PARTIALLY_PAID";
  else {
    const processedRefund = await tx.refund.findFirst({
      where: {
        status: "PROCESSED",
        payment: { allocations: { some: { invoiceId } } },
      },
      select: { id: true },
    });
    next = processedRefund ? "REFUNDED" : "ISSUED";
  }
  if (next === invoice.status) return invoice;
  return tx.invoice.update({ where: { id: invoiceId }, data: { status: next } });
}

/** Order paymentStatus rollup (schema §5): derived from the order's
 * invoices, which are themselves derived from allocations. Orders
 * with no invoices keep their current status. */
export async function recomputeOrderPaymentStatus(tx: Tx, orderId: string) {
  const invoices = await tx.invoice.findMany({
    where: {
      status: { not: "CANCELLED" },
      OR: [{ orderId }, { lines: { some: { orderId } } }],
    },
    select: { id: true, totalPaisa: true, status: true },
  });
  if (invoices.length === 0) return;
  let anyPaid = false;
  let allPaid = true;
  let anyRefunded = false;
  for (const invoice of invoices) {
    const paid = await invoicePaidComponents(tx, invoice.id);
    if (paid.totalPaidPaisa > BigInt(0)) anyPaid = true;
    if (paid.totalPaidPaisa < invoice.totalPaisa) allPaid = false;
    if (invoice.status === "REFUNDED") anyRefunded = true;
  }
  const next = allPaid ? "PAID" : anyPaid ? "PARTIAL" : anyRefunded ? "REFUNDED" : "UNPAID";
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { paymentStatus: true } });
  if (order && order.paymentStatus !== next) {
    await tx.order.update({ where: { id: orderId }, data: { paymentStatus: next } });
  }
}

/** Read-time status: OVERDUE is derived from dueAt, never stored. */
export function effectiveInvoiceStatus(invoice: { status: string; dueAt: Date | null }): string {
  if (
    (invoice.status === "ISSUED" || invoice.status === "PARTIALLY_PAID") &&
    invoice.dueAt &&
    invoice.dueAt.getTime() < Date.now()
  ) {
    return "OVERDUE";
  }
  return invoice.status;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export type InvoiceView = {
  id: string;
  invoiceNumber: string;
  orderId: string | null;
  vendorId: string | null;
  customerId: string | null;
  vendorName: string | null;
  subtotalPaisa: string;
  discountPaisa: string;
  taxPaisa: string;
  totalPaisa: string;
  paidPaisa: string;
  outstandingPaisa: string;
  status: string;
  issuedAt: string;
  dueAt: string | null;
};

function toInvoiceView(
  invoice: {
    id: string;
    invoiceNumber: string;
    orderId: string | null;
    vendorId: string | null;
    customerId: string | null;
    vendor: { businessName: string } | null;
    subtotalPaisa: bigint;
    discountPaisa: bigint;
    taxPaisa: bigint;
    totalPaisa: bigint;
    status: string;
    issuedAt: Date;
    dueAt: Date | null;
  },
  paidPaisa: bigint,
): InvoiceView {
  const outstanding = invoice.totalPaisa - paidPaisa;
  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    orderId: invoice.orderId,
    vendorId: invoice.vendorId,
    customerId: invoice.customerId,
    vendorName: invoice.vendor?.businessName ?? null,
    subtotalPaisa: invoice.subtotalPaisa.toString(),
    discountPaisa: invoice.discountPaisa.toString(),
    taxPaisa: invoice.taxPaisa.toString(),
    totalPaisa: invoice.totalPaisa.toString(),
    paidPaisa: paidPaisa.toString(),
    outstandingPaisa: (outstanding > BigInt(0) ? outstanding : BigInt(0)).toString(),
    status: effectiveInvoiceStatus(invoice),
    issuedAt: invoice.issuedAt.toISOString(),
    dueAt: invoice.dueAt?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Generate one invoice for a vendor covering every fully-DELIVERED,
 * not-yet-billed shipment at its snapshotted charge, plus completed
 * vendor-borne return charges. Idempotent: safe to re-run and safe
 * under concurrent runs (vendor row lock + partial unique indexes).
 * Returns null when there is nothing new to bill.
 */
export async function generateVendorInvoice(
  actor: ActorContext,
  input: unknown,
): Promise<InvoiceView | null> {
  await requirePermAudited(actor, "invoice.create", "Invoice");
  const data = parse(generateInvoicesSchema, input);

  const result = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "app"."Vendor" WHERE "id" = ${data.vendorId} FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError("Vendor not found");

    const shipments = await tx.shipment.findMany({
      where: {
        order: { vendorId: data.vendorId },
        packages: { some: {}, every: { operationalStatus: DELIVERED_STATUS } },
        invoiceLines: { none: { kind: "SHIPPING_CHARGE" } },
      },
      select: { id: true, shipmentNumber: true, shippingChargePaisa: true, orderId: true },
      orderBy: { createdAt: "asc" },
    });
    const returns = await tx.returnRequest.findMany({
      where: {
        status: "COMPLETED",
        chargeBearer: "VENDOR",
        invoiceLines: { none: { kind: "RETURN_CHARGE" } },
        package: { shipment: { order: { vendorId: data.vendorId } } },
      },
      select: {
        id: true,
        returnNumber: true,
        chargeAmountPaisa: true,
        packageId: true,
        shipmentId: true,
        orderId: true,
      },
      orderBy: { createdAt: "asc" },
    });
    if (shipments.length === 0 && returns.length === 0) return null;

    const lines: Prisma.InvoiceLineCreateWithoutInvoiceInput[] = [];
    let subtotal = BigInt(0);
    for (const shipment of shipments) {
      subtotal += shipment.shippingChargePaisa;
      lines.push({
        kind: "SHIPPING_CHARGE",
        description: `Shipping charge — shipment ${shipment.shipmentNumber}`,
        amountPaisa: shipment.shippingChargePaisa,
        shipment: { connect: { id: shipment.id } },
        order: { connect: { id: shipment.orderId } },
      });
    }
    for (const ret of returns) {
      subtotal += ret.chargeAmountPaisa;
      lines.push({
        kind: "RETURN_CHARGE",
        description: `Return charge — ${ret.returnNumber}`,
        amountPaisa: ret.chargeAmountPaisa,
        returnRequest: { connect: { id: ret.id } },
        shipment: { connect: { id: ret.shipmentId } },
        package: { connect: { id: ret.packageId } },
        order: { connect: { id: ret.orderId } },
      });
    }

    const seq = await nextFinanceSequence(tx, "invoice_number_seq");
    const invoiceNumber = `INV-${seq.toString()}`;
    const dueAt = new Date(Date.now() + data.dueInDays * 24 * 60 * 60 * 1000);
    const invoice = await tx.invoice.create({
      data: {
        invoiceNumber,
        vendorId: data.vendorId,
        subtotalPaisa: subtotal,
        discountPaisa: BigInt(0),
        taxPaisa: BigInt(0),
        totalPaisa: subtotal,
        status: "ISSUED",
        dueAt,
        issuedById: actor.userId,
        lines: { create: lines },
      },
      include: { vendor: { select: { businessName: true } }, lines: true },
    });

    // Accrual: the vendor's payable absorbs the charge against
    // shipping revenue (financial-workflow §2: invoicing creates the
    // receivable/payable entries immediately).
    const payable = await vendorPayableAccount(tx, data.vendorId);
    const revenue = await companyAccount(tx, "SHIPPING_REVENUE");
    const accrualLegs: LedgerLeg[] = [];
    for (const line of invoice.lines) {
      // Zero-charge lines (free-shipping shipments) stay on the
      // invoice but post no accrual legs (Phase 7 review F11):
      // postJournal rejects non-positive amounts, and one
      // zero-charge delivery must not roll back the vendor's whole
      // billing run.
      if (line.amountPaisa === BigInt(0)) continue;
      accrualLegs.push({
        accountCode: payable.code,
        direction: "DEBIT",
        amountPaisa: line.amountPaisa,
        type: "SHIPPING_CHARGE",
        invoiceId: invoice.id,
        orderId: line.orderId,
      });
      accrualLegs.push({
        accountCode: revenue.code,
        direction: "CREDIT",
        amountPaisa: line.amountPaisa,
        type: "SHIPPING_CHARGE",
        invoiceId: invoice.id,
        orderId: line.orderId,
      });
    }
    if (accrualLegs.length > 0) {
      await postJournal(tx, {
        journalRef: invoiceNumber,
        actorId: actor.userId,
        legs: accrualLegs,
      });
    }

    await auditOps(actor, "invoice.generated", "Invoice", invoice.id, {
      after: {
        invoiceNumber,
        vendorId: data.vendorId,
        totalPaisa: subtotal.toString(),
        lineCount: invoice.lines.length,
      },
    });
    return invoice;
  });

  if (!result) return null;
  const paid = await invoicePaidComponents(prisma, result.id);
  return toInvoiceView(result, paid.totalPaidPaisa);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function invoiceScope(actor: ActorContext): Prisma.InvoiceWhereInput {
  if (actor.vendorId) return { vendorId: actor.vendorId };
  if (actor.customerId) return { customerId: actor.customerId };
  return {};
}

export async function listInvoices(
  actor: ActorContext,
  filters: { vendorId?: string; status?: string; search?: string; page?: number; pageSize?: number } = {},
) {
  await requirePermAudited(actor, "invoice.read", "Invoice");
  if (actor.vendorId && filters.vendorId && filters.vendorId !== actor.vendorId) {
    await auditAccessDenied(actor, "Invoice", {
      entityId: null,
      reason: "vendor_scope_other_vendor_list",
    });
    throw new AuthorizationError("Vendors can only list their own invoices");
  }
  if (actor.customerId && filters.vendorId) {
    await auditAccessDenied(actor, "Invoice", {
      entityId: null,
      reason: "customer_scope_vendor_list",
    });
    throw new AuthorizationError("Customers cannot list vendor invoices");
  }
  const { skip, take, page, pageSize } = pageArgs(filters.page ?? 1, filters.pageSize ?? 25);
  const conditions: Prisma.InvoiceWhereInput[] = [invoiceScope(actor)];
  if (filters.vendorId) conditions.push({ vendorId: filters.vendorId });
  if (filters.status && filters.status !== "OVERDUE") conditions.push({ status: filters.status });
  if (filters.search) {
    conditions.push({ invoiceNumber: { contains: filters.search, mode: "insensitive" } });
  }
  const where: Prisma.InvoiceWhereInput = { AND: conditions };
  const [total, rows] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where,
      include: { vendor: { select: { businessName: true } } },
      orderBy: { issuedAt: "desc" },
      skip,
      take,
    }),
  ]);
  const views: InvoiceView[] = [];
  for (const row of rows) {
    const paid = await invoicePaidComponents(prisma, row.id);
    const view = toInvoiceView(row, paid.totalPaidPaisa);
    if (filters.status === "OVERDUE" && view.status !== "OVERDUE") continue;
    views.push(view);
  }
  return { items: views, meta: pageMeta(total, page, pageSize) };
}

export type InvoiceDetailView = InvoiceView & {
  lines: {
    id: string;
    kind: string;
    description: string;
    amountPaisa: string;
    shipmentId: string | null;
    orderId: string | null;
    returnRequestId: string | null;
  }[];
  payments: {
    paymentId: string;
    amountPaisa: string;
    method: string;
    status: string;
    paidAt: string | null;
    transactionRef: string | null;
  }[];
  settlementCoveragePaisa: string;
  adjustmentCreditsPaisa: string;
  reservedPaisa: string;
};

export async function getInvoice(actor: ActorContext, invoiceId: string): Promise<InvoiceDetailView> {
  await requirePermAudited(actor, "invoice.read", "Invoice");
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      vendor: { select: { businessName: true } },
      lines: { orderBy: { createdAt: "asc" } },
      allocations: {
        include: { payment: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!invoice) throw new NotFoundError("Invoice not found");
  if (actor.vendorId && invoice.vendorId !== actor.vendorId) {
    await auditAccessDenied(actor, "Invoice", {
      entityId: invoiceId,
      reason: "vendor_scope_other_vendor_invoice",
    });
    throw new AuthorizationError("Vendors can only view their own invoices");
  }
  if (actor.customerId && invoice.customerId !== actor.customerId) {
    await auditAccessDenied(actor, "Invoice", {
      entityId: invoiceId,
      reason: "customer_scope_other_customer_invoice",
    });
    throw new AuthorizationError("Customers can only view their own invoices");
  }
  const paid = await invoicePaidComponents(prisma, invoice.id);
  const reserved = await invoiceReservedPaisa(prisma, invoice.id);
  const base = toInvoiceView(invoice, paid.totalPaidPaisa);
  return {
    ...base,
    lines: invoice.lines.map((line) => ({
      id: line.id,
      kind: line.kind,
      description: line.description,
      amountPaisa: line.amountPaisa.toString(),
      shipmentId: line.shipmentId,
      orderId: line.orderId,
      returnRequestId: line.returnRequestId,
    })),
    payments: invoice.allocations.map((allocation) => ({
      paymentId: allocation.paymentId,
      amountPaisa: allocation.amountPaisa.toString(),
      method: allocation.payment.method,
      status: allocation.payment.status,
      paidAt: allocation.payment.paidAt?.toISOString() ?? null,
      transactionRef: allocation.payment.transactionRef,
    })),
    settlementCoveragePaisa: paid.settlementCoveragePaisa.toString(),
    adjustmentCreditsPaisa: paid.adjustmentCreditsPaisa.toString(),
    reservedPaisa: reserved.toString(),
  };
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

export type PaymentView = {
  id: string;
  amountPaisa: string;
  method: string;
  status: string;
  payerType: string;
  transactionRef: string | null;
  paidAt: string | null;
  allocations: { invoiceId: string; amountPaisa: string }[];
};

/**
 * Phase 2 (V2) C3 — request fingerprint for idempotent payments.
 * SHA-256 hex of a canonical JSON payload built from the
 * CLIENT-CONTROLLED fields only: amountPaisa (string), method,
 * transactionRef (null when absent), allocations sorted by
 * invoiceId as [{ invoiceId, amountPaisa (string) }], and paidAt
 * (security review F-1): a client-supplied paidAt is stored on the
 * payment and becomes the journal's occurredAt, so it is part of
 * the payload identity — two requests differing only in paidAt are
 * different payments. When the client omits paidAt the canonical
 * value is null: the stored value is server-defaulted at creation,
 * and a faithful retry reproduces the omission, so legitimate
 * retries still match.
 */
function paymentRequestFingerprint(data: {
  amountPaisa: bigint;
  method: string;
  transactionRef?: string | null;
  paidAt?: Date | null;
  allocations: { invoiceId: string; amountPaisa: bigint }[];
}): string {
  const canonical = {
    amountPaisa: data.amountPaisa.toString(),
    method: data.method,
    transactionRef: data.transactionRef ?? null,
    paidAt: data.paidAt ? data.paidAt.toISOString() : null,
    allocations: [...data.allocations]
      .sort((a, b) => (a.invoiceId < b.invoiceId ? -1 : a.invoiceId > b.invoiceId ? 1 : 0))
      .map((a) => ({ invoiceId: a.invoiceId, amountPaisa: a.amountPaisa.toString() })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Phase 2 (V2) C3 — when an idempotency replay finds an existing
 * payment, the stored fingerprint decides: a match returns the
 * original payment exactly as before; a mismatch means the key was
 * reused with a DIFFERENT payload — a conflict, not a replay.
 *
 * Security review F-2: rows recorded before fingerprints existed
 * carry requestFingerprint = NULL and are NOT exempt — amount,
 * method, transactionRef and allocations are all persisted, so the
 * expected fingerprint is derived from the stored row and compared
 * against the incoming request's legacy fingerprint. paidAt is
 * excluded on BOTH sides for legacy rows only: a legacy row cannot
 * distinguish a client-supplied paidAt from the server default, so
 * that one field is uncheckable for them; every money-bearing
 * field is checked.
 */
function assertFingerprintMatches(
  existing: {
    requestFingerprint: string | null;
    amountPaisa: bigint;
    method: string;
    transactionRef: string | null;
    allocations: { invoiceId: string; amountPaisa: bigint }[];
  },
  computed: string,
  computedLegacy: string,
) {
  const matches =
    existing.requestFingerprint !== null
      ? existing.requestFingerprint === computed
      : paymentRequestFingerprint({
          amountPaisa: existing.amountPaisa,
          method: existing.method,
          transactionRef: existing.transactionRef,
          paidAt: null,
          allocations: existing.allocations,
        }) === computedLegacy;
  if (!matches) {
    throw new ConflictError(
      "Idempotency key was reused with a different payment payload — the original payment was recorded with different amount, method, transaction reference, payment date or allocations",
    );
  }
}

/**
 * Record a payment and allocate it across invoices
 * (financial-workflow §3). One transaction: idempotency replay
 * returns the original payment untouched (Scenario 12); invoice rows
 * are locked before outstanding checks so concurrent payments cannot
 * overpay; the balanced ledger journal posts in the same commit.
 * Overpayment beyond an invoice's outstanding (net of amounts
 * reserved by APPROVED settlements) is rejected — credit balances
 * are never created implicitly; corrections go through refunds and
 * adjustments.
 */
export async function recordPayment(actor: ActorContext, input: unknown): Promise<PaymentView> {
  await requirePermAudited(actor, "finance.record_payment", "Payment");
  const data = parse(recordPaymentSchema, input);

  const allocatedTotal = data.allocations.reduce((sum, a) => sum + a.amountPaisa, BigInt(0));
  if (data.amountPaisa <= BigInt(0)) throw new DomainValidationError("Payment amount must be positive");
  if (allocatedTotal > data.amountPaisa) {
    throw new DomainValidationError("Allocations cannot exceed the payment amount");
  }
  const seenInvoices = new Set<string>();
  for (const allocation of data.allocations) {
    if (allocation.amountPaisa <= BigInt(0)) {
      throw new DomainValidationError("Allocation amounts must be positive");
    }
    if (seenInvoices.has(allocation.invoiceId)) {
      throw new DomainValidationError("Duplicate invoice in allocations");
    }
    seenInvoices.add(allocation.invoiceId);
  }

  // Phase 2 (V2) C3: fingerprint of this request's client-controlled
  // payload — compared at every replay checkpoint below and stored
  // on the created payment so a later reuse of the key can be told
  // apart from a faithful retry.
  const requestFingerprint = paymentRequestFingerprint(data);
  // Security review F-2: the legacy comparison fingerprint — the
  // same canonical payload with paidAt excluded, used only when the
  // existing row predates fingerprints (see assertFingerprintMatches).
  const legacyRequestFingerprint = paymentRequestFingerprint({ ...data, paidAt: null });

  try {
    return await prisma.$transaction(async (tx) => {
      if (data.idempotencyKey) {
        const existing = await tx.payment.findUnique({
          where: { idempotencyKey: data.idempotencyKey },
          include: { allocations: true },
        });
        if (existing) {
          // Phase 2 (V2) C3: a replay is only a replay when the
          // payload matches — a reused key with a different payload
          // is a conflict (see assertFingerprintMatches).
          assertFingerprintMatches(existing, requestFingerprint, legacyRequestFingerprint);
          return {
            id: existing.id,
            amountPaisa: existing.amountPaisa.toString(),
            method: existing.method,
            status: existing.status,
            payerType: existing.payerType,
            transactionRef: existing.transactionRef,
            paidAt: existing.paidAt?.toISOString() ?? null,
            allocations: existing.allocations.map((a) => ({
              invoiceId: a.invoiceId,
              amountPaisa: a.amountPaisa.toString(),
            })),
          };
        }
      }

      const invoiceIds = [...seenInvoices].sort();
      const invoices = [];
      for (const id of invoiceIds) {
        const rows = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "app"."Invoice" WHERE "id" = ${id} FOR UPDATE`;
        if (rows.length === 0) throw new NotFoundError(`Invoice ${id} not found`);
        const invoice = await tx.invoice.findUnique({ where: { id } });
        if (!invoice) throw new NotFoundError(`Invoice ${id} not found`);
        invoices.push(invoice);
      }

      if (data.idempotencyKey) {
        // F8 (Phase 10 slice 2): re-check the key AFTER the invoice
        // row locks are held. A concurrent twin transaction blocked
        // on those locks ran its first check before the winner
        // committed; serialized here, the winner's payment is now
        // visible and the replay returns it instead of dying on the
        // (now zero) outstanding-balance check.
        // Phase 2 (V2) C3 extends the re-check: the winner is only
        // returned when this request's fingerprint matches the
        // winner's — concurrent submissions that share a key but
        // carry different payloads conflict here instead of silently
        // collapsing into whichever payment won the race.
        const winner = await tx.payment.findUnique({
          where: { idempotencyKey: data.idempotencyKey },
          include: { allocations: true },
        });
        if (winner) {
          assertFingerprintMatches(winner, requestFingerprint, legacyRequestFingerprint);
          return {
            id: winner.id,
            amountPaisa: winner.amountPaisa.toString(),
            method: winner.method,
            status: winner.status,
            payerType: winner.payerType,
            transactionRef: winner.transactionRef,
            paidAt: winner.paidAt?.toISOString() ?? null,
            allocations: winner.allocations.map((a) => ({
              invoiceId: a.invoiceId,
              amountPaisa: a.amountPaisa.toString(),
            })),
          };
        }
      }

      const vendorIds = new Set(invoices.map((i) => i.vendorId).filter(Boolean));
      const customerIds = new Set(invoices.map((i) => i.customerId).filter(Boolean));
      if (vendorIds.size + customerIds.size !== 1) {
        throw new DomainValidationError("All allocated invoices must belong to one payer");
      }
      const payerVendorId = vendorIds.size === 1 ? [...vendorIds][0]! : null;
      const payerCustomerId = customerIds.size === 1 ? [...customerIds][0]! : null;

      for (const invoice of invoices) {
        if (invoice.status === "CANCELLED" || invoice.status === "REFUNDED") {
          throw new DomainValidationError(`Invoice ${invoice.invoiceNumber} is ${invoice.status} and cannot take payments`);
        }
        const allocation = data.allocations.find((a) => a.invoiceId === invoice.id)!;
        const paid = await invoicePaidComponents(tx, invoice.id);
        const reserved = await invoiceReservedPaisa(tx, invoice.id);
        const available = invoice.totalPaisa - paid.totalPaidPaisa - reserved;
        if (allocation.amountPaisa > available) {
          throw new DomainValidationError(
            `Payment of ${allocation.amountPaisa} exceeds the outstanding ${available} on invoice ${invoice.invoiceNumber}`,
          );
        }
      }

      const orderIds = new Set(invoices.map((i) => i.orderId).filter(Boolean));
      const paidAt = data.paidAt ?? new Date();
      const payment = await tx.payment.create({
        data: {
          orderId: orderIds.size === 1 ? [...orderIds][0]! : null,
          invoiceId: invoices.length === 1 ? invoices[0]!.id : null,
          payerType: payerVendorId ? "VENDOR" : "CUSTOMER",
          payerCustomerId,
          payerVendorId,
          amountPaisa: data.amountPaisa,
          method: data.method,
          status: "PAID",
          transactionRef: data.transactionRef ?? null,
          idempotencyKey: data.idempotencyKey ?? null,
          requestFingerprint,
          paidAt,
          recordedById: actor.userId,
          allocations: {
            create: data.allocations.map((a) => ({
              invoiceId: a.invoiceId,
              amountPaisa: a.amountPaisa,
              allocatedById: actor.userId,
            })),
          },
        },
        include: { allocations: true },
      });

      const cashAccount = await companyAccount(tx, cashAccountForMethod(data.method));
      const creditAccount = payerVendorId
        ? await vendorPayableAccount(tx, payerVendorId)
        : await companyAccount(tx, "ACCOUNTS_RECEIVABLE");
      await postJournal(tx, {
        journalRef: `PAY-${payment.id}`,
        actorId: actor.userId,
        occurredAt: paidAt,
        legs: [
          {
            accountCode: cashAccount.code,
            direction: "DEBIT",
            amountPaisa: data.amountPaisa,
            type: "PAYMENT_RECEIVED",
            paymentId: payment.id,
            paymentMethod: data.method,
            invoiceId: invoices.length === 1 ? invoices[0]!.id : null,
            orderId: payment.orderId,
          },
          {
            accountCode: creditAccount.code,
            direction: "CREDIT",
            amountPaisa: data.amountPaisa,
            type: "PAYMENT_RECEIVED",
            paymentId: payment.id,
            paymentMethod: data.method,
            invoiceId: invoices.length === 1 ? invoices[0]!.id : null,
            orderId: payment.orderId,
          },
        ],
      });

      const orderIdsToRollup = new Set<string>();
      for (const invoice of invoices) {
        await recomputeInvoiceStatus(tx, invoice.id);
        if (invoice.orderId) orderIdsToRollup.add(invoice.orderId);
        const lineOrders = await tx.invoiceLine.findMany({
          where: { invoiceId: invoice.id, orderId: { not: null } },
          select: { orderId: true },
          distinct: ["orderId"],
        });
        for (const line of lineOrders) if (line.orderId) orderIdsToRollup.add(line.orderId);
      }
      for (const orderId of orderIdsToRollup) await recomputeOrderPaymentStatus(tx, orderId);

      await auditOps(actor, "payment.recorded", "Payment", payment.id, {
        after: {
          amountPaisa: data.amountPaisa.toString(),
          method: data.method,
          payerType: payment.payerType,
          invoiceIds,
        },
      });

      return {
        id: payment.id,
        amountPaisa: payment.amountPaisa.toString(),
        method: payment.method,
        status: payment.status,
        payerType: payment.payerType,
        transactionRef: payment.transactionRef,
        paidAt: payment.paidAt?.toISOString() ?? null,
        allocations: payment.allocations.map((a) => ({
          invoiceId: a.invoiceId,
          amountPaisa: a.amountPaisa.toString(),
        })),
      };
    });
  } catch (error) {
    if (isUniqueViolationOn(error, "transactionRef")) {
      throw new ConflictError("A payment with this transaction reference already exists");
    }
    if (isUniqueViolationOn(error, "idempotencyKey")) {
      // Phase 10 slice 2 (F8-finance): the sequential replay at the
      // top of the transaction returns the original payment, but
      // two CONCURRENT submissions with the same key both pass that
      // check and the loser dies here on the unique index. A retry
      // with the same key is the same payment — return the winner's
      // record instead of an error (Scenario 12 semantics).
      if (data.idempotencyKey) {
        const existing = await prisma.payment.findUnique({
          where: { idempotencyKey: data.idempotencyKey },
          include: { allocations: true },
        });
        if (existing) {
          // Phase 2 (V2) C3: the unique-index loser path obeys the
          // same fingerprint rule as the in-transaction checkpoints
          // — a different payload under the winner's key conflicts
          // rather than returning the winner's payment.
          assertFingerprintMatches(existing, requestFingerprint, legacyRequestFingerprint);
          return {
            id: existing.id,
            amountPaisa: existing.amountPaisa.toString(),
            method: existing.method,
            status: existing.status,
            payerType: existing.payerType,
            transactionRef: existing.transactionRef,
            paidAt: existing.paidAt?.toISOString() ?? null,
            allocations: existing.allocations.map((a) => ({
              invoiceId: a.invoiceId,
              amountPaisa: a.amountPaisa.toString(),
            })),
          };
        }
      }
      throw new ConflictError("A payment with this idempotency key already exists");
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Void (compensating path — never a delete)
// ---------------------------------------------------------------------------

/** Void an ISSUED invoice with no payments/coverage: the accrual
 * journal is reversed with mirror entries and the invoice moves to
 * CANCELLED. Lines and the original journal remain untouched. */
export async function voidInvoice(actor: ActorContext, invoiceId: string, input: unknown) {
  await requirePermAudited(actor, "invoice.create", "Invoice");
  const data = parse(voidInvoiceSchema, input);
  const updated = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "app"."Invoice" WHERE "id" = ${invoiceId} FOR UPDATE`;
    if (rows.length === 0) throw new NotFoundError("Invoice not found");
    const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
    if (!invoice) throw new NotFoundError("Invoice not found");
    if (invoice.status === "CANCELLED") throw new ConflictError("Invoice is already cancelled");
    const paid = await invoicePaidComponents(tx, invoiceId);
    if (paid.totalPaidPaisa > BigInt(0)) {
      throw new DomainValidationError(
        "An invoice with payments or settlement coverage cannot be voided — use a credit-note adjustment",
      );
    }
    const reserved = await invoiceReservedPaisa(tx, invoiceId);
    if (reserved > BigInt(0)) {
      throw new DomainValidationError("Invoice is reserved by an approved settlement and cannot be voided");
    }
    await reverseJournal(tx, { journalRef: invoice.invoiceNumber, actorId: actor.userId, reason: data.reason });
    const cancelled = await tx.invoice.update({
      where: { id: invoiceId },
      data: { status: "CANCELLED", notes: data.reason },
    });
    await auditOps(actor, "invoice.voided", "Invoice", invoiceId, {
      before: { status: invoice.status },
      after: { status: "CANCELLED", reason: data.reason },
    });
    return cancelled;
  });
  const paid = await invoicePaidComponents(prisma, updated.id);
  return toInvoiceView(
    { ...updated, vendor: null },
    paid.totalPaidPaisa,
  );
}
