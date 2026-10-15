-- =============================================================================
-- BLA — Delivery Operations Platform
-- PostgreSQL / Supabase schema (SOURCE OF TRUTH)
-- =============================================================================
-- Apply with:  psql "$SUPABASE_DB_URL" -f db/schema.sql
-- or paste into the Supabase SQL editor.
--
-- Conventions:
--   * UUID primary keys (gen_random_uuid()) to align with Supabase Auth ids.
--   * created_at / updated_at audit columns on mutable tables.
--   * Row Level Security (RLS) enabled on every table; policies at the bottom.
--   * Realtime: gps_tracking, delivery_assignments, orders, delivery_status_history
--     are added to the supabase_realtime publication.
-- =============================================================================

-- Extensions ------------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- =============================================================================
-- ENUMS
-- =============================================================================
do $$ begin
  create type user_role as enum ('admin', 'dispatcher', 'warehouse', 'driver', 'customer');
exception when duplicate_object then null; end $$;

do $$ begin
  -- Status progression visible to customers:
  -- received -> on_place -> went_for_delivery -> out_for_delivery -> delivered
  create type order_status as enum (
    'received',
    'on_place',
    'went_for_delivery',
    'out_for_delivery',
    'delivered',
    'cancelled',
    'failed'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type assignment_status as enum ('pending', 'accepted', 'in_progress', 'completed', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type vehicle_type as enum ('bike', 'car', 'van', 'truck');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_status as enum ('pending', 'paid', 'failed', 'refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type payment_method as enum ('cash', 'card', 'upi', 'wallet', 'cod');
exception when duplicate_object then null; end $$;

-- Phase 1: role-based platform structure (idempotent) --------------------------
-- super_admin        : full system control (vendors, staff, COD, settings)
-- warehouse_admin    : parcel registration, scanning, transfers, handovers
-- vendor             : business vendor staff (own shipments + COD only)
-- micro_driver       : last-mile rider (no live map exposure)
-- big_driver         : inter-warehouse driver (live map exposure)
do $$ begin
  alter type user_role add value if not exists 'super_admin';
exception when duplicate_object then null; end $$;
do $$ begin
  alter type user_role add value if not exists 'warehouse_admin';
exception when duplicate_object then null; end $$;
do $$ begin
  alter type user_role add value if not exists 'vendor';
exception when duplicate_object then null; end $$;
do $$ begin
  alter type user_role add value if not exists 'micro_driver';
exception when duplicate_object then null; end $$;
do $$ begin
  alter type user_role add value if not exists 'big_driver';
exception when duplicate_object then null; end $$;

-- Phase 2: FOUR INDEPENDENT STATUS TRACKS (per spec) ---------------------------
--   parcel_status          : where the PARCEL is in the network
--   driver_task_status     : micro-driver task progress
--   trip_status            : big-driver inter-warehouse journey progress
--   cod_settlement_status  : money state (collection -> settlement)
do $$ begin
  create type parcel_status as enum (
    'registered', 'picked_up', 'at_origin_hub', 'in_transit', 'at_dest_hub',
    'out_for_delivery', 'delivered', 'delivery_failed', 'returned', 'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type driver_task_status as enum (
    'pending', 'accepted', 'picked_up', 'out_for_delivery',
    'delivered', 'delivery_failed', 'returned'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type trip_status as enum (
    'assigned', 'loading', 'departed', 'at_checkpoint',
    'arrived_dest', 'unloading', 'completed', 'cancelled'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type cod_settlement_status as enum (
    'pending', 'collected', 'reconciled', 'deducted', 'settled', 'disputed'
  );
exception when duplicate_object then null; end $$;

-- =============================================================================
-- HELPERS
-- =============================================================================
-- Generic trigger to keep updated_at fresh.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- =============================================================================
-- TABLES
-- =============================================================================

-- users -----------------------------------------------------------------------
-- Mirrors auth.users (1:1 by id). Stores app-level profile + role.
create table if not exists users (
  id           uuid primary key default gen_random_uuid(),
  email        text unique not null,
  full_name    text,
  phone        text,
  role         user_role not null default 'customer',
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- customers -------------------------------------------------------------------
create table if not exists customers (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references users(id) on delete set null,
  name            text not null,
  email           text,
  phone           text not null,
  address_line1   text,
  address_line2   text,
  city            text,
  state           text,
  postal_code     text,
  country         text default 'IN',
  latitude        double precision,
  longitude       double precision,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- warehouses ------------------------------------------------------------------
create table if not exists warehouses (
  id          uuid primary key default gen_random_uuid(),
  code        text unique not null,
  name        text not null,
  address     text,
  city        text,
  postal_code text,
  latitude    double precision not null,
  longitude   double precision not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- vehicles --------------------------------------------------------------------
create table if not exists vehicles (
  id             uuid primary key default gen_random_uuid(),
  warehouse_id   uuid references warehouses(id) on delete set null,
  registration   text unique not null,
  type           vehicle_type not null default 'van',
  capacity_kg    numeric(10,2) default 0,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- drivers ---------------------------------------------------------------------
create table if not exists drivers (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid unique references users(id) on delete cascade,
  warehouse_id       uuid references warehouses(id) on delete set null,
  vehicle_id         uuid references vehicles(id) on delete set null,
  name               text not null,
  phone              text not null,
  license_number     text,
  is_available       boolean not null default true,
  current_latitude   double precision,
  current_longitude  double precision,
  last_seen_at       timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- orders ----------------------------------------------------------------------
create table if not exists orders (
  id                   uuid primary key default gen_random_uuid(),
  order_number         text unique not null,
  customer_id          uuid references customers(id) on delete set null,
  warehouse_id         uuid references warehouses(id) on delete set null,
  status               order_status not null default 'received',
  -- Pickup (usually warehouse) and drop-off
  pickup_address       text,
  pickup_latitude      double precision,
  pickup_longitude     double precision,
  delivery_address     text not null,
  delivery_latitude    double precision,
  delivery_longitude   double precision,
  recipient_name       text,
  recipient_phone      text,
  total_weight_kg      numeric(10,2) default 0,
  total_amount         numeric(12,2) default 0,
  notes                text,
  scheduled_at         timestamptz,
  delivered_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- order_items -----------------------------------------------------------------
create table if not exists order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  sku          text,
  description  text not null,
  quantity     integer not null default 1 check (quantity > 0),
  unit_price   numeric(12,2) default 0,
  weight_kg    numeric(10,2) default 0,
  created_at   timestamptz not null default now()
);

-- packages --------------------------------------------------------------------
create table if not exists packages (
  id            uuid primary key default gen_random_uuid(),
  order_id      uuid not null references orders(id) on delete cascade,
  tracking_code text unique not null,
  weight_kg     numeric(10,2) default 0,
  length_cm     numeric(10,2),
  width_cm      numeric(10,2),
  height_cm     numeric(10,2),
  -- Proof of delivery (Cloudinary secure_url)
  pod_photo_url text,
  pod_signed_by text,
  pod_signed_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- inventory -------------------------------------------------------------------
create table if not exists inventory (
  id               uuid primary key default gen_random_uuid(),
  warehouse_id     uuid not null references warehouses(id) on delete cascade,
  sku              text not null,
  description      text,
  quantity         integer not null default 0 check (quantity >= 0),
  reorder_level    integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (warehouse_id, sku)
);

-- delivery_assignments --------------------------------------------------------
create table if not exists delivery_assignments (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id) on delete cascade,
  driver_id           uuid not null references drivers(id) on delete cascade,
  vehicle_id          uuid references vehicles(id) on delete set null,
  status              assignment_status not null default 'pending',
  -- Cached route summary from MapTiler / OpenRouteService
  route_distance_m    numeric(12,2),
  route_duration_s    numeric(12,2),
  route_geometry      jsonb,           -- GeoJSON LineString
  assigned_at         timestamptz not null default now(),
  accepted_at         timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- gps_tracking ----------------------------------------------------------------
-- High-volume table: drivers push a row every ~5s while on a delivery.
-- Cleaned up periodically by a cron job (see .github/workflows).
create table if not exists gps_tracking (
  id            bigint generated always as identity primary key,
  driver_id     uuid not null references drivers(id) on delete cascade,
  assignment_id uuid references delivery_assignments(id) on delete set null,
  order_id      uuid references orders(id) on delete set null,
  latitude      double precision not null,
  longitude     double precision not null,
  speed_kmh     numeric(6,2),
  heading       numeric(6,2),
  accuracy_m    numeric(8,2),
  recorded_at   timestamptz not null default now()
);

-- delivery_status_history -----------------------------------------------------
create table if not exists delivery_status_history (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid not null references orders(id) on delete cascade,
  status       order_status not null,
  changed_by   uuid references users(id) on delete set null,
  latitude     double precision,
  longitude    double precision,
  note         text,
  created_at   timestamptz not null default now()
);

-- payments (optional) ---------------------------------------------------------
create table if not exists payments (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id) on delete cascade,
  amount          numeric(12,2) not null default 0,
  currency        text not null default 'INR',
  method          payment_method not null default 'cod',
  status          payment_status not null default 'pending',
  transaction_ref text,
  paid_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists admin_notifications (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text,
  type        text not null default 'info' check (type in ('info', 'success', 'warning', 'error')),
  created_at  timestamptz not null default now()
);

create table if not exists admin_messages (
  id           uuid primary key default gen_random_uuid(),
  sender_name  text not null,
  body         text not null,
  created_at   timestamptz not null default now()
);

create table if not exists admin_settings (
  id            uuid primary key default gen_random_uuid(),
  setting_key   text not null unique,
  setting_value jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now()
);

create table if not exists admin_help (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text,
  link        text,
  created_at  timestamptz not null default now()
);

insert into admin_help (title, body, link) values
  ('How cashflow is calculated', 'Paid payments summed per delivery; pending shown separately.', '/analytics/cashflow'),
  ('How to manage customers', 'Search, create, edit, and delete customers from the admin panel.', '/customers')
on conflict do nothing;

-- =============================================================================
-- PHASE 1 — ROLE IDENTITY (vendors, vendor scoping, driver types)
-- =============================================================================
-- Business vendors: companies that create/manage shipments and collect COD.
create table if not exists vendors (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  contact_name text,
  email        text,
  phone        text,
  address      text,
  city         text,
  state        text,
  postal_code  text,
  country      text default 'IN',
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Vendor staff belong to a vendor account (identity / scoping key).
do $$ begin
  alter table users
    add column if not exists vendor_id uuid references vendors(id) on delete set null;
exception when duplicate_column then null; end $$;

-- Shipments belong to a vendor when created by vendor businesses.
do $$ begin
  alter table orders
    add column if not exists vendor_id uuid references vendors(id) on delete set null;
exception when duplicate_column then null; end $$;

-- Driver split: micro (last-mile; NOT on admin live map)
--               big  (inter-warehouse trips; ON admin live map).
do $$ begin
  alter table drivers
    add column if not exists driver_type text not null default 'micro';
exception when duplicate_column then null; end $$;
do $$ begin
  alter table drivers add constraint chk_drivers_driver_type
    check (driver_type in ('micro', 'big'));
exception when duplicate_object then null; end $$;

create index if not exists idx_users_vendor_id    on users(vendor_id);
create index if not exists idx_orders_vendor_id   on orders(vendor_id);
create index if not exists idx_drivers_driver_type on drivers(driver_type);
create index if not exists idx_vendors_name       on vendors(name);

-- =============================================================================
-- PHASE 2 — PARCEL LIFECYCLE & INDEPENDENT STATUS TRACKS
-- =============================================================================

-- shipments: the canonical parcel record --------------------------------------
create table if not exists shipments (
  id                    uuid primary key default gen_random_uuid(),
  tracking_code         text unique not null,
  order_id              uuid references orders(id) on delete set null,
  vendor_id             uuid references vendors(id) on delete set null,
  origin_warehouse_id   uuid references warehouses(id) on delete set null,
  dest_warehouse_id     uuid references warehouses(id) on delete set null,
  recipient_name        text,
  recipient_phone       text,
  destination_address   text not null,
  destination_latitude  double precision,
  destination_longitude double precision,
  weight_kg             numeric(10,2) default 0,
  declared_value        numeric(12,2) default 0,
  parcel_status         parcel_status not null default 'registered',
  registered_by         uuid references users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- scan_events: every barcode scan (registration, sort, dispatch, arrival) ------
create table if not exists scan_events (
  id           uuid primary key default gen_random_uuid(),
  shipment_id  uuid not null references shipments(id) on delete cascade,
  warehouse_id uuid references warehouses(id) on delete set null,
  event        text not null,
  scanned_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- warehouse_transfers: shipment movement between warehouses --------------------
create table if not exists warehouse_transfers (
  id                 uuid primary key default gen_random_uuid(),
  shipment_id       uuid not null references shipments(id) on delete cascade,
  from_warehouse_id uuid references warehouses(id) on delete set null,
  to_warehouse_id   uuid not null references warehouses(id) on delete cascade,
  status            text not null default 'dispatched'
                     check (status in ('dispatched', 'in_transit', 'received')),
  dispatched_by     uuid references users(id) on delete set null,
  received_by       uuid references users(id) on delete set null,
  created_at        timestamptz not null default now(),
  received_at       timestamptz
);

-- handovers: parcel custody between staff and drivers ---------------------------
create table if not exists handovers (
  id           uuid primary key default gen_random_uuid(),
  shipment_id  uuid not null references shipments(id) on delete cascade,
  warehouse_id uuid references warehouses(id) on delete set null,
  driver_id    uuid references drivers(id) on delete set null,
  direction    text not null check (direction in ('to_driver', 'to_warehouse')),
  status       text not null default 'pending' check (status in ('pending', 'confirmed')),
  handed_by    uuid references users(id) on delete set null,
  confirmed_at timestamptz,
  created_at   timestamptz not null default now()
);

-- driver_tasks: micro-driver pickup/delivery tasks (own status track) -----------
create table if not exists driver_tasks (
  id            uuid primary key default gen_random_uuid(),
  shipment_id   uuid not null references shipments(id) on delete cascade,
  driver_id     uuid not null references drivers(id) on delete cascade,
  task_type     text not null check (task_type in ('pickup', 'delivery')),
  status        driver_task_status not null default 'pending',
  cod_required  boolean not null default false,
  cod_amount    numeric(12,2) default 0,
  cod_collected numeric(12,2) default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create index if not exists idx_shipments_tracking_code   on shipments(tracking_code);
create index if not exists idx_shipments_order_id        on shipments(order_id);
create index if not exists idx_shipments_vendor_id       on shipments(vendor_id);
create index if not exists idx_shipments_parcel_status   on shipments(parcel_status);
create index if not exists idx_scans_shipment_id         on scan_events(shipment_id);
create index if not exists idx_transfers_shipment_id     on warehouse_transfers(shipment_id);
create index if not exists idx_handovers_shipment_id     on handovers(shipment_id);
create index if not exists idx_driver_tasks_shipment_id  on driver_tasks(shipment_id);
create index if not exists idx_driver_tasks_driver_id    on driver_tasks(driver_id);

-- trips: big-driver inter-warehouse journeys ----------------------------------
create table if not exists trips (
  id                   uuid primary key default gen_random_uuid(),
  big_driver_id        uuid not null references drivers(id) on delete cascade,
  vehicle_id           uuid references vehicles(id) on delete set null,
  origin_warehouse_id  uuid references warehouses(id) on delete set null,
  dest_warehouse_id    uuid references warehouses(id) on delete set null,
  status               trip_status not null default 'assigned',
  departed_at          timestamptz,
  arrived_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- trip_manifests: parcels consolidated on a trip -------------------------------
create table if not exists trip_manifests (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references trips(id) on delete cascade,
  shipment_id uuid not null references shipments(id) on delete cascade,
  loaded      boolean not null default false,
  unique (trip_id, shipment_id)
);

-- checkpoints: intermediate trip events (district arrivals, etc.) --------------
create table if not exists checkpoints (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references trips(id) on delete cascade,
  label      text not null,
  latitude   double precision,
  longitude  double precision,
  passed_at  timestamptz,
  created_at timestamptz not null default now()
);

-- cod_collections: money collected per delivery ---------------------------------
create table if not exists cod_collections (
  id             uuid primary key default gen_random_uuid(),
  shipment_id    uuid not null references shipments(id) on delete cascade,
  driver_task_id uuid references driver_tasks(id) on delete set null,
  collected_by   uuid references drivers(id) on delete set null,
  amount         numeric(12,2) not null default 0,
  collected_at   timestamptz,
  created_at     timestamptz not null default now()
);

-- settlements: vendor payout batches --------------------------------------------
create table if not exists settlements (
  id           uuid primary key default gen_random_uuid(),
  vendor_id    uuid not null references vendors(id) on delete cascade,
  period_start date not null,
  period_end   date not null,
  gross_amount numeric(12,2) not null default 0,
  deductions   numeric(12,2) not null default 0,
  net_amount   numeric(12,2) not null default 0,
  status       cod_settlement_status not null default 'pending',
  settled_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- shipment_events: universal audit trail (accountability + timestamps) ------------
create table if not exists shipment_events (
  id          uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references shipments(id) on delete cascade,
  event       text not null,
  actor_id    uuid references users(id) on delete set null,
  actor_role  text,
  location    text,
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists idx_trips_driver_id        on trips(big_driver_id);
create index if not exists idx_trips_status           on trips(status);
create index if not exists idx_manifests_trip_id      on trip_manifests(trip_id);
create index if not exists idx_manifests_shipment_id  on trip_manifests(shipment_id);
create index if not exists idx_checkpoints_trip_id    on checkpoints(trip_id);
create index if not exists idx_cod_shipment_id        on cod_collections(shipment_id);
create index if not exists idx_settlements_vendor_id  on settlements(vendor_id);
create index if not exists idx_settlements_status     on settlements(status);
create index if not exists idx_shipev_shipment_id     on shipment_events(shipment_id);

-- =============================================================================
-- INDEXES
-- =============================================================================
create index if not exists idx_customers_user_id          on customers(user_id);
create index if not exists idx_vehicles_warehouse_id       on vehicles(warehouse_id);
create index if not exists idx_drivers_user_id             on drivers(user_id);
create index if not exists idx_drivers_warehouse_id        on drivers(warehouse_id);
create index if not exists idx_drivers_is_available        on drivers(is_available);
create index if not exists idx_orders_customer_id          on orders(customer_id);
create index if not exists idx_orders_warehouse_id         on orders(warehouse_id);
create index if not exists idx_orders_status               on orders(status);
create index if not exists idx_orders_created_at           on orders(created_at);
create index if not exists idx_order_items_order_id        on order_items(order_id);
create index if not exists idx_packages_order_id           on packages(order_id);
create index if not exists idx_inventory_warehouse_sku     on inventory(warehouse_id, sku);
create index if not exists idx_assignments_order_id        on delivery_assignments(order_id);
create index if not exists idx_assignments_driver_id       on delivery_assignments(driver_id);
create index if not exists idx_assignments_status          on delivery_assignments(status);
create index if not exists idx_gps_driver_id               on gps_tracking(driver_id);
create index if not exists idx_gps_order_id                on gps_tracking(order_id);
create index if not exists idx_gps_recorded_at             on gps_tracking(recorded_at);
create index if not exists idx_status_history_order_id     on delivery_status_history(order_id);
create index if not exists idx_payments_order_id           on payments(order_id);

-- =============================================================================
-- TRIGGERS (updated_at)
-- =============================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'users','customers','warehouses','vehicles','drivers','orders',
    'packages','inventory','delivery_assignments','payments','vendors',
    'shipments','driver_tasks','trips','settlements'
  ] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on %1$s;', t);
    execute format(
      'create trigger trg_%1$s_updated_at before update on %1$s
       for each row execute function set_updated_at();', t);
  end loop;
end $$;

-- Set delivered_at automatically (BEFORE trigger: mutating NEW.* is allowed).
create or replace function set_delivered_at()
returns trigger as $$
begin
  if new.status = 'delivered' and new.delivered_at is null then
    new.delivered_at = now();
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_orders_delivered_at on orders;
create trigger trg_orders_delivered_at
  before insert or update of status on orders
  for each row execute function set_delivered_at();

-- Log every order status change into delivery_status_history automatically
-- (AFTER trigger: history insert only; auth.uid() may be NULL for seeds).
create or replace function log_order_status_change()
returns trigger as $$
begin
  if (tg_op = 'INSERT') or (new.status is distinct from old.status) then
    insert into delivery_status_history(order_id, status, changed_by)
    values (new.id, new.status, auth.uid());
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_orders_status_history on orders;
create trigger trg_orders_status_history
  after insert or update of status on orders
  for each row execute function log_order_status_change();


-- =============================================================================
-- ROW LEVEL SECURITY
-- =============================================================================
-- Strategy:
--   * service_role (used by the FastAPI backend) bypasses RLS entirely.
--   * Helper functions read the caller's role/driver-id from the users table.
--   * Staff (admin/dispatcher/warehouse) get broad read/write access.
--   * Drivers can read/update only their own assignments, orders and packages.
--   * Customers can read only their own orders and related rows.
--   * gps_tracking is readable by everyone authenticated (needed for the public
--     tracking page via the anon key through a narrow policy) and writable by
--     the owning driver.

create or replace function auth_role()
returns user_role
language sql stable as $$
  select role from users where id = auth.uid();
$$;

-- NOTE: role comparisons cast to text on purpose. ALTER TYPE ... ADD VALUE
-- forbids *using* a new value inside the same transaction that added it
-- (error 55P04), and the Supabase SQL editor runs a pasted script as ONE
-- transaction. Comparing (auth_role())::text keeps this file safe to run in
-- a single paste, fresh or repeat.
create or replace function is_staff()
returns boolean
language sql stable as $$
  select coalesce(
    (auth_role())::text in ('admin','dispatcher','warehouse','super_admin','warehouse_admin'),
    false
  );
$$;

create or replace function is_super_admin()
returns boolean
language sql stable as $$
  select coalesce((auth_role())::text in ('super_admin','admin'), false);
$$;

create or replace function current_driver_id()
returns uuid
language sql stable as $$
  select id from drivers where user_id = auth.uid();
$$;

create or replace function current_customer_ids()
returns setof uuid
language sql stable as $$
  select id from customers where user_id = auth.uid();
$$;

-- Vendor scoping: the vendor this signed-in user belongs to (NULL for others).
create or replace function current_vendor_id()
returns uuid
language sql stable as $$
  select vendor_id from users where id = auth.uid();
$$;

-- Driver scoping: the driver row for this signed-in user (NULL for others).
create or replace function current_driver_type()
returns text
language sql stable as $$
  select driver_type from drivers where user_id = auth.uid();
$$;

-- Enable RLS everywhere -------------------------------------------------------
alter table users                    enable row level security;
alter table customers                enable row level security;
alter table warehouses               enable row level security;
alter table vehicles                 enable row level security;
alter table drivers                  enable row level security;
alter table orders                   enable row level security;
alter table order_items              enable row level security;
alter table packages                 enable row level security;
alter table inventory                enable row level security;
alter table delivery_assignments     enable row level security;
alter table gps_tracking             enable row level security;
alter table delivery_status_history  enable row level security;
alter table payments                 enable row level security;
alter table admin_notifications      enable row level security;
alter table admin_messages           enable row level security;
alter table admin_settings           enable row level security;
alter table admin_help               enable row level security;
alter table vendors                  enable row level security;
alter table shipments                enable row level security;
alter table scan_events              enable row level security;
alter table warehouse_transfers      enable row level security;
alter table handovers                enable row level security;
alter table driver_tasks             enable row level security;
alter table trips                    enable row level security;
alter table trip_manifests           enable row level security;
alter table checkpoints              enable row level security;
alter table cod_collections          enable row level security;
alter table settlements              enable row level security;
alter table shipment_events          enable row level security;

-- users: read own row; staff reads all; users update own profile -------------
drop policy if exists users_select on users;
create policy users_select on users for select
  using (id = auth.uid() or is_staff());

drop policy if exists users_update_self on users;
create policy users_update_self on users for update
  using (id = auth.uid()) with check (id = auth.uid());

-- customers -------------------------------------------------------------------
drop policy if exists customers_select on customers;
create policy customers_select on customers for select
  using (is_staff() or user_id = auth.uid());

drop policy if exists customers_staff_write on customers;
create policy customers_staff_write on customers for all
  using (is_staff()) with check (is_staff());

-- warehouses / vehicles / inventory: staff full, drivers read ----------------
drop policy if exists warehouses_read on warehouses;
create policy warehouses_read on warehouses for select
  using (auth.uid() is not null);
drop policy if exists warehouses_staff_write on warehouses;
create policy warehouses_staff_write on warehouses for all
  using (is_staff()) with check (is_staff());

drop policy if exists vehicles_read on vehicles;
create policy vehicles_read on vehicles for select
  using (auth.uid() is not null);
drop policy if exists vehicles_staff_write on vehicles;
create policy vehicles_staff_write on vehicles for all
  using (is_staff()) with check (is_staff());

drop policy if exists inventory_read on inventory;
create policy inventory_read on inventory for select
  using (is_staff());
drop policy if exists inventory_staff_write on inventory;
create policy inventory_staff_write on inventory for all
  using (is_staff()) with check (is_staff());

-- drivers: staff full; driver reads/updates own row --------------------------
drop policy if exists drivers_select on drivers;
create policy drivers_select on drivers for select
  using (is_staff() or user_id = auth.uid());
drop policy if exists drivers_update_self on drivers;
create policy drivers_update_self on drivers for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists drivers_staff_write on drivers;
create policy drivers_staff_write on drivers for all
  using (is_staff()) with check (is_staff());

-- orders: staff full; driver sees assigned orders; customer sees own ---------
drop policy if exists orders_select on orders;
create policy orders_select on orders for select
  using (
    is_staff()
    or customer_id in (select current_customer_ids())
    or vendor_id = current_vendor_id()
    or exists (
      select 1 from delivery_assignments da
      where da.order_id = orders.id and da.driver_id = current_driver_id()
    )
  );
drop policy if exists orders_staff_write on orders;
create policy orders_staff_write on orders for all
  using (is_staff()) with check (is_staff());
-- Drivers may update status of orders assigned to them.
drop policy if exists orders_driver_update on orders;
create policy orders_driver_update on orders for update
  using (exists (
    select 1 from delivery_assignments da
    where da.order_id = orders.id and da.driver_id = current_driver_id()
  ))
  with check (exists (
    select 1 from delivery_assignments da
    where da.order_id = orders.id and da.driver_id = current_driver_id()
  ));

-- order_items: follow parent order visibility --------------------------------
drop policy if exists order_items_select on order_items;
create policy order_items_select on order_items for select
  using (exists (select 1 from orders o where o.id = order_items.order_id));
drop policy if exists order_items_staff_write on order_items;
create policy order_items_staff_write on order_items for all
  using (is_staff()) with check (is_staff());

-- packages: staff full; driver reads/updates packages of assigned orders -----
drop policy if exists packages_select on packages;
create policy packages_select on packages for select
  using (exists (select 1 from orders o where o.id = packages.order_id));
drop policy if exists packages_staff_write on packages;
create policy packages_staff_write on packages for all
  using (is_staff()) with check (is_staff());
drop policy if exists packages_driver_update on packages;
create policy packages_driver_update on packages for update
  using (exists (
    select 1 from delivery_assignments da
    where da.order_id = packages.order_id and da.driver_id = current_driver_id()
  ))
  with check (exists (
    select 1 from delivery_assignments da
    where da.order_id = packages.order_id and da.driver_id = current_driver_id()
  ));

-- delivery_assignments: staff full; driver reads/updates own -----------------
drop policy if exists assignments_select on delivery_assignments;
create policy assignments_select on delivery_assignments for select
  using (is_staff() or driver_id = current_driver_id());
drop policy if exists assignments_staff_write on delivery_assignments;
create policy assignments_staff_write on delivery_assignments for all
  using (is_staff()) with check (is_staff());
drop policy if exists assignments_driver_update on delivery_assignments;
create policy assignments_driver_update on delivery_assignments for update
  using (driver_id = current_driver_id())
  with check (driver_id = current_driver_id());

-- gps_tracking: driver inserts own; staff + driver read; insert by owner -----
drop policy if exists gps_select on gps_tracking;
create policy gps_select on gps_tracking for select
  using (is_staff() or driver_id = current_driver_id());
drop policy if exists gps_driver_insert on gps_tracking;
create policy gps_driver_insert on gps_tracking for insert
  with check (driver_id = current_driver_id());

-- delivery_status_history: visible to anyone who can see the order -----------
drop policy if exists status_history_select on delivery_status_history;
create policy status_history_select on delivery_status_history for select
  using (exists (select 1 from orders o where o.id = delivery_status_history.order_id));
drop policy if exists status_history_staff_write on delivery_status_history;
create policy status_history_staff_write on delivery_status_history for all
  using (is_staff()) with check (is_staff());

-- payments: staff full; customer reads own -----------------------------------
drop policy if exists payments_select on payments;
create policy payments_select on payments for select
  using (
    is_staff()
    or exists (
      select 1 from orders o
      where o.id = payments.order_id
        and o.customer_id in (select current_customer_ids())
    )
  );
drop policy if exists payments_staff_write on payments;
create policy payments_staff_write on payments for all
  using (is_staff()) with check (is_staff());

-- admin_notifications/messages/settings: staff full read/write ----------------
drop policy if exists admin_notifications_select on admin_notifications;
create policy admin_notifications_select on admin_notifications for select
  using (is_staff());
drop policy if exists admin_notifications_write on admin_notifications;
create policy admin_notifications_write on admin_notifications for all
  using (is_staff()) with check (is_staff());

drop policy if exists admin_messages_select on admin_messages;
create policy admin_messages_select on admin_messages for select
  using (is_staff());
drop policy if exists admin_messages_write on admin_messages;
create policy admin_messages_write on admin_messages for all
  using (is_staff()) with check (is_staff());

drop policy if exists admin_settings_select on admin_settings;
create policy admin_settings_select on admin_settings for select
  using (is_staff());
drop policy if exists admin_settings_write on admin_settings;
create policy admin_settings_write on admin_settings for all
  using (is_staff()) with check (is_staff());

drop policy if exists admin_help_select on admin_help;
create policy admin_help_select on admin_help for select
  using (is_staff());
drop policy if exists admin_help_write on admin_help;
create policy admin_help_write on admin_help for all
  using (is_staff()) with check (is_staff());

-- vendors: staff full; vendor users read their own account --------------------
drop policy if exists vendors_select on vendors;
create policy vendors_select on vendors for select
  using (is_staff() or id = current_vendor_id());
drop policy if exists vendors_staff_write on vendors;
create policy vendors_staff_write on vendors for all
  using (is_super_admin()) with check (is_super_admin());

-- =============================================================================
-- PHASE 2 policies: shipments + children inherit parent visibility
-- =============================================================================
drop policy if exists shipments_select on shipments;
create policy shipments_select on shipments for select
  using (
    is_staff()
    or vendor_id = current_vendor_id()
    or exists (
      select 1 from orders o
      where o.id = shipments.order_id and o.customer_id in (select current_customer_ids())
    )
    or exists (
      select 1 from driver_tasks dt
      where dt.shipment_id = shipments.id and dt.driver_id = current_driver_id()
    )
    or exists (
      select 1 from trip_manifests tm
      join trips t on t.id = tm.trip_id
      where tm.shipment_id = shipments.id and t.big_driver_id = current_driver_id()
    )
  );
drop policy if exists shipments_staff_write on shipments;
create policy shipments_staff_write on shipments for all
  using (is_staff()) with check (is_staff());
drop policy if exists shipments_vendor_write on shipments;
create policy shipments_vendor_write on shipments for all
  using (vendor_id = current_vendor_id()) with check (vendor_id = current_vendor_id());

drop policy if exists scan_events_select on scan_events;
create policy scan_events_select on scan_events for select
  using (exists (select 1 from shipments s where s.id = scan_events.shipment_id));
drop policy if exists scan_events_staff_write on scan_events;
create policy scan_events_staff_write on scan_events for all
  using (is_staff()) with check (is_staff());

drop policy if exists transfers_select on warehouse_transfers;
create policy transfers_select on warehouse_transfers for select
  using (exists (select 1 from shipments s where s.id = warehouse_transfers.shipment_id));
drop policy if exists transfers_staff_write on warehouse_transfers;
create policy transfers_staff_write on warehouse_transfers for all
  using (is_staff()) with check (is_staff());

drop policy if exists handovers_select on handovers;
create policy handovers_select on handovers for select
  using (exists (select 1 from shipments s where s.id = handovers.shipment_id));
drop policy if exists handovers_staff_write on handovers;
create policy handovers_staff_write on handovers for all
  using (is_staff()) with check (is_staff());

drop policy if exists shipment_events_select on shipment_events;
create policy shipment_events_select on shipment_events for select
  using (exists (select 1 from shipments s where s.id = shipment_events.shipment_id));
drop policy if exists shipment_events_staff_write on shipment_events;
create policy shipment_events_staff_write on shipment_events for all
  using (is_staff()) with check (is_staff());

-- driver_tasks: staff full; driver reads/updates own ---------------------------------
drop policy if exists driver_tasks_select on driver_tasks;
create policy driver_tasks_select on driver_tasks for select
  using (is_staff() or driver_id = current_driver_id());
drop policy if exists driver_tasks_update_self on driver_tasks;
create policy driver_tasks_update_self on driver_tasks for update
  using (driver_id = current_driver_id()) with check (driver_id = current_driver_id());
drop policy if exists driver_tasks_staff_write on driver_tasks;
create policy driver_tasks_staff_write on driver_tasks for all
  using (is_staff()) with check (is_staff());

-- trips: staff full; big driver reads/updates own ------------------------------------
drop policy if exists trips_select on trips;
create policy trips_select on trips for select
  using (is_staff() or big_driver_id = current_driver_id());
drop policy if exists trips_update_self on trips;
create policy trips_update_self on trips for update
  using (big_driver_id = current_driver_id()) with check (big_driver_id = current_driver_id());
drop policy if exists trips_staff_write on trips;
create policy trips_staff_write on trips for all
  using (is_staff()) with check (is_staff());

-- trip_manifests + checkpoints follow parent trip visibility ----------------------------
drop policy if exists manifests_select on trip_manifests;
create policy manifests_select on trip_manifests for select
  using (exists (select 1 from trips t where t.id = trip_manifests.trip_id));
drop policy if exists manifests_staff_write on trip_manifests;
create policy manifests_staff_write on trip_manifests for all
  using (is_staff()) with check (is_staff());

drop policy if exists checkpoints_select on checkpoints;
create policy checkpoints_select on checkpoints for select
  using (exists (select 1 from trips t where t.id = checkpoints.trip_id));
drop policy if exists checkpoints_write on checkpoints;
create policy checkpoints_write on checkpoints for all
  using (exists (select 1 from trips t where t.id = checkpoints.trip_id));
drop policy if exists checkpoints_staff_write on checkpoints;
create policy checkpoints_staff_write on checkpoints for all
  using (is_staff()) with check (is_staff());

-- cod_collections: staff full; vendor sees own; collecting driver writes own -------------
drop policy if exists cod_select on cod_collections;
create policy cod_select on cod_collections for select
  using (
    is_staff()
    or collected_by = current_driver_id()
    or exists (
      select 1 from shipments s
      where s.id = cod_collections.shipment_id and s.vendor_id = current_vendor_id()
    )
  );
drop policy if exists cod_staff_write on cod_collections;
create policy cod_staff_write on cod_collections for all
  using (is_staff()) with check (is_staff());

-- settlements: staff full; vendor reads own; super-admin writes ---------------------------
drop policy if exists settlements_select on settlements;
create policy settlements_select on settlements for select
  using (is_staff() or vendor_id = current_vendor_id());
drop policy if exists settlements_staff_write on settlements;
create policy settlements_staff_write on settlements for all
  using (is_super_admin()) with check (is_super_admin());

-- =============================================================================
-- REALTIME PUBLICATION
-- =============================================================================
-- Supabase ships a `supabase_realtime` publication; add the tables the
-- frontends subscribe to. Wrapped in DO blocks so re-runs are idempotent.
do $$
begin
  alter publication supabase_realtime add table gps_tracking;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table delivery_assignments;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table orders;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table delivery_status_history;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table shipments;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table scan_events;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table driver_tasks;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table trips;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table checkpoints;
exception when duplicate_object then null; when undefined_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table shipment_events;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- =============================================================================
-- MAINTENANCE HELPERS (called by cron jobs)
-- =============================================================================
-- Delete GPS pings older than N days. Defaults to 7.
create or replace function cleanup_gps_tracking(retention_days integer default 7)
returns integer
language plpgsql
security definer
as $$
declare deleted integer;
begin
  delete from gps_tracking
  where recorded_at < now() - (retention_days || ' days')::interval;
  get diagnostics deleted = row_count;
  return deleted;
end;
$$;

-- =============================================================================
-- END
-- =============================================================================
