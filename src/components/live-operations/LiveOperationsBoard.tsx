"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { formatPaisa } from "@/components/bookings/ui";
import { Drawer } from "@/components/ui/Drawer";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatusBadge } from "@/components/ui/StatusBadge";
import type {
  FreshnessState,
  LiveOperationDetail,
  LiveOperationItem,
  LiveOperationsListResponse,
  WarehouseCoordsMap,
  WarehouseOption,
} from "@/components/live-operations/types";

/**
 * Live Operations board (V2 Phase 5) — the client half of the map
 * page. Data comes from GET /api/live-operations (snapshot-based;
 * see docs/live-gps-tracking.md §3):
 *
 * - polling every 50s, ONLY while the document is visible;
 *   visibility return triggers an immediate fetch;
 * - search + warehouse filter go to the SERVER (they change the
 *   authorized result set); the chips below filter the fetched
 *   list client-side;
 * - a failed fetch keeps the last good items on screen, flags the
 *   data as possibly stale, and offers Retry — the board never
 *   blanks out on a network hiccup;
 * - freshness is always rendered next to its last-update time
 *   (guidelines §6): a stale position is never styled as live.
 */

const LiveMap = dynamic(() => import("@/components/live-operations/LiveMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-[420px] items-center justify-center rounded-lg border border-border bg-card text-[13px] text-ink-2">
      Loading map…
    </div>
  ),
});

const POLL_INTERVAL_MS = 50_000;

// ---------------------------------------------------------------------------
// Freshness + relative time
// ---------------------------------------------------------------------------

const FRESHNESS_CLASSES: Record<FreshnessState, string> = {
  FRESH: "bg-successbg text-success",
  DELAYED: "bg-warningbg text-warning",
  STALE: "bg-dangerbg text-danger",
  OFFLINE: "bg-neutralbg text-neutral",
};

const FRESHNESS_LABELS: Record<FreshnessState, string> = {
  FRESH: "Fresh",
  DELAYED: "Delayed",
  STALE: "Stale",
  OFFLINE: "Offline",
};

