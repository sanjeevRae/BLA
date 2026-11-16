"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import {
  ErrorBox,
  inputClass,
  labelClass,
  primaryButtonClass,
  subtleButtonClass,
} from "@/components/warehouses/ui";

function OkBox({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-line bg-greenbg px-3 py-2 text-[13px] text-green">
      {message}
    </div>
  );
}
import {
  INCIDENT_CATEGORIES,
  INCIDENT_SEVERITIES,
  TICKET_CATEGORIES,
} from "@/lib/operations/domain";
import {
  acknowledgeIncidentAction,
  addIncidentNoteAction,
  addTaskCommentAction,
  approveIncidentResolutionAction,
  assignIncidentAction,
  assignTicketAction,
  cancelTaskAction,
  closeIncidentAction,
  closeTicketAction,
  createIncidentAction,
  createIncidentFollowUpTaskAction,
  createTaskAction,
  escalateIncidentAction,
  escalateTicketAction,
  markAllNotificationsReadAction,
  markNotificationReadAction,
  proposeIncidentResolutionAction,
  raiseTicketAction,
  reassignTaskAction,
  replyTicketAction,
  requestAddressCorrectionAction,
  requestRedeliveryAction,
  resolveIncidentAction,
  resolveTicketAction,
  updateNotificationPreferenceAction,
  updateTaskStatusAction,
} from "@/server/actions/operations";
import type { StaffUserOption } from "@/server/services/tasks";

export interface WarehouseOption {
  id: string;
  code: string;
  name: string;
}

function useActionRunner() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function run<T>(
    fn: () => Promise<{ success: boolean; data?: T; error?: string }>,
    okMessage?: string,
  ): Promise<T | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    const result = await fn();
    setBusy(false);
    if (!result.success) {
      setError(result.error ?? "Something went wrong");
      return null;
    }
    if (okMessage) setNotice(okMessage);
    router.refresh();
    return (result.data as T) ?? null;
  }
  return { busy, error, notice, run, setError };
}

function Feedback({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {error ? <ErrorBox message={error} /> : null}
      {notice ? <OkBox message={notice} /> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export function ReportIncidentForm({ warehouses }: { warehouses: WarehouseOption[] }) {
  const { busy, error, notice, run } = useActionRunner();
  const [category, setCategory] = useState<string>("MISSING_PACKAGE");
  const [severity, setSeverity] = useState<string>("");
  const [description, setDescription] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [packageId, setPackageId] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await run(
      () =>
        createIncidentAction({
          category: category as never,
          severity: (severity || undefined) as never,
          description,
          warehouseId: warehouseId || undefined,
          packageId: packageId.trim() || undefined,
        }),
      "Incident reported",
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className={labelClass}>Category</span>
          <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
            {INCIDENT_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={labelClass}>Severity (default per category if blank)</span>
          <select className={inputClass} value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">Category default</option>
            {INCIDENT_SEVERITIES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="grid gap-1">
        <span className={labelClass}>What happened?</span>
        <textarea className={inputClass} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} required minLength={5} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className={labelClass}>Warehouse (optional)</span>
          <select className={inputClass} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">—</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={labelClass}>Package ID (optional)</span>
          <input className={inputClass} value={packageId} onChange={(e) => setPackageId(e.target.value)} placeholder="Package UUID" />
        </label>
      </div>
      <Feedback error={error} notice={notice} />
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Reporting…" : "Report incident"}
        </button>
      </div>
    </form>
  );
}

/** Driver-relevant incident categories (Phase 7): the subset a
 *  rider / line-haul driver can plausibly hit on the road. The
 *  service accepts the full catalog; the driver surfaces offer
 *  only what a driver can act on. */
export const DRIVER_INCIDENT_CATEGORIES = [
  "DRIVER_BREAKDOWN",
  "VEHICLE_ACCIDENT",
  "DELAYED_SHIPMENT",
  "DAMAGED_PACKAGE",
  "MISSING_PACKAGE",
  "DELIVERY_FAILURE",
  "PICKUP_FAILURE",
  "INCORRECT_ADDRESS",
  "CUSTOMER_REFUSAL",
] as const;

/** Rider "Report problem" form for one delivery assignment
 *  (Phase 7). Posts to createIncident with the assignment +
 *  package links; the service validates the assignment is the
 *  reporting driver's own. */
export function DriverAssignmentIncidentForm({
  assignmentId,
  packageId,
}: {
  assignmentId: string;
  packageId: string;
}) {
  const { busy, error, notice, run } = useActionRunner();
  const [category, setCategory] = useState<string>("DELIVERY_FAILURE");
  const [description, setDescription] = useState("");

  return (
    <form
      className="grid gap-2 border-t border-line pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          () =>
            createIncidentAction({
              category: category as never,
              description,
              packageId,
              deliveryAssignmentId: assignmentId,
            }),
          "Problem reported — dispatch has the incident",
        ).then((r) => {
          if (r) setDescription("");
        });
      }}
    >
      <span className={labelClass}>Report a problem with this delivery</span>
      <div className="flex flex-wrap gap-2">
        <select
          className={inputClass}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Problem category"
        >
          {DRIVER_INCIDENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>{c.replaceAll("_", " ")}</option>
          ))}
        </select>
      </div>
      <textarea
        className={inputClass}
        rows={2}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What happened?"
        aria-label="Problem description"
        required
        minLength={5}
      />
      <Feedback error={error} notice={notice} />
      <div>
        <button
          type="submit"
          className={subtleButtonClass}
          disabled={busy || description.trim().length < 5}
        >
          {busy ? "Reporting…" : "Report problem"}
        </button>
      </div>
    </form>
  );
}

