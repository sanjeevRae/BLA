"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";

/**
 * Profile menu (V2 Phase 1): identity, role, and the account links
 * that already exist (notifications inbox, MFA security, password).
 * Sign-out is the existing server-action form, passed in by the
 * server shell so this component stays client-only.
 */
export function ProfileMenu({
  name,
  email,
  roleLabel,
  notificationsHref,
  signOut,
}: {
  name: string;
  email: string;
  roleLabel: string;
  notificationsHref: string | null;
  signOut: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open ]);

  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");

  const linkClass =
    "flex min-h-[44px] items-center px-3 text-[13px] font-medium text-ink hover:bg-surface-2";

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${name}`}
        className="flex h-11 items-center gap-2.5 rounded-md px-2 hover:bg-surface-2"
        onClick={() => setOpen((v) => !v)}
      >
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-light text-[12px] font-bold text-primary-dark"
        >
          {initials || "?"}
        </span>
        <span className="hidden text-left leading-tight lg:block">
          <span className="block max-w-[160px] truncate text-[13px] font-semibold text-ink">
            {name}
          </span>
          <span className="block max-w-[160px] truncate text-[11px] text-ink-2">{roleLabel}</span>
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-[260px] overflow-hidden rounded-lg border border-line bg-card shadow-pop"
        >
          <div className="border-b border-line px-3 py-2.5">
            <div className="truncate text-[13px] font-semibold text-ink">{name}</div>
            <div className="truncate text-[12px] text-ink-2">{email}</div>
            <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-2">
              {roleLabel}
            </div>
          </div>
          {notificationsHref ? (
            <Link role="menuitem" className={linkClass} href={notificationsHref} onClick={() => setOpen(false)}>
              Notifications
            </Link>
          ) : null}
          <Link role="menuitem" className={linkClass} href="/mfa-setup" onClick={() => setOpen(false)}>
            Security &amp; MFA
          </Link>
          <Link role="menuitem" className={linkClass} href="/set-password" onClick={() => setOpen(false)}>
            Change password
          </Link>
          <div className="border-t border-line px-3 py-2">{signOut}</div>
        </div>
      ) : null}
    </div>
  );
}
