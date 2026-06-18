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
    'packages','inventory','delivery_assignments','payments'
  ] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on %1$s;', t);
    execute format(
      'create trigger trg_%1$s_updated_at before update on %1$s
       for each row execute function set_updated_at();', t);
  end loop;
end $$;

-- Log every order status change into delivery_status_history automatically.
create or replace function log_order_status_change()
returns trigger as $$
begin
  if (tg_op = 'INSERT') or (new.status is distinct from old.status) then
    insert into delivery_status_history(order_id, status, changed_by)
    values (new.id, new.status, auth.uid());
    if new.status = 'delivered' and new.delivered_at is null then
      new.delivered_at = now();
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_orders_status_history on orders;
create trigger trg_orders_status_history
  before insert or update of status on orders
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

create or replace function is_staff()
returns boolean
language sql stable as $$
  select coalesce(auth_role() in ('admin','dispatcher','warehouse'), false);
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
