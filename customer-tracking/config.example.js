// Copy to config.js and fill in. These are PUBLIC client values:
//   - Supabase ANON key (never the service key) — RLS protects the data.
//   - MapTiler key (restrict it to your domain in the MapTiler dashboard).
//
// config.js is git-ignored; for static hosting you can also inject these at
// build/deploy time instead of committing a file.
window.BLA_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT.supabase.co',
  SUPABASE_ANON_KEY: 'your-anon-key',
  MAPTILER_API_KEY: 'your-maptiler-key',
  // Base URL of the FastAPI backend (used to fetch order status by tracking code).
  API_BASE_URL: 'http://localhost:8000',
};
