"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import { EmptyState, SkeletonRows } from "./states";

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
  } = props;

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

  const hasToolbar = Boolean(search || filters || dateRange || hideableColumns.length > 0);
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
      <span className="text-[13px] text-slate2">
        Showing {from}–{to} of {total}
      </span>
    );
    paginationControls = (
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!canPrev}
          onClick={() => onPageChange(page - 1)}
          className="inline-flex min-h-[44px] items-center rounded-md border border-line bg-surface px-3 text-[13px] font-semibold text-ink disabled:opacity-60"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={!canNext}
          onClick={() => onPageChange(page + 1)}
          className="inline-flex min-h-[44px] items-center rounded-md border border-line bg-surface px-3 text-[13px] font-semibold text-ink disabled:opacity-60"
        >
          Next
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-line bg-surface">
      {hasToolbar ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          {search ? (
            <input
              type="search"
              value={search.value}
              onChange={(event) => search.onChange(event.target.value)}
              placeholder={search.placeholder ?? "Search…"}
              aria-label={search.placeholder ?? "Search"}
              className="h-11 min-w-[200px] flex-1 rounded-md border border-line bg-surface px-3 text-[13px] text-ink sm:flex-none sm:basis-64"
            />
          ) : null}
          {filters}
          {dateRange}
          {hideableColumns.length > 0 ? (
            <div className="relative ml-auto">
              <button
                type="button"
                aria-haspopup="true"
                aria-expanded={columnsOpen}
                onClick={() => setColumnsOpen((value) => !value)}
                className="inline-flex min-h-[44px] items-center rounded-md border border-line bg-surface px-3 text-[13px] font-semibold text-ink"
              >
                Columns
              </button>
              {columnsOpen ? (
                <div className="absolute right-0 z-20 mt-1 w-56 rounded-md border border-line bg-surface p-2 shadow-pop">
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
        <table aria-label={ariaLabel} className="w-full border-collapse">
          <thead>
            <tr>
              {visibleColumns.map((column) => {
                const isSorted = Boolean(sort && sort.key === column.key);
                const ariaSort = column.sortable
                  ? isSorted
                    ? sort?.direction === "asc"
                      ? "ascending"
                      : "descending"
                    : "none"
                  : undefined;
                const indicator = !column.sortable
                  ? null
                  : isSorted
                    ? sort?.direction === "asc"
                      ? " ▲"
                      : " ▼"
                    : " ↕";
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={ariaSort}
                    className={`bg-cream/60 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate2 ${alignClass(column.align)} ${column.className ?? ""}`}
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
                <tr key={rowKey(row)} className="border-t border-line">
                  {visibleColumns.map((column) => {
                    const content = column.render
                      ? column.render(row)
                      : String(
                          (row as Record<string, unknown>)[column.key] ?? "",
                        );
                    return (
                      <td
                        key={column.key}
                        className={`px-3 py-2 text-[13px] text-ink ${alignClass(column.align)} ${column.className ?? ""}`}
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
        <div className="border-t border-line">
          <SkeletonRows rows={4} />
        </div>
      ) : null}

      {isEmpty ? (
        <div className="border-t border-line p-3">
          {emptyState ?? (
            <EmptyState
              title="No records"
              description="There are no records to show yet."
            />
          )}
        </div>
      ) : null}

      {pagination ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2">
          {paginationSummary}
          {paginationControls}
        </div>
      ) : null}
    </div>
  );
}