/** Line-haul "Report problem" form at trip level (Phase 7). Posts
 *  to createIncident with the trip link and an optional package
 *  from the trip manifest; the service validates the trip is the
 *  reporting driver's own. The trip delay form is a separate,
 *  unchanged flow — this raises a formal incident. */
export function DriverTripIncidentForm({
  tripId,
  packages,
}: {
  tripId: string;
  packages: { packageId: string; trackingId: string }[];
}) {
  const { busy, error, notice, run } = useActionRunner();
  const [category, setCategory] = useState<string>("DRIVER_BREAKDOWN");
  const [description, setDescription] = useState("");
  const [packageId, setPackageId] = useState("");

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          () =>
            createIncidentAction({
              category: category as never,
              description,
              tripId,
              packageId: packageId || undefined,
            }),
          "Problem reported — dispatch has the incident",
        ).then((r) => {
          if (r) setDescription("");
        });
      }}
    >
      <span className={labelClass}>Report a problem on this trip</span>
      <div className="flex flex-wrap gap-2">
        <select
          className={inputClass}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          aria-label="Problem category"
        >
          {DRIVER_INCIDENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>{c.replaceAll("_", " ")}</option>
          ))}
        </select>
        {packages.length > 0 ? (
          <select
            className={inputClass}
            value={packageId}
            onChange={(e) => setPackageId(e.target.value)}
            aria-label="Package (optional)"
          >
            <option value="">Whole trip (no single package)</option>
            {packages.map((p) => (
              <option key={p.packageId} value={p.packageId}>{p.trackingId}</option>
            ))}
          </select>
        ) : null}
      </div>
      <textarea
        className={inputClass}
        rows={2}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="What happened?"
        aria-label="Problem description"
        required
        minLength={5}
      />
      <Feedback error={error} notice={notice} />
      <div>
        <button
          type="submit"
          className={subtleButtonClass}
          disabled={busy || description.trim().length < 5}
        >
          {busy ? "Reporting…" : "Report problem"}
        </button>
      </div>
    </form>
  );
}

/** Incident → follow-up task (Phase 7). Shown only to
 *  incident.manage holders (the page gates it); the service
 *  re-checks the permission and validates the assignee as staff. */
