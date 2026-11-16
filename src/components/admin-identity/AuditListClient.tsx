"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { DataTable } from "@/components/ui/DataTable";
import { Drawer } from "@/components/ui/Drawer";
import { TONE_CLASSES } from "@/lib/status/status-tones";
import type { AuditLogView, ListAuditLogsResult } from "@/server/services/audit-log";
import { formatDateTime } from "./ui";

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
    "min-h-[44px] rounded-md border border-line bg-surface px-3 text-[13px] text-ink";

  return (
    <>
      <form
        className="flex flex-wrap items-end gap-2 rounded-lg border border-line bg-surface px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          navigate({ actorSearch, action, entityType, page: 1 });
        }}
      >
        <label className="grid gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate2">Actor</span>
          <input
            className={inputClass}
            value={actorSearch}
            onChange={(e) => setActorSearch(e.target.value)}
            placeholder="Name or email"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate2">Action</span>
          <input
            className={inputClass}
            value={action}
            onChange={(e) => setAction(e.target.value)}
            placeholder="e.g. user.suspended"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate2">Resource type</span>
          <input
            className={inputClass}
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            placeholder="e.g. User"
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate2">Outcome</span>
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
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate2">From</span>
          <input
            type="date"
            className={inputClass}
            value={initial.from}
            onChange={(e) => navigate({ from: e.target.value, page: 1 })}
          />
        </label>
        <label className="grid gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate2">To</span>
          <input
            type="date"
            className={inputClass}
            value={initial.to}
            onChange={(e) => navigate({ to: e.target.value, page: 1 })}
          />
        </label>
        <button
          type="submit"
          className="inline-flex min-h-[44px] items-center rounded-md bg-brand px-3 text-[13px] font-semibold text-white"
        >
          Apply filters
        </button>
      </form>

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
                {row.outcome === "denied" ? "DENIED" : "RECORDED"}
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

      <Drawer open={selected !== null} onClose={() => setSelected(null)} title="Audit entry">
        {selected ? (
          <div className="grid gap-3 text-[13px]">
            <dl className="grid gap-1.5">
              <div className="flex justify-between gap-4">
                <dt className="text-slate2">Time</dt>
                <dd className="font-medium text-ink">{formatDateTime(selected.createdAt)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate2">Actor</dt>
                <dd className="font-medium text-ink">
                  {selected.actorName ?? "System"} ({selected.actorRole ?? "—"})
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate2">Action</dt>
                <dd className="font-medium text-ink">{selected.action}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate2">Resource</dt>
                <dd className="break-all font-medium text-ink">
                  {selected.entityType}
                  {selected.entityId ? ` · ${selected.entityId}` : ""}
                </dd>
              </div>
              {selected.warehouseId ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-slate2">Warehouse</dt>
                  <dd className="break-all font-medium text-ink">{selected.warehouseId}</dd>
                </div>
              ) : null}
            </dl>
            <div>
              <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate2">
                Before
              </h3>
              <pre className="overflow-x-auto rounded-md border border-line bg-cream p-3 text-[12px] text-ink">
                {selected.before == null ? "—" : JSON.stringify(selected.before, null, 2)}
              </pre>
            </div>
            <div>
              <h3 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate2">
                After
              </h3>
              <pre className="overflow-x-auto rounded-md border border-line bg-cream p-3 text-[12px] text-ink">
                {selected.after == null ? "—" : JSON.stringify(selected.after, null, 2)}
              </pre>
            </div>
          </div>
        ) : null}
      </Drawer>
    </>
  );
}
