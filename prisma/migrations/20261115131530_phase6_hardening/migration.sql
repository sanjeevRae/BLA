-- Phase 6 hardening (docs/database-schema.md §8, docs/delivery-workflow.md,
-- docs/return-workflow.md): vocabulary CHECK constraints, the one-active-
-- assignment / one-valid-POD / one-open-return partial unique indexes,
-- the return number sequence, and append-only triggers on the attempt
-- and COD-collection ledgers.

-- Return numbers (RTN-1001, RTN-1002, ...) — read inside the creating
-- transaction like order/shipment/transfer numbers.
CREATE SEQUENCE "app"."return_number_seq" START WITH 1001;

-- DeliveryBatch -----------------------------------------------------------------
ALTER TABLE "DeliveryBatch"
  ADD CONSTRAINT "DeliveryBatch_kind_check"
    CHECK ("kind" IN ('PICKUP', 'DELIVERY', 'MIXED')),
  ADD CONSTRAINT "DeliveryBatch_status_check"
    CHECK ("status" IN ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'));

-- DeliveryAssignment --------------------------------------------------------------
ALTER TABLE "DeliveryAssignment"
  ADD CONSTRAINT "DeliveryAssignment_kind_check"
    CHECK ("kind" IN ('PICKUP', 'DELIVERY')),
  ADD CONSTRAINT "DeliveryAssignment_status_check"
    CHECK ("status" IN ('PENDING', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED', 'REASSIGNED')),
  ADD CONSTRAINT "DeliveryAssignment_otpAttempts_check"
    CHECK ("otpFailedAttempts" >= 0);

-- One ACTIVE assignment per package per kind (schema doc §8). The service
-- also checks under a Package row lock (SELECT ... FOR UPDATE) inside the
-- assignment transaction — READ COMMITTED alone does not serialise the
-- check (Phase 5 review P5-1/P5-2); this index is the database backstop.
CREATE UNIQUE INDEX "DeliveryAssignment_one_active_per_package"
  ON "DeliveryAssignment" ("packageId", "kind")
  WHERE "status" IN ('PENDING', 'ACCEPTED', 'IN_PROGRESS');

-- DeliveryAttempt -----------------------------------------------------------------
ALTER TABLE "DeliveryAttempt"
  ADD CONSTRAINT "DeliveryAttempt_result_check"
    CHECK ("result" IN ('DELIVERED', 'RECIPIENT_UNAVAILABLE', 'PHONE_UNREACHABLE', 'WRONG_ADDRESS', 'REFUSED', 'BUSINESS_CLOSED', 'AREA_INACCESSIBLE', 'PAYMENT_UNAVAILABLE', 'PACKAGE_DAMAGED', 'PICKUP_FAILED', 'OTHER')),
  ADD CONSTRAINT "DeliveryAttempt_nextAction_check"
    CHECK ("nextAction" IN ('REDELIVER', 'ADDRESS_CORRECTION', 'SUPPORT_ESCALATION', 'RETURN_TO_SENDER', 'RETURN_TO_WAREHOUSE', 'NONE')),
  ADD CONSTRAINT "DeliveryAttempt_number_check"
    CHECK ("attemptNumber" >= 1);

CREATE TRIGGER "DeliveryAttempt_no_update"
  BEFORE UPDATE ON "DeliveryAttempt"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "DeliveryAttempt_no_delete"
  BEFORE DELETE ON "DeliveryAttempt"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "DeliveryAttempt_no_truncate"
  BEFORE TRUNCATE ON "DeliveryAttempt"
  FOR EACH STATEMENT EXECUTE FUNCTION "app"."prevent_history_rewrite"();

-- ProofOfDelivery -----------------------------------------------------------------
ALTER TABLE "ProofOfDelivery"
  ADD CONSTRAINT "ProofOfDelivery_method_check"
    CHECK ("method" IN ('OTP', 'SIGNATURE', 'PHOTO', 'AUTHORISED_PERSON'));

-- Exactly one valid (non-superseded) proof per package: DELIVERED is
-- backed by precisely one live evidence record.
CREATE UNIQUE INDEX "ProofOfDelivery_one_valid_per_package"
  ON "ProofOfDelivery" ("packageId")
  WHERE "supersededById" IS NULL;

-- DeliveryCodCollection -------------------------------------------------------------
ALTER TABLE "DeliveryCodCollection"
  ADD CONSTRAINT "DeliveryCodCollection_status_check"
    CHECK ("status" IN ('MATCHED', 'MISMATCH')),
  ADD CONSTRAINT "DeliveryCodCollection_method_check"
    CHECK ("method" IN ('CASH', 'MOBILE_WALLET', 'BANK_TRANSFER')),
  ADD CONSTRAINT "DeliveryCodCollection_amounts_check"
    CHECK ("expectedPaisa" >= 0 AND "collectedPaisa" >= 0),
  ADD CONSTRAINT "DeliveryCodCollection_status_matches_amounts"
    CHECK (("status" = 'MATCHED' AND "collectedPaisa" = "expectedPaisa")
        OR ("status" = 'MISMATCH' AND "collectedPaisa" <> "expectedPaisa"));

CREATE TRIGGER "DeliveryCodCollection_no_update"
  BEFORE UPDATE ON "DeliveryCodCollection"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "DeliveryCodCollection_no_delete"
  BEFORE DELETE ON "DeliveryCodCollection"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "DeliveryCodCollection_no_truncate"
  BEFORE TRUNCATE ON "DeliveryCodCollection"
  FOR EACH STATEMENT EXECUTE FUNCTION "app"."prevent_history_rewrite"();

-- ReturnRequest ---------------------------------------------------------------------
ALTER TABLE "ReturnRequest"
  ADD CONSTRAINT "ReturnRequest_reason_check"
    CHECK ("reason" IN ('RECIPIENT_REFUSED', 'ATTEMPT_LIMIT_REACHED', 'WRONG_ADDRESS', 'VENDOR_REQUEST', 'PACKAGE_DAMAGED', 'UNDELIVERABLE', 'CANCELLATION_AFTER_PICKUP', 'OTHER')),
  ADD CONSTRAINT "ReturnRequest_status_check"
    CHECK ("status" IN ('REQUESTED', 'APPROVED', 'REJECTED', 'COLLECTION_ASSIGNED', 'COLLECTED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTED', 'COMPLETED', 'CANCELLED')),
  ADD CONSTRAINT "ReturnRequest_chargeBearer_check"
    CHECK ("chargeBearer" IS NULL OR "chargeBearer" IN ('VENDOR', 'RECIPIENT', 'COMPANY')),
  ADD CONSTRAINT "ReturnRequest_chargeAmount_check"
    CHECK ("chargeAmountPaisa" >= 0),
  ADD CONSTRAINT "ReturnRequest_conditionAtInitiation_check"
    CHECK ("conditionAtInitiation" IN ('GOOD', 'DAMAGED', 'SUSPECTED_DAMAGE', 'PACKAGING_COMPROMISED')),
  ADD CONSTRAINT "ReturnRequest_conditionAtInspection_check"
    CHECK ("conditionAtInspection" IS NULL OR "conditionAtInspection" IN ('GOOD', 'DAMAGED', 'SUSPECTED_DAMAGE', 'PACKAGING_COMPROMISED'));

-- One OPEN return per package (return-workflow rule 6). The service also
-- checks under a Package row lock inside the creating transaction.
CREATE UNIQUE INDEX "ReturnRequest_one_open_per_package"
  ON "ReturnRequest" ("packageId")
  WHERE "status" IN ('REQUESTED', 'APPROVED', 'COLLECTION_ASSIGNED', 'COLLECTED', 'IN_TRANSIT', 'RECEIVED', 'INSPECTED');
