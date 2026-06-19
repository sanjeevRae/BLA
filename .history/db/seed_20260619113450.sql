-- =============================================================================
-- BLA — Minimal seed data for local development / demos
-- =============================================================================
-- Apply AFTER schema.sql:
--   psql "$SUPABASE_DB_URL" -f db/seed.sql
--
-- NOTE: This seed inserts directly into the `users` table with fixed UUIDs so
-- the rest of the rows can reference them. In a real Supabase project these
-- ids would match auth.users ids created via Supabase Auth. For local dev you
-- can run this against a plain Postgres or with RLS bypassed (service role).
-- =============================================================================

begin;

-- Users -----------------------------------------------------------------------
insert into users (id, email, full_name, phone, role) values
  ('11111111-1111-1111-1111-111111111111', 'admin@bla.test',      ' Admin',       '+977 98712345671', 'admin'),
  ('22222222-2222-2222-2222-222222222222', 'dispatch@bla.test',   ' Dispatcher',  '+977 98712345672', 'dispatcher'),
  ('33333333-3333-3333-3333-333333333333', 'driver1@bla.test',    ' Driver',      '+977 98712345673', 'driver'),
  ('44444444-4444-4444-4444-444444444444', 'driver2@bla.test',    ' Pilot',     '+977 98712345674', 'driver'),
  ('55555555-5555-5555-5555-555555555555', 'customer1@bla.test',  ' Customer',   '+977 98712345675', 'customer')
on conflict (id) do nothing;

-- Warehouses ------------------------------------------------------------------
insert into warehouses (id, code, name, address, city, postal_code, latitude, longitude) values
  ('a1111111-1111-1111-1111-111111111111', 'WH-BLR-01', 'KTM Central Hub',
   '100 MG Road', 'KTM', '560001', 12.9759, 77.6063)
on conflict (id) do nothing;

