import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Helpful warning during local dev if .env is missing.
  // eslint-disable-next-line no-console
  console.warn('VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set.');
}

export const supabase = createClient(url ?? '', anonKey ?? '', {
  realtime: { params: { eventsPerSecond: 10 } },
});
