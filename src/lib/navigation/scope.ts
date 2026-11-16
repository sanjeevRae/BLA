import { cookies } from "next/headers";

/**
 * The top-bar warehouse selector's persisted state (V2 Phase 1).
 *
 * This is a REQUESTED scope only — a display/context preference the
 * user picks in the shell. It never grants access: every service
 * keeps enforcing permission + membership scope server-side exactly
 * as before, and later phases may read this preference to default
 * their filters. A stale or forged cookie value is harmless because
 * nothing authorises from it.
 */
export const WAREHOUSE_SCOPE_COOKIE = "bla_wh_scope";

export async function getRequestedWarehouseScope(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(WAREHOUSE_SCOPE_COOKIE)?.value?.trim();
  return value ? value : null;
}
