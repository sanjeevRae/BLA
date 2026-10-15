-- =============================================================================
-- BLA Logistics — Phase 1 demo seed
-- =============================================================================
-- Run AFTER db/phase1_identity.sql (needs the new enum values committed).
-- Idempotent: safe to run multiple times.
-- =============================================================================

-- Demo business vendor ---------------------------------------------------------
insert into vendors (id, name, contact_name, email, phone, city, country)
values (
  '77777777-7777-4777-8777-777777777777',
  'Acme Retail Pvt Ltd',
  'Ravi Kumar',
  'vendor@acme.test',
  '+91 9800000001',
  'Bengaluru',
  'IN'
)
on conflict (id) do nothing;

-- One user per new platform role ----------------------------------------------
insert into users (id, email, full_name, phone, role, vendor_id) values
  ('aaaa0000-0000-4000-8000-000000000001', 'superadmin@bla.test',  'Super Admin',     '+91 9800000011', 'super_admin',     null),
  ('aaaa0000-0000-4000-8000-000000000002', 'whadmin@bla.test',     'Warehouse Admin', '+91 9800000012', 'warehouse_admin', null),
  ('aaaa0000-0000-4000-8000-000000000003', 'vendor@acme.test',     'Acme Ops',        '+91 9800000013', 'vendor',
   '77777777-7777-4777-8777-777777777777')
on conflict (email) do update
  set role = excluded.role,
      vendor_id = excluded.vendor_id,
      updated_at = now();

-- Driver split demo: oldest driver becomes the big (inter-warehouse) driver,
-- everyone else stays micro (last-mile, hidden from the admin live map).
update drivers
   set driver_type = 'big'
 where id = (select id from drivers order by created_at limit 1)
   and not exists (select 1 from drivers where driver_type = 'big');

-- Give the demo driver user the matching JWT role (used when REQUIRE_AUTH=true).
update users
   set role = 'big_driver'
 where email = 'driver1@bla.test' and role = 'driver';

-- Vendor-linked demo order: tag the oldest order with the demo vendor so the
-- vendor scoping policy has something to read.
update orders
   set vendor_id = '77777777-7777-4777-8777-777777777777'
 where id = (select id from orders order by created_at limit 1)
   and vendor_id is null;

-- END Phase 1 seed -------------------------------------------------------------