export function IncidentFollowUpTaskForm({
  incidentId,
  users,
}: {
  incidentId: string;
  users: StaffUserOption[];
}) {
  const { busy, error, notice, run } = useActionRunner();
  const [assigneeId, setAssigneeId] = useState("");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("NORMAL");
  const [dueAt, setDueAt] = useState("");

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run(
          () =>
            createIncidentFollowUpTaskAction(incidentId, {
              assigneeId,
              title: title.trim() || undefined,
              priority: priority as never,
              dueAt: dueAt ? new Date(dueAt) : undefined,
            }),
          "Follow-up task created",
        ).then((r) => {
          if (r) {
            setTitle("");
            setAssigneeId("");
          }
        });
      }}
    >
      <span className={labelClass}>Create a follow-up task for this incident</span>
      <div className="flex flex-wrap gap-2">
        <select
          className={inputClass}
          value={assigneeId}
          onChange={(e) => setAssigneeId(e.target.value)}
          required
          aria-label="Task assignee"
        >
          <option value="">Select staff…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>{u.fullName} ({u.roles.join(", ")})</option>
          ))}
        </select>
        <select
          className={inputClass}
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          aria-label="Task priority"
        >
          {["LOW", "NORMAL", "HIGH", "URGENT"].map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <input
          type="datetime-local"
          className={inputClass}
          value={dueAt}
          onChange={(e) => setDueAt(e.target.value)}
          aria-label="Task due (optional)"
        />
      </div>
      <input
        className={inputClass}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title (defaults to “Follow up incident …”)"
        aria-label="Follow-up task title (optional)"
        minLength={3}
      />
      <Feedback error={error} notice={notice} />
      <div>
        <button type="submit" className={subtleButtonClass} disabled={busy || !assigneeId}>
          Create follow-up task
        </button>
      </div>
    </form>
  );
}

