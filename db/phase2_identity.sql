-- =============================================================================
-- BLA Logistics — Phase 2 IDENTITY migration (schema changes only)
-- =============================================================================
-- For EXISTING databases (Supabase SQL editor or psql). Fresh installs already
-- get all of this from db/schema.sql. Fully idempotent.
--
-- IMPORTANT: run THIS file first, then db/phase2_seed.sql in a SECOND
-- execution. PostgreSQL cannot use brand-new enum values in the same
-- transaction that added them.
-- =============================================================================

-- 1) Four independent status tracks -----------------------------------------
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

-- 2) Canonical parcel record --------------------------------------------------
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

create table if not exists scan_events (
  id           uuid primary key default gen_random_uuid(),
  shipment_id  uuid not null references shipments(id) on delete cascade,
  warehouse_id uuid references warehouses(id) on delete set null,
  event        text not null,
  scanned_by   uuid references users(id) on delete set null,
  created_at   timestamptz not null default now()
);

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

create index if not exists idx_shipments_tracking_code  on shipments(tracking_code);
create index if not exists idx_shipments_order_id       on shipments(order_id);
create index if not exists idx_shipments_vendor_id      on shipments(vendor_id);
create index if not exists idx_shipments_parcel_status  on shipments(parcel_status);
create index if not exists idx_scans_shipment_id        on scan_events(shipment_id);
create index if not exists idx_transfers_shipment_id    on warehouse_transfers(shipment_id);

-- 3) Big-driver trips, manifests, checkpoints -----------------------------------
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

create table if not exists trip_manifests (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references trips(id) on delete cascade,
  shipment_id uuid not null references shipments(id) on delete cascade,
  loaded      boolean not null default false,
  unique (trip_id, shipment_id)
);

create table if not exists checkpoints (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references trips(id) on delete cascade,
  label      text not null,
  latitude   double precision,
  longitude  double precision,
  passed_at  timestamptz,
  created_at timestamptz not null default now()
);

-- 4) COD + settlements + universal audit trail ---------------------------------
create table if not exists cod_collections (
  id             uuid primary key default gen_random_uuid(),
  shipment_id    uuid not null references shipments(id) on delete cascade,
  driver_task_id uuid references driver_tasks(id) on delete set null,
  collected_by   uuid references drivers(id) on delete set null,
  amount         numeric(12,2) not null default 0,
  collected_at   timestamptz,
  created_at     timestamptz not null default now()
);

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

create index if not exists idx_trips_driver_id       on trips(big_driver_id);
create index if not exists idx_trips_status          on trips(status);
create index if not exists idx_manifests_trip_id     on trip_manifests(trip_id);
create index if not exists idx_manifests_shipment_id on trip_manifests(shipment_id);
create index if not exists idx_checkpoints_trip_id   on checkpoints(trip_id);
create index if not exists idx_cod_shipment_id       on cod_collections(shipment_id);
create index if not exists idx_settlements_vendor_id on settlements(vendor_id);
create index if not exists idx_settlements_status    on settlements(status);
create index if not exists idx_shipev_shipment_id    on shipment_events(shipment_id);

-- 5) updated_at triggers (mirror db/schema.sql) ---------------------------------
do $$ declare t text; begin
  foreach t in array array['shipments','driver_tasks','trips','settlements'] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on %1$s;', t);
    execute format(
      'create trigger trg_%1$s_updated_at before update on %1$s for each row execute function set_updated_at();', t);
  end loop;
end $$;

-- 6) Row Level Security ----------------------------------------------------------
alter table shipments           enable row level security;
alter table scan_events         enable row level security;
alter table warehouse_transfers enable row level security;
alter table handovers           enable row level security;
alter table driver_tasks        enable row level security;
alter table trips               enable row level security;
alter table trip_manifests      enable row level security;
alter table checkpoints         enable row level security;
alter table cod_collections     enable row level security;
alter table settlements         enable row level security;
alter table shipment_events     enable row level security;

drop policy if exists shipments_select on shipments;
create policy shipments_select on shipments for select
  using (
    is_staff()
    or vendor_id = current_vendor_id()
    or exists (select 1 from orders o where o.id = shipments.order_id and o.customer_id in (select current_customer_ids()))
    or exists (select 1 from driver_tasks dt where dt.shipment_id = shipments.id and dt.driver_id = current_driver_id())
    or exists (select 1 from trip_manifests tm join trips t on t.id = tm.trip_id where tm.shipment_id = shipments.id and t.big_driver_id = current_driver_id())
  );
