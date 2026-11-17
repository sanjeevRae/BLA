import Link from "next/link";

import { hasPermission, type ActorContext } from "@/lib/auth/actor";
import { SectionCard, subtleButtonClass } from "@/components/warehouses/ui";
import { PriorityBadge, StatusBadge as SharedStatusBadge } from "@/components/ui/StatusBadge";
import { statusLabel } from "@/lib/status/labels";
import { PageHeader } from "@/components/ui/PageHeader";
import { DensityScope } from "@/components/ui/TableDensity";
import {
  TABLE_CLASS,
  TD_CLASS,
  TD_ID_CLASS,
  THEAD_ROW_CLASS,
  TH_CLASS,
  TR_CLASS,
} from "@/components/ui/table-chrome";
import { listWarehouses } from "@/server/services/warehouses";
import {
  getIncident,
  listIncidents,
  type IncidentView,
} from "@/server/services/incidents";
import {
  getMyNotificationPreferences,
  listMyNotifications,
} from "@/server/services/notifications";
import {
  getTicket,
  listTickets,
  type TicketView,
} from "@/server/services/support-tickets";
import {
  getTask,
  listStaffUserOptions,
  listTasks,
  type TaskView,
} from "@/server/services/tasks";
import {
  CreateTaskForm,
  IncidentFollowUpTaskForm,
  IncidentWorkflowForms,
  MarkAllReadButton,
  MarkReadButton,
  PreferenceToggle,
  RaiseTicketForm,
  ReportIncidentForm,
  TaskWorkflowForms,
  TicketReplyForm,
  TicketStaffForms,
  type WarehouseOption,
} from "@/components/operations/forms";

/**
 * Phase 8 operations screens (incidents, tasks, support tickets,
 * notifications) shared by the admin / warehouse / staff / support /
 * finance / vendor / customer / rider dashboards. Every row comes
 * from the services — scoped inside their queries — never from
 * client-supplied state.
 */

export function StatusBadge({ status }: { status: string }) {
  return <SharedStatusBadge domain="generic" status={status} />;
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <SharedStatusBadge domain="generic" status={severity} />;
}

async function warehouseOptions(actor: ActorContext): Promise<WarehouseOption[]> {
  const { items } = await listWarehouses(actor, { pageSize: 100 });
  return items.map((w) => ({ id: w.id, code: w.code, name: w.name }));
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export async function IncidentsQueuePage({
  actor,
  basePath,
}: {
  actor: ActorContext;
  basePath: string;
}) {
  const [open, all] = await Promise.all([
    listIncidents(actor, { openOnly: true, pageSize: 50 }),
    listIncidents(actor, { pageSize: 25 }),
  ]);
  const warehouses = await warehouseOptions(actor).catch(() => []);
  const canReport = hasPermission(actor, "incident.report");
  return (
    <div className="grid gap-5">
      <PageHeader eyebrow="Operations" title="Incidents" />
      <SectionCard title={`Open incidents (${open.meta.total})`}>
        <IncidentTable rows={open.items} basePath={basePath} />
      </SectionCard>
      <SectionCard title="All incidents in your scope">
        <IncidentTable rows={all.items} basePath={basePath} />
      </SectionCard>
      {canReport ? (
        <SectionCard title="Report an incident">
          <ReportIncidentForm warehouses={warehouses} />
        </SectionCard>
      ) : null}
    </div>
  );
}

function IncidentTable({ rows, basePath }: { rows: IncidentView[]; basePath: string }) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-ink-2">No incidents here.</p>;
  }
  return (
    <DensityScope showToggle>
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS}>
          <thead>
            <tr className={THEAD_ROW_CLASS}>
              <th className={`${TH_CLASS} text-left`}>Number</th>
              <th className={`${TH_CLASS} text-left`}>Category</th>
              <th className={`${TH_CLASS} text-left`}>Severity</th>
              <th className={`${TH_CLASS} text-left`}>Status</th>
              <th className={`${TH_CLASS} text-left`}>Package</th>
              <th className={`${TH_CLASS} text-left`}>Assignee</th>
              <th className={`${TH_CLASS} text-left`}>Raised</th>
              <th className={`${TH_CLASS} text-left`} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={TR_CLASS}>
                <td className={TD_ID_CLASS}>{r.incidentNumber}</td>
                <td className={TD_CLASS}>{statusLabel("generic", r.category)}</td>
                <td className={TD_CLASS}><SeverityBadge severity={r.severity} /></td>
                <td className={TD_CLASS}><StatusBadge status={r.status} /></td>
                <td className={TD_ID_CLASS}>{r.packageTrackingId ?? "—"}</td>
                <td className={TD_CLASS}>{r.assigneeName ?? "—"}</td>
                <td className={TD_CLASS}>{fmtDate(r.createdAt)}</td>
                <td className={TD_CLASS}>
                  <Link className={subtleButtonClass} href={`${basePath}/incidents/${r.id}`}>
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DensityScope>
  );
}

