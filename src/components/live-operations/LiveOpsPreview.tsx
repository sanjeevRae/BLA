"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  FreshnessBadge,
  relativeTime,
} from "@/components/live-operations/LiveOperationsBoard";
import type {
  LiveOperationItem,
  LiveOperationsListResponse,
  WarehouseCoordsMap,
} from "@/components/live-operations/types";
import { EmptyState, Skeleton } from "@/components/ui/states";

/**
 * Live Operations preview (V3 Step 4) — the compact home-dashboard
 * surface. It reuses the existing LiveMap island and the existing
 * GET /api/live-operations API; it does not fork the board.
 *
 * Polling mirrors the board exactly: every 50s, only while the
 * document is visible, with an immediate refetch on visibility
 * return. A failed fetch keeps the last good items on screen and
 * flags them with a small note — the preview never blanks out.
 * The warehouse prop is display scope only: the API re-intersects
 * it with the actor's authority server-side on every fetch.
 */

const LiveMap = dynamic(() => import("@/components/live-operations/LiveMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[300px] items-center justify-center rounded-lg border border-line bg-surface text-[13px] text-slate2">
      Loading map…
    </div>
  ),
});

const POLL_INTERVAL_MS = 50_000;

const TYPE_LABELS: Record<LiveOperationItem["trackingType"], string> = {
  LINEHAUL: "Warehouse transfer",
  PICKUP: "Pickup",
  DELIVERY: "Delivery",
};

function clockTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export interface PreviewSummary {
  activeTrips: number;
  activeRiders: number;
  delayedMovements: number;
  stalest: LiveOperationItem[];
}

/**
 * Pure aggregation for the preview side column. Only sessions that
 * are ACTIVE or PAUSED count. The stalest ordering reuses the board
 * summary rule: never-reported movements (location === null) first,
 * then oldest lastReceivedAt first, capped at three.
 */
export function summarizePreviewItems(
  items: readonly LiveOperationItem[],
): PreviewSummary {
  const active = items.filter(
    (item) => item.sessionStatus === "ACTIVE" || item.sessionStatus === "PAUSED",
  );

  const activeTrips = active.filter(
    (item) => item.trackingType === "LINEHAUL",
  ).length;

  const activeRiders = new Set(active.map((item) => item.driverId)).size;

  const delayedMovements = active.filter(
    (item) => item.freshnessState === "DELAYED",
  ).length;

  const stalest = [...active]
    .sort((a, b) => {
      const at = a.location?.lastReceivedAt ?? null;
      const bt = b.location?.lastReceivedAt ?? null;
      if (at === null && bt === null) return 0;
      if (at === null) return -1;
      if (bt === null) return 1;
      return at < bt ? -1 : at > bt ? 1 : 0;
    })
    .slice(0, 3);

  return { activeTrips, activeRiders, delayedMovements, stalest };
}

export interface LiveOpsPreviewProps {
  basePath: string;
  warehouseCoords: WarehouseCoordsMap;
  initialWarehouseId: string | null;
}

export function LiveOpsPreview({
  basePath,
  warehouseCoords,
  initialWarehouseId,
}: LiveOpsPreviewProps) {
  const [items, setItems] = useState<LiveOperationItem[]>([]);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const loadList = useCallback(async (): Promise<
    { ok: true; body: LiveOperationsListResponse } | { ok: false }
  > => {
    const params = new URLSearchParams();
    if (initialWarehouseId) params.set("warehouseId", initialWarehouseId);
    const query = params.toString();
    try {
      const res = await fetch(`/api/live-operations${query ? `?${query}` : ""}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true, body: (await res.json()) as LiveOperationsListResponse };
    } catch {
      return { ok: false };
    }
  }, [initialWarehouseId]);

  const applyListResult = useCallback(
    (result: { ok: true; body: LiveOperationsListResponse } | { ok: false }) => {
      if (result.ok) {
        setItems(result.body.items ?? []);
        setLastRefreshedAt(new Date());
        setFetchFailed(false);
      } else {
        // Keep the last good items; flag the data as possibly stale.
        setFetchFailed(true);
      }
      setHasLoaded(true);
    },
    [],
  );

  const refreshList = useCallback(() => {
    void loadList().then(applyListResult);
  }, [loadList, applyListResult]);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    void loadList().then((result) => {
      if (!cancelled) applyListResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [loadList, applyListResult]);

  // Poll every 50s while visible; pause while hidden; refetch
  // immediately on return to visibility (same pattern as the board).
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") refreshList();
    }, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === "visible") refreshList();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshList]);

  // Relative-time tick.
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const viewAllLink = (
    <Link
      href={`${basePath}/live-operations`}
      className="text-[13px] font-semibold text-brand"
    >
      View All Live Operations →
    </Link>
  );

  if (!hasLoaded) {
    return (
      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]" aria-label="Loading live operations">
        <Skeleton className="h-[300px] w-full" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        {fetchFailed ? (
          <p role="alert" className="text-[12px] font-semibold text-reddeep">
            refresh failed — showing last known positions
          </p>
        ) : null}
        <EmptyState
          title="No active movements"
          description="Active transfers, pickups and deliveries appear here while tracking is on."
          action={viewAllLink}
        />
      </div>
    );
  }

  const summary = summarizePreviewItems(items);

  const countRows: { label: string; value: number }[] = [
    { label: "Active trips", value: summary.activeTrips },
    { label: "Active riders", value: summary.activeRiders },
    { label: "Delayed movements", value: summary.delayedMovements },
  ];

  return (
    <div className="flex flex-col gap-3">
      {fetchFailed ? (
        <p role="alert" className="text-[12px] font-semibold text-reddeep">
          refresh failed — showing last known positions
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div>
          <LiveMap
            items={items}
            selectedId={selectedId}
            onSelect={(id) => setSelectedId(id)}
            warehouseCoords={warehouseCoords}
            selectedWarehouseId={initialWarehouseId}
            onShowAllAuthorized={() => {
              // Display fit only: LiveMap fits the current items
              // itself after this callback. The fetch scope is not
              // changed here — scope changes belong to the full
              // Live Operations page.
            }}
            heightClassName="h-[300px]"
            showLegend
          />
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            {countRows.map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-2"
              >
                <span className="text-[13px] text-slate2">{row.label}</span>
                <span className="tnum text-[14px] font-semibold text-ink">
                  {row.value}
                </span>
              </div>
            ))}
          </div>

          {summary.stalest.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-[13px] font-semibold text-ink">
                Least-recent updates
              </h3>
              {summary.stalest.map((item) => {
                const selected = item.trackingSessionId === selectedId;
                return (
                  <button
                    key={item.trackingSessionId}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setSelectedId(item.trackingSessionId)}
                    className={`flex flex-col gap-1 rounded-lg border px-3 py-2 text-left ${
                      selected
                        ? "border-brand bg-accentbg"
                        : "border-line bg-surface hover:bg-page"
                    }`}
                  >
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-ink">
                        {item.driverName}
                      </span>
                      <FreshnessBadge state={item.freshnessState} />
                    </span>
                    <span className="text-[12px] text-slate2">
                      {`${TYPE_LABELS[item.trackingType]} · ${item.origin.code} → ${item.destination ? item.destination.code : "Local"}`}
                    </span>
                    <span className="text-[12px] text-slate2">
                      Last update{" "}
                      {relativeTime(item.location?.lastReceivedAt ?? null, nowMs)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-slate2">
          Updated {lastRefreshedAt ? clockTime(lastRefreshedAt.toISOString()) : "—"}
        </span>
        {viewAllLink}
      </div>
    </div>
  );
}

export default LiveOpsPreview;