-- Vehicles --------------------------------------------------------------------
insert into vehicles (id, warehouse_id, registration, type, capacity_kg) values
  ('b1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'KA01AB1234', 'van',  800),
  ('b2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111', 'KA01CD5678', 'bike', 25)
on conflict (id) do nothing;

-- Drivers ---------------------------------------------------------------------
insert into drivers (id, user_id, warehouse_id, vehicle_id, name, phone, license_number, is_available, current_latitude, current_longitude, last_seen_at) values
  ('d1111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
   'a1111111-1111-1111-1111-111111111111', 'b1111111-1111-1111-1111-111111111111',
   'Dan Driver', '+977 98712345673', 'DL-KA-001', true, 12.9759, 77.6063, now()),
  ('d2222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444',
   'a1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222',
   'Priya Pilot', '+977 98712345674', 'DL-KA-002', true, 12.9352, 77.6245, now())
on conflict (id) do nothing;

-- Customers -------------------------------------------------------------------
insert into customers (id, user_id, name, email, phone, address_line1, city, state, postal_code, country, latitude, longitude) values
  ('c1111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555',
   'Carl Customer', 'customer1@bla.test', '+977 98712345675',
   '42 Indiranagar 100ft Rd', 'KTM', 'Karnataka', '560038', 'IN', 12.9719, 77.6412)
on conflict (id) do nothing;

-- Orders ----------------------------------------------------------------------
-- IMPORTANT:
-- In db/schema.sql there is a trigger on orders that logs every status change
-- into delivery_status_history using `auth.uid()`.
-- During seed runs, auth.uid() can be NULL (no logged-in user), which can
-- cause FK errors depending on how `delivery_status_history.order_id_fkey`
-- is evaluated.
--
-- Fix: Insert orders with triggers temporarily disabled, then insert the
-- corresponding delivery_status_history rows explicitly.

-- Temporarily disable orders status history trigger (and re-enable later)
alter table orders disable trigger trg_orders_status_history;

insert into orders (
  id, order_number, customer_id, warehouse_id, status,
  pickup_address, pickup_latitude, pickup_longitude,
  delivery_address, delivery_latitude, delivery_longitude,
  recipient_name, recipient_phone, total_weight_kg, total_amount, notes
) values
  ('e1111111-1111-1111-1111-111111111111', 'BLA-2026-0001',
   'c1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'received',
   '100 MG Road, KTM', 12.9759, 77.6063,
   '42 Indiranagar 100ft Rd, KTM', 12.9719, 77.6412,
   'Carl Customer', '+977 98712345675', 3.5, 499.00, 'Ring the bell twice'),
  ('e2222222-2222-2222-2222-222222222222', 'BLA-2026-0002',
   'c1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'out_for_delivery',
   '100 MG Road, KTM', 12.9759, 77.6063,
   '8 Koramangala 5th Block, KTM', 12.9352, 77.6245,
   'Carl Customer', '+977 98712345675', 1.2, 199.00, 'Leave at reception')
on conflict (id) do nothing;

-- Re-enable trigger for future inserts/updates
alter table orders enable trigger trg_orders_status_history;

-- Explicitly seed delivery status history to match current order status
-- (so realtime/customer views have initial history rows).
insert into delivery_status_history (order_id, status, changed_by)
values
  ('e1111111-1111-1111-1111-111111111111', 'received', null),
  ('e2222222-2222-2222-2222-222222222222', 'out_for_delivery', null)
on conflict (order_id, status) do nothing;


-- Order items -----------------------------------------------------------------
insert into order_items (order_id, sku, description, quantity, unit_price, weight_kg) values
  ('e1111111-1111-1111-1111-111111111111', 'SKU-100', 'Wireless headphones', 1, 499.00, 0.5),
  ('e1111111-1111-1111-1111-111111111111', 'SKU-200', 'USB-C cable (3m)',     2, 0.00,   0.1),
  ('e2222222-2222-2222-2222-222222222222', 'SKU-300', 'Paperback novel',      1, 199.00, 0.4)
on conflict do nothing;

-- Packages --------------------------------------------------------------------
insert into packages (id, order_id, tracking_code, weight_kg, length_cm, width_cm, height_cm) values
  ('f1111111-1111-1111-1111-111111111111', 'e1111111-1111-1111-1111-111111111111', 'TRK-0001', 3.5, 30, 20, 15),
  ('f2222222-2222-2222-2222-222222222222', 'e2222222-2222-2222-2222-222222222222', 'TRK-0002', 1.2, 25, 18, 5)
on conflict (id) do nothing;

-- Inventory -------------------------------------------------------------------
insert into inventory (warehouse_id, sku, description, quantity, reorder_level) values
  ('a1111111-1111-1111-1111-111111111111', 'SKU-100', 'Wireless headphones', 120, 20),
  ('a1111111-1111-1111-1111-111111111111', 'SKU-200', 'USB-C cable (3m)',     500, 50),
  ('a1111111-1111-1111-1111-111111111111', 'SKU-300', 'Paperback novel',       40, 10)
on conflict (warehouse_id, sku) do nothing;

-- Delivery assignments --------------------------------------------------------
insert into delivery_assignments (
  id, order_id, driver_id, vehicle_id, status,
  route_distance_m, route_duration_s, assigned_at, accepted_at
) values
  ('aa111111-1111-1111-1111-111111111111', 'e2222222-2222-2222-2222-222222222222',
   'd2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', 'in_progress',
   7400, 1080, now() - interval '20 minutes', now() - interval '18 minutes')
on conflict (id) do nothing;

-- GPS tracking (a few pings for the in-progress assignment) -------------------
insert into gps_tracking (driver_id, assignment_id, order_id, latitude, longitude, speed_kmh, heading, recorded_at) values
  ('d2222222-2222-2222-2222-222222222222', 'aa111111-1111-1111-1111-111111111111', 'e2222222-2222-2222-2222-222222222222', 12.9700, 77.6100, 22.0, 120, now() - interval '90 seconds'),
  ('d2222222-2222-2222-2222-222222222222', 'aa111111-1111-1111-1111-111111111111', 'e2222222-2222-2222-2222-222222222222', 12.9620, 77.6170, 18.0, 130, now() - interval '45 seconds'),
  ('d2222222-2222-2222-2222-222222222222', 'aa111111-1111-1111-1111-111111111111', 'e2222222-2222-2222-2222-222222222222', 12.9500, 77.6210, 15.0, 140, now() - interval '5 seconds')
on conflict do nothing;

-- Payments --------------------------------------------------------------------
insert into payments (order_id, amount, currency, method, status) values
  ('e1111111-1111-1111-1111-111111111111', 499.00, 'INR', 'cod',  'pending'),
  ('e2222222-2222-2222-2222-222222222222', 199.00, 'INR', 'upi',  'paid')
on conflict do nothing;

commit;
