-- =============================================================================
-- BLA Logistics — Phase 1 IDENTITY migration (schema changes only)
-- =============================================================================
-- For EXISTING databases (Supabase SQL editor or psql). Fresh installs already
-- get all of this from db/schema.sql. Fully idempotent — safe to run multiple
-- times.
--
-- IMPORTANT: run THIS file first, then run db/phase1_seed.sql in a SECOND
-- execution. PostgreSQL cannot use a brand-new enum value inside the same
-- transaction that added it.
-- =============================================================================

-- 1) New platform roles on the existing enum -------------------------------
do $$ begin alter type user_role add value if not exists 'super_admin';      exception when duplicate_object then null; end $$;
do $$ begin alter type user_role add value if not exists 'warehouse_admin';  exception when duplicate_object then null; end $$;
do $$ begin alter type user_role add value if not exists 'vendor';           exception when duplicate_object then null; end $$;
do $$ begin alter type user_role add value if not exists 'micro_driver';     exception when duplicate_object then null; end $$;
do $$ begin alter type user_role add value if not exists 'big_driver';       exception when duplicate_object then null; end $$;

-- 2) Business vendors (companies that create shipments and collect COD) ------
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

-- 3) Identity / scoping columns ---------------------------------------------
do $$ begin
  alter table users add column if not exists vendor_id uuid references vendors(id) on delete set null;
exception when duplicate_column then null; end $$;

do $$ begin
  alter table orders add column if not exists vendor_id uuid references vendors(id) on delete set null;
exception when duplicate_column then null; end $$;

do $$ begin
  alter table drivers add column if not exists driver_type text not null default 'micro';
exception when duplicate_column then null; end $$;
do $$ begin
  alter table drivers add constraint chk_drivers_driver_type check (driver_type in ('micro','big'));
exception when duplicate_object then null; end $$;

-- 4) Indexes ------------------------------------------------------------------
create index if not exists idx_users_vendor_id     on users(vendor_id);
create index if not exists idx_orders_vendor_id    on orders(vendor_id);
create index if not exists idx_drivers_driver_type on drivers(driver_type);
create index if not exists idx_vendors_name        on vendors(name);

-- 5) updated_at trigger for vendors ------------------------------------------
drop trigger if exists trg_vendors_updated_at on vendors;
create trigger trg_vendors_updated_at before update on vendors
  for each row execute function set_updated_at();

-- 6) Permission helpers (mirror db/schema.sql) -------------------------------
-- NOTE: role comparisons cast to text on purpose. ALTER TYPE ... ADD VALUE
-- forbids *using* a new value inside the same transaction that added it
-- (error 55P04), and the Supabase SQL editor runs a pasted script as ONE
-- transaction. Comparing (auth_role())::text keeps this file safe to run in
-- a single paste, fresh or repeat.
create or replace function is_staff()
returns boolean language sql stable as $$
  select coalesce(
    (auth_role())::text in ('admin','dispatcher','warehouse','super_admin','warehouse_admin'),
    false
  );
$$;

create or replace function is_super_admin()
returns boolean language sql stable as $$
  select coalesce((auth_role())::text in ('super_admin','admin'), false);
$$;

create or replace function current_vendor_id()
returns uuid language sql stable as $$
  select vendor_id from users where id = auth.uid();
$$;

create or replace function current_driver_type()
returns text language sql stable as $$
  select driver_type from drivers where user_id = auth.uid();
$$;

-- 7) Row Level Security -------------------------------------------------------
alter table vendors enable row level security;

drop policy if exists vendors_select on vendors;
create policy vendors_select on vendors for select
  using (is_staff() or id = current_vendor_id());

drop policy if exists vendors_staff_write on vendors;
create policy vendors_staff_write on vendors for all
  using (is_super_admin()) with check (is_super_admin());

-- Orders: add vendor scoping to the existing visibility policy.
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

-- END Phase 1 identity --------------------------------------------------------
