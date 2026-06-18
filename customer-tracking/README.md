# BLA Customer Tracking Page

A single, framework-free HTML/JS page that shows a customer their order's
status progression and the driver's live location on a MapTiler map.

## Run locally

```bash
cd customer-tracking
cp config.example.js config.js   # fill in Supabase anon key + MapTiler key
# serve the folder (any static server)
python3 -m http.server 8080      # then open http://localhost:8080
```

Deep link directly to an order: `index.html?order=BLA-2026-0002`.

## How it works

- Looks up the order by number (Supabase direct read, RLS-protected).
- Renders the progression: received → on place → went for delivery →
  out for delivery → delivered.
- Subscribes to Supabase Realtime:
  - `gps_tracking` INSERTs (`order_id` filter) → moves the driver marker.
  - `delivery_status_history` INSERTs → advances the status tracker.

## Deploy

Static host (Vercel/Netlify). No build step — publish the folder. Provide the
public config via `config.js` (git-ignored) or inject at deploy time.
Restrict the MapTiler key to your domain in the MapTiler dashboard.
