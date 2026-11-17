"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";

import type { NavIconName, NavItemView } from "@/lib/navigation/registry";
import { NavIcon } from "@/components/layout/icons";

/**
 * The V3 command menu (docs/ui-design-system.md §8), built on cmdk
 * composed with its Dialog (the repo's Dialog primitive is a
 * header/footer confirmation shell — it fights the palette's input-
 * first anatomy, so cmdk's own Dialog is used and styled to the DS
 * anatomy: centred, 640px max, radius 16, pop shadow, white; a
 * full-screen sheet on mobile).
 *
 * Data sources (existing only): Navigate + Actions come from the
 * actor's registry items, already permission-filtered server-side
 * before they reach this component. Records come from GET
 * /api/search, which filters SERVER-SIDE — unauthorised records are
 * never returned and never rendered here. Selecting any row only
 * navigates to its href: quick actions ARE routes in this app, so
 * execution goes through exactly the same page-level permission
 * checks and confirmations as the header toolbar — no new execution
 * path exists.
 */

export const OPEN_PALETTE_EVENT = "bla:open-palette";

interface PaletteEntry {
  key: string;
  label: string;
  hint: string;
  href: string;
  icon: NavIconName;
}

interface RecordGroup {
  id: string;
  label: string;
  results: { id: string; label: string; hint: string; href: string }[];
}

const RECORD_GROUP_ICONS: Record<string, NavIconName> = {
  packages: "package",
  bookings: "file",
  vendors: "store",
  customers: "users",
  warehouses: "warehouse",
  drivers: "truck",
};

const RECENTS_LIMIT = 5;
const SEARCH_DEBOUNCE_MS = 200;

function SearchGlyph({ className = "h-[18px] w-[18px]" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      className={`${className} shrink-0`}
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.8-3.8" />
    </svg>
  );
}

/**
 * Header trigger styled as a search field (DS §7.2). It carries no
 * palette state of its own — it asks the mounted CommandMenu to open
 * via the `bla:open-palette` window event, so ShellFrame can place
 * the trigger and the palette independently. Below `sm` it collapses
 * to an icon-only button.
 */
export function CommandMenuTrigger({ className = "" }: { className?: string }) {
  return (
    <button
      type="button"
      aria-label="Search or jump to (Ctrl K)"
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT))}
      className={`flex h-10 w-10 items-center justify-center gap-2 rounded-xl border border-border-control bg-page px-0 text-[13px] text-ink-2 transition-colors hover:border-primary sm:w-64 sm:justify-start sm:px-3 ${className}`}
    >
      <SearchGlyph />
      <span className="hidden min-w-0 flex-1 truncate text-left sm:inline">
        Search or jump to…
      </span>
      <kbd
        aria-hidden="true"
        className="hidden shrink-0 rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px] font-medium text-ink-2 sm:inline"
      >
        Ctrl K
      </kbd>
    </button>
  );
}

function recentsKey(recentsScope: string): string {
  // Per-USER keying (F3): recents are keyed by the actor's userId
  // (threaded from DashboardShell via ShellFrame as `recentsScope`),
  // never by dashboard tree — record selections carry a tracking-ID
  // label + recipient hint + href, so two users of the same tree on
  // a shared browser must never see each other's records. A stale
  // key for another user is simply never read again by this actor.
  return `bla:palette-recents:${recentsScope}`;
}

