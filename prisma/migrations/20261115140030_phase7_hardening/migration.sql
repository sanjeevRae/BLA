-- Phase 7 hardening (docs/financial-workflow.md, docs/cod-reconciliation.md,
-- docs/database-schema.md §9): business-reference sequences, vocabulary
-- CHECK constraints, idempotency / one-time-coverage partial unique
-- indexes, and the append-only enforcement for the ledger. Applied
-- after 20261115140000_phase7_finance.

-- Business references ---------------------------------------------------------
CREATE SEQUENCE "app"."invoice_number_seq" START WITH 1001;
CREATE SEQUENCE "app"."remittance_number_seq" START WITH 1001;
CREATE SEQUENCE "app"."settlement_number_seq" START WITH 1001;
CREATE SEQUENCE "app"."ledger_reference_seq" START WITH 100001;

-- FinancialAccount ------------------------------------------------------------
ALTER TABLE "FinancialAccount"
  ADD CONSTRAINT "FinancialAccount_kind_check"
    CHECK ("kind" IN ('ASSET', 'LIABILITY', 'REVENUE', 'EXPENSE')),
  ADD CONSTRAINT "FinancialAccount_ownerType_check"
    CHECK ("ownerType" IN ('COMPANY', 'VENDOR', 'DRIVER')),
  ADD CONSTRAINT "FinancialAccount_currency_check"
    CHECK ("currency" = 'NPR');

-- LedgerTransaction -----------------------------------------------------------
ALTER TABLE "LedgerTransaction"
  ADD CONSTRAINT "LedgerTransaction_direction_check"
    CHECK ("direction" IN ('DEBIT', 'CREDIT')),
  ADD CONSTRAINT "LedgerTransaction_type_check"
    CHECK ("type" IN ('SHIPPING_CHARGE', 'PAYMENT_RECEIVED', 'COD_COLLECTED',
                      'COD_REMITTED', 'COD_SETTLED', 'REFUND', 'ADJUSTMENT',
                      'REVERSAL', 'DRIVER_PAYOUT')),
  ADD CONSTRAINT "LedgerTransaction_amount_check"
    CHECK ("amountPaisa" > 0),
  ADD CONSTRAINT "LedgerTransaction_currency_check"
    CHECK ("currency" = 'NPR');

-- Append-only: no role can update, delete or truncate the ledger —
-- corrections are new linked entries (financial-workflow §4).
CREATE TRIGGER "LedgerTransaction_no_update"
  BEFORE UPDATE ON "LedgerTransaction"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "LedgerTransaction_no_delete"
  BEFORE DELETE ON "LedgerTransaction"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "LedgerTransaction_no_truncate"
  BEFORE TRUNCATE ON "LedgerTransaction"
  FOR EACH STATEMENT EXECUTE FUNCTION "app"."prevent_history_rewrite"();

-- Invoice ---------------------------------------------------------------------
ALTER TABLE "Invoice"
  ADD CONSTRAINT "Invoice_status_check"
    CHECK ("status" IN ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE',
                        'CANCELLED', 'REFUNDED')),
  ADD CONSTRAINT "Invoice_amounts_check"
    CHECK ("subtotalPaisa" >= 0 AND "discountPaisa" >= 0 AND "taxPaisa" >= 0
           AND "totalPaisa" = "subtotalPaisa" - "discountPaisa" + "taxPaisa"),
  ADD CONSTRAINT "Invoice_currency_check"
    CHECK ("currency" = 'NPR');

ALTER TABLE "InvoiceLine"
  ADD CONSTRAINT "InvoiceLine_kind_check"
    CHECK ("kind" IN ('SHIPPING_CHARGE', 'RETURN_CHARGE', 'ADJUSTMENT')),
  ADD CONSTRAINT "InvoiceLine_amount_check"
    CHECK ("amountPaisa" >= 0);

-- A shipment's forward shipping charge is billed at most once, and a
-- vendor-borne return charge likewise (invoice-generation idempotency
-- backstop; the service also checks under the vendor row lock).
CREATE UNIQUE INDEX "InvoiceLine_one_charge_per_shipment"
  ON "InvoiceLine" ("shipmentId")
  WHERE "kind" = 'SHIPPING_CHARGE' AND "shipmentId" IS NOT NULL;
CREATE UNIQUE INDEX "InvoiceLine_one_charge_per_return"
  ON "InvoiceLine" ("returnRequestId")
  WHERE "kind" = 'RETURN_CHARGE' AND "returnRequestId" IS NOT NULL;

-- Payment ---------------------------------------------------------------------
ALTER TABLE "Payment"
  ADD CONSTRAINT "Payment_payerType_check"
    CHECK ("payerType" IN ('CUSTOMER', 'VENDOR', 'COMPANY')),
  ADD CONSTRAINT "Payment_method_check"
    CHECK ("method" IN ('CASH', 'BANK_TRANSFER', 'MOBILE_WALLET',
                        'ONLINE_GATEWAY', 'PREPAID_BALANCE', 'CREDIT_ACCOUNT')),
  ADD CONSTRAINT "Payment_status_check"
    CHECK ("status" IN ('PENDING', 'PAID', 'FAILED', 'REFUNDED',
                        'PARTIALLY_REFUNDED', 'DISPUTED', 'REVERSED')),
  ADD CONSTRAINT "Payment_amount_check"
    CHECK ("amountPaisa" > 0),
  ADD CONSTRAINT "Payment_currency_check"
    CHECK ("currency" = 'NPR');

