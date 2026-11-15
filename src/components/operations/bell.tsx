"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  listMyNotificationsAction,
  markAllNotificationsReadAction,
  markNotificationReadAction,
} from "@/server/actions/operations";

interface BellItem {
  id: string;
  title: string;
  body: string;
  category: string;
  readAt: string | null;
  createdAt: string;
}

/**
 * Notifications bell for the dashboard shells: unread badge +
 * dropdown with the caller's latest in-app notifications. All data
 * comes from the caller's own notification rows (the service scopes
 * by user) — recipient-addressed rows never appear here.
 */
export function NotificationsBell() {
  const pathname = usePathname();
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<BellItem[]>([]);
  const [available, setAvailable] = useState(true);
  const boxRef = useRef<HTMLDivElement>(null);

  const basePath = pathname?.split("/").slice(0, 2).join("/") || "/admin";

  const refreshCount = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/unread-count");
      if (!res.ok) return;
      const data = (await res.json()) as { count: number };
      setCount(data.count);
    } catch {
      // chrome only — never break the shell
    }
  }, []);

  const loadItems = useCallback(async () => {
    const result = await listMyNotificationsAction({ pageSize: 10 });
    if (!result.success) {
      setAvailable(false);
      return;
    }
    setItems(result.data.items as BellItem[]);
    setCount(result.data.unreadCount);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/notifications/unread-count")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { count: number } | null) => {
        if (!cancelled && data) setCount(data.count);
      })
      .catch(() => {
        // chrome only — never break the shell
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listMyNotificationsAction({ pageSize: 10 })
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          setAvailable(false);
          return;
        }
        setItems(result.data.items as BellItem[]);
        setCount(result.data.unreadCount);
      })
      .catch(() => {
        // chrome only
      });
    function onClick(event: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => {
      cancelled = true;
      document.removeEventListener("mousedown", onClick);
    };
  }, [open ]);

  if (!available && count === 0) return null;

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        aria-label="Notifications"
        className="relative rounded-full border border-line bg-page px-3 py-1.5 text-[13px] font-semibold text-ink"
        onClick={() => setOpen((v) => !v)}
      >
        Bell
        {count > 0 ? (
          <span className="absolute -right-1.5 -top-1.5 rounded-full bg-red px-1.5 py-0.5 text-[10px] font-bold text-white">
            {count}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-[360px] rounded-lg border border-line bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-[13px] font-semibold text-ink">Notifications</span>
            <button
              type="button"
              className="text-[12px] font-medium text-slate2 underline"
              onClick={() => {
                void markAllNotificationsReadAction().then(() => {
                  void loadItems();
                  void refreshCount();
                });
              }}
            >
              Mark all read
            </button>
          </div>
          {items.length === 0 ? (
            <p className="px-3 py-4 text-[13px] text-slate2">No notifications.</p>
          ) : (
            <ul className="max-h-[380px] overflow-y-auto">
              {items.map((n) => (
                <li key={n.id} className="border-b border-line/60 px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-[13px] font-semibold text-ink">
                        {n.title}
                        {!n.readAt ? (
                          <span className="ml-2 text-[10px] font-bold text-red">NEW</span>
                        ) : null}
                      </div>
                      <p className="text-[12px] leading-snug text-slate2">{n.body}</p>
                      <div className="text-[11px] text-faint">
                        {n.category} · {new Date(n.createdAt).toLocaleString()}
                      </div>
                    </div>
                    {!n.readAt ? (
                      <button
                        type="button"
                        className="shrink-0 text-[12px] font-medium text-slate2 underline"
                        onClick={() => {
                          void markNotificationReadAction(n.id).then(() => {
                            void loadItems();
                            void refreshCount();
                          });
                        }}
                      >
                        Read
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="px-3 py-2">
            <Link
              className="text-[12px] font-medium text-slate2 underline"
              href={`${basePath}/notifications`}
              onClick={() => setOpen(false)}
            >
              Open the full inbox &amp; preferences
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
}