function readRecents(recentsScope: string): PaletteEntry[] {
  try {
    const raw = window.localStorage.getItem(recentsKey(recentsScope));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PaletteEntry[];
    return Array.isArray(parsed)
      ? parsed.filter((entry) => entry && entry.href && entry.label).slice(0, RECENTS_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function storeRecent(recentsScope: string, entry: PaletteEntry) {
  try {
    const next = [
      entry,
      ...readRecents(recentsScope).filter((recent) => recent.href !== entry.href),
    ].slice(0, RECENTS_LIMIT);
    window.localStorage.setItem(recentsKey(recentsScope), JSON.stringify(next));
  } catch {
    // Private-mode storage failures just mean no recents next time.
  }
}

const ITEM_CLASS =
  "flex min-h-[44px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] text-ink data-[selected=true]:bg-primary-light data-[selected=true]:text-primary-dark";
const GROUP_CLASS =
  "[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-ink-2";

function PaletteRow({ entry }: { entry: PaletteEntry }) {
  return (
    <>
      <NavIcon name={entry.icon} className="h-4 w-4 shrink-0 text-ink-2" />
      <span className="min-w-0 flex-1 truncate font-medium">{entry.label}</span>
      {entry.hint ? (
        <span className="max-w-[45%] shrink-0 truncate text-[12px] text-ink-2">
          {entry.hint}
        </span>
      ) : null}
    </>
  );
}

export function CommandMenu({
  items,
  quickActions,
  recentsScope,
}: {
  items: NavItemView[];
  quickActions: NavItemView[];
  recentsScope: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Record results are stored tagged with the query that produced
  // them; the rows on screen are DERIVED (they render only while the
  // tag matches the current query), so the fetch effect never has to
  // clear state synchronously when the query changes.
  const [searchState, setSearchState] = useState<{
    query: string;
    groups: RecordGroup[];
  }>({ query: "", groups: [] });
  const [pendingQuery, setPendingQuery] = useState<string | null>(null);
  const [recents, setRecents] = useState<PaletteEntry[]>([]);
  const requestSeq = useRef(0);

  // Every open path funnels through here so recents are re-read from
  // localStorage at open time (a client-only, per-open snapshot).
  function applyOpen(next: boolean) {
    if (next) setRecents(readRecents(recentsScope));
    setOpen(next);
  }

  // Ctrl+K / Cmd+K toggles from anywhere; the header trigger opens
  // via the window event. Escape is handled by the Dialog itself,
  // which also returns focus to the element that had it on open
  // (the trigger, when opened by click).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => {
          if (!value) setRecents(readRecents(recentsScope));
          return !value;
        });
      }
    }
    function onOpenRequest() {
      setRecents(readRecents(recentsScope));
      setOpen(true);
    }
    document.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpenRequest);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpenRequest);
    };
  }, [recentsScope]);

  const trimmed = query.trim();
  const recordGroups = useMemo(
    () => (searchState.query === trimmed ? searchState.groups : []),
    [searchState, trimmed],
  );
  const loading =
    trimmed.length >= 2 && pendingQuery === trimmed && searchState.query !== trimmed;

  // Debounced record search. Zero requests below 2 characters; a
  // monotonically increasing sequence number makes stale responses
  // no-ops, so a slow earlier query can never overwrite a newer one.
  // All state writes happen inside the timer/async continuation,
  // never synchronously in the effect body.
  useEffect(() => {
    if (!open || trimmed.length < 2) return;
    const seq = ++requestSeq.current;
    const timer = window.setTimeout(async () => {
      setPendingQuery(trimmed);
      try {
        const response = await fetch(
          `/api/search?q=${encodeURIComponent(trimmed)}`,
        );
        const body = (await response.json()) as { groups?: RecordGroup[] };
        if (requestSeq.current !== seq) return;
        setSearchState({
          query: trimmed,
          groups: Array.isArray(body.groups) ? body.groups : [],
        });
      } catch {
        if (requestSeq.current !== seq) return;
        setSearchState({ query: trimmed, groups: [] });
      } finally {
        if (requestSeq.current === seq) setPendingQuery(null);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, trimmed]);

  const matches = (label: string) =>
    trimmed.length === 0 || label.toLowerCase().includes(trimmed.toLowerCase());

  const navEntries = useMemo<PaletteEntry[]>(
    () =>
      items
        .filter((item) => matches(item.label))
        .slice(0, trimmed.length === 0 ? items.length : 10)
        .map((item) => ({
          key: `nav:${item.id}`,
          label: item.label,
          hint: "Go to page",
          href: item.href,
          icon: item.icon,
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, trimmed],
  );

  const actionEntries = useMemo<PaletteEntry[]>(
    () =>
      quickActions
        .filter((item) => matches(item.label))
        .slice(0, 6)
        .map((item) => ({
          key: `action:${item.id}`,
          label: item.label,
          hint: "Quick action",
          href: item.href,
          icon: item.icon,
        })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [quickActions, trimmed],
  );

  const recordEntries = useMemo(
    () =>
      recordGroups.map((group) => ({
        ...group,
        entries: group.results.map(
          (result): PaletteEntry => ({
            key: `record:${group.id}:${result.id}`,
            label: result.label,
            hint: result.hint,
            href: result.href,
            icon: RECORD_GROUP_ICONS[group.id] ?? "package",
          }),
        ),
      })),
    [recordGroups],
  );

  const resultCount =
    navEntries.length +
    actionEntries.length +
    recordEntries.reduce((sum, group) => sum + group.entries.length, 0) +
    (trimmed.length === 0 ? recents.length : 0);

  function choose(entry: PaletteEntry) {
    storeRecent(recentsScope, entry);
    setOpen(false);
    setQuery("");
    setSearchState({ query: "", groups: [] });
    setPendingQuery(null);
    router.push(entry.href);
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={applyOpen}
      label="Search or jump to"
      aria-label="Search or jump to"
      shouldFilter={false}
      overlayClassName="fixed inset-0 z-50 bg-ink/40"
      contentClassName="fixed inset-0 z-50 flex flex-col overflow-hidden bg-card shadow-pop max-sm:h-full sm:inset-x-0 sm:bottom-auto sm:top-[10vh] sm:mx-auto sm:max-h-[70vh] sm:w-full sm:max-w-[640px] sm:rounded-2xl sm:border sm:border-border"
    >
      <div className="flex items-center gap-2 border-b border-border px-4">
        <SearchGlyph className="h-5 w-5 text-ink-2" />
        <Command.Input
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="Search or jump to…"
          aria-label="Search or jump to"
          className="h-12 w-full bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-2"
        />
        <kbd
          aria-hidden="true"
          className="shrink-0 rounded-md border border-border bg-page px-1.5 py-0.5 text-[11px] font-medium text-ink-2"
        >
          Esc
        </kbd>
      </div>
      <div aria-live="polite" className="sr-only">
        {open && trimmed.length >= 2 && !loading
          ? `${resultCount} results for ${trimmed}`
          : ""}
      </div>
      <Command.List className="max-h-full flex-1 overflow-y-auto p-2 sm:max-h-[60vh]">
        <Command.Empty className="px-3 py-6 text-center text-[13px] text-ink-2">
          No matches for &lsquo;{trimmed}&rsquo;
        </Command.Empty>
        {trimmed.length === 0 && recents.length > 0 ? (
          <Command.Group heading="Recent" className={GROUP_CLASS}>
            {recents.map((entry) => (
              <Command.Item
                key={`recent:${entry.href}`}
                value={`recent:${entry.href}`}
                onSelect={() => choose(entry)}
                className={ITEM_CLASS}
              >
                <PaletteRow entry={entry} />
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        {navEntries.length > 0 ? (
          <Command.Group heading="Navigate" className={GROUP_CLASS}>
            {navEntries.map((entry) => (
              <Command.Item
                key={entry.key}
                value={entry.key}
                onSelect={() => choose(entry)}
                className={ITEM_CLASS}
              >
                <PaletteRow entry={entry} />
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        {actionEntries.length > 0 ? (
          <Command.Group heading="Actions" className={GROUP_CLASS}>
            {actionEntries.map((entry) => (
              <Command.Item
                key={entry.key}
                value={entry.key}
                onSelect={() => choose(entry)}
                className={ITEM_CLASS}
              >
                <PaletteRow entry={entry} />
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        {loading ? (
          <div
            role="status"
            className="px-3 py-3 text-[13px] text-ink-2"
          >
            Searching records…
          </div>
        ) : null}
        {recordEntries.map((group) => (
          <Command.Group
            key={group.id}
            heading={group.label}
            className={GROUP_CLASS}
          >
            {group.entries.map((entry) => (
              <Command.Item
                key={entry.key}
                value={entry.key}
                onSelect={() => choose(entry)}
                className={ITEM_CLASS}
              >
                <PaletteRow entry={entry} />
              </Command.Item>
            ))}
          </Command.Group>
        ))}
      </Command.List>
    </Command.Dialog>
  );
}
