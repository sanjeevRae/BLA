"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

import { LocationTrackingPanel } from "@/components/tracking/LocationTrackingPanel";
import { ToneIcon } from "@/components/ui/ToneIcon";
import { TONE_TEXT_CLASSES, type StatusTone } from "@/lib/status/status-tones";
import type { OwnTrackingState } from "@/server/services/tracking";

/**
 * V3 Step 6 — compact driver tracking strip.
 *
 * Demotes the V2 LocationTrackingPanel from a full card at the top
 * of both driver layouts to a one-row status strip: a bold state
 * label + freshness line (tone + icon + dot — never colour alone,
 * DS §7.11) on a ≥48px header button, with the REAL panel mounted
 * inside an expandable region below it. The region is hidden with
 * `display:none` only — the panel never unmounts while collapsed,
 * so its engine/watch lifecycle is never interrupted, and the
 * strip carries no controls of its own (no duplicated Start /
 * Pause / End buttons outside the region).
 *
 * The strip reads the SAME endpoint as the panel
 * (GET /api/tracking/session/current) purely to summarise state
 * for the header; all tracking behaviour stays in the panel.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Local copy of the panel's relative-time label (the panel file
 *  is frozen — do not import from it). */
function agoLabel(atMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min ago`;
}

async function loadCurrentState(): Promise<OwnTrackingState> {
  const res = await fetch("/api/tracking/session/current", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as OwnTrackingState;
}

const DOT_CLASSES: Record<StatusTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-neutral",
};

interface StripState {
  label: string;
  /** Tone for the status icon + dot beside the label. */
  tone: StatusTone;
  freshness: string | null;
  /** Tone for the freshness line (ACTIVE varies by freshnessState). */
  freshnessTone: StatusTone;
}

function deriveStripState(
  data: OwnTrackingState | null,
  loadFailed: boolean,
  nowMs: number,
): StripState {
  if (data === null) {
    return loadFailed
      ? { label: "Tracking status unavailable", tone: "neutral", freshness: null, freshnessTone: "neutral" }
      : { label: "Loading tracking status…", tone: "neutral", freshness: null, freshnessTone: "neutral" };
  }

  const session = data.session;
  if (session?.status === "ACTIVE") {
    const lastPing = data.lastPing;
    if (lastPing === null || lastPing.freshnessState === "OFFLINE") {
      return {
        label: "Location sharing on",
        tone: "neutral",
        freshness: "Sharing · no update sent yet",
        freshnessTone: "neutral",
      };
    }
    const ago = agoLabel(new Date(lastPing.receivedAt).getTime(), nowMs);
    switch (lastPing.freshnessState) {
      case "FRESH":
        return {
          label: "Location sharing on",
          tone: "success",
          freshness: `Updated ${ago}`,
          freshnessTone: "success",
        };
      case "DELAYED":
        return {
          label: "Location sharing on",
          tone: "warning",
          freshness: `Updated ${ago} · delayed`,
          freshnessTone: "warning",
        };
      case "STALE":
        return {
          label: "Location sharing on",
          tone: "neutral",
          freshness: `Last seen ${ago}`,
          freshnessTone: "neutral",
        };
      default:
        return {
          label: "Location sharing on",
          tone: "neutral",
          freshness: "Sharing · no update sent yet",
          freshnessTone: "neutral",
        };
    }
  }
  if (session?.status === "PAUSED") {
    return { label: "Tracking paused", tone: "warning", freshness: null, freshnessTone: "warning" };
  }
  if (session?.status === "ENDED") {
    return { label: "Tracking ended", tone: "neutral", freshness: null, freshnessTone: "neutral" };
  }
  if (data.eligibleAssignments.length > 0) {
    return {
      label: "Tracking off — tap to start",
      tone: "neutral",
      freshness: null,
      freshnessTone: "neutral",
    };
  }
  return { label: "Tracking off", tone: "neutral", freshness: null, freshnessTone: "neutral" };
}

// ---------------------------------------------------------------------------
// Strip
// ---------------------------------------------------------------------------

export function TrackingStrip({ variant }: { variant: "rider" | "driver" }) {
  const [data, setData] = useState<OwnTrackingState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const succeededRef = useRef(false);

  const regionId = `tracking-strip-panel-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  /** Resync the header summary. Failures leave the last known
   *  state untouched; "unavailable" is derived only when no fetch
   *  has ever succeeded (data still null + a failure recorded). */
  const fetchCurrent = useCallback(async () => {
    try {
      const body = await loadCurrentState();
      succeededRef.current = true;
      setData(body);
      setLoadFailed(false);
      setNowMs(Date.now());
    } catch {
      if (!succeededRef.current) setLoadFailed(true);
    }
  }, []);

  // Initial load + 30s resync (mirrors the panel's discipline —
  //  the initial load is inlined here exactly as the panel does).
  useEffect(() => {
    let cancelled = false;
    loadCurrentState()
      .then((body) => {
        if (cancelled) return;
        succeededRef.current = true;
        setData(body);
        setLoadFailed(false);
        setNowMs(Date.now());
      })
      .catch(() => {
        if (!cancelled && !succeededRef.current) setLoadFailed(true);
      });
    const id = window.setInterval(() => {
      void fetchCurrent();
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [fetchCurrent]);

  // Resync when the tab becomes visible again.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") void fetchCurrent();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [fetchCurrent]);

  const handleToggle = () => {
    setExpanded((prev) => !prev);
    void fetchCurrent();
  };

  const state = deriveStripState(data, loadFailed, nowMs);

  return (
    <section className="rounded-lg border border-border bg-card">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={regionId}
        onClick={handleToggle}
        className="flex min-h-[48px] w-full items-center gap-3 px-4 py-2 text-left"
      >
        <span
          className={`flex items-center gap-2 ${TONE_TEXT_CLASSES[state.tone]}`}
        >
          <ToneIcon tone={state.tone} className="h-4 w-4" />
          <span
            aria-hidden="true"
            className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${DOT_CLASSES[state.tone]}`}
          />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="text-[14px] font-semibold text-ink">{state.label}</span>
          {state.freshness !== null ? (
            <span className={`text-[12.5px] font-medium ${TONE_TEXT_CLASSES[state.freshnessTone]}`}>
              {state.freshness}
            </span>
          ) : null}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[12.5px] font-semibold text-ink-2">
          Details
          <svg
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      <div id={regionId} hidden={!expanded} className="border-t border-border px-4 py-4">
        <LocationTrackingPanel variant={variant} framed={false} />
      </div>
    </section>
  );
}
