-- Phase 4 hardening (hand-written, following the Phase 3 pattern):
-- vocabulary CHECK constraints, the custody custodian-shape CHECK,
-- single-open-row partial unique indexes (Prisma cannot express
-- partial indexes), and append-only trigger protection for the two
-- new ledger tables. See docs/database-schema.md §6 and
-- docs/inventory-and-custody.md.

-- InventoryRecord ------------------------------------------------------------
ALTER TABLE "app"."InventoryRecord"
  ADD CONSTRAINT "InventoryRecord_conditionOnArrival_check"
    CHECK ("conditionOnArrival" IN ('GOOD', 'DAMAGED', 'SUSPECTED_DAMAGE', 'PACKAGING_COMPROMISED')),
  ADD CONSTRAINT "InventoryRecord_releaseReason_check"
    CHECK ("releaseReason" IS NULL OR "releaseReason" IN ('DISPATCH', 'DELIVERY_HANDOUT', 'TRANSFER', 'RETURN', 'CORRECTION')),
  ADD CONSTRAINT "InventoryRecord_release_shape_check"
    CHECK (("releasedAt" IS NULL) = ("releasedById" IS NULL AND "releaseReason" IS NULL));

-- One open inventory record per package, ever (duplicate-scan guard).
CREATE UNIQUE INDEX "InventoryRecord_one_open_per_package"
  ON "app"."InventoryRecord" ("packageId") WHERE "releasedAt" IS NULL;

-- InventoryMovement ----------------------------------------------------------
ALTER TABLE "app"."InventoryMovement"
  ADD CONSTRAINT "InventoryMovement_type_check"
    CHECK ("type" IN ('RECEIVING', 'PUT_AWAY', 'INTERNAL_MOVE', 'PICKING', 'DISPATCH', 'TRANSFER_OUT', 'TRANSFER_IN', 'RETURN_RECEIVING', 'DAMAGE_QUARANTINE', 'CORRECTION'));

CREATE TRIGGER "InventoryMovement_no_update"
  BEFORE UPDATE ON "app"."InventoryMovement"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "InventoryMovement_no_delete"
  BEFORE DELETE ON "app"."InventoryMovement"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "InventoryMovement_no_truncate"
  BEFORE TRUNCATE ON "app"."InventoryMovement"
  FOR EACH STATEMENT EXECUTE FUNCTION "app"."prevent_history_rewrite"();

-- PackageCustody -------------------------------------------------------------
ALTER TABLE "app"."PackageCustody"
  ADD CONSTRAINT "PackageCustody_custodianType_check"
    CHECK ("custodianType" IN ('WAREHOUSE', 'USER', 'RECIPIENT', 'RETURN_TEAM')),
  ADD CONSTRAINT "PackageCustody_custodian_shape_check"
    CHECK (
      ("custodianType" = 'WAREHOUSE' AND "custodianUserId" IS NULL AND "warehouseId" IS NOT NULL)
      OR ("custodianType" = 'USER' AND "custodianUserId" IS NOT NULL AND "warehouseId" IS NULL AND "storageLocationId" IS NULL)
      OR ("custodianType" = 'RECIPIENT' AND "custodianUserId" IS NULL AND "warehouseId" IS NULL AND "storageLocationId" IS NULL)
      OR ("custodianType" = 'RETURN_TEAM' AND "custodianUserId" IS NULL AND "warehouseId" IS NOT NULL)
    );

-- Exactly one accountable custodian per package (custody invariant).
CREATE UNIQUE INDEX "PackageCustody_one_open_per_package"
  ON "app"."PackageCustody" ("packageId") WHERE "endedAt" IS NULL;

-- HandoverBatch ---------------------------------------------------------------
ALTER TABLE "app"."HandoverBatch"
  ADD CONSTRAINT "HandoverBatch_status_check"
    CHECK ("status" IN ('PENDING', 'PARTIALLY_CONFIRMED', 'CONFIRMED', 'DISPUTED')),
  ADD CONSTRAINT "HandoverBatch_fromCustodianType_check"
    CHECK ("fromCustodianType" IN ('WAREHOUSE', 'USER', 'RECIPIENT', 'RETURN_TEAM')),
  ADD CONSTRAINT "HandoverBatch_toCustodianType_check"
    CHECK ("toCustodianType" IN ('WAREHOUSE', 'USER', 'RECIPIENT', 'RETURN_TEAM')),
  ADD CONSTRAINT "HandoverBatch_counts_check"
    CHECK ("expectedCount" >= 1 AND "confirmedCount" >= 0 AND "confirmedCount" <= "expectedCount");

-- CustodyHandover -------------------------------------------------------------
ALTER TABLE "app"."CustodyHandover"
  ADD CONSTRAINT "CustodyHandover_status_check"
    CHECK ("status" IN ('PENDING', 'CONFIRMED', 'MISSING', 'DAMAGED'));

-- StockItem -------------------------------------------------------------------
ALTER TABLE "app"."StockItem"
  ADD CONSTRAINT "StockItem_unit_check"
    CHECK ("unit" IN ('PCS', 'ROLL', 'KG')),
  ADD CONSTRAINT "StockItem_quantity_nonnegative_check"
    CHECK ("quantityOnHand" >= 0),
  ADD CONSTRAINT "StockItem_reorder_nonnegative_check"
    CHECK ("reorderLevel" >= 0);

-- StockMovement ----------------------------------------------------------------
ALTER TABLE "app"."StockMovement"
  ADD CONSTRAINT "StockMovement_type_check"
    CHECK ("type" IN ('PURCHASE', 'ISSUE', 'RETURN', 'ADJUSTMENT', 'DAMAGE_WRITE_OFF')),
  ADD CONSTRAINT "StockMovement_quantities_check"
    CHECK ("quantityBefore" >= 0 AND "quantityAfter" >= 0
      AND "quantityAfter" = "quantityBefore" + "quantityDelta"
      AND "quantityDelta" <> 0);

CREATE TRIGGER "StockMovement_no_update"
  BEFORE UPDATE ON "app"."StockMovement"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "StockMovement_no_delete"
  BEFORE DELETE ON "app"."StockMovement"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "StockMovement_no_truncate"
  BEFORE TRUNCATE ON "app"."StockMovement"
  FOR EACH STATEMENT EXECUTE FUNCTION "app"."prevent_history_rewrite"();
