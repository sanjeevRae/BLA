"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { NavItemView } from "@/lib/navigation/registry";
import { NavIcon } from "@/components/layout/icons";

interface SearchResult {
  key: string;
  label: string;
  hint: string;
  href: string;
}

/**
 * Top-bar search (V2 Phase 1): searches the actor's own visible
 * navigation (permission-filtered server-side before it reaches this
 * component) and offers package tracking for anything that looks like
 * a tracking reference. Tracking opens the existing public tracking
 * page — no new data surface is exposed.
 */
export function GlobalSearch({ items }: { items: NavItemView[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const navMatches = items
      .filter((item) => item.label.toLowerCase().includes(q))
      .slice(0, 6)
      .map((item) => ({
        key: `nav:${item.id}`,
        label: item.label,
        hint: "Go to page",
        href: item.href,
      }));
    const tracking: SearchResult[] =
      query.trim().length >= 4
        ? [
            {
              key: "track",
              label: `Track package ${query.trim().toUpperCase()}`,
              hint: "Open tracking",
              href: `/track/${encodeURIComponent(query.trim())}`,
            },
          ]
        : [];
    return [...tracking, ...navMatches];
  }, [items, query]);

  // Clamp rather than sync state in an effect: the highlight resets
  // to the first row whenever the query (and thus the result set)
  // changes, and never points past the end of a shrinking list.
  const activeIndex = results.length === 0 ? -1 : Math.min(highlight, results.length - 1);

  useEffect(() => {
    if (!open) return;
    function onClick(event: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open ]);

  function go(result: SearchResult | undefined) {
    if (!result) return;
    setOpen(false);
    setQuery("");
    router.push(result.href);
  }

  return (
    <div className="relative w-full max-w-xs" ref={boxRef}>
      <div className="flex h-11 items-center gap-2 rounded-md border border-line bg-page px-3">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          className="h-[18px] w-[18px] shrink-0 text-faint"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.8-3.8" />
        </svg>
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls="global-search-results"
          aria-label="Search pages or track a package"
          placeholder="Search or track a package…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlight(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setHighlight((h) => Math.min(h + 1, results.length - 1));
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            }
            if (event.key === "Enter") {
              event.preventDefault();
              go(results[activeIndex] ?? results[0]);
            }
          }}
          className="w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
        />
      </div>
      {open && results.length > 0 ? (
        <ul
          id="global-search-results"
          role="listbox"
          className="absolute left-0 right-0 z-50 mt-2 overflow-hidden rounded-lg border border-line bg-surface shadow-pop"
        >
          {results.map((result, index) => (
            <li key={result.key} role="option" aria-selected={index === activeIndex}>
              <button
                type="button"
                className={`flex min-h-[44px] w-full items-center gap-2.5 px-3 text-left text-[13px] ${
                  index === activeIndex ? "bg-accentbg" : "bg-surface"
                }`}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => go(result)}
              >
                <NavIcon name="package" className="h-4 w-4 shrink-0 text-faint" />
                <span className="min-w-0 flex-1 truncate font-medium text-ink">
                  {result.label}
                </span>
                <span className="shrink-0 text-[11px] text-faint">{result.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