drop policy if exists shipments_staff_write on shipments;
create policy shipments_staff_write on shipments for all using (is_staff()) with check (is_staff());
drop policy if exists shipments_vendor_write on shipments;
create policy shipments_vendor_write on shipments for all using (vendor_id = current_vendor_id()) with check (vendor_id = current_vendor_id());

drop policy if exists scan_events_select on scan_events;
create policy scan_events_select on scan_events for select using (exists (select 1 from shipments s where s.id = scan_events.shipment_id));
drop policy if exists scan_events_staff_write on scan_events;
create policy scan_events_staff_write on scan_events for all using (is_staff()) with check (is_staff());

drop policy if exists transfers_select on warehouse_transfers;
create policy transfers_select on warehouse_transfers for select using (exists (select 1 from shipments s where s.id = warehouse_transfers.shipment_id));
drop policy if exists transfers_staff_write on warehouse_transfers;
create policy transfers_staff_write on warehouse_transfers for all using (is_staff()) with check (is_staff());

drop policy if exists handovers_select on handovers;
create policy handovers_select on handovers for select using (exists (select 1 from shipments s where s.id = handovers.shipment_id));
drop policy if exists handovers_staff_write on handovers;
create policy handovers_staff_write on handovers for all using (is_staff()) with check (is_staff());

drop policy if exists shipment_events_select on shipment_events;
create policy shipment_events_select on shipment_events for select using (exists (select 1 from shipments s where s.id = shipment_events.shipment_id));
drop policy if exists shipment_events_staff_write on shipment_events;
create policy shipment_events_staff_write on shipment_events for all using (is_staff()) with check (is_staff());

drop policy if exists driver_tasks_select on driver_tasks;
create policy driver_tasks_select on driver_tasks for select using (is_staff() or driver_id = current_driver_id());
drop policy if exists driver_tasks_update_self on driver_tasks;
create policy driver_tasks_update_self on driver_tasks for update using (driver_id = current_driver_id()) with check (driver_id = current_driver_id());
drop policy if exists driver_tasks_staff_write on driver_tasks;
create policy driver_tasks_staff_write on driver_tasks for all using (is_staff()) with check (is_staff());

drop policy if exists trips_select on trips;
create policy trips_select on trips for select using (is_staff() or big_driver_id = current_driver_id());
drop policy if exists trips_update_self on trips;
create policy trips_update_self on trips for update using (big_driver_id = current_driver_id()) with check (big_driver_id = current_driver_id());
drop policy if exists trips_staff_write on trips;
create policy trips_staff_write on trips for all using (is_staff()) with check (is_staff());

drop policy if exists manifests_select on trip_manifests;
create policy manifests_select on trip_manifests for select using (exists (select 1 from trips t where t.id = trip_manifests.trip_id));
drop policy if exists manifests_staff_write on trip_manifests;
create policy manifests_staff_write on trip_manifests for all using (is_staff()) with check (is_staff());

drop policy if exists checkpoints_select on checkpoints;
create policy checkpoints_select on checkpoints for select using (exists (select 1 from trips t where t.id = checkpoints.trip_id));
drop policy if exists checkpoints_write on checkpoints;
create policy checkpoints_write on checkpoints for all using (exists (select 1 from trips t where t.id = checkpoints.trip_id));
drop policy if exists checkpoints_staff_write on checkpoints;
create policy checkpoints_staff_write on checkpoints for all using (is_staff()) with check (is_staff());

drop policy if exists cod_select on cod_collections;
create policy cod_select on cod_collections for select
  using (is_staff() or collected_by = current_driver_id() or exists (select 1 from shipments s where s.id = cod_collections.shipment_id and s.vendor_id = current_vendor_id()));
drop policy if exists cod_staff_write on cod_collections;
create policy cod_staff_write on cod_collections for all using (is_staff()) with check (is_staff());

drop policy if exists settlements_select on settlements;
create policy settlements_select on settlements for select using (is_staff() or vendor_id = current_vendor_id());
drop policy if exists settlements_staff_write on settlements;
create policy settlements_staff_write on settlements for all using (is_super_admin()) with check (is_super_admin());

-- 7) Realtime publication ----------------------------------------------------------
do $$ begin alter publication supabase_realtime add table shipments; exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table scan_events; exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table driver_tasks; exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table trips; exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table checkpoints; exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table shipment_events; exception when duplicate_object then null; when undefined_object then null; end $$;

-- END Phase 2 identity (part 2 of 2) ----------------------------------------------


create index if not exists idx_handovers_shipment_id    on handovers(shipment_id);
create index if not exists idx_driver_tasks_shipment_id on driver_tasks(shipment_id);
create index if not exists idx_driver_tasks_driver_id   on driver_tasks(driver_id);

-- END Phase 2 identity (part 1 of 2) -------------------------------------------