export function IncidentWorkflowForms({
  incidentId,
  status,
  users,
  hasPackage,
}: {
  incidentId: string;
  status: string;
  users: StaffUserOption[];
  hasPackage: boolean;
}) {
  const { busy, error, notice, run } = useActionRunner();
  const [assigneeId, setAssigneeId] = useState("");
  const [note, setNote] = useState("");
  const [awaiting, setAwaiting] = useState(false);
  const [escalationReason, setEscalationReason] = useState("");
  const [resolution, setResolution] = useState("");
  const [clearMisrouted, setClearMisrouted] = useState(false);

  const closed = status === "RESOLVED" || status === "CLOSED";

  return (
    <div className="grid gap-4">
      <Feedback error={error} notice={notice} />
      {status === "REPORTED" ? (
        <div>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={busy}
            onClick={() => void run(() => acknowledgeIncidentAction(incidentId), "Incident acknowledged")}
          >
            Acknowledge
          </button>
        </div>
      ) : null}

      {!closed ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => assignIncidentAction(incidentId, { assigneeId }), "Incident assigned");
          }}
        >
          <span className={labelClass}>Assign to</span>
          <div className="flex gap-2">
            <select className={inputClass} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} required aria-label="Assign incident to">
              <option value="">Select staff…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName} ({u.roles.join(", ")})</option>
              ))}
            </select>
            <button type="submit" className={subtleButtonClass} disabled={busy || !assigneeId}>Assign</button>
          </div>
        </form>
      ) : null}

      {!closed ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => addIncidentNoteAction(incidentId, { body: note, awaitingInformation: awaiting }),
              "Note added",
            );
          }}
        >
          <span className={labelClass}>Investigation note</span>
          <textarea className={inputClass} rows={2} value={note} onChange={(e) => setNote(e.target.value)} required aria-label="Investigation note" />
          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input type="checkbox" checked={awaiting} onChange={(e) => setAwaiting(e.target.checked)} />
            We are waiting for information from someone else
          </label>
          <div>
            <button type="submit" className={subtleButtonClass} disabled={busy || !note.trim()}>Add note</button>
          </div>
        </form>
      ) : null}

      {!closed && status !== "RESOLUTION_PROPOSED" && status !== "RESOLUTION_APPROVED" ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => escalateIncidentAction(incidentId, { reason: escalationReason }), "Incident escalated");
          }}
        >
          <span className={labelClass}>Escalate (raises severity, notifies Admin)</span>
          <div className="flex gap-2">
            <input className={inputClass} value={escalationReason} onChange={(e) => setEscalationReason(e.target.value)} placeholder="Why is this being escalated?" required minLength={3} aria-label="Escalation reason" />
            <button type="submit" className={subtleButtonClass} disabled={busy || escalationReason.trim().length < 3}>Escalate</button>
          </div>
        </form>
      ) : null}

      {["ASSIGNED", "INVESTIGATING", "AWAITING_INFORMATION", "ESCALATED"].includes(status) ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => proposeIncidentResolutionAction(incidentId, { resolution }), "Resolution proposed — it now needs approval");
          }}
        >
          <span className={labelClass}>Propose resolution</span>
          <textarea className={inputClass} rows={2} value={resolution} onChange={(e) => setResolution(e.target.value)} required minLength={5} aria-label="Proposed resolution" />
          <div>
            <button type="submit" className={subtleButtonClass} disabled={busy || resolution.trim().length < 5}>Propose resolution</button>
          </div>
        </form>
      ) : null}

      {status === "RESOLUTION_PROPOSED" ? (
        <div>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={busy}
            onClick={() => void run(() => approveIncidentResolutionAction(incidentId), "Resolution approved")}
          >
            Approve resolution
          </button>
        </div>
      ) : null}

      {status === "RESOLUTION_APPROVED" ? (
        <div className="grid gap-2">
          {hasPackage ? (
            <label className="flex items-center gap-2 text-[13px] text-ink">
              <input type="checkbox" checked={clearMisrouted} onChange={(e) => setClearMisrouted(e.target.checked)} />
              This package was flagged MISROUTED — clear the flag as part of the resolution
            </label>
          ) : null}
          <div>
            <button
              type="button"
              className={primaryButtonClass}
              disabled={busy}
              onClick={() => void run(() => resolveIncidentAction(incidentId, { clearMisrouted }), "Incident resolved")}
            >
              Resolve incident
            </button>
          </div>
        </div>
      ) : null}

      {status === "RESOLVED" ? (
        <div>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={busy}
            onClick={() => void run(() => closeIncidentAction(incidentId), "Incident closed")}
          >
            Close incident
          </button>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function CreateTaskForm({
  users,
  warehouses,
}: {
  users: StaffUserOption[];
  warehouses: WarehouseOption[];
}) {
  const { busy, error, notice, run } = useActionRunner();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [priority, setPriority] = useState("NORMAL");
  const [dueAt, setDueAt] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await run(
      () =>
        createTaskAction({
          title,
          description: description || undefined,
          assigneeId,
          warehouseId: warehouseId || undefined,
          priority: priority as never,
          dueAt: dueAt ? new Date(dueAt) : undefined,
        }),
      "Task created",
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <label className="grid gap-1">
        <span className={labelClass}>Title</span>
        <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} required minLength={3} />
      </label>
      <label className="grid gap-1">
        <span className={labelClass}>Description</span>
        <textarea className={inputClass} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className={labelClass}>Assignee</span>
          <select className={inputClass} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} required>
            <option value="">Select staff…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>{u.fullName} ({u.roles.join(", ")})</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={labelClass}>Warehouse (optional)</span>
          <select className={inputClass} value={warehouseId} onChange={(e) => setWarehouseId(e.target.value)}>
            <option value="">—</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>{w.code} — {w.name}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={labelClass}>Priority</span>
          <select className={inputClass} value={priority} onChange={(e) => setPriority(e.target.value)}>
            {["LOW", "NORMAL", "HIGH", "URGENT"].map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={labelClass}>Due (optional)</span>
          <input type="datetime-local" className={inputClass} value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </label>
      </div>
      <Feedback error={error} notice={notice} />
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy || !assigneeId}>
          {busy ? "Creating…" : "Create task"}
        </button>
      </div>
    </form>
  );
}

