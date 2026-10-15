-- =============================================================================
-- BLA Logistics — Phase 2 demo seed (run in a SECOND execution, after
-- db/phase2_identity.sql). Idempotent: safe to re-run.
-- =============================================================================
-- PostgreSQL forbids using brand-new enum values in the same transaction that
-- added them, so this file is intentionally separate from the migration.

-- 1) Demo parcels (one registered, one moving) --------------------------------
insert into shipments (tracking_code, recipient_name, recipient_phone,
                       destination_address, weight_kg, parcel_status,
                       vendor_id, origin_warehouse_id, dest_warehouse_id)
select 'BLA-DEMO-0001', 'Ananya Sharma', '+977 9800000012',
       'Kumaripati, Lalitpur, Nepal', 2.5, 'registered',
       (select id from vendors order by created_at limit 1),
       (select id from warehouses order by created_at limit 1),
       (select id from warehouses order by created_at limit 1)
where not exists (select 1 from shipments where tracking_code = 'BLA-DEMO-0001');

insert into shipments (tracking_code, recipient_name, recipient_phone,
                       destination_address, weight_kg, parcel_status,
                       vendor_id, origin_warehouse_id, dest_warehouse_id)
select 'BLA-DEMO-0002', 'Rohan Verma', '+977 9800000034',
       'Thamel Marg, Kathmandu, Nepal', 1.2, 'in_transit',
       (select id from vendors order by created_at limit 1),
       (select id from warehouses order by created_at limit 1),
       (select id from warehouses order by created_at limit 1)
where not exists (select 1 from shipments where tracking_code = 'BLA-DEMO-0002');

-- 2) A pending COD delivery task for the moving parcel ------------------------
-- NOTE: no UNION + ORDER BY inline (Postgres rejects it: 0A000) — a single
-- ordered pick prefers a big driver, falls back to any driver.
insert into driver_tasks (shipment_id, driver_id, task_type, status,
                          cod_required, cod_amount)
select s.id, d.id, 'delivery', 'pending', true, 1299
from shipments s
cross join lateral (
  select id from drivers
  order by (driver_type = 'big') desc, created_at
  limit 1
) d
where s.tracking_code = 'BLA-DEMO-0002'
  and exists (select 1 from drivers)
  and not exists (select 1 from driver_tasks where shipment_id = s.id);

-- 3) One big-driver trip -------------------------------------------------------
insert into trips (big_driver_id, origin_warehouse_id, dest_warehouse_id, status)
select d.id,
       (select id from warehouses order by created_at limit 1),
       (select id from warehouses order by created_at desc limit 1),
       'assigned'
from (
  select id from drivers
  order by (driver_type = 'big') desc, created_at
  limit 1
) d
where not exists (select 1 from trips where status = 'assigned');

-- 4) Put both demo parcels on the trip manifest --------------------------------
insert into trip_manifests (trip_id, shipment_id, loaded)
select t.id, s.id, false
from trips t
join shipments s on s.tracking_code in ('BLA-DEMO-0001', 'BLA-DEMO-0002')
where t.status = 'assigned'
  and not exists (
    select 1 from trip_manifests m where m.trip_id = t.id and m.shipment_id = s.id
  );
