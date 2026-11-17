/**
 * Shared table chrome (V3 Step 9, DS §7.6) — Tailwind class-string
 * constants so CLIENT tables (the `DataTable` component) and SERVER
 * tables (hand-written `<table>` markup in server components) render
 * identically: surface-2 header row, 12px/600 uppercase ink-2 header
 * labels, 13.5px body cells, hairline dividers, hover wash.
 *
 * This module is deliberately free of "use client" and of any React
 * import: it is plain strings, importable from server components.
 *
 * TWO complementary mechanisms live here / in globals.css:
 *  1. These constants — compose them onto <table>/<th>/<td>/<tr>.
 *  2. Row density — the `bla-table` class (part of TABLE_CLASS) plus
 *     the CSS in src/app/globals.css: any `.bla-table` inside a
 *     `[data-density]` scope (see TableDensity.tsx `DensityScope`, or
 *     DataTable's own wrapper) gets 44px rows at "comfortable" and
 *     40px rows at "compact". Server tables opt in by using
 *     TABLE_CLASS and sitting inside a DensityScope.
 *
 * Alignment: TH_CLASS / TD_CLASS are alignment-free bases — append
 * `text-left` / `text-right` / `text-center`, or use the ready-made
 * variants (TH_NUMERIC_CLASS, TD_NUMERIC_CLASS, TD_ID_CLASS).
 */

/** Table element: carries the `bla-table` density hook class. */
export const TABLE_CLASS = "bla-table w-full border-collapse";

/** Header row (<tr> inside <thead>): surface-2 wash (also on each th). */
export const THEAD_ROW_CLASS = "bg-surface-2";

/** Header cell base: surface-2, 12px/600 uppercase ink-2, px-3 py-2. Append an alignment class. */
export const TH_CLASS =
  "bg-surface-2 px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-ink-2";

/** Header cell, right-aligned (numeric columns). */
export const TH_NUMERIC_CLASS = `${TH_CLASS} text-right tabular-nums`;

/** Header cell, centre-aligned. */
export const TH_CENTER_CLASS = `${TH_CLASS} text-center`;

/** Body cell base: px-3 py-2, table text size (13.5px), ink. Append an alignment class. */
export const TD_CLASS = "px-3 py-2 text-table text-ink";

/** Body cell, numeric: right-aligned with mandatory tabular figures (DS §3). */
export const TD_NUMERIC_CLASS = `${TD_CLASS} text-right tabular-nums`;

/** Body cell, identifier: mono, never wraps mid-string (DS §3). */
export const TD_ID_CLASS = `${TD_CLASS} font-mono whitespace-nowrap`;

/** Body row: hairline top divider + hover wash. (DataTable adds its density height + selected treatment on top.) */
export const TR_CLASS = "border-t border-border hover:bg-surface-2";
