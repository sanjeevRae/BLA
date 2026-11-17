"use client";

import type { ReactNode } from "react";
import { useState } from "react";
import Link from "next/link";

import type { NavGroupView, NavItemView } from "@/lib/navigation/registry";
import { NotificationsBell } from "@/components/operations/bell";
import { Breadcrumbs } from "@/components/layout/Breadcrumbs";
import { CommandMenu, CommandMenuTrigger } from "@/components/layout/CommandMenu";
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
 * The shared dashboard chrome (V2 Phase 1; V3 Step 3 shell, DS §5/
 * §7.1/§7.2): dark graphite-teal sidebar (248px expanded / 72px
 * icon-collapsed on desktop, slide-over drawer with scrim on
 * mobile) and a 60px white header carrying breadcrumbs, the
 * command-menu trigger, quick actions, warehouse context, the
 * notifications bell, and the profile menu. All navigation data was
 * permission-filtered server-side by DashboardShell from the single
 * registry — this component only renders it.
 */
export function ShellFrame(props: ShellFrameProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const initials = props.userName
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  const brand = (expanded: boolean) => (
    <Link
      href={props.dashboardHomeHref}
      className="focus-on-dark flex min-h-[44px] items-center gap-2.5 px-3"
      aria-label="BLA Logistics — dashboard home"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-dark text-[15px] font-semibold text-white">
        B
      </span>
      {expanded ? (
        <span className="truncate text-[17px] leading-tight">
          <span className="font-semibold text-white">BLA</span>{" "}
          <span className="font-normal text-sidebar-text">Logistics</span>
        </span>
      ) : null}
    </Link>
  );

  const collapseToggle = (
    <button
      type="button"
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!collapsed}
      className="focus-on-dark flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-sidebar-text hover:bg-white/[0.06] hover:text-white"
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
  );

  return (
    <div className="min-h-screen bg-page lg:flex">
      {/* Desktop sidebar */}
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 flex-col bg-sidebar text-sidebar-text lg:flex ${
          collapsed ? "w-[72px]" : "w-[248px]"
        }`}
      >
        <div className="border-b border-white/10 py-2">{brand(!collapsed)}</div>
        <div className="flex-1 overflow-y-auto px-2 py-3">
          <NavList groups={props.groups} collapsed={collapsed} />
        </div>
        <div className="border-t border-white/10 p-2">
          {collapsed ? (
            <div className="flex flex-col items-center gap-1">
              <span
                aria-hidden="true"
                title={props.userName}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-dark text-[12px] font-semibold text-white"
              >
                {initials || "?"}
              </span>
              {collapseToggle}
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-dark text-[12px] font-semibold text-white"
              >
                {initials || "?"}
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-[13px] font-semibold text-white">
                  {props.userName}
                </span>
                <span className="block truncate text-[11.5px] text-sidebar-text">
                  {props.title}
                </span>
              </span>
              {collapseToggle}
            </div>
          )}
        </div>
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
          <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-sidebar text-sidebar-text shadow-pop">
            <div className="flex items-center justify-between border-b border-white/10 py-2 pr-2">
              {brand(true)}
              <button
                type="button"
                aria-label="Close navigation"
                className="focus-on-dark flex h-11 w-11 items-center justify-center rounded-md text-sidebar-text hover:bg-white/[0.06] hover:text-white"
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
        <header className="sticky top-0 z-40 border-b border-line bg-card">
          <div className="flex h-[60px] items-center gap-2 px-3 sm:px-4">
            <button
              type="button"
              aria-label="Open navigation"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink hover:bg-surface-2 lg:hidden"
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
            <CommandMenuTrigger />
            {props.quickActions.length > 0 ? (
              <div className="hidden items-center gap-1.5 xl:flex">
                {props.quickActions.map((action, index) => (
                  <Link
                    key={action.id}
                    href={action.href}
                    className={
                      index === 0
                        ? "flex h-10 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[14px] font-medium text-white hover:bg-primary-dark"
                        : "flex h-10 items-center gap-1.5 rounded-lg border border-border-control bg-card px-3.5 text-[14px] font-medium text-ink hover:bg-surface-2"
                    }
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
        </header>
        <main className="mx-auto w-full max-w-[1450px] flex-1 px-4 py-6 sm:px-5">
          {props.children}
        </main>
      </div>

      <CommandMenu items={props.searchItems} quickActions={props.quickActions} />
    </div>
  );
}