export async function IncidentDetailPage({
  actor,
  id,
  basePath,
}: {
  actor: ActorContext;
  id: string;
  basePath: string;
}) {
  const incident = await getIncident(actor, id);
  const users = await listStaffUserOptions(actor);
  const canManage = hasPermission(actor, "incident.manage");
  return (
    <div className="grid gap-5">
      <PageHeader eyebrow={`Incident ${incident.incidentNumber}`} title={statusLabel("generic", incident.category)} />
      <SectionCard title="Summary">
        <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
          <div><dt className="text-ink-2">Status</dt><dd><StatusBadge status={incident.status} /></dd></div>
          <div><dt className="text-ink-2">Severity</dt><dd><SeverityBadge severity={incident.severity} /></dd></div>
          <div><dt className="text-ink-2">Team</dt><dd className="text-ink">{incident.responsibleTeam ?? "—"}</dd></div>
          <div><dt className="text-ink-2">Reporter</dt><dd className="text-ink">{incident.reporterName ?? "—"}</dd></div>
          <div><dt className="text-ink-2">Assignee</dt><dd className="text-ink">{incident.assigneeName ?? "Unassigned"}</dd></div>
          <div><dt className="text-ink-2">Package</dt><dd className="font-mono text-ink">{incident.packageTrackingId ?? "—"}</dd></div>
          <div><dt className="text-ink-2">Raised</dt><dd className="text-ink">{fmtDate(incident.createdAt)}</dd></div>
          <div><dt className="text-ink-2">Resolved</dt><dd className="text-ink">{fmtDate(incident.resolvedAt)}</dd></div>
        </dl>
        <p className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
          {incident.description}
        </p>
        {incident.resolution ? (
          <p className="mt-3 rounded-md border border-border bg-page px-3 py-2 text-[13px] text-ink">
            <strong>Resolution:</strong> {incident.resolution}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title="Investigation thread">
        {incident.notes.length === 0 ? (
          <p className="text-[13px] text-ink-2">No notes yet.</p>
        ) : (
          <ul className="grid gap-3">
            {incident.notes.map((n) => (
              <li key={n.id} className="rounded-md border border-border bg-page px-3 py-2">
                <div className="text-[12px] text-ink-2">
                  {n.authorName} · {fmtDate(n.createdAt)}
                </div>
                <p className="whitespace-pre-wrap text-[13px] text-ink">{n.body}</p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {canManage ? (
        <SectionCard title="Work this incident">
          <IncidentWorkflowForms
            incidentId={incident.id}
            status={incident.status}
            users={users}
            hasPackage={Boolean(incident.packageId)}
          />
        </SectionCard>
      ) : null}

      {canManage ? (
        <SectionCard title="Follow-up task">
          <IncidentFollowUpTaskForm incidentId={incident.id} users={users} />
        </SectionCard>
      ) : null}

      <div>
        <Link className={subtleButtonClass} href={`${basePath}/incidents`}>
          Back to incidents
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function TasksBoardPage({
  actor,
  basePath,
  queue = "all",
}: {
  actor: ActorContext;
  basePath: string;
  queue?: "mine" | "created" | "all";
}) {
  const [board, overdue] = await Promise.all([
    listTasks(actor, { queue, pageSize: 50 }),
    listTasks(actor, { queue, overdueOnly: true, pageSize: 50 }),
  ]);
  const users = await listStaffUserOptions(actor);
  const warehouses = await warehouseOptions(actor).catch(() => []);
  const canCreate = hasPermission(actor, "task.create");
  return (
    <div className="grid gap-5">
      <PageHeader eyebrow="Operations" title={queue === "mine" ? "My tasks" : "Tasks"} />
      {overdue.items.length > 0 ? (
        <SectionCard title={`Overdue (${overdue.items.length})`}>
          <TaskTable rows={overdue.items} basePath={basePath} />
        </SectionCard>
      ) : null}
      <SectionCard title={`Tasks (${board.meta.total})`}>
        <TaskTable rows={board.items} basePath={basePath} />
      </SectionCard>
      {canCreate ? (
        <SectionCard title="Create a task">
          <CreateTaskForm users={users} warehouses={warehouses} />
        </SectionCard>
      ) : null}
    </div>
  );
}

function TaskTable({ rows, basePath }: { rows: TaskView[]; basePath: string }) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-ink-2">No tasks here.</p>;
  }
  return (
    <DensityScope showToggle>
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS}>
          <thead>
            <tr className={THEAD_ROW_CLASS}>
              <th className={`${TH_CLASS} text-left`}>Title</th>
              <th className={`${TH_CLASS} text-left`}>Status</th>
              <th className={`${TH_CLASS} text-left`}>Priority</th>
              <th className={`${TH_CLASS} text-left`}>Assignee</th>
              <th className={`${TH_CLASS} text-left`}>Due</th>
              <th className={`${TH_CLASS} text-left`} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={TR_CLASS}>
                <td className={TD_CLASS}>{r.title}</td>
                <td className={TD_CLASS}><StatusBadge status={r.status} /></td>
                <td className={TD_CLASS}><PriorityBadge priority={r.priority} /></td>
                <td className={TD_CLASS}>{r.assigneeName ?? "—"}</td>
                <td className={TD_CLASS}>
                  {r.dueAt ? (
                    <span className={r.overdue ? "font-semibold text-red" : ""}>
                      {fmtDate(r.dueAt)}{r.overdue ? " (overdue)" : ""}
                    </span>
                  ) : "—"}
                </td>
                <td className={TD_CLASS}>
                  <Link className={subtleButtonClass} href={`${basePath}/tasks/${r.id}`}>
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DensityScope>
  );
}

export async function TaskDetailPage({
  actor,
  id,
  basePath,
}: {
  actor: ActorContext;
  id: string;
  basePath: string;
}) {
  const task = await getTask(actor, id);
  const users = await listStaffUserOptions(actor);
  return (
    <div className="grid gap-5">
      <PageHeader eyebrow="Task" title={task.title} />
      <SectionCard title="Summary">
        <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
          <div><dt className="text-ink-2">Status</dt><dd><StatusBadge status={task.status} /></dd></div>
          <div><dt className="text-ink-2">Priority</dt><dd><PriorityBadge priority={task.priority} /></dd></div>
          <div><dt className="text-ink-2">Assignee</dt><dd className="text-ink">{task.assigneeName ?? "—"}</dd></div>
          <div><dt className="text-ink-2">Created by</dt><dd className="text-ink">{task.creatorName ?? "—"}</dd></div>
          <div>
            <dt className="text-ink-2">Due</dt>
            <dd className={task.overdue ? "font-semibold text-red" : "text-ink"}>
              {fmtDate(task.dueAt)}{task.overdue ? " (overdue)" : ""}
            </dd>
          </div>
          <div><dt className="text-ink-2">Accepted</dt><dd className="text-ink">{fmtDate(task.acceptedAt)}</dd></div>
          <div><dt className="text-ink-2">Submitted</dt><dd className="text-ink">{fmtDate(task.submittedAt)}</dd></div>
          <div><dt className="text-ink-2">Verified</dt><dd className="text-ink">{fmtDate(task.verifiedAt)}</dd></div>
        </dl>
        {task.description ? (
          <p className="mt-3 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">{task.description}</p>
        ) : null}
        {task.reassignmentReason ? (
          <p className="mt-2 text-[13px] text-ink-2">Last reassignment: {task.reassignmentReason}</p>
        ) : null}
      </SectionCard>

      <SectionCard title="Comments">
        {task.comments.length === 0 ? (
          <p className="text-[13px] text-ink-2">No comments yet.</p>
        ) : (
          <ul className="grid gap-3">
            {task.comments.map((c) => (
              <li key={c.id} className="rounded-md border border-border bg-page px-3 py-2">
                <div className="text-[12px] text-ink-2">{c.authorName} · {fmtDate(c.createdAt)}</div>
                <p className="whitespace-pre-wrap text-[13px] text-ink">{c.body}</p>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="Work this task">
        <TaskWorkflowForms taskId={task.id} status={task.status} users={users} />
      </SectionCard>

      <div>
        <Link className={subtleButtonClass} href={`${basePath}/tasks`}>Back to tasks</Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Support tickets
// ---------------------------------------------------------------------------

export async function TicketsInboxPage({
  actor,
  basePath,
}: {
  actor: ActorContext;
  basePath: string;
}) {
  const staff = hasPermission(actor, "support.ticket.manage");
  const [open, all] = await Promise.all([
    listTickets(actor, { openOnly: true, pageSize: 50 }),
    listTickets(actor, { pageSize: 25 }),
  ]);
  return (
    <div className="grid gap-5">
      <PageHeader eyebrow="Support" title={staff ? "Support inbox" : "My support tickets"} />
      <SectionCard title={`Open tickets (${open.meta.total})`}>
        <TicketTable rows={open.items} basePath={basePath} />
      </SectionCard>
      <SectionCard title="All tickets">
        <TicketTable rows={all.items} basePath={basePath} />
      </SectionCard>
      {!staff ? (
        <SectionCard title="Raise a ticket">
          <RaiseTicketForm />
        </SectionCard>
      ) : null}
    </div>
  );
}

function TicketTable({ rows, basePath }: { rows: TicketView[]; basePath: string }) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-ink-2">No tickets here.</p>;
  }
  return (
    <DensityScope showToggle>
      <div className="overflow-x-auto">
        <table className={TABLE_CLASS}>
          <thead>
            <tr className={THEAD_ROW_CLASS}>
              <th className={`${TH_CLASS} text-left`}>Number</th>
              <th className={`${TH_CLASS} text-left`}>Subject</th>
              <th className={`${TH_CLASS} text-left`}>Category</th>
              <th className={`${TH_CLASS} text-left`}>Status</th>
              <th className={`${TH_CLASS} text-left`}>Priority</th>
              <th className={`${TH_CLASS} text-left`}>Raised by</th>
              <th className={`${TH_CLASS} text-left`}>Raised</th>
              <th className={`${TH_CLASS} text-left`} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={TR_CLASS}>
                <td className={TD_ID_CLASS}>{r.ticketNumber}</td>
                <td className={TD_CLASS}>{r.subject}</td>
                <td className={TD_CLASS}>{statusLabel("generic", r.category)}</td>
                <td className={TD_CLASS}><StatusBadge status={r.status} /></td>
                <td className={TD_CLASS}><PriorityBadge priority={r.priority} /></td>
                <td className={TD_CLASS}>{r.raiserName ?? r.contactPhone ?? "—"}</td>
                <td className={TD_CLASS}>{fmtDate(r.createdAt)}</td>
                <td className={TD_CLASS}>
                  <Link className={subtleButtonClass} href={`${basePath}/tickets/${r.id}`}>
                    Open
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DensityScope>
  );
}

export async function TicketDetailPage({
  actor,
  id,
  basePath,
}: {
  actor: ActorContext;
  id: string;
  basePath: string;
}) {
  const ticket = await getTicket(actor, id);
  const staff = hasPermission(actor, "support.ticket.manage");
  const users = staff ? await listStaffUserOptions(actor) : [];
  return (
    <div className="grid gap-5">
      <PageHeader eyebrow={`Ticket ${ticket.ticketNumber}`} title={ticket.subject} />
      <SectionCard title="Summary">
        <dl className="grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4">
          <div><dt className="text-ink-2">Status</dt><dd><StatusBadge status={ticket.status} /></dd></div>
          <div><dt className="text-ink-2">Category</dt><dd className="text-ink">{statusLabel("generic", ticket.category)}</dd></div>
          <div><dt className="text-ink-2">Priority</dt><dd><PriorityBadge priority={ticket.priority} /></dd></div>
          <div><dt className="text-ink-2">Assigned to</dt><dd className="text-ink">{ticket.assigneeName ?? "Unassigned"}</dd></div>
          <div><dt className="text-ink-2">Package</dt><dd className="font-mono text-ink">{ticket.packageTrackingId ?? "—"}</dd></div>
          <div><dt className="text-ink-2">Raised by</dt><dd className="text-ink">{ticket.raiserName ?? ticket.contactPhone ?? "—"}</dd></div>
          <div><dt className="text-ink-2">Raised</dt><dd className="text-ink">{fmtDate(ticket.createdAt)}</dd></div>
          <div><dt className="text-ink-2">Resolved</dt><dd className="text-ink">{fmtDate(ticket.resolvedAt)}</dd></div>
        </dl>
        {ticket.resolutionNote ? (
          <p className="mt-3 rounded-md border border-border bg-page px-3 py-2 text-[13px] text-ink">
            <strong>Resolution:</strong> {ticket.resolutionNote}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title="Conversation">
        <ul className="grid gap-3">
          {ticket.messages.map((m) => (
            <li
              key={m.id}
              className={`rounded-md border px-3 py-2 ${
                m.visibility === "INTERNAL" ? "border-red/40 bg-page" : "border-border bg-page"
              }`}
            >
              <div className="text-[12px] text-ink-2">
                {m.authorName} · {fmtDate(m.createdAt)}
                {m.visibility === "INTERNAL" ? " · INTERNAL (staff only)" : ""}
              </div>
              <p className="whitespace-pre-wrap text-[13px] text-ink">{m.body}</p>
            </li>
          ))}
        </ul>
        <div className="mt-4">
          <TicketReplyForm ticketId={ticket.id} staff={staff} />
        </div>
      </SectionCard>

      {staff ? (
        <SectionCard title="Support actions">
          <TicketStaffForms ticketId={ticket.id} status={ticket.status} users={users} />
        </SectionCard>
      ) : null}

      <div>
        <Link className={subtleButtonClass} href={`${basePath}/tickets`}>Back to tickets</Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export async function NotificationsPage({ actor }: { actor: ActorContext }) {
  if (!hasPermission(actor, "notification.read_own")) {
    return (
      <div className="grid gap-5">
        <PageHeader eyebrow="Account" title="Notifications" />
        <SectionCard title="Inbox">
          <p className="text-[13px] text-ink-2">
            This account receives delivery updates on the tracking page instead of an
            in-app inbox.
          </p>
        </SectionCard>
      </div>
    );
  }
  const [list, preferences] = await Promise.all([
    listMyNotifications(actor, { pageSize: 50 }),
    getMyNotificationPreferences(actor),
  ]);
  const categories = [...new Set(preferences.map((p) => p.category))];
  return (
    <div className="grid gap-5">
      <PageHeader eyebrow="Account" title="Notifications" />
      <SectionCard title={`Inbox (${list.unreadCount} unread)`}>
        <div className="mb-3">
          <MarkAllReadButton />
        </div>
        {list.items.length === 0 ? (
          <p className="text-[13px] text-ink-2">No notifications.</p>
        ) : (
          <ul className="grid gap-2">
            {list.items.map((n) => (
              <li
                key={n.id}
                className={`flex items-start justify-between gap-3 rounded-md border px-3 py-2 ${
                  n.readAt ? "border-border bg-card" : "border-border bg-page"
                }`}
              >
                <div>
                  <div className="text-[13px] font-semibold text-ink">
                    {n.title}
                    {!n.readAt ? <span className="ml-2 text-[11px] font-bold text-red">NEW</span> : null}
                  </div>
                  <p className="text-[13px] text-ink-2">{n.body}</p>
                  <div className="text-[12px] text-ink-2">
                    {n.category} · {fmtDate(n.createdAt)}
                  </div>
                </div>
                {!n.readAt ? <MarkReadButton notificationId={n.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
      <SectionCard title="Channel preferences">
        <p className="mb-3 text-[13px] text-ink-2">
          In-app notifications are always delivered here. Email and SMS take effect when a
          provider is connected; today they are recorded as intent only.
        </p>
        <div className="grid gap-3">
          {categories.map((category) => (
            <div key={category} className="flex flex-wrap items-center gap-4">
              <span className="w-44 text-[13px] font-medium text-ink">{category}</span>
              {preferences
                .filter((p) => p.category === category)
                .map((p) => (
                  <PreferenceToggle
                    key={`${p.category}:${p.channel}`}
                    category={p.category}
                    channel={p.channel}
                    enabled={p.enabled}
                  />
                ))}
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