const TASK_NEXT: Record<string, { label: string; status: string }[]> = {
  ASSIGNED: [{ label: "Accept", status: "ACCEPTED" }],
  ACCEPTED: [
    { label: "Start work", status: "IN_PROGRESS" },
    { label: "Mark blocked", status: "BLOCKED" },
  ],
  IN_PROGRESS: [
    { label: "Mark blocked", status: "BLOCKED" },
    { label: "Submit for review (complete my work)", status: "SUBMITTED" },
  ],
  BLOCKED: [
    { label: "Resume work", status: "IN_PROGRESS" },
    { label: "Submit for review", status: "SUBMITTED" },
  ],
  REJECTED: [{ label: "Resume work", status: "IN_PROGRESS" }],
  SUBMITTED: [
    { label: "Begin review", status: "UNDER_REVIEW" },
    { label: "Verify (approve)", status: "VERIFIED" },
    { label: "Reject back to assignee", status: "REJECTED" },
  ],
  UNDER_REVIEW: [
    { label: "Verify (approve)", status: "VERIFIED" },
    { label: "Reject back to assignee", status: "REJECTED" },
  ],
  VERIFIED: [{ label: "Close task", status: "CLOSED" }],
};

export function TaskWorkflowForms({
  taskId,
  status,
  users,
}: {
  taskId: string;
  status: string;
  users: StaffUserOption[];
}) {
  const { busy, error, notice, run } = useActionRunner();
  const [comment, setComment] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [reason, setReason] = useState("");
  // Phase 7: the service requires a reason note when moving to
  // BLOCKED (it persists as a task comment). The note is offered
  // for every transition and required for the blocked ones.
  const [statusNote, setStatusNote] = useState("");
  const blockedNoteOk = statusNote.replace(/\s/g, "").length >= 3;
  const next = TASK_NEXT[status] ?? [];
  const terminal = status === "CLOSED" || status === "CANCELLED";

  return (
    <div className="grid gap-4">
      <Feedback error={error} notice={notice} />
      {next.length > 0 ? (
        <div className="grid gap-2">
          <label className="grid gap-1">
            <span className={labelClass}>
              Note for the status change (required when marking blocked)
            </span>
            <input
              className={inputClass}
              value={statusNote}
              onChange={(e) => setStatusNote(e.target.value)}
              placeholder="e.g. Waiting on the vendor to confirm the count"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {next.map((n) => (
              <button
                key={n.status}
                type="button"
                className={n.status === "SUBMITTED" || n.status === "VERIFIED" || n.status === "CLOSED" ? primaryButtonClass : subtleButtonClass}
                disabled={busy || (n.status === "BLOCKED" && !blockedNoteOk)}
                onClick={() =>
                  void run(
                    () =>
                      updateTaskStatusAction(taskId, {
                        status: n.status as never,
                        note: statusNote.trim() || undefined,
                      }),
                    `Task moved to ${n.status}`,
                  ).then((r) => {
                    if (r) setStatusNote("");
                  })
                }
              >
                {n.label}
              </button>
            ))}
          </div>
          {next.some((n) => n.status === "BLOCKED") && !blockedNoteOk ? (
            <p className="text-[12px] text-slate2">
              Add a reason above to enable “Mark blocked” — a blocked task must say what it is
              waiting on.
            </p>
          ) : null}
        </div>
      ) : null}

      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => addTaskCommentAction(taskId, { body: comment }), "Comment added");
        }}
      >
        <span className={labelClass}>Add a comment</span>
        <div className="flex gap-2">
          <input className={inputClass} value={comment} onChange={(e) => setComment(e.target.value)} required />
          <button type="submit" className={subtleButtonClass} disabled={busy || !comment.trim()}>Comment</button>
        </div>
      </form>

      {!terminal ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => reassignTaskAction(taskId, { assigneeId, reason }), "Task reassigned");
          }}
        >
          <span className={labelClass}>Reassign (reason required)</span>
          <div className="flex flex-wrap gap-2">
            <select className={inputClass} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} required>
              <option value="">Select staff…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName}</option>
              ))}
            </select>
            <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" required minLength={3} />
            <button type="submit" className={subtleButtonClass} disabled={busy || !assigneeId}>Reassign</button>
          </div>
        </form>
      ) : null}

      {!terminal ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => cancelTaskAction(taskId, { reason }), "Task cancelled");
          }}
        >
          <span className={labelClass}>Cancel task</span>
          <div className="flex gap-2">
            <input className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Cancellation reason" minLength={3} />
            <button type="submit" className={subtleButtonClass} disabled={busy || reason.trim().length < 3}>Cancel task</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Support tickets
