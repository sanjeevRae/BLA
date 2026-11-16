"use server";

import { cookies } from "next/headers";

import { getActorContext } from "@/lib/auth/permissions";
import { WAREHOUSE_SCOPE_COOKIE } from "@/lib/navigation/scope";

/**
 * Persist the top-bar warehouse selector choice (V2 Phase 1).
 *
 * The value is validated against the actor's own scope before it is
 * stored — a global reader (warehouse.read_all) may pick any
 * warehouse; anyone else only one of their membership warehouses.
 * An out-of-scope value clears the preference instead of storing it.
 * The cookie is a display preference only; services never authorise
 * from it.
 */
export async function setWarehouseScopeAction(warehouseId: string | null): Promise<void> {
  const actor = await getActorContext();
  if (!actor) return;

  const store = await cookies();
  if (!warehouseId) {
    store.delete(WAREHOUSE_SCOPE_COOKIE);
    return;
  }
  const allowed =
    actor.permissions.has("warehouse.read_all") || actor.warehouseIds.includes(warehouseId);
  if (!allowed) {
    store.delete(WAREHOUSE_SCOPE_COOKIE);
    return;
  }
  store.set(WAREHOUSE_SCOPE_COOKIE, warehouseId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}
