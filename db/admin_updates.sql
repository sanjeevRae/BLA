-- Separate admin seed for cashflow, notifications, messages, and settings.
-- NOTE: canonical definitions now live in db/schema.sql; this file only seeds.

insert into admin_notifications (title, body, type)
values
  ('Daily cashflow synced', 'Revenue and payout numbers were refreshed from payments.', 'success'),
  ('Pending orders need attention', 'Review dispatch for pending or failed orders.', 'warning')
on conflict do nothing;

insert into admin_messages (sender_name, body)
values
  ('Dispatch bot', 'Driver availability updated from latest assignments.'),
  ('Ops support', 'Customer contact panel is ready in the admin dashboard.')
on conflict do nothing;

insert into admin_settings (setting_key, setting_value)
values
  ('auto_assign', '{"enabled": false}'::jsonb),
  ('realtime_tracking', '{"enabled": true}'::jsonb),
  ('customer_alerts', '{"enabled": true}'::jsonb)
on conflict (setting_key) do update
set setting_value = excluded.setting_value,
    updated_at = now();

insert into admin_help (title, body, link)
values
  ('How cashflow is calculated', 'Paid payments summed per delivery; pending shown separately.', '/analytics/cashflow'),
  ('How to manage customers', 'Search, create, edit, and delete customers from the admin panel.', '/customers')
on conflict do nothing;