// ---------------------------------------------------------------------------

export function RaiseTicketForm() {
  const { busy, error, notice, run } = useActionRunner();
  const [category, setCategory] = useState<string>("GENERAL");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [packageId, setPackageId] = useState("");

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    await run(
      () =>
        raiseTicketAction({
          category: category as never,
          subject,
          description,
          packageId: packageId.trim() || undefined,
        }),
      "Ticket raised — support has been notified",
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1">
          <span className={labelClass}>Category</span>
          <select className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)}>
            {TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1">
          <span className={labelClass}>Package ID (optional)</span>
          <input className={inputClass} value={packageId} onChange={(e) => setPackageId(e.target.value)} placeholder="Package UUID" />
        </label>
      </div>
      <label className="grid gap-1">
        <span className={labelClass}>Subject</span>
        <input className={inputClass} value={subject} onChange={(e) => setSubject(e.target.value)} required minLength={3} />
      </label>
      <label className="grid gap-1">
        <span className={labelClass}>Describe the problem</span>
        <textarea className={inputClass} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} required minLength={5} />
      </label>
      <Feedback error={error} notice={notice} />
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy}>
          {busy ? "Raising…" : "Raise ticket"}
        </button>
      </div>
    </form>
  );
}

export function TicketReplyForm({ ticketId, staff }: { ticketId: string; staff: boolean }) {
  const { busy, error, notice, run } = useActionRunner();
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);

  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => replyTicketAction(ticketId, { body, internal }), internal ? "Internal note added" : "Reply sent");
      }}
    >
      <span className={labelClass}>{internal ? "Internal note (never shown to the customer)" : "Reply"}</span>
      <textarea className={inputClass} rows={2} value={body} onChange={(e) => setBody(e.target.value)} required />
      {staff ? (
        <label className="flex items-center gap-2 text-[13px] text-ink">
          <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
          Internal note (staff only)
        </label>
      ) : null}
      <Feedback error={error} notice={notice} />
      <div>
        <button type="submit" className={primaryButtonClass} disabled={busy || !body.trim()}>
          {internal ? "Add internal note" : "Send reply"}
        </button>
      </div>
    </form>
  );
}

