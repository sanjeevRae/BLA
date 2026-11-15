-- Warehouse hardening (docs/database-schema.md §2, docs/warehouse-workflow.md
-- §7): status vocabularies as database CHECK constraints, operating-hours
-- ranges, and warehouse code immutability enforced at the database level
-- (labels already printed with a code must never point at another site).

ALTER TABLE "app"."Warehouse"
  ADD CONSTRAINT "Warehouse_type_check"
  CHECK ("type" IN ('MAIN', 'REGIONAL', 'LOCAL_HUB', 'COLLECTION_CENTER', 'RETURN_CENTER'));

ALTER TABLE "app"."Warehouse"
  ADD CONSTRAINT "Warehouse_status_check"
  CHECK ("status" IN ('ACTIVE', 'INACTIVE', 'ARCHIVED'));

ALTER TABLE "app"."WarehouseAddress"
  ADD CONSTRAINT "WarehouseAddress_kind_check"
  CHECK ("kind" IN ('PRIMARY', 'GATE', 'BILLING'));

ALTER TABLE "app"."WarehouseZone"
  ADD CONSTRAINT "WarehouseZone_kind_check"
  CHECK ("kind" IN ('RECEIVING', 'INSPECTION', 'SORTING', 'STORAGE', 'DISPATCH', 'DAMAGED', 'RETURNS'));

ALTER TABLE "app"."WarehouseOperatingHours"
  ADD CONSTRAINT "WarehouseOperatingHours_day_check"
  CHECK ("dayOfWeek" BETWEEN 0 AND 6);

ALTER TABLE "app"."WarehouseOperatingHours"
  ADD CONSTRAINT "WarehouseOperatingHours_minutes_check"
  CHECK (
    ("opensAt" IS NULL OR ("opensAt" BETWEEN 0 AND 1439))
    AND ("closesAt" IS NULL OR ("closesAt" BETWEEN 0 AND 1439))
  );

CREATE OR REPLACE FUNCTION "app"."prevent_warehouse_code_change"()
RETURNS trigger AS $$
BEGIN
  IF NEW."code" <> OLD."code" THEN
    RAISE EXCEPTION 'Warehouse code is immutable (was %, attempted %)', OLD."code", NEW."code";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Warehouse_code_immutable"
  BEFORE UPDATE OF "code" ON "app"."Warehouse"
  FOR EACH ROW EXECUTE FUNCTION "app"."prevent_warehouse_code_change"();
