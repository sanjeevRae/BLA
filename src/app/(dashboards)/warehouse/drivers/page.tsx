import { requireActor } from "@/lib/auth/permissions";
import { DriversPage } from "@/components/fleet/pages";

/**
 * Warehouse Admin fleet surface (audit M-4): the shared DriversPage
 * with the WA actor — listDrivers scopes the rows to drivers homed
 * at the actor's own warehouses inside the service, and the
 * management controls render only under driver.manage, which WA
 * holds for its own scope (service re-checks scope per write).
 */
export default async function Page() {
  const actor = await requireActor();
  return <DriversPage actor={actor} />;
}
