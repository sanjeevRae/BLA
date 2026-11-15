import type { ReactNode } from "react";

import type { ActorContext } from "@/lib/auth/actor";
import { SignOutButton } from "@/components/layout/SignOutButton";
import { NotificationsBell } from "@/components/operations/bell";

/**
 * Minimal dashboard frame for Phase 1 — header with the signed-in user's
 * identity and sign-out. The full Sidebar/TopBar migration (spec Part 19
 * navigation) lands with the module phases.
 */
export function DashboardShell({
  actor,
  title,
  children,
}: {
  actor: ActorContext;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-page">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[1450px] items-center justify-between px-5 py-3">
          <div className="flex items-baseline gap-3">
            <span className="text-[15px] font-bold text-ink">BLA Logistics</span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate2">
              {title}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <NotificationsBell />
            <div className="text-right leading-tight">
              <div className="text-[13px] font-semibold text-ink">{actor.fullName}</div>
              <div className="text-[12px] text-faint">{actor.email}</div>
            </div>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1450px] px-5 py-6">{children}</main>
    </div>
  );
}
