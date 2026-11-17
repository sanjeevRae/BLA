"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import { EmptyState, SkeletonRows } from "./states";
import {
  TABLE_CLASS,
  TD_CLASS,
  THEAD_ROW_CLASS,
  TH_CLASS,
  TR_CLASS,
} from "./table-chrome";
import { DensityToggle, useTableDensity } from "./TableDensity";

export interface DataTableColumn<Row> {
  key: string;
  header: ReactNode;
  render?: (row: Row) => ReactNode;
  sortable?: boolean;
  align?: "left" | "right" | "center";
  hideable?: boolean;
  className?: string;
}

export interface DataTableProps<Row> {
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  search?: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
  };
  sort?: {
    key: string;
    direction: "asc" | "desc";
    onChange: (key: string, direction: "asc" | "desc") => void;
  };
  pagination?: {
    page: number;
    pageSize: number;
    total: number;
    onPageChange: (page: number) => void;
  };
  filters?: ReactNode;
  dateRange?: ReactNode;
  emptyState?: ReactNode;
  loading?: boolean;
  ariaLabel?: string;
  /** Row key of the selected row, rendered with the primary-light wash
   * + left indicator (DS §7.6). Optional; no selection state is owned
   * by the table itself. */
  selectedRowKey?: string;
  /** Render the density toggle (DS §7.6) in the toolbar. Default true:
   * the toolbar row renders even when it is the only toolbar content.
   * Density itself is the shared useTableDensity() state (persisted
   * per user, "comfortable" 44px / "compact" 40px). */
  densityToggle?: boolean;
}

function alignClass(align: DataTableColumn<unknown>["align"]): string {
  if (align === "right") return "text-right";
  if (align === "center") return "text-center";
  return "text-left";
}

