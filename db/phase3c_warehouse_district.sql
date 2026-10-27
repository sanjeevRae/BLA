-- =============================================================================
-- BLA Logistics â€” Phase 3c WORKFLOW (warehouse district + parcel intake routing).
-- Run AFTER phase3a/phase3b, as its OWN execution. Idempotent.
-- Adds a `district` column to warehouses so the intake flow can auto-decide:
--   same district  -> last-mile delivery by this warehouse's driver
--   other district -> inter-warehouse transfer to the destination warehouse
-- =============================================================================

-- 1) WAREHOUSES: service district for routing decisions -------------------------
alter table warehouses add column if not exists district text;
create index if not exists idx_warehouses_district on warehouses(district);

-- 2) Backfill: derive district from city/postal_code where missing ------------
-- (Safe no-op if already populated.)
update warehouses
set district = coalesce(nullif(trim(city), ''), nullif(trim(postal_code), ''))
where district is null;

-- =============================================================================
-- END
-- =============================================================================