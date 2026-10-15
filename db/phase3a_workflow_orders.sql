-- =============================================================================
-- BLA Logistics — Phase 3a WORKFLOW (order approval + warehouse intake fields).
-- Run AFTER phase1/phase2, as its OWN execution. Idempotent.
-- TEXT + CHECK (no enum types) so it runs as one Supabase transaction safely.
-- =============================================================================

-- 1) ORDERS: approval workflow, routing context, payment -----------------------
alter table orders add column if not exists approval_status text not null default 'approved';
alter table orders drop constraint if exists chk_orders_approval;
alter table orders add constraint chk_orders_approval
  check (approval_status in ('pending', 'approved', 'rejected'));

alter table orders add column if not exists created_by_role text not null default 'admin';
alter table orders drop constraint if exists chk_orders_created_by;
alter table orders add constraint chk_orders_created_by
  check (created_by_role in ('admin', 'vendor'));

alter table orders add column if not exists approved_by uuid references users(id) on delete set null;
alter table orders add column if not exists approved_at timestamptz;
alter table orders add column if not exists approval_note text;

-- Routing context: where the parcel starts and which district it goes to.
alter table orders add column if not exists origin_warehouse_id uuid references warehouses(id) on delete set null;
alter table orders add column if not exists origin_district text;
alter table orders add column if not exists destination_district text;
alter table orders add column if not exists delivery_instructions text;
alter table orders add column if not exists sender_name text;
alter table orders add column if not exists sender_phone text;

-- Payment tracked INDEPENDENTLY from delivery status.
alter table orders add column if not exists payment_method text not null default 'cod';
alter table orders drop constraint if exists chk_orders_payment_method;
alter table orders add constraint chk_orders_payment_method
  check (payment_method in ('cod', 'online', 'advance'));
alter table orders add column if not exists payment_status text not null default 'unpaid';
alter table orders drop constraint if exists chk_orders_payment_status;
alter table orders add constraint chk_orders_payment_status
  check (payment_status in ('unpaid', 'pending', 'paid', 'refunded'));

-- The shipment produced after warehouse intake (nullable until intake).
alter table orders add column if not exists shipment_id uuid references shipments(id) on delete set null;

create index if not exists idx_orders_approval_status on orders(approval_status);
create index if not exists idx_orders_vendor_id       on orders(vendor_id);
create index if not exists idx_orders_shipment_id     on orders(shipment_id);
create index if not exists idx_orders_dest_district   on orders(destination_district);

-- 2) SHIPMENTS: verified warehouse intake details ------------------------------
alter table shipments add column if not exists parcel_type text not null default 'package';
alter table shipments drop constraint if exists chk_shipments_parcel_type;
alter table shipments add constraint chk_shipments_parcel_type
  check (parcel_type in ('document', 'package', 'fragile', 'perishable', 'liquid', 'other'));

alter table shipments add column if not exists quantity integer not null default 1;
alter table shipments drop constraint if exists chk_shipments_quantity;
alter table shipments add constraint chk_shipments_quantity check (quantity > 0);

alter table shipments add column if not exists length_cm numeric(10,2);
alter table shipments add column if not exists width_cm numeric(10,2);
alter table shipments add column if not exists height_cm numeric(10,2);
alter table shipments add column if not exists handling_requirements text;

-- Sender details (recipient_* already exist).
alter table shipments add column if not exists sender_name text;
alter table shipments add column if not exists sender_phone text;

-- Districts drive the last-mile vs inter-warehouse decision.
alter table shipments add column if not exists origin_district text;
alter table shipments add column if not exists destination_district text;
alter table shipments add column if not exists delivery_instructions text;

-- Payment independent of delivery.
alter table shipments add column if not exists payment_method text not null default 'cod';
alter table shipments drop constraint if exists chk_shipments_payment_method;
alter table shipments add constraint chk_shipments_payment_method
  check (payment_method in ('cod', 'online', 'advance'));
alter table shipments add column if not exists payment_status text not null default 'unpaid';
alter table shipments drop constraint if exists chk_shipments_payment_status;
alter table shipments add constraint chk_shipments_payment_status
  check (payment_status in ('unpaid', 'pending', 'paid', 'refunded'));

-- Intake provenance.
alter table shipments add column if not exists verified_by uuid references users(id) on delete set null;
alter table shipments add column if not exists verified_at timestamptz;

-- Current warehouse the parcel physically sits at (updated on scan/transfer).
alter table shipments add column if not exists current_warehouse_id uuid references warehouses(id) on delete set null;

-- Routing decision cached at intake: 'last_mile' (same district) / 'inter_warehouse'.
alter table shipments add column if not exists route_kind text;
alter table shipments drop constraint if exists chk_shipments_route_kind;
alter table shipments add constraint chk_shipments_route_kind
  check (route_kind is null or route_kind in ('last_mile', 'inter_warehouse'));

create index if not exists idx_shipments_dest_district  on shipments(destination_district);
create index if not exists idx_shipments_current_wh     on shipments(current_warehouse_id);
create index if not exists idx_shipments_payment_status on shipments(payment_status);
