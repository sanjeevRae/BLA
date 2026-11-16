"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { NavGroupView } from "@/lib/navigation/registry";
import { NavIcon } from "@/components/layout/icons";

/**
 * The grouped, permission-filtered navigation list (V2 Phase 1).
 * Rendered by both the desktop sidebar (expanded or icon-collapsed)
 * and the mobile drawer — one component, so the two can never drift.
 * Active state follows the longest registry href that prefixes the
 * current path; the dashboard home item is active only on exact match.
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
    <nav aria-label="Dashboard" className="flex flex-col gap-4">
      {groups.map((group) => (
        <div key={group.id}>
          {collapsed ? (
            <div aria-hidden="true" className="mx-3 border-t border-line" />
          ) : (
            <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
              {group.label}
            </div>
          )}
          <ul className="flex flex-col">
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
                    className={`flex min-h-[44px] items-center gap-2.5 rounded-md px-3 text-[13px] font-medium ${
                      collapsed ? "justify-center px-0" : ""
                    } ${
                      active
                        ? "bg-accentbg text-brand"
                        : "text-ink hover:bg-cream"
                    }`}
                  >
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