export function TicketStaffForms({
  ticketId,
  status,
  users,
}: {
  ticketId: string;
  status: string;
  users: StaffUserOption[];
}) {
  const { busy, error, notice, run } = useActionRunner();
  const [assigneeId, setAssigneeId] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");
  const [followUpNote, setFollowUpNote] = useState("");
  const [taskAssigneeId, setTaskAssigneeId] = useState("");
  const [escalationNote, setEscalationNote] = useState("");
  const resolved = status === "RESOLVED" || status === "CLOSED";

  return (
    <div className="grid gap-4">
      <Feedback error={error} notice={notice} />
      {!resolved ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => assignTicketAction(ticketId, { assigneeId }), "Ticket assigned");
          }}
        >
          <span className={labelClass}>Assign to support staff</span>
          <div className="flex gap-2">
            <select className={inputClass} value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} required>
              <option value="">Select staff…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName} ({u.roles.join(", ")})</option>
              ))}
            </select>
            <button type="submit" className={subtleButtonClass} disabled={busy || !assigneeId}>Assign</button>
          </div>
        </form>
      ) : null}

      {!resolved ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => resolveTicketAction(ticketId, { resolutionNote }), "Ticket resolved — the customer has been notified");
          }}
        >
          <span className={labelClass}>Resolve ticket</span>
          <textarea className={inputClass} rows={2} value={resolutionNote} onChange={(e) => setResolutionNote(e.target.value)} required minLength={3} />
          <div>
            <button type="submit" className={primaryButtonClass} disabled={busy || resolutionNote.trim().length < 3}>Resolve</button>
          </div>
        </form>
      ) : null}

      {status === "RESOLVED" ? (
        <div>
          <button
            type="button"
            className={primaryButtonClass}
            disabled={busy}
            onClick={() => void run(() => closeTicketAction(ticketId), "Ticket closed")}
          >
            Close ticket
          </button>
        </div>
      ) : null}

      {!resolved ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <span className={labelClass}>Request an operational follow-up</span>
          <input className={inputClass} value={followUpNote} onChange={(e) => setFollowUpNote(e.target.value)} placeholder="Details for the warehouse" minLength={3} />
          <div className="flex gap-2">
            <button
              type="button"
              className={subtleButtonClass}
              disabled={busy || followUpNote.trim().length < 3}
              onClick={() => void run(() => requestRedeliveryAction(ticketId, { note: followUpNote }), "Redelivery requested")}
            >
              Request redelivery
            </button>
            <button
              type="button"
              className={subtleButtonClass}
              disabled={busy || followUpNote.trim().length < 3}
              onClick={() => void run(() => requestAddressCorrectionAction(ticketId, { note: followUpNote }), "Address correction requested")}
            >
              Request address correction
            </button>
          </div>
        </form>
      ) : null}

      {!resolved ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => escalateTicketAction(ticketId, { assigneeId: taskAssigneeId, note: escalationNote }),
              "Escalated to an investigation task",
            );
          }}
        >
          <span className={labelClass}>Escalate to an investigation task</span>
          <div className="flex flex-wrap gap-2">
            <select className={inputClass} value={taskAssigneeId} onChange={(e) => setTaskAssigneeId(e.target.value)} required>
              <option value="">Investigator…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.fullName}</option>
              ))}
            </select>
            <input className={inputClass} value={escalationNote} onChange={(e) => setEscalationNote(e.target.value)} placeholder="What must be investigated?" required minLength={3} />
            <button type="submit" className={subtleButtonClass} disabled={busy || !taskAssigneeId}>Escalate</button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export function MarkAllReadButton() {
  const { busy, run } = useActionRunner();
  return (
    <button
      type="button"
      className={subtleButtonClass}
      disabled={busy}
      onClick={() => void run(() => markAllNotificationsReadAction(), "All caught up")}
    >
      Mark all read
    </button>
  );
}

export function MarkReadButton({ notificationId }: { notificationId: string }) {
  const { busy, run } = useActionRunner();
  return (
    <button
      type="button"
      className={subtleButtonClass}
      disabled={busy}
      onClick={() => void run(() => markNotificationReadAction(notificationId))}
    >
      Mark read
    </button>
  );
}

export function PreferenceToggle({
  category,
  channel,
  enabled,
}: {
  category: string;
  channel: string;
  enabled: boolean;
}) {
  const { busy, run } = useActionRunner();
  const [on, setOn] = useState(enabled);
  return (
    <label className="flex items-center gap-2 text-[13px] text-ink">
      <input
        type="checkbox"
        checked={on}
        disabled={busy}
        onChange={(e) => {
          const next = e.target.checked;
          setOn(next);
          void run(() =>
            updateNotificationPreferenceAction({
              category: category as never,
              channel: channel as never,
              enabled: next,
            }),
          );
        }}
      />
      {channel}
    </label>
  );
}