export function FreshnessBadge({ state }: { state: FreshnessState }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${FRESHNESS_CLASSES[state]}`}
    >
      {FRESHNESS_LABELS[state]}
    </span>
  );
}

export function relativeTime(iso: string | null, nowMs: number): string {
  if (!iso) return "No update yet";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "No update yet";
  const seconds = Math.max(0, Math.round((nowMs - then) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${minutes % 60} min ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

function clockTime(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// ---------------------------------------------------------------------------
// Row copy helpers
// ---------------------------------------------------------------------------

const TYPE_LABELS: Record<LiveOperationItem["trackingType"], string> = {
  LINEHAUL: "Warehouse transfer",
  PICKUP: "Pickup",
  DELIVERY: "Delivery",
};

export function movementRef(item: LiveOperationItem): string {
  if (item.tripNumber) return item.tripNumber;
  if (item.deliveryBatchId) return `${item.origin.code} · ${item.batchDate ?? ""}`.trim();
  return item.origin.code;
}

export function activityLabel(item: LiveOperationItem): string {
  if (item.sessionStatus === "PAUSED") return "Paused";
  if (item.sessionStatus === "ENDED") return "Ended";
  if (item.trackingType === "LINEHAUL") return "In transit";
  if (item.deliveredCount !== null) {
    return item.trackingType === "PICKUP"
      ? `Picking up — ${item.deliveredCount} of ${item.packageCount} collected`
      : `Delivering — ${item.deliveredCount} of ${item.packageCount} delivered`;
  }
  return "In progress";
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

type FilterKey = "ALL" | "LINEHAUL" | "PICKUP" | "DELIVERY" | "ACTIVE" | "DELAYED" | "STALE";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "ALL", label: "All" },
  { key: "LINEHAUL", label: "Warehouse transfers" },
  { key: "PICKUP", label: "Pickups" },
  { key: "DELIVERY", label: "Deliveries" },
  { key: "ACTIVE", label: "Active" },
  { key: "DELAYED", label: "Delayed" },
  { key: "STALE", label: "Stale" },
];

function matchesFilter(item: LiveOperationItem, filter: FilterKey): boolean {
  switch (filter) {
    case "ALL":
      return true;
    case "LINEHAUL":
    case "PICKUP":
    case "DELIVERY":
      return item.trackingType === filter;
    case "ACTIVE":
      return item.freshnessState === "FRESH" || item.freshnessState === "DELAYED";
    case "DELAYED":
      return item.freshnessState === "DELAYED";
    case "STALE":
      return item.freshnessState === "STALE" || item.freshnessState === "OFFLINE";
  }
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export interface LiveOperationsBoardProps {
  basePath: string;
  permissions: string[];
  warehouseOptions: WarehouseOption[];
  warehouseCoords: WarehouseCoordsMap;
  initialWarehouseId: string | null;
}

export function LiveOperationsBoard({
  basePath,
  permissions,
  warehouseOptions,
  warehouseCoords,
  initialWarehouseId,
}: LiveOperationsBoardProps) {
  const permissionSet = useMemo(() => new Set(permissions), [permissions]);
  const isWarehouseDashboard = basePath === "/warehouse";

  const [items, setItems] = useState<LiveOperationItem[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [latestReceivedAt, setLatestReceivedAt] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [warehouseId, setWarehouseId] = useState<string>(
    initialWarehouseId && warehouseOptions.some((w) => w.id === initialWarehouseId)
      ? initialWarehouseId
      : "",
  );
  const [filter, setFilter] = useState<FilterKey>("ALL");
  const [mobileView, setMobileView] = useState<"map" | "list">("list");

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LiveOperationDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const rowRefs = useRef(new Map<string, HTMLButtonElement | null>());

  // Debounce the search box into the server query.
  useEffect(() => {
    const id = window.setTimeout(() => setSearch(searchInput.trim()), 400);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  // The loader returns its result instead of setting state (the
  // Phase 4 panel pattern): callers apply it from promise callbacks
  // and event handlers.
  const loadList = useCallback(async (): Promise<
    { ok: true; body: LiveOperationsListResponse } | { ok: false }
  > => {
    const params = new URLSearchParams();
    if (warehouseId) params.set("warehouseId", warehouseId);
    if (search) params.set("search", search);
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
  }, [warehouseId, search]);

  const applyListResult = useCallback(
    (result: { ok: true; body: LiveOperationsListResponse } | { ok: false }) => {
      if (result.ok) {
        setItems(result.body.items ?? []);
        setGeneratedAt(result.body.generatedAt ?? null);
        setLatestReceivedAt(result.body.latestReceivedAt ?? null);
        setLastRefreshedAt(new Date());
        setFetchError(null);
      } else {
        // Keep the last good items; flag the data as possibly stale.
        setFetchError("Could not refresh live operations. The data below may be stale.");
      }
      setHasLoaded(true);
    },
    [],
  );

  const refreshList = useCallback(() => {
    void loadList().then(applyListResult);
  }, [loadList, applyListResult]);

  // Initial load + refetch when the server-side params change.
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
  // immediately on return to visibility.
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

  const selectSession = useCallback(async (trackingSessionId: string) => {
    setSelectedId(trackingSessionId);
    setDetail(null);
    setDetailError(null);
    try {
      const res = await fetch(`/api/live-operations/${trackingSessionId}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDetail((await res.json()) as LiveOperationDetail);
    } catch {
      setDetailError("Could not load this movement's details. Please retry.");
    }
  }, []);

  // Keep the selected list row in view when selection comes from a
  // marker click.
  useEffect(() => {
    if (!selectedId) return;
    const el = rowRefs.current.get(selectedId);
    if (el && typeof el.scrollIntoView === "function") {
      try {
        el.scrollIntoView({ block: "nearest" });
      } catch {
        // jsdom / older browsers — scrolling is a nicety, not a contract.
      }
    }
  }, [selectedId]);

  const visibleItems = useMemo(
    () => items.filter((item) => matchesFilter(item, filter)),
    [items, filter],
  );
  const allStale =
    items.length > 0 &&
    items.every((item) => item.freshnessState === "STALE" || item.freshnessState === "OFFLINE");
  const selectedItem = items.find((item) => item.trackingSessionId === selectedId) ?? null;

  // Detail action links, each permission-gated. Trip/manifest/batch
  // links are warehouse-dashboard only (admin/super-admin have no
  // transfers/deliveries tree). "View driver" (Phase 7) works on
  // every dashboard: the driver-detail route exists in the admin,
  // super-admin and warehouse trees, and basePath already resolves
  // to the actor's own dashboard — it shows when the payload carries
  // a driverId and the actor holds the fleet read gate
  // (driver.manage / driver.assign, the Drivers-page gate).
  const detailForActions = detail ?? selectedItem;
  const showTripActions =
    isWarehouseDashboard &&
    detailForActions?.transferId != null &&
    permissionSet.has("transfer.read_warehouse");
  const showBatchAction =
    isWarehouseDashboard &&
    detailForActions?.deliveryBatchId != null &&
    (permissionSet.has("delivery.assign") ||
      permissionSet.has("delivery.read_assigned") ||
      permissionSet.has("package.receive"));
  const showDriverAction =
    detailForActions?.driverId != null &&
    (permissionSet.has("driver.manage") || permissionSet.has("driver.assign"));
  const showConnectorNote =
    detail !== null &&
    detail.location !== null &&
    detail.destination !== null &&
    warehouseCoords[detail.destination.warehouseId] !== undefined;

  const listPanel = (
    <div className="flex flex-col gap-2">
      {!hasLoaded ? (
        <p className="text-[13px] text-ink-2">Loading live movements…</p>
      ) : visibleItems.length === 0 ? (
        <div className="rounded-md border border-border bg-card px-4 py-8 text-center">
          <p className="text-[14px] font-semibold text-ink">No active movements</p>
          <p className="mt-1 text-[13px] text-ink-2">
            Movements appear here while a driver has tracking on for a trip or batch.
          </p>
        </div>
      ) : (
        visibleItems.map((item) => {
          const selected = item.trackingSessionId === selectedId;
          return (
            <button
              key={item.trackingSessionId}
              ref={(el) => {
                rowRefs.current.set(item.trackingSessionId, el);
              }}
              type="button"
              aria-pressed={selected}
              onClick={() => void selectSession(item.trackingSessionId)}
              className={`flex flex-col gap-1 rounded-lg border px-3 py-2 text-left ${
                selected
                  ? "border-primary bg-primary-light"
                  : "border-border bg-card hover:bg-page"
              }`}
            >
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-ink">{item.driverName}</span>
                <FreshnessBadge state={item.freshnessState} />
              </span>
              <span className="text-[12px] text-ink-2">
                {TYPE_LABELS[item.trackingType]} · {movementRef(item)}
                {item.vehicleRegistration ? ` · ${item.vehicleRegistration}` : ""}
              </span>
              <span className="text-[12px] text-ink-2">
                {item.origin.name} → {item.destination ? item.destination.name : "Local deliveries"}
              </span>
              <span className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-ink-2">
                <span>
                  <span className="tnum">{item.packageCount}</span> package(s) ·{" "}
                  {activityLabel(item)}
                </span>
                <span>
                  {item.location
                    ? `Last update ${relativeTime(item.location.lastReceivedAt, nowMs)}`
                    : "Waiting for first location"}
                </span>
              </span>
            </button>
          );
        })
      )}
    </div>
  );

  const mapPanel = (
    <LiveMap
      items={visibleItems}
      selectedId={selectedId}
      onSelect={(id) => void selectSession(id)}
      warehouseCoords={warehouseCoords}
      selectedWarehouseId={warehouseId || null}
      onShowAllAuthorized={() => setWarehouseId("")}
      showLegend
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        eyebrow="Operations"
        title="Live Operations"
        description={
          <>
            Last refreshed: {lastRefreshedAt ? clockTime(lastRefreshedAt.toISOString()) : "—"} ·
            Latest driver update received: {clockTime(latestReceivedAt)}
            {generatedAt ? ` · Board generated ${clockTime(generatedAt)}` : ""}
          </>
        }
        actions={
          <button
            type="button"
            onClick={refreshList}
            className="rounded-md bg-primary px-4 py-2 text-[13px] font-semibold text-white"
          >
            Refresh
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="live-ops-search">
          Search live operations
        </label>
        <input
          id="live-ops-search"
          type="search"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          placeholder="Search driver, trip, or package…"
          className="min-h-[40px] w-full max-w-xs rounded-md border border-border bg-card px-3 py-2 text-[13px] text-ink"
        />
        {warehouseOptions.length > 1 ? (
          <>
            <label className="sr-only" htmlFor="live-ops-warehouse">
              Warehouse
            </label>
            <select
              id="live-ops-warehouse"
              value={warehouseId}
              onChange={(event) => setWarehouseId(event.target.value)}
              className="min-h-[40px] rounded-md border border-border bg-card px-3 py-2 text-[13px] text-ink"
            >
              <option value="">All warehouses</option>
              {warehouseOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.code} — {option.name}
                </option>
              ))}
            </select>
          </>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter movements">
        {FILTERS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            aria-pressed={filter === entry.key}
            onClick={() => setFilter(entry.key)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-semibold ${
              filter === entry.key
                ? "border-primary bg-primary-light text-primary-dark"
                : "border-border bg-surface-2 text-ink"
            }`}
          >
            {filter === entry.key ? (
              <span aria-hidden="true" className="text-[11px] leading-none">
                ✓
              </span>
            ) : null}
            {entry.label}
          </button>
        ))}
      </div>

      {fetchError ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/30 bg-dangerbg px-3 py-2"
        >
          <p className="text-[13px] font-semibold text-danger">{fetchError}</p>
          <button
            type="button"
            onClick={refreshList}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-[12px] font-semibold text-ink"
          >
            Retry
          </button>
        </div>
      ) : null}

      {allStale ? (
        <div className="rounded-md border border-border bg-warningbg px-3 py-2">
          <p className="text-[13px] font-semibold text-warning">
            No live positions right now — every movement below is stale or offline. Positions
            update only while a driver&apos;s app is open on screen.
          </p>
        </div>
      ) : null}

      <div className="flex gap-2 lg:hidden" role="group" aria-label="Map or list view">
        {(["list", "map"] as const).map((view) => (
          <button
            key={view}
            type="button"
            aria-pressed={mobileView === view}
            onClick={() => setMobileView(view)}
            className={`rounded-md border px-3 py-2 text-[12px] font-semibold ${
              mobileView === view
                ? "border-primary bg-primary-light text-primary-dark"
                : "border-border bg-card text-ink-2"
            }`}
          >
            {view === "list" ? "List" : "Map"}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr] min-[1440px]:grid-cols-[360px_1fr]">
        <div className={mobileView === "list" ? "" : "hidden lg:block"}>{listPanel}</div>
        <div className={mobileView === "map" ? "" : "hidden lg:block"}>{mapPanel}</div>
      </div>

      <Drawer
        open={selectedId !== null}
        onClose={() => {
          setSelectedId(null);
          setDetail(null);
          setDetailError(null);
        }}
        title={detail ? `Movement — ${detail.driverName}` : "Movement details"}
      >
        {detailError ? (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] text-danger">{detailError}</p>
            <div>
              <button
                type="button"
                className="rounded-md border border-border bg-card px-3 py-2 text-[12px] font-semibold text-ink"
                onClick={() => selectedId && void selectSession(selectedId)}
              >
                Retry
              </button>
            </div>
          </div>
        ) : detail === null ? (
          <p className="text-[13px] text-ink-2">Loading details…</p>
        ) : (
          <div className="flex flex-col gap-3 text-[13px] text-ink">
            <div className="flex flex-wrap items-center gap-2">
              <FreshnessBadge state={detail.freshnessState} />
              <span className="text-ink-2">
                {detail.location
                  ? `Last GPS update ${relativeTime(detail.location.lastReceivedAt, nowMs)} · accuracy ±${Math.round(detail.location.accuracyMeters)} m`
                  : "Waiting for first location"}
              </span>
            </div>
            <dl className="grid grid-cols-[110px_1fr] gap-y-1.5">
              <dt className="text-ink-2">Driver</dt>
              <dd className="font-medium">{detail.driverName}</dd>
              {detail.vehicleRegistration ? (
                <>
                  <dt className="text-ink-2">Vehicle</dt>
                  <dd className="font-medium">{detail.vehicleRegistration}</dd>
                </>
              ) : null}
              <dt className="text-ink-2">{detail.tripId ? "Trip" : "Batch"}</dt>
              <dd className="font-medium">{movementRef(detail)}</dd>
              <dt className="text-ink-2">Route</dt>
              <dd className="font-medium">
                {detail.origin.name} →{" "}
                {detail.destination ? detail.destination.name : "Local deliveries"}
              </dd>
              <dt className="text-ink-2">Packages</dt>
              <dd className="font-medium tnum">{detail.packageCount}</dd>
              {detail.deliveredCount !== null ? (
                <>
                  <dt className="text-ink-2">Delivered</dt>
                  <dd className="font-medium tnum">
                    {detail.deliveredCount} delivered · {detail.remainingCount ?? 0} remaining
                  </dd>
                </>
              ) : null}
              {"codCollectedPaisa" in detail && detail.codCollectedPaisa !== undefined ? (
                <>
                  <dt className="text-ink-2">COD collected</dt>
                  <dd className="font-medium tnum">{formatPaisa(detail.codCollectedPaisa)}</dd>
                </>
              ) : null}
              <dt className="text-ink-2">Activity</dt>
              <dd className="font-medium">{activityLabel(detail)}</dd>
            </dl>

            {showConnectorNote ? (
              <p className="text-[12px] text-ink-2">
                Straight-line connection — not a road route
              </p>
            ) : null}

            {showTripActions || showBatchAction || showDriverAction ? (
              <div className="flex flex-wrap gap-2">
                {showTripActions ? (
                  <>
                    <Link
                      href={`${basePath}/transfers/${detailForActions!.transferId}`}
                      className="rounded-md bg-primary px-3 py-2 text-[12px] font-semibold text-white"
                    >
                      View trip
                    </Link>
                    <Link
                      href={`${basePath}/transfers/${detailForActions!.transferId}/manifest`}
                      className="rounded-md border border-border bg-card px-3 py-2 text-[12px] font-semibold text-ink"
                    >
                      View manifest
                    </Link>
                  </>
                ) : null}
                {showBatchAction ? (
                  <Link
                    href={`${basePath}/deliveries/${detailForActions!.deliveryBatchId}`}
                    className="rounded-md bg-primary px-3 py-2 text-[12px] font-semibold text-white"
                  >
                    View batch
                  </Link>
                ) : null}
                {showDriverAction ? (
                  <Link
                    href={`${basePath}/drivers/${detailForActions!.driverId}`}
                    className="rounded-md border border-border bg-card px-3 py-2 text-[12px] font-semibold text-ink"
                  >
                    View driver
                  </Link>
                ) : null}
              </div>
            ) : null}

            <div>
              <h3 className="text-[13px] font-semibold text-ink">
                Packages ({detail.packages.length})
              </h3>
              {detail.packages.length === 0 ? (
                <p className="mt-1 text-[12px] text-ink-2">No packages on this movement.</p>
              ) : (
                <ul className="mt-1 flex flex-col gap-1">
                  {detail.packages.map((pkg) => (
                    <li
                      key={pkg.packageId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5"
                    >
                      <Link
                        href={`/track/${pkg.trackingId}`}
                        className="font-mono text-[12px] font-semibold text-primary"
                      >
                        {pkg.trackingId}
                      </Link>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <StatusBadge domain="operational" status={pkg.packageStatus} density="compact" />
                        {pkg.itemStatus ? (
                          <StatusBadge domain="generic" status={pkg.itemStatus} density="compact" />
                        ) : null}
                        {pkg.assignmentStatus ? (
                          <StatusBadge domain="generic" status={pkg.assignmentStatus} density="compact" />
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