-- Duplicate gateway callbacks / manual references collide safely
-- (database-schema §9; legacy transaction_ref had no uniqueness).
CREATE UNIQUE INDEX "Payment_transactionRef_unique"
  ON "Payment" ("transactionRef")
  WHERE "transactionRef" IS NOT NULL;

-- A payment's recorded facts are immutable; only its status (and
-- paidAt) may move, driven by finance services (refunds). Deletes are
-- impossible for any role.
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
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'Payment recorded facts are immutable (financial-workflow §3)';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "Payment_no_delete"
  BEFORE DELETE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "Payment_no_rewrite"
  BEFORE UPDATE ON "Payment"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_payment_rewrite"();

ALTER TABLE "PaymentAllocation"
  ADD CONSTRAINT "PaymentAllocation_amount_check"
    CHECK ("amountPaisa" > 0);

-- CodRemittance ---------------------------------------------------------------
ALTER TABLE "CodRemittance"
  ADD CONSTRAINT "CodRemittance_status_check"
    CHECK ("status" IN ('SUBMITTED', 'UNDER_VERIFICATION', 'VERIFIED',
                        'DISCREPANCY', 'CLOSED')),
  ADD CONSTRAINT "CodRemittance_method_check"
    CHECK ("method" IN ('CASH', 'MOBILE_WALLET', 'BANK_TRANSFER')),
  ADD CONSTRAINT "CodRemittance_resolution_check"
    CHECK ("resolution" IS NULL OR "resolution" IN ('ACCEPTED_COUNTED', 'REJECTED')),
  ADD CONSTRAINT "CodRemittance_amounts_check"
    CHECK ("declaredAmountPaisa" >= 0
           AND ("countedAmountPaisa" IS NULL OR "countedAmountPaisa" >= 0));

ALTER TABLE "CodRemittanceLine"
  ADD CONSTRAINT "CodRemittanceLine_amounts_check"
    CHECK ("expectedPaisa" >= 0 AND "collectedPaisa" >= 0
           AND ("verifiedPaisa" IS NULL
                OR ("verifiedPaisa" >= 0 AND "verifiedPaisa" <= "collectedPaisa")));

-- VendorSettlement --------------------------------------------------------------
ALTER TABLE "VendorSettlement"
  ADD CONSTRAINT "VendorSettlement_status_check"
    CHECK ("status" IN ('PENDING', 'RECONCILED', 'APPROVED', 'SETTLED',
                        'DISPUTED', 'CANCELLED')),
  ADD CONSTRAINT "VendorSettlement_amounts_check"
    CHECK ("grossCodPaisa" >= 0 AND "shippingChargesPaisa" >= 0
           AND "otherDeductionsPaisa" >= 0
           AND "netPayablePaisa" = "grossCodPaisa" - "shippingChargesPaisa"
               - "otherDeductionsPaisa");

ALTER TABLE "VendorSettlementLine"
  ADD CONSTRAINT "VendorSettlementLine_kind_check"
    CHECK ("kind" IN ('COD_CREDIT', 'SHIPPING_CHARGE', 'DEDUCTION', 'ADJUSTMENT')),
  ADD CONSTRAINT "VendorSettlementLine_amount_check"
    CHECK ("amountPaisa" >= 0);

-- A COD collection may be settled at most once — double-settlement is
-- a DB error, not a report discrepancy (database-schema §9).
CREATE UNIQUE INDEX "VendorSettlementLine_one_settlement_per_collection"
  ON "VendorSettlementLine" ("codCollectionId")
  WHERE "codCollectionId" IS NOT NULL;

-- Refund ------------------------------------------------------------------------
ALTER TABLE "Refund"
  ADD CONSTRAINT "Refund_status_check"
    CHECK ("status" IN ('REQUESTED', 'APPROVED', 'PROCESSED', 'REJECTED')),
  ADD CONSTRAINT "Refund_amount_check"
    CHECK ("amountPaisa" > 0);

-- FinancialAdjustment -----------------------------------------------------------
ALTER TABLE "FinancialAdjustment"
  ADD CONSTRAINT "FinancialAdjustment_targetType_check"
    CHECK ("targetType" IN ('PAYMENT', 'INVOICE', 'COD_COLLECTION',
                            'SETTLEMENT', 'LEDGER')),
  ADD CONSTRAINT "FinancialAdjustment_status_check"
    CHECK ("status" IN ('REQUESTED', 'APPROVED', 'REJECTED', 'APPLIED')),
  ADD CONSTRAINT "FinancialAdjustment_amount_check"
    CHECK ("amountPaisa" > 0);
