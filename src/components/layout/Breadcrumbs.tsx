"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { NavItemView } from "@/lib/navigation/registry";

/**
 * Route-derived breadcrumbs (V2 Phase 1). Segment labels come from
 * the navigation registry where a registry href matches; opaque id
 * segments render as "Detail"; anything else is humanised. The first
 * crumb is always the dashboard home.
 */
export function Breadcrumbs({
  homeHref,
  homeLabel,
  items,
}: {
  homeHref: string;
  homeLabel: string;
  items: NavItemView[];
}) {
  const pathname = usePathname() ?? homeHref;
  const labelByHref = new Map(items.map((item) => [item.href, item.label]));

  const segments = pathname.split("/").filter(Boolean);
  const crumbs: { href: string; label: string }[] = [{ href: homeHref, label: homeLabel }];
  let acc = "";
  segments.forEach((segment, index) => {
    acc += `/${segment}`;
    if (index === 0) return; // dashboard root segment = home crumb
    const known = labelByHref.get(acc);
    if (known) {
      crumbs.push({ href: acc, label: known });
    } else if (/^[0-9a-f-]{12,}$/i.test(segment) || /^\d+$/.test(segment)) {
      crumbs.push({ href: acc, label: "Detail" });
    } else {
      crumbs.push({
        href: acc,
        label: segment.replaceAll("-", " ").replace(/^\w/, (c) => c.toUpperCase()),
      });
    }
  });

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-[13px]">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={crumb.href} className="flex min-w-0 items-center gap-1.5">
              {index > 0 ? (
                <span aria-hidden="true" className="text-faint">
                  /
                </span>
              ) : null}
              {last ? (
                <span aria-current="page" className="truncate font-semibold text-ink">
                  {crumb.label}
                </span>
              ) : (
                <Link href={crumb.href} className="truncate text-slate2 hover:text-ink">
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
