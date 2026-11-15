-- Phase 10 slice 2 hardening (docs/known-limitations.md dispositions):
-- F9   LedgerTransaction.notes — journal reversals store their reason.
-- F12e PaymentAllocation.refundedPaisa — refunds mark allocations
--      instead of shrinking/deleting them; the CHECK keeps the
--      refunded portion within the allocated amount.
-- F12b CodRemittance.idempotencyKey — retried submissions return the
--      original remittance (mirrors Payment.idempotencyKey).
-- F10  prevent_payment_rewrite now also guards invoiceId/orderId —
--      a payment could previously be re-pointed at another invoice
--      or order by direct UPDATE.
-- Ops  Notification category vocabulary gains DAILY_OPS_SUMMARY
--      (scripts/daily-ops-summary.ts, the daily-report replacement).

-- AlterTable
ALTER TABLE "CodRemittance" ADD COLUMN     "idempotencyKey" TEXT;

-- AlterTable
ALTER TABLE "LedgerTransaction" ADD COLUMN     "notes" TEXT;

-- AlterTable
ALTER TABLE "PaymentAllocation" ADD COLUMN     "refundedPaisa" BIGINT NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "CodRemittance_idempotencyKey_key" ON "CodRemittance"("idempotencyKey");

-- F12e: the refunded portion can never exceed (or go below) the
-- allocation it marks.
ALTER TABLE "PaymentAllocation"
  ADD CONSTRAINT "PaymentAllocation_refunded_check"
    CHECK ("refundedPaisa" >= 0 AND "refundedPaisa" <= "amountPaisa");

-- F10: extend the payment immutability guard to the invoice/order
-- links (previously omitted — a payment's recorded facts include
-- what it was recorded against).
CREATE OR REPLACE FUNCTION "app"."prevent_payment_rewrite"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."amountPaisa" IS DISTINCT FROM NEW."amountPaisa"
     OR OLD."method" IS DISTINCT FROM NEW."method"
     OR OLD."payerType" IS DISTINCT FROM NEW."payerType"
     OR OLD."payerCustomerId" IS DISTINCT FROM NEW."payerCustomerId"
     OR OLD."payerVendorId" IS DISTINCT FROM NEW."payerVendorId"
     OR OLD."transactionRef" IS DISTINCT FROM NEW."transactionRef"
     OR OLD."idempotencyKey" IS DISTINCT FROM NEW."idempotencyKey"
     OR OLD."recordedById" IS DISTINCT FROM NEW."recordedById"
     OR OLD."invoiceId" IS DISTINCT FROM NEW."invoiceId"
     OR OLD."orderId" IS DISTINCT FROM NEW."orderId"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'Payment recorded facts are immutable (financial-workflow §3)';
  END IF;
  RETURN NEW;
END;
$$;

-- Daily ops summary notification category.
ALTER TABLE "app"."Notification" DROP CONSTRAINT "Notification_category_chk";
ALTER TABLE "app"."Notification" ADD CONSTRAINT "Notification_category_chk"
  CHECK ("category" IN ('DELIVERY_OTP', 'DELIVERY_ASSIGNED',
    'OUT_FOR_DELIVERY', 'DELIVERED', 'INCIDENT_CREATED',
    'INCIDENT_ASSIGNED', 'INCIDENT_ESCALATED', 'TASK_ASSIGNED',
    'TICKET_RAISED', 'TICKET_REPLIED', 'TICKET_RESOLVED',
    'SETTLEMENT_PAID', 'RETURN_AUTHORISED', 'COD_DISCREPANCY',
    'GENERAL', 'DAILY_OPS_SUMMARY'));
