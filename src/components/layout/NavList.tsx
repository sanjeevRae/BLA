"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { NavGroupView } from "@/lib/navigation/registry";
import { NavIcon } from "@/components/layout/icons";

/**
 * The grouped, permission-filtered navigation list (V2 Phase 1;
 * V3 Step 3 dark-sidebar skin, DS §7.1). Rendered by both the
 * desktop sidebar (expanded or icon-collapsed) and the mobile
 * drawer — one component, so the two can never drift. Active state
 * follows the longest registry href that prefixes the current path;
 * the dashboard home item is active only on exact match.
 *
 * Skin: sidebar-text labels on the graphite-teal sidebar, group
 * labels in sidebar-label, hover = white on a white/6% wash, active
 * = white on primary-dark fill with the 3px accent indicator bar.
 * Focus uses the dark-surface ring (`.focus-on-dark`, DS §2.5).
 */
export function NavList({
  groups,
  collapsed = false,
  onNavigate,
}: {
  groups: NavGroupView[];
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname() ?? "";

  const allHrefs = groups.flatMap((group) => group.items.map((item) => item.href));
  const activeHref = allHrefs
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <nav aria-label="Dashboard" className="flex flex-col gap-5">
      {groups.map((group) => (
        <div key={group.id}>
          {collapsed ? (
            <div aria-hidden="true" className="mx-3 border-t border-white/10" />
          ) : (
            <div className="px-3 pb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.14em] text-sidebar-label">
              {group.label}
            </div>
          )}
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const active = item.href === activeHref;
              return (
                <li key={item.id}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    title={collapsed ? item.label : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    className={`focus-on-dark relative flex h-9 items-center gap-2.5 rounded-md px-3 text-[14px] font-medium ${
                      collapsed ? "justify-center px-0" : ""
                    } ${
                      active
                        ? "bg-primary-dark text-white"
                        : "text-sidebar-text hover:bg-white/[0.06] hover:text-white"
                    }`}
                  >
                    {active ? (
                      <span
                        aria-hidden="true"
                        className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-accent"
                      />
                    ) : null}
                    <NavIcon name={item.icon} className="h-[18px] w-[18px] shrink-0" />
                    {collapsed ? null : <span className="truncate">{item.label}</span>}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
