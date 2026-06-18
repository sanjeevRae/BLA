# BLA Admin Dashboard

React + Vite + Tailwind CSS + MapTiler GL JS. Shows a live driver map,
the orders list, a driver-assignment / dispatch panel, and summary analytics.

## Run locally

```bash
cd admin-dashboard
npm install
cp .env.example .env       # fill in Supabase anon key, MapTiler key, API URL
npm run dev                # http://localhost:5173
```

## Environment

| Variable                  | Purpose                                  |
|---------------------------|------------------------------------------|
| `VITE_SUPABASE_URL`       | Supabase project URL                     |
| `VITE_SUPABASE_ANON_KEY`  | Supabase **anon** key (RLS-protected)    |
| `VITE_MAPTILER_API_KEY`   | MapTiler GL JS tiles                      |
| `VITE_API_BASE_URL`       | FastAPI backend base URL                 |

## Realtime

- **Driver positions:** subscribes to `gps_tracking` INSERTs and moves markers.
- **Orders list:** subscribes to `orders` changes and refreshes the summary.

## Deploy (Vercel)

Import the repo on Vercel, set the project root to `admin-dashboard/`, add the
`VITE_*` env vars, and deploy. `vercel.json` handles the SPA rewrite.
(Netlify config is in `netlify.toml` as an alternative.)
