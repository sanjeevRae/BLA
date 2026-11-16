"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";

import type { NavGroupView, NavItemView } from "@/lib/navigation/registry";
import { NotificationsBell } from "@/components/operations/bell";
import { Breadcrumbs } from "@/components/layout/Breadcrumbs";
import { GlobalSearch } from "@/components/layout/GlobalSearch";
import { NavList } from "@/components/layout/NavList";
import { ProfileMenu } from "@/components/layout/ProfileMenu";
import {
  WarehouseSelector,
  type WarehouseOption,
} from "@/components/layout/WarehouseSelector";
import { NavIcon } from "@/components/layout/icons";

export interface ShellFrameProps {
  title: string;
  dashboardHomeHref: string;
  groups: NavGroupView[];
  quickActions: NavItemView[];
  searchItems: NavItemView[];
  warehouses: WarehouseOption[] | null;
  selectedWarehouseId: string | null;
  canSelectAllWarehouses: boolean;
  userName: string;
  userEmail: string;
  /** Null when the actor lacks notification.read_own — the bell and
   *  the profile-menu inbox link are then not rendered at all. */
  notificationsHref: string | null;
  signOut: ReactNode;
  children: ReactNode;
}

/**
 * The shared dashboard chrome (V2 Phase 1): collapsible sidebar on
 * desktop, drawer navigation on mobile, and a top bar carrying
 * breadcrumbs, search, quick actions, warehouse context, the
 * notifications bell, and the profile menu. All navigation data was
 * permission-filtered server-side by DashboardShell from the single
 * registry — this component only renders it.
 */
export function ShellFrame(props: ShellFrameProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const brand = (
    <Link
      href={props.dashboardHomeHref}
      className="flex min-h-[44px] items-center gap-2 px-3"
      aria-label="BLA Logistics — dashboard home"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand text-[13px] font-bold text-white">
        B
      </span>
      {collapsed ? null : (
        <span className="truncate text-[15px] font-bold text-ink">BLA Logistics</span>
      )}
    </Link>
  );

  return (
    <div className="min-h-screen bg-page lg:flex">
      {/* Desktop sidebar */}
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-line bg-surface lg:flex ${
          collapsed ? "w-[68px]" : "w-60"
        }`}
      >
        <div className="flex items-center justify-between border-b border-line py-2 pr-2">
          {brand}
          <button
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-slate2 hover:bg-cream"
            onClick={() => setCollapsed((v) => !v)}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              className={`h-5 w-5 transition-transform ${collapsed ? "rotate-180" : ""}`}
            >
              <path d="m14 6-6 6 6 6" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-3">
          <NavList groups={props.groups} collapsed={collapsed} />
        </div>
        {collapsed ? null : (
          <div className="border-t border-line px-4 py-3 text-[11px] leading-snug text-faint">
            {props.title} workspace
          </div>
        )}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 h-full w-full bg-ink/40"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-surface shadow-pop">
            <div className="flex items-center justify-between border-b border-line py-2 pr-2">
              {brand}
              <button
                type="button"
                aria-label="Close navigation"
                className="flex h-11 w-11 items-center justify-center rounded-md text-slate2 hover:bg-cream"
                onClick={() => setDrawerOpen(false)}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  className="h-5 w-5"
                >
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-2 py-3">
              <NavList groups={props.groups} onNavigate={() => setDrawerOpen(false)} />
            </div>
          </div>
        </div>
      ) : null}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 border-b border-line bg-surface">
          <div className="flex items-center gap-2 px-3 py-2 sm:px-4">
            <button
              type="button"
              aria-label="Open navigation"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink hover:bg-cream lg:hidden"
              onClick={() => setDrawerOpen(true)}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                className="h-5 w-5"
              >
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <div className="min-w-0 flex-1">
              <Breadcrumbs
                homeHref={props.dashboardHomeHref}
                homeLabel={props.title}
                items={props.searchItems}
              />
            </div>
            <div className="hidden md:block">
              <GlobalSearch items={props.searchItems} />
            </div>
            {props.quickActions.length > 0 ? (
              <div className="hidden items-center gap-1.5 xl:flex">
                {props.quickActions.map((action) => (
                  <Link
                    key={action.id}
                    href={action.href}
                    className="flex h-11 items-center gap-1.5 rounded-md bg-brand px-3 text-[13px] font-semibold text-white hover:opacity-90"
                  >
                    <NavIcon name={action.icon} className="h-4 w-4" />
                    {action.label}
                  </Link>
                ))}
              </div>
            ) : null}
            {props.warehouses ? (
              <WarehouseSelector
                warehouses={props.warehouses}
                selectedId={props.selectedWarehouseId}
                canSelectAll={props.canSelectAllWarehouses}
              />
            ) : null}
            {props.notificationsHref ? <NotificationsBell /> : null}
            <ProfileMenu
              name={props.userName}
              email={props.userEmail}
              roleLabel={props.title}
              notificationsHref={props.notificationsHref}
              signOut={props.signOut}
            />
          </div>
          <div className="px-3 pb-2 md:hidden">
            <GlobalSearch items={props.searchItems} />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1450px] flex-1 px-4 py-6 sm:px-5">
          {props.children}
        </main>
      </div>
    </div>
  );
}
