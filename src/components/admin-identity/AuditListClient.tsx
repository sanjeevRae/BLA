"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { ActivityTimeline } from "@/components/ui/ActivityTimeline";
import { DataTable } from "@/components/ui/DataTable";
import { Drawer } from "@/components/ui/Drawer";
import { TONE_CLASSES } from "@/lib/status/status-tones";
import type { AuditLogView, ListAuditLogsResult } from "@/server/services/audit-log";
import { formatDateTime } from "./ui";

/**
 * Friendly action label for the timeline view: humanise the dot-code
 * segment by segment — "user.suspended" → "User suspended",
 * "access.denied" → "Access denied". The raw code stays visible in
 * the table view and in the detail Drawer; only the timeline label
 * is humanised.
 */
function friendlyActionLabel(action: string): string {
  const words = action
    .split(".")
    .flatMap((segment) => segment.split("_"))
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
  if (words.length === 0) return action;
  const joined = words.join(" ");
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

/**
 * Audit-log viewer (Phase 6): server-driven filters (actor, action,
 * resource, outcome, dates) via the URL, and a detail Drawer with the
 * before/after JSON exactly as stored.
 */
export function AuditListClient({
  basePath,
  result,
  initial,
}: {
  basePath: string;
  result: ListAuditLogsResult;
  initial: {
    actorSearch: string;
    action: string;
    entityType: string;
    outcome: string;
    from: string;
    to: string;
  };
}) {
  const router = useRouter();
  const [view, setView] = useState<"table" | "timeline">("table");
  const [selected, setSelected] = useState<AuditLogView | null>(null);
  const [actorSearch, setActorSearch] = useState(initial.actorSearch);
  const [action, setAction] = useState(initial.action);
  const [entityType, setEntityType] = useState(initial.entityType);

  function navigate(next: Partial<typeof initial> & { page?: number }) {
    const merged = { ...initial, ...next };
    const params = new URLSearchParams();
    if (merged.actorSearch) params.set("actor", merged.actorSearch);
    if (merged.action) params.set("action", merged.action);
    if (merged.entityType) params.set("entityType", merged.entityType);
    if (merged.outcome) params.set("outcome", merged.outcome);
    if (merged.from) params.set("from", merged.from);
    if (merged.to) params.set("to", merged.to);
    if (next.page && next.page > 1) params.set("page", String(next.page));
    const qs = params.toString();
    router.push(qs ? `${basePath}/audit?${qs}` : `${basePath}/audit`);
  }

  const inputClass =
    "min-h-[44px] rounded-md border border-border bg-surface px-3 text-[13px] text-ink";

  return (
    <>
      <form
        className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-surface px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({ actorSearch, action, entityType, page: 1 });
        }}
      >
        <label className="grid gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Actor</span>
          <input
            className={inputClass}
            value={actorSearch}
            onChange={(e) => setActorSearch(e.target.value)}
            placeholder="Name or email"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Action</span>
          <input
            className={inputClass}
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="e.g. user.suspended"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Resource type</span>
          <input
            className={inputClass}
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            placeholder="e.g. User"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">Outcome</span>
          <select
            className={inputClass}
            value={initial.outcome}
            onChange={(e) => navigate({ outcome: e.target.value, page: 1 })}
          >
            <option value="">All outcomes</option>
            <option value="recorded">Recorded</option>
            <option value="denied">Denied</option>
          </select>
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">From</span>
          <input
            type="date"
            className={inputClass}
            value={initial.from}
            onChange={(e) => navigate({ from: e.target.value, page: 1 })}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-2">To</span>
          <input
            type="date"
            className={inputClass}
            value={initial.to}
            onChange={(e) => navigate({ to: e.target.value, page: 1 })}
          />
        </label>
        <button
          type="submit"
          className="inline-flex min-h-[44px] items-center rounded-md bg-primary px-3 text-[13px] font-semibold text-white"
        >
          Apply filters
        </button>
      </form>

      <div className="flex items-center justify-end">
        <div role="group" aria-label="Audit view" className="inline-flex items-center gap-1">
          <span className="text-[13px] text-ink-2">View:</span>
          <button
            type="button"
            aria-pressed={view === "table"}
            onClick={() => setView("table")}
            className={`inline-flex min-h-[32px] items-center rounded-md px-2.5 text-[13px] font-semibold ${
              view === "table"
                ? "bg-primary-light text-primary-dark"
                : "text-ink-2 hover:bg-surface-2 hover:text-ink"
            }`}
          >
            Table
          </button>
          <button
            type="button"
            aria-pressed={view === "timeline"}
            onClick={() => setView("timeline")}
            className={`inline-flex min-h-[32px] items-center rounded-md px-2.5 text-[13px] font-semibold ${
              view === "timeline"
                ? "bg-primary-light text-primary-dark"
                : "text-ink-2 hover:bg-surface-2 hover:text-ink"
            }`}
          >
            Timeline
          </button>
        </div>
      </div>

      {view === "timeline" ? (
        result.items.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-[14px] font-semibold text-ink">No audit entries match</p>
            <p className="mt-1 text-[13px] text-ink-2">
              Audit entries appear here as users act. Try widening the filters.
            </p>
          </div>
        ) : (
          <ActivityTimeline
            ariaLabel="Audit logs timeline"
            items={result.items.map((row) => ({
              id: row.id,
              label: friendlyActionLabel(row.action),
              actor: (
                <>
                  {row.actorName ?? "System"}
                  {row.actorRole ? ` (${row.actorRole})` : ""}
                </>
              ),
              time: formatDateTime(row.createdAt),
              detail: `${row.entityType} · ${row.outcome}`,
              tone: row.outcome === "denied" ? ("danger" as const) : ("neutral" as const),
              onSelect: () => setSelected(row),
            }))}
          />
        )
      ) : (
      <DataTable
        ariaLabel="Audit logs"
        rows={result.items}
        rowKey={(row) => row.id}
        pagination={{
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          onPageChange: (page) => navigate({ page }),
        }}
        emptyState={
          <div className="py-6 text-center">
            <p className="text-[14px] font-semibold text-ink">No audit entries match</p>
            <p className="mt-1 text-[13px] text-slate2">
              Audit entries appear here as users act. Try widening the filters.
            </p>
          </div>
        }
        columns={[
          {
            key: "createdAt",
            header: "Time",
            render: (row) => formatDateTime(row.createdAt),
          },
          {
            key: "actor",
            header: "Actor",
            render: (row) => (
              <div className="leading-tight">
                <div className="font-medium">{row.actorName ?? "System"}</div>
                <div className="text-[12px] text-slate2">
                  {row.actorRole ?? ""}
                  {row.actorEmail ? ` · ${row.actorEmail}` : ""}
                </div>
              </div>
            ),
          },
          { key: "action", header: "Action" },
          {
            key: "resource",
            header: "Resource",
            render: (row) => (
              <span className="text-slate2">
                {row.entityType}
                {row.entityId ? ` · ${row.entityId.slice(0, 8)}…` : ""}
              </span>
            ),
          },
          {
            key: "outcome",
            header: "Outcome",
            render: (row) => (
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${
                  row.outcome === "denied" ? TONE_CLASSES.danger : TONE_CLASSES.success
                }`}
              >
                {row.outcome === "denied" ? "Denied" : "Recorded"}
              </span>
            ),
          },
          {
            key: "detail",
            header: "",
            render: (row) => (
              <button
                type="button"
                onClick={() => setSelected(row)}
                className="font-semibold text-brand"
                aria-label={`View audit entry ${row.action} at ${row.createdAt}`}
              >
                Details
              </button>
            ),
          },
        ]}
      />
      )}

      <Drawer open={selected !== null} onClose={() => setSelected(null)} title="Audit entry">
        {selected ? (
          <div className="grid gap-3 text-[13px]">
            <dl className="grid gap-1.5">
              <div className="flex justify-between gap-4">
                <dt className="text-ink-2">Time</dt>
                <dd className="font-medium text-ink">{formatDateTime(selected.createdAt)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-ink-2">Actor</dt>
                <dd className="font-medium text-ink">
                  {selected.actorName ?? "System"} ({selected.actorRole ?? "—"})
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-ink-2">Action</dt>
                <dd className="font-medium text-ink">{selected.action}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-ink-2">Resource</dt>
                <dd className="break-all font-medium text-ink">
                  {selected.entityType}
                  {selected.entityId ? ` · ${selected.entityId}` : ""}
                </dd>
              </div>
              {selected.warehouseId ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-2">Warehouse</dt>
                  <dd className="break-all font-medium text-ink">{selected.warehouseId}</dd>
                </div>
              ) : null}
            </dl>
            <div>
              <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-2">
                Before
              </h3>
              <pre className="overflow-x-auto rounded-md border border-border bg-cream p-3 text-[12px] text-ink">
                {selected.before == null ? "—" : JSON.stringify(selected.before, null, 2)}
              </pre>
            </div>
            <div>
              <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-2">
                After
              </h3>
              <pre className="overflow-x-auto rounded-md border border-border bg-cream p-3 text-[12px] text-ink">
                {selected.after == null ? "—" : JSON.stringify(selected.after, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
