-- Phase 5 hardening (hand-written, following the Phase 3/4 pattern):
-- vocabulary CHECK constraints, the origin != destination rule,
-- number sequences, the one-open-transfer-per-package trigger (the
-- predicate spans TransferItem + Transfer, so Prisma cannot express
-- it as an index), and append-only trigger protection for the scan
-- ledger. See docs/database-schema.md §7 and docs/transfer-workflow.md §7.

-- Number sequences (order/shipment pattern from Phase 3) ----------------------
CREATE SEQUENCE "app"."transfer_number_seq" START WITH 1001;
CREATE SEQUENCE "app"."trip_number_seq" START WITH 1001;

-- Driver ----------------------------------------------------------------------
ALTER TABLE "app"."Driver"
  ADD CONSTRAINT "Driver_employmentStatus_check"
    CHECK ("employmentStatus" IN ('ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'INACTIVE')),
  ADD CONSTRAINT "Driver_availabilityStatus_check"
    CHECK ("availabilityStatus" IN ('AVAILABLE', 'ASSIGNED', 'ON_PICKUP', 'ON_DELIVERY', 'ON_TRIP', 'OFF_DUTY', 'ON_LEAVE', 'SUSPENDED', 'INACTIVE'));

-- DriverCapability ------------------------------------------------------------
ALTER TABLE "app"."DriverCapability"
  ADD CONSTRAINT "DriverCapability_capability_check"
    CHECK ("capability" IN ('PICKUP', 'DELIVERY', 'LINEHAUL'));

-- Vehicle ---------------------------------------------------------------------
ALTER TABLE "app"."Vehicle"
  ADD CONSTRAINT "Vehicle_type_check"
    CHECK ("type" IN ('BIKE', 'CAR', 'VAN', 'TRUCK', 'PICKUP')),
  ADD CONSTRAINT "Vehicle_status_check"
    CHECK ("status" IN ('AVAILABLE', 'ASSIGNED', 'ON_TRIP', 'MAINTENANCE', 'OFFLINE')),
  ADD CONSTRAINT "Vehicle_inspectionStatus_check"
    CHECK ("inspectionStatus" IN ('VALID', 'DUE', 'EXPIRED')),
  ADD CONSTRAINT "Vehicle_capacity_check"
    CHECK (("capacityKg" IS NULL OR "capacityKg" >= 0)
       AND ("capacityVolumeM3" IS NULL OR "capacityVolumeM3" >= 0));

-- VehicleMaintenance ----------------------------------------------------------
ALTER TABLE "app"."VehicleMaintenance"
  ADD CONSTRAINT "VehicleMaintenance_kind_check"
    CHECK ("kind" IN ('SCHEDULED', 'REPAIR', 'INSPECTION'));

-- Transfer --------------------------------------------------------------------
ALTER TABLE "app"."Transfer"
  ADD CONSTRAINT "Transfer_status_check"
    CHECK ("status" IN ('DRAFT', 'REQUESTED', 'APPROVED', 'REJECTED', 'PREPARING', 'READY_FOR_DISPATCH', 'DISPATCHED', 'IN_TRANSIT', 'ARRIVED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'RECONCILIATION_PENDING', 'RECONCILED', 'CLOSED', 'EXCEPTION', 'CANCELLED')),
  ADD CONSTRAINT "Transfer_distinct_warehouses_check"
    CHECK ("originWarehouseId" <> "destinationWarehouseId"),
  ADD CONSTRAINT "Transfer_version_check"
    CHECK ("version" >= 1);

-- TransferItem ----------------------------------------------------------------
ALTER TABLE "app"."TransferItem"
  ADD CONSTRAINT "TransferItem_itemStatus_check"
    CHECK ("itemStatus" IN ('EXPECTED', 'LOADED', 'IN_TRANSIT', 'RECEIVED', 'MISSING', 'DAMAGED', 'EXCESS', 'WRONG_PACKAGE')),
  ADD CONSTRAINT "TransferItem_expectedCondition_check"
    CHECK ("expectedCondition" IN ('GOOD', 'DAMAGED', 'SUSPECTED_DAMAGE', 'PACKAGING_COMPROMISED')),
  ADD CONSTRAINT "TransferItem_receivedCondition_check"
    CHECK ("receivedCondition" IS NULL OR "receivedCondition" IN ('GOOD', 'DAMAGED', 'SUSPECTED_DAMAGE', 'PACKAGING_COMPROMISED'));

-- One open transfer per package (transfer-workflow.md §7 rule 1).
-- "Open" = every status in which the package is committed to the
-- transfer: from selection (DRAFT) until the transfer is reconciled,
-- closed or cancelled. Checked inside the service transaction as
-- well; this trigger is the database backstop (Phase 4 review P4-3).
CREATE OR REPLACE FUNCTION "app"."enforce_one_open_transfer_item"()
  RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "app"."TransferItem" ti
    JOIN "app"."Transfer" t ON t."id" = ti."transferId"
    WHERE ti."packageId" = NEW."packageId"
      AND ti."transferId" <> NEW."transferId"
      AND t."status" IN ('DRAFT', 'REQUESTED', 'APPROVED', 'REJECTED', 'PREPARING',
                         'READY_FOR_DISPATCH', 'DISPATCHED', 'IN_TRANSIT', 'ARRIVED',
                         'PARTIALLY_RECEIVED', 'RECEIVED', 'RECONCILIATION_PENDING', 'EXCEPTION')
  ) THEN
    RAISE EXCEPTION 'Package % is already on an open transfer', NEW."packageId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "TransferItem_one_open_transfer"
  BEFORE INSERT ON "app"."TransferItem"
  FOR EACH ROW EXECUTE FUNCTION "app"."enforce_one_open_transfer_item"();

-- TransferManifest --------------------------------------------------------------
ALTER TABLE "app"."TransferManifest"
  ADD CONSTRAINT "TransferManifest_counts_check"
    CHECK ("packageCount" >= 0 AND "totalWeightKg" >= 0 AND "totalCodPaisa" >= 0);

-- TransferScan — append-only ----------------------------------------------------
ALTER TABLE "app"."TransferScan"
  ADD CONSTRAINT "TransferScan_scanType_check"
    CHECK ("scanType" IN ('LOAD', 'UNLOAD', 'RECHECK'));

CREATE TRIGGER "TransferScan_no_update"
  BEFORE UPDATE ON "app"."TransferScan"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "TransferScan_no_delete"
  BEFORE DELETE ON "app"."TransferScan"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_history_rewrite"();
CREATE TRIGGER "TransferScan_no_truncate"
  BEFORE TRUNCATE ON "app"."TransferScan"
  FOR EACH STATEMENT EXECUTE FUNCTION "app"."prevent_history_rewrite"();

-- Trip --------------------------------------------------------------------------
ALTER TABLE "app"."Trip"
  ADD CONSTRAINT "Trip_status_check"
    CHECK ("status" IN ('PLANNED', 'ASSIGNED', 'LOADING', 'DISPATCHED', 'IN_TRANSIT', 'DELAYED', 'ARRIVED', 'UNLOADING', 'COMPLETED', 'CANCELLED', 'INCIDENT'));