export function DataTable<Row>(props: DataTableProps<Row>) {
  const {
    columns,
    rows,
    rowKey,
    search,
    sort,
    pagination,
    filters,
    dateRange,
    emptyState,
    loading = false,
    ariaLabel,
    selectedRowKey,
    densityToggle = true,
  } = props;

  const { density, setDensity } = useTableDensity();

  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);

  const visibleColumns = columns.filter((column) => !hiddenKeys.has(column.key));
  const hideableColumns = columns.filter((column) => column.hideable);

  function toggleColumn(key: string, visible: boolean) {
    setHiddenKeys((current) => {
      const next = new Set(current);
      if (visible) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function onSortClick(column: DataTableColumn<Row>) {
    if (!sort) return;
    if (sort.key === column.key) {
      sort.onChange(column.key, sort.direction === "asc" ? "desc" : "asc");
    } else {
      sort.onChange(column.key, "asc");
    }
  }

  const hasToolbar = Boolean(
    search || filters || dateRange || hideableColumns.length > 0 || densityToggle,
  );
  const isEmpty = !loading && rows.length === 0;

  let paginationSummary: ReactNode = null;
  let paginationControls: ReactNode = null;
  if (pagination) {
    const { page, pageSize, total, onPageChange } = pagination;
    const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const to = Math.min(page * pageSize, total);
    const canPrev = page > 1;
    const canNext = page * pageSize < total;
    paginationSummary = (
      <span aria-live="polite" className="text-[13px] text-ink-2">
        Showing {from}–{to} of {total}
      </span>
    );
    paginationControls = (
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!canPrev}
          onClick={() => onPageChange(page - 1)}
          className="inline-flex min-h-[44px] items-center rounded-lg border border-border-control bg-card px-3 text-[13px] font-semibold text-ink hover:bg-surface-2 disabled:opacity-45"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!canNext}
          onClick={() => onPageChange(page + 1)}
          className="inline-flex min-h-[44px] items-center rounded-lg border border-border-control bg-card px-3 text-[13px] font-semibold text-ink hover:bg-surface-2 disabled:opacity-45"
        >
          Next
        </button>
      </div>
    );
  }

  return (
    <div data-density={density} className="rounded-lg border border-border bg-card">
      {hasToolbar ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          {search ? (
            <input
              type="search"
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
              placeholder={search.placeholder ?? "Search…"}
              aria-label={search.placeholder ?? "Search"}
              className="h-11 min-w-[200px] flex-1 rounded-md border border-border-control bg-card px-3 text-[13px] text-ink sm:flex-none sm:basis-64"
            />
          ) : null}
          {filters}
          {dateRange}
          {densityToggle ? (
            <div className="ml-auto">
              <DensityToggle density={density} onDensityChange={setDensity} />
            </div>
          ) : null}
          {hideableColumns.length > 0 ? (
            <div className={`relative ${densityToggle ? "" : "ml-auto"}`}>
              <button
                type="button"
                aria-haspopup="true"
                aria-expanded={columnsOpen}
                onClick={() => setColumnsOpen((value) => !value)}
                className="inline-flex min-h-[44px] items-center rounded-lg border border-border-control bg-card px-3 text-[13px] font-semibold text-ink hover:bg-surface-2"
              >
                Columns
              </button>
              {columnsOpen ? (
                <div className="absolute right-0 z-20 mt-1 w-56 rounded-lg border border-border bg-card p-2 shadow-pop">
                  {hideableColumns.map((column) => {
                    const visible = !hiddenKeys.has(column.key);
                    const checkboxId = `datatable-column-${column.key}`;
                    return (
                      <label
                        key={column.key}
                        htmlFor={checkboxId}
                        className="flex min-h-[44px] cursor-pointer items-center gap-2 px-2 text-[13px] text-ink"
                      >
                        <input
                          id={checkboxId}
                          type="checkbox"
                          checked={visible}
                          onChange={(event) => toggleColumn(column.key, event.target.checked)}
                        />
                        <span>{column.header}</span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table aria-label={ariaLabel} className={TABLE_CLASS}>
          <thead>
            <tr className={THEAD_ROW_CLASS}>
              {visibleColumns.map((column) => {
                const isSorted = Boolean(sort && sort.key === column.key);
                const ariaSort = column.sortable
                  ? isSorted
                    ? sort?.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                  : undefined;
                const indicator = !column.sortable ? null : (
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="h-[12px] w-[12px]"
                  >
                    {isSorted ? (
                      sort?.direction === "asc" ? (
                        <path d="m6 15 6-6 6 6" />
                      ) : (
                        <path d="m6 9 6 6 6-6" />
                      )
                    ) : (
                      <>
                        <path d="m7 10 5-5 5 5" />
                        <path d="m7 14 5 5 5-5" />
                      </>
                    )}
                  </svg>
                );
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={`${TH_CLASS} ${alignClass(column.align)} ${column.className ?? ""}`}
                  >
                    {column.sortable && sort ? (
                      <button
                        type="button"
                        onClick={() => onSortClick(column)}
                        className="inline-flex items-center gap-1 text-inherit"
                        aria-label={`Sort by ${column.key}`}
                      >
                        <span>{column.header}</span>
                        <span aria-hidden="true">{indicator}</span>
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          {!loading && !isEmpty ? (
            <tbody>
              {rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  aria-selected={selectedRowKey !== undefined ? rowKey(row) === selectedRowKey : undefined}
                  className={`${density === "compact" ? "h-10" : "h-11"} ${TR_CLASS} ${
                    selectedRowKey !== undefined && rowKey(row) === selectedRowKey
                      ? "bg-primary-light shadow-[inset_3px_0_0_0_var(--color-primary)] hover:bg-primary-light"
                      : ""
                  }`}
                >
                  {visibleColumns.map((column) => {
                    const content = column.render
                      ? column.render(row)
                      : String(
                          (row as Record<string, unknown>)[column.key] ?? "",
                        );
                    return (
                      <td
                        key={column.key}
                        className={`${TD_CLASS} ${alignClass(column.align)} ${column.className ?? ""}`}
                      >
                        {content}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          ) : null}
        </table>
      </div>

      {loading ? (
        <div className="border-t border-border">
          <SkeletonRows rows={4} />
        </div>
      ) : null}

      {isEmpty ? (
        <div className="border-t border-border p-3">
          {emptyState ?? (
            <EmptyState
              title="No records"
              description="There are no records to show yet."
            />
          )}
        </div>
      ) : null}

      {pagination ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2">
          {paginationSummary}
          {paginationControls}
        </div>
      ) : (
        <span aria-live="polite" className="sr-only">
          {rows.length} rows
        </span>
      )}
    </div>
  );
}
