import type { ReactNode } from "react";

import type { ActorContext } from "@/lib/auth/actor";
import {
  groupNavItems,
  toNavGroupViews,
  visibleNavItems,
  visibleQuickActions,
  type DashboardId,
  type NavItemView,
} from "@/lib/navigation/registry";
import { getRequestedWarehouseScope } from "@/lib/navigation/scope";
import { listWarehouses } from "@/server/services/warehouses";
import { SignOutButton } from "@/components/layout/SignOutButton";
import { ShellFrame } from "@/components/layout/ShellFrame";
import type { WarehouseOption } from "@/components/layout/WarehouseSelector";

/**
 * The shared dashboard shell (V2 Phase 1, audit defect H-1).
 *
 * Server component: it derives everything the chrome renders from
 * the signed-in actor and the single navigation registry
 * (src/lib/navigation/registry.ts) — sidebar groups, quick actions,
 * and search index are all permission-filtered here, so a user only
 * ever sees links their permissions entitle them to. That filtering
 * is UX only; every page and service behind those links keeps its
 * own server-side enforcement.
 *
 * Warehouse context: actors with global warehouse read, or membership
 * of more than one warehouse, get the top-bar selector. The stored
 * choice is a requested scope (see lib/navigation/scope.ts) and is
 * re-validated against the actor's scope on every render.
 */
export async function DashboardShell({
  actor,
  title,
  dashboard,
  children,
}: {
  actor: ActorContext;
  title: string;
  dashboard: DashboardId;
  children: ReactNode;
}) {
  const items = visibleNavItems(actor.permissions, dashboard);
  const groups = toNavGroupViews(groupNavItems(items));
  const toView = (item: (typeof items)[number]): NavItemView => ({
    id: item.id,
    label: item.label,
    href: item.href,
    icon: item.icon,
  });
  const searchItems = items.map(toView);
  const quickActions = visibleQuickActions(actor.permissions, dashboard).map(toView);

  let warehouses: WarehouseOption[] | null = null;
  let selectedWarehouseId: string | null = null;
  const canSelectAllWarehouses = actor.permissions.has("warehouse.read_all");
  if (canSelectAllWarehouses || actor.warehouseIds.length > 1) {
    try {
      const { items: rows } = await listWarehouses(actor, { pageSize: 100 });
      warehouses = rows.map((w) => ({ id: w.id, code: w.code, name: w.name }));
      const requested = await getRequestedWarehouseScope();
      selectedWarehouseId =
        requested && warehouses.some((w) => w.id === requested) ? requested : null;
    } catch {
      // Chrome only — a failed warehouse lookup must never break the shell.
      warehouses = null;
    }
  }

  return (
    <ShellFrame
      title={title}
      dashboardHomeHref={`/${dashboard}`}
      groups={groups}
      quickActions={quickActions}
      searchItems={searchItems}
      warehouses={warehouses}
      selectedWarehouseId={selectedWarehouseId}
      canSelectAllWarehouses={canSelectAllWarehouses}
      userName={actor.fullName}
      userEmail={actor.email}
      notificationsHref={`/${dashboard}/notifications`}
      signOut={<SignOutButton />}
    >
      {children}
    </ShellFrame>
  );
}
