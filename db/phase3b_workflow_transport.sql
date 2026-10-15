-- =============================================================================
-- BLA Logistics — Phase 3b WORKFLOW (transport + fleet + last-mile + audit).
-- Run AFTER phase3a, as its OWN execution. Idempotent. TEXT + CHECK (no enums).
-- =============================================================================

-- 1) WAREHOUSE TRANSFERS: link manifest rows to a vehicle trip ----------------
alter table warehouse_transfers add column if not exists trip_id uuid references trips(id) on delete set null;
alter table warehouse_transfers add column if not exists vehicle_id uuid references vehicles(id) on delete set null;
alter table warehouse_transfers add column if not exists manifest_code text;
alter table warehouse_transfers add column if not exists loaded_at timestamptz;
alter table warehouse_transfers add column if not exists unloaded_at timestamptz;
create index if not exists idx_transfers_trip_id    on warehouse_transfers(trip_id);
create index if not exists idx_transfers_vehicle_id on warehouse_transfers(vehicle_id);

-- 2) TRIPS: ETA for the fleet overview ---------------------------------------
alter table trips add column if not exists estimated_arrival timestamptz;
create index if not exists idx_trips_vehicle_id on trips(vehicle_id);

-- 3) VEHICLES: lifecycle status + last ping -----------------------------------
alter table vehicles add column if not exists status text not null default 'idle';
alter table vehicles drop constraint if exists chk_vehicles_status;
alter table vehicles add constraint chk_vehicles_status
  check (status in ('idle', 'loading', 'in_transit', 'maintenance', 'offline'));
alter table vehicles add column if not exists last_seen_at timestamptz;
create index if not exists idx_vehicles_status on vehicles(status);

-- 4) DRIVER TASKS: last-mile payment + proof + attempts ------------------------
alter table driver_tasks add column if not exists payment_method text;
alter table driver_tasks drop constraint if exists chk_driver_tasks_payment_method;
alter table driver_tasks add constraint chk_driver_tasks_payment_method
  check (payment_method is null or payment_method in ('cod', 'online', 'advance'));
alter table driver_tasks add column if not exists payment_amount numeric(12,2) default 0;
alter table driver_tasks add column if not exists payment_collected boolean not null default false;
alter table driver_tasks add column if not exists proof_url text;
alter table driver_tasks add column if not exists proof_note text;
alter table driver_tasks add column if not exists failed_attempts integer not null default 0;
alter table driver_tasks add column if not exists last_attempt_at timestamptz;
alter table driver_tasks add column if not exists delivery_instructions text;

-- 5) ORDER EVENTS: timestamped audit for approval/intake/routing/payment -------
create table if not exists order_events (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  event       text not null,
  actor_id    uuid references users(id) on delete set null,
  actor_role  text,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_orderev_order_id on order_events(order_id);

alter table order_events enable row level security;
drop policy if exists order_events_read on order_events;
create policy order_events_read on order_events for select
  using (
    is_staff()
    or order_id in (
      select id from orders
      where customer_id in (select current_customer_ids())
         or vendor_id = current_vendor_id()
    )
  );
drop policy if exists order_events_write on order_events;
create policy order_events_write on order_events for all
  using (is_staff()) with check (is_staff());

-- 6) Realtime publication (best-effort; ignore if already added/unsupported).
do $$
begin
  alter publication supabase_realtime add table order_events;
exception when duplicate_object then null; when undefined_object then null; end $$;
