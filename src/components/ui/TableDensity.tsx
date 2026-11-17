"use client";

import type { ReactNode } from "react";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Table density (V3 Step 9, DS §7.6) — ONE mechanism for the whole
 * app: "comfortable" (44px rows) or "compact" (40px rows), persisted
 * per user in localStorage under `bla.tableDensity`, default
 * "comfortable".
 *
 * How it reaches rows, two ways that always agree:
 *  - `DataTable` reads `useTableDensity()` and renders h-11 / h-10
 *    row classes directly, and stamps `data-density` on its wrapper.
 *  - Any other table (server tables composed from table-chrome.ts)
 *    sits inside a `DensityScope`, which stamps `data-density`; the
 *    additive CSS in globals.css then sizes `.bla-table` rows.
 *
 * SSR guard: the server snapshot is always "comfortable" (server and
 * hydration renders agree); the stored value applies from the client
 * snapshot once mounted.
 */

export type TableDensity = "comfortable" | "compact";

export const TABLE_DENSITY_STORAGE_KEY = "bla.tableDensity";

export const DEFAULT_TABLE_DENSITY: TableDensity = "comfortable";

function isTableDensity(value: string | null): value is TableDensity {
  return value === "comfortable" || value === "compact";
}

function readStoredDensity(): TableDensity {
  try {
    const stored = window.localStorage.getItem(TABLE_DENSITY_STORAGE_KEY);
    return isTableDensity(stored) ? stored : DEFAULT_TABLE_DENSITY;
  } catch {
    return DEFAULT_TABLE_DENSITY;
  }
}

function writeStoredDensity(density: TableDensity) {
  try {
    window.localStorage.setItem(TABLE_DENSITY_STORAGE_KEY, density);
  } catch {
    // Storage unavailable (private mode / disabled): the in-memory
    // choice still applies for this session.
  }
}

export interface UseTableDensity {
  density: TableDensity;
  setDensity: (density: TableDensity) => void;
  toggleDensity: () => void;
}

/*
 * The density value lives in localStorage, modelled as an external
 * store (useSyncExternalStore): the server snapshot is the default
 * (SSR-safe, no hydration mismatch), the client snapshot reads
 * storage, `storage` events sync other tabs, and setDensity notifies
 * same-tab subscribers — so EVERY useTableDensity() instance in the
 * app (DataTable, DensityScope, a standalone toggle) always agrees.
 * The snapshot is a string primitive, so re-reading it per render is
 * identity-stable.
 */
const densityListeners = new Set<() => void>();

function subscribeToDensity(listener: () => void): () => void {
  densityListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === TABLE_DENSITY_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    densityListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function getDensitySnapshot(): TableDensity {
  return readStoredDensity();
}

function getDensityServerSnapshot(): TableDensity {
  return DEFAULT_TABLE_DENSITY;
}

export function useTableDensity(): UseTableDensity {
  const density = useSyncExternalStore(
    subscribeToDensity,
    getDensitySnapshot,
    getDensityServerSnapshot,
  );

  const setDensity = useCallback((next: TableDensity) => {
    writeStoredDensity(next);
    for (const listener of densityListeners) listener();
  }, []);

  const toggleDensity = useCallback(() => {
    setDensity(readStoredDensity() === "comfortable" ? "compact" : "comfortable");
  }, [setDensity]);

  return { density, setDensity, toggleDensity };
}

const TOGGLE_BUTTON_BASE =
  "inline-flex min-h-[32px] items-center rounded-md px-2.5 text-[13px] font-semibold";
const TOGGLE_BUTTON_ACTIVE = "bg-primary-light text-primary-dark";
const TOGGLE_BUTTON_INACTIVE = "text-ink-2 hover:bg-surface-2 hover:text-ink";

/**
 * DensityToggle — a compact labelled button group:
 * "Density: [Comfortable|Compact]", each option a button with
 * aria-pressed. Controlled when `density` + `onDensityChange` are
 * passed; otherwise it manages (and persists) its own state via
 * useTableDensity().
 */
export function DensityToggle({
  density: densityProp,
  onDensityChange,
  className,
}: {
  density?: TableDensity;
  onDensityChange?: (density: TableDensity) => void;
  className?: string;
}) {
  const internal = useTableDensity();
  const density = densityProp ?? internal.density;
  const apply = onDensityChange ?? internal.setDensity;

  return (
    <div
      role="group"
      aria-label="Table density"
      className={`inline-flex items-center gap-1 ${className ?? ""}`}
    >
      <span className="text-[13px] text-ink-2">Density:</span>
      <button
        type="button"
        aria-pressed={density === "comfortable"}
        onClick={() => apply("comfortable")}
        className={`${TOGGLE_BUTTON_BASE} ${density === "comfortable" ? TOGGLE_BUTTON_ACTIVE : TOGGLE_BUTTON_INACTIVE}`}
      >
        Comfortable
      </button>
      <button
        type="button"
        aria-pressed={density === "compact"}
        onClick={() => apply("compact")}
        className={`${TOGGLE_BUTTON_BASE} ${density === "compact" ? TOGGLE_BUTTON_ACTIVE : TOGGLE_BUTTON_INACTIVE}`}
      >
        Compact
      </button>
    </div>
  );
}

/**
 * DensityScope — wrapper that stamps `data-density` so the globals.css
 * rules size any descendant `.bla-table` (see table-chrome.ts). With
 * `showToggle`, a toolbar row aligned right renders the DensityToggle
 * above the children, driving this scope. Controlled when `density` +
 * `onDensityChange` are passed; otherwise self-managed + persisted.
 */
export function DensityScope({
  children,
  showToggle = false,
  density: densityProp,
  onDensityChange,
  className,
}: {
  children: ReactNode;
  showToggle?: boolean;
  density?: TableDensity;
  onDensityChange?: (density: TableDensity) => void;
  className?: string;
}) {
  const internal = useTableDensity();
  const density = densityProp ?? internal.density;
  const apply = onDensityChange ?? internal.setDensity;

  return (
    <div data-density={density} className={className}>
      {showToggle ? (
        <div className="flex items-center justify-end pb-2">
          <DensityToggle density={density} onDensityChange={apply} />
        </div>
      ) : null}
      {children}
    </div>
  );
}
