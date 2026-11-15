import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import {
  AuthorizationError,
  hasPermission,
  type ActorContext,
} from "@/lib/auth/actor";
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
} from "@/lib/errors";
import {
  TASK_OVERDUE_STATUSES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TERMINAL_STATUSES,
  type TaskStatus,
} from "@/lib/operations/domain";
import {
  auditAccessDenied,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import { auditOps, isUnscoped } from "@/server/services/warehouse-ops-shared";
import { notifyUsersInTx } from "@/server/services/notifications";

/**
 * Task management (spec Part 15; schema doc §10). Tasks organise
 * human work — investigations, follow-ups, operational to-dos —
 * and NEVER substitute for package status updates: moving a task
 * changes no package, shipment or money state.
 *
 * Workflow: DRAFT → ASSIGNED → ACCEPTED → IN_PROGRESS → (BLOCKED)
 * → SUBMITTED → UNDER_REVIEW → VERIFIED → CLOSED, with REJECTED
 * bouncing a submission back to the assignee and CANCELLED as the
 * creator/manager escape hatch. Only the assignee can accept,
 * start, block and submit (completion is assignee-only); only a
 * task.verify holder who is not the assignee can verify.
 */

export interface TaskView {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  createdById: string;
  creatorName: string | null;
  assigneeId: string;
  assigneeName: string | null;
  warehouseId: string | null;
  dueAt: string | null;
  overdue: boolean;
  relatedPackageId: string | null;
  relatedShipmentId: string | null;
  relatedTransferId: string | null;
  relatedIncidentId: string | null;
  relatedTicketId: string | null;
  reassignmentReason: string | null;
  acceptedAt: string | null;
  submittedAt: string | null;
  verifiedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const taskInclude = {
  createdBy: { select: { fullName: true } },
  assignee: { select: { fullName: true } },
} satisfies Prisma.TaskInclude;

type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

function isOverdue(row: { status: string; dueAt: Date | null }): boolean {
  return (
    row.dueAt !== null &&
    row.dueAt.getTime() < Date.now() &&
    (TASK_OVERDUE_STATUSES as readonly string[]).includes(row.status)
  );
}

function toTaskView(row: TaskRow): TaskView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    createdById: row.createdById,
    creatorName: row.createdBy?.fullName ?? null,
    assigneeId: row.assigneeId,
    assigneeName: row.assignee?.fullName ?? null,
    warehouseId: row.warehouseId,
    dueAt: row.dueAt?.toISOString() ?? null,
    overdue: isOverdue(row),
    relatedPackageId: row.relatedPackageId,
    relatedShipmentId: row.relatedShipmentId,
    relatedTransferId: row.relatedTransferId,
    relatedIncidentId: row.relatedIncidentId,
    relatedTicketId: row.relatedTicketId,
    reassignmentReason: row.reassignmentReason,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadTaskOr404(id: string): Promise<TaskRow> {
  const row = await prisma.task.findUnique({ where: { id }, include: taskInclude });
  if (!row) throw new NotFoundError("Task not found");
  return row;
}

/**
 * Roles that make a user an assignable staff member — every catalog
 * role except VENDOR and CUSTOMER (the set the assignee picker,
 * listStaffUserOptions, offers; LINEHAUL_DRIVER is the catalog's
 * line-haul code). Phase 8 review P8-R7: assignees were previously
 * validated only as ACTIVE users, so an internal task could be
 * assigned to a vendor account, which could then read and fully
 * work it despite holding no task permission. Tasks are internal
 * work records; they are never assignable outside staff.
 */
const STAFF_ASSIGNEE_ROLES = new Set([
  "SUPER_ADMIN",
  "ADMIN",
  "WAREHOUSE_ADMIN",
  "WAREHOUSE_STAFF",
  "FINANCE",
  "SUPPORT",
  "RIDER",
  "LINEHAUL_DRIVER",
  "TRANSPORT_DRIVER",
]);

function assertStaffAssigneeUser(
  assignee: {
    status: string;
    roles: { role: { code: string } }[];
  } | null,
): void {
  if (!assignee || assignee.status !== "ACTIVE") {
    throw new DomainValidationError("Assignee must be an active user");
  }
  if (!assignee.roles.some((r) => STAFF_ASSIGNEE_ROLES.has(r.role.code))) {
    throw new DomainValidationError("Tasks can only be assigned to staff users");
  }
}

async function assertStaffAssignee(assigneeId: string): Promise<void> {
  const assignee = await prisma.user.findUnique({
    where: { id: assigneeId },
    select: {
      id: true,
      status: true,
      roles: { select: { role: { select: { code: true } } } },
    },
  });
  assertStaffAssigneeUser(assignee);
}

async function lockTaskRow(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "app"."Task" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Task not found");
}

/** Who can see a task: its creator, its assignee, task.assign
 *  managers (globally, or warehouse-scoped for their warehouses). */
function taskVisibleTo(actor: ActorContext, row: { createdById: string; assigneeId: string; warehouseId: string | null }): boolean {
  if (row.createdById === actor.userId || row.assigneeId === actor.userId) return true;
  if (hasPermission(actor, "task.assign")) {
    if (isUnscoped(actor)) return true;
    if (row.warehouseId && actor.warehouseIds.includes(row.warehouseId)) return true;
  }
  return false;
}

async function assertTaskVisible(actor: ActorContext, row: TaskRow): Promise<void> {
  if (!taskVisibleTo(actor, row)) {
    await auditAccessDenied(actor, "Task", {
      entityId: row.id,
      warehouseId: row.warehouseId,
      reason: "task_out_of_scope",
    });
    throw new AuthorizationError("Task is outside your scope");
  }
}

/**
 * Read/work gate (Phase 8 review P8-R7): visibility alone is not
 * authority over a task. The creator acts in their own right;
 * task.assign managers and task.verify reviewers act in theirs;
 * the assignee works the task via task.update_own. Anyone else —
 * notably a non-staff assignee named on a row from before the
 * staff-assignee validation existed — is denied (audited) even
 * though the row names them, because they hold no task permission
 * at all. Applied by getTask / updateTaskStatus / addTaskComment.
 */
async function assertTaskAccessible(actor: ActorContext, row: TaskRow): Promise<void> {
  await assertTaskVisible(actor, row);
  if (row.createdById === actor.userId) return;
  if (hasPermission(actor, "task.assign") || hasPermission(actor, "task.verify")) return;
  if (row.assigneeId === actor.userId && hasPermission(actor, "task.update_own")) return;
  await auditAccessDenied(actor, "Task", {
    entityId: row.id,
    warehouseId: row.warehouseId,
    reason: "task_missing_permission",
  });
  throw new AuthorizationError("You do not hold a task permission for this task");
}

// ---------------------------------------------------------------------------
// Create / assign
// ---------------------------------------------------------------------------

export const createTaskSchema = z.object({
  title: z.string().min(3).max(200),
  description: z.string().max(4000).optional(),
  assigneeId: z.string().uuid(),
  warehouseId: z.string().uuid().optional(),
  priority: z.enum(TASK_PRIORITIES).default("NORMAL"),
  dueAt: z.coerce.date().optional(),
  publish: z.boolean().default(true),
  relatedPackageId: z.string().uuid().optional(),
  relatedShipmentId: z.string().uuid().optional(),
  relatedTransferId: z.string().uuid().optional(),
  relatedIncidentId: z.string().uuid().optional(),
  relatedTicketId: z.string().uuid().optional(),
});
export type CreateTaskInput = z.input<typeof createTaskSchema>;

export async function createTask(actor: ActorContext, input: CreateTaskInput): Promise<TaskView> {
  const data = parse(createTaskSchema, input);
  await requirePermAudited(actor, "task.create", "Task");

  await assertStaffAssignee(data.assigneeId);
  let warehouseId = data.warehouseId ?? null;
  if (data.relatedPackageId) {
    const pkg = await prisma.package.findUnique({
      where: { id: data.relatedPackageId },
      select: { id: true, currentWarehouseId: true },
    });
    if (!pkg) throw new NotFoundError("Related package not found");
    warehouseId = warehouseId ?? pkg.currentWarehouseId;
  }
  if (data.relatedShipmentId) {
    const exists = await prisma.shipment.findUnique({ where: { id: data.relatedShipmentId }, select: { id: true } });
    if (!exists) throw new NotFoundError("Related shipment not found");
  }
  if (data.relatedTransferId) {
    const exists = await prisma.transfer.findUnique({ where: { id: data.relatedTransferId }, select: { id: true } });
    if (!exists) throw new NotFoundError("Related transfer not found");
  }
  if (data.relatedIncidentId) {
    const exists = await prisma.incident.findUnique({ where: { id: data.relatedIncidentId }, select: { id: true } });
    if (!exists) throw new NotFoundError("Related incident not found");
  }
  if (data.relatedTicketId) {
    const exists = await prisma.supportTicket.findUnique({ where: { id: data.relatedTicketId }, select: { id: true } });
    if (!exists) throw new NotFoundError("Related support ticket not found");
  }
  if (warehouseId && !isUnscoped(actor) && !actor.warehouseIds.includes(warehouseId)) {
    await auditAccessDenied(actor, "Task", { warehouseId, reason: "warehouse_out_of_scope" });
    throw new AuthorizationError("Warehouse is outside your assigned scope");
  }

  const status = data.publish ? "ASSIGNED" : "DRAFT";
  const task = await prisma.$transaction(async (tx) => {
    const created = await tx.task.create({
      data: {
        title: data.title,
        description: data.description ?? null,
        createdById: actor.userId,
        assigneeId: data.assigneeId,
        warehouseId,
        priority: data.priority,
        status,
        dueAt: data.dueAt ?? null,
        relatedPackageId: data.relatedPackageId ?? null,
        relatedShipmentId: data.relatedShipmentId ?? null,
        relatedTransferId: data.relatedTransferId ?? null,
        relatedIncidentId: data.relatedIncidentId ?? null,
        relatedTicketId: data.relatedTicketId ?? null,
      },
      include: taskInclude,
    });
    if (status === "ASSIGNED" && data.assigneeId !== actor.userId) {
      await notifyUsersInTx(tx, [data.assigneeId], {
        category: "TASK_ASSIGNED",
        title: `New task: ${data.title}`,
        body: data.description?.slice(0, 160) ?? "A task has been assigned to you.",
        entityType: "Task",
        entityId: created.id,
        dedupeKey: `task-assigned:${created.id}:${data.assigneeId}`,
      });
    }
    return created;
  });
  const view = toTaskView(task);
  await auditOps(actor, "task.created", "Task", task.id, {
    warehouseId,
    after: { title: data.title, assigneeId: data.assigneeId, status },
  });
  return view;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const listTasksSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  warehouseId: z.string().uuid().optional(),
  queue: z.enum(["mine", "created", "all"]).default("all"),
  overdueOnly: z.coerce.boolean().default(false),
});
export type ListTasksInput = z.input<typeof listTasksSchema>;

export async function listTasks(actor: ActorContext, input: ListTasksInput) {
  const data = parse(listTasksSchema, input);
  await requirePermAudited(actor, "task.update_own", "Task");
  const { skip, take } = pageArgs(data.page, data.pageSize);

  const scope: Prisma.TaskWhereInput[] = [];
  if (data.queue === "mine") {
    scope.push({ assigneeId: actor.userId });
  } else if (data.queue === "created") {
    scope.push({ createdById: actor.userId });
  } else if (hasPermission(actor, "task.assign") && isUnscoped(actor)) {
    // global managers see the whole board
  } else if (hasPermission(actor, "task.assign")) {
    scope.push({
      OR: [
        { assigneeId: actor.userId },
        { createdById: actor.userId },
        { warehouseId: { in: actor.warehouseIds } },
      ],
    });
  } else {
    scope.push({ OR: [{ assigneeId: actor.userId }, { createdById: actor.userId }] });
  }
  const filters: Prisma.TaskWhereInput[] = [...scope];
  if (data.status) filters.push({ status: data.status });
  if (data.priority) filters.push({ priority: data.priority });
  if (data.warehouseId) filters.push({ warehouseId: data.warehouseId });
  if (data.overdueOnly) {
    filters.push({ dueAt: { lt: new Date() }, status: { in: [...TASK_OVERDUE_STATUSES] } });
  }
  const where: Prisma.TaskWhereInput = { AND: filters };
  const [total, rows] = await Promise.all([
    prisma.task.count({ where }),
    prisma.task.findMany({
      where,
      include: taskInclude,
      orderBy: [{ dueAt: "asc" }, { createdAt: "desc" }],
      skip,
      take,
    }),
  ]);
  return { items: rows.map(toTaskView), meta: pageMeta(total, data.page, data.pageSize) };
}

export async function getTask(actor: ActorContext, taskId: string) {
  const row = await loadTaskOr404(taskId);
  await assertTaskAccessible(actor, row);
  const comments = await prisma.taskComment.findMany({
    where: { taskId },
    include: { author: { select: { fullName: true } } },
    orderBy: { createdAt: "asc" },
  });
  return {
    ...toTaskView(row),
    comments: comments.map((c) => ({
      id: c.id,
      body: c.body,
      authorId: c.authorId,
      authorName: c.author.fullName,
      createdAt: c.createdAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

/** Assignee-driven transitions (completion path). */
const ASSIGNEE_TRANSITIONS: Partial<Record<TaskStatus, TaskStatus[]>> = {
  ASSIGNED: ["ACCEPTED"],
  ACCEPTED: ["IN_PROGRESS", "BLOCKED"],
  IN_PROGRESS: ["BLOCKED", "SUBMITTED"],
  BLOCKED: ["IN_PROGRESS", "SUBMITTED"],
  REJECTED: ["IN_PROGRESS"],
  DRAFT: [],
};

export const updateTaskStatusSchema = z.object({
  status: z.enum(["ACCEPTED", "IN_PROGRESS", "BLOCKED", "SUBMITTED", "UNDER_REVIEW", "VERIFIED", "REJECTED", "CLOSED"]),
  note: z.string().max(2000).optional(),
});
export type UpdateTaskStatusInput = z.input<typeof updateTaskStatusSchema>;

export async function updateTaskStatus(
  actor: ActorContext,
  taskId: string,
  input: UpdateTaskStatusInput,
): Promise<TaskView> {
  const data = parse(updateTaskStatusSchema, input);
  const row = await loadTaskOr404(taskId);
  await assertTaskAccessible(actor, row);
  const target = data.status as TaskStatus;

  await prisma.$transaction(async (tx) => {
    await lockTaskRow(tx, taskId);
    const fresh = await tx.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { status: true, assigneeId: true, createdById: true },
    });
    const from = fresh.status as TaskStatus;
    const patch: Prisma.TaskUpdateInput = { status: target };

    if ((ASSIGNEE_TRANSITIONS[from] ?? []).includes(target)) {
      // Working transitions are the assignee's alone — not even the
      // creator can submit (complete) someone else's task.
      if (fresh.assigneeId !== actor.userId) {
        await auditAccessDenied(actor, "Task", {
          entityId: taskId,
          reason: "task_transition_not_assignee",
        });
        throw new AuthorizationError("Only the assignee can work this task");
      }
      if (target === "ACCEPTED") patch.acceptedAt = new Date();
      if (target === "SUBMITTED") patch.submittedAt = new Date();
    } else if (target === "UNDER_REVIEW" && from === "SUBMITTED") {
      await requirePermAudited(actor, "task.verify", "Task");
    } else if ((target === "VERIFIED" || target === "REJECTED") && (from === "SUBMITTED" || from === "UNDER_REVIEW")) {
      await requirePermAudited(actor, "task.verify", "Task");
      if (fresh.assigneeId === actor.userId) {
        throw new DomainValidationError("The assignee cannot verify their own task");
      }
      if (target === "VERIFIED") patch.verifiedAt = new Date();
      if (target === "REJECTED") patch.submittedAt = null;
    } else if (target === "CLOSED" && from === "VERIFIED") {
      if (fresh.createdById !== actor.userId) {
        await requirePermAudited(actor, "task.assign", "Task");
      }
      patch.closedAt = new Date();
    } else {
      throw new ConflictError(`Task is ${from} — cannot move to ${target}`);
    }
    await tx.task.update({ where: { id: taskId }, data: patch });
    if (data.note) {
      await tx.taskComment.create({
        data: { taskId, authorId: actor.userId, body: data.note },
      });
    }
  });
  const view = toTaskView(await loadTaskOr404(taskId));
  await auditOps(actor, "task.status_changed", "Task", taskId, {
    warehouseId: row.warehouseId,
    after: { status: view.status },
  });
  return view;
}

export const reassignTaskSchema = z.object({
  assigneeId: z.string().uuid(),
  reason: z.string().min(3).max(500),
});
export type ReassignTaskInput = z.input<typeof reassignTaskSchema>;

export async function reassignTask(
  actor: ActorContext,
  taskId: string,
  input: ReassignTaskInput,
): Promise<TaskView> {
  const data = parse(reassignTaskSchema, input);
  await requirePermAudited(actor, "task.assign", "Task");
  const row = await loadTaskOr404(taskId);
  await assertTaskVisible(actor, row);
  await assertStaffAssignee(data.assigneeId);
  await prisma.$transaction(async (tx) => {
    await lockTaskRow(tx, taskId);
    const fresh = await tx.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { status: true },
    });
    if ((TASK_TERMINAL_STATUSES as readonly string[]).includes(fresh.status)) {
      throw new ConflictError(`Task is ${fresh.status} — it cannot be reassigned`);
    }
    await tx.task.update({
      where: { id: taskId },
      data: {
        assigneeId: data.assigneeId,
        status: "ASSIGNED",
        acceptedAt: null,
        submittedAt: null,
        reassignmentReason: data.reason,
      },
    });
    await tx.taskComment.create({
      data: {
        taskId,
        authorId: actor.userId,
        body: `Reassigned: ${data.reason}`,
      },
    });
    if (data.assigneeId !== actor.userId) {
      await notifyUsersInTx(tx, [data.assigneeId], {
        category: "TASK_ASSIGNED",
        title: `Task reassigned to you: ${row.title}`,
        body: data.reason,
        entityType: "Task",
        entityId: taskId,
        dedupeKey: `task-assigned:${taskId}:${data.assigneeId}:${Date.now()}`,
      });
    }
  });
  const view = toTaskView(await loadTaskOr404(taskId));
  await auditOps(actor, "task.reassigned", "Task", taskId, {
    warehouseId: row.warehouseId,
    after: { assigneeId: data.assigneeId, reason: data.reason },
  });
  return view;
}

export const cancelTaskSchema = z.object({
  reason: z.string().min(3).max(500),
});
export type CancelTaskInput = z.input<typeof cancelTaskSchema>;

export async function cancelTask(
  actor: ActorContext,
  taskId: string,
  input: CancelTaskInput,
): Promise<TaskView> {
  const data = parse(cancelTaskSchema, input);
  const row = await loadTaskOr404(taskId);
  await assertTaskVisible(actor, row);
  if (row.createdById !== actor.userId) {
    await requirePermAudited(actor, "task.assign", "Task");
  }
  await prisma.$transaction(async (tx) => {
    await lockTaskRow(tx, taskId);
    const fresh = await tx.task.findUniqueOrThrow({
      where: { id: taskId },
      select: { status: true },
    });
    if ((TASK_TERMINAL_STATUSES as readonly string[]).includes(fresh.status)) {
      throw new ConflictError(`Task is already ${fresh.status}`);
    }
    await tx.task.update({
      where: { id: taskId },
      data: { status: "CANCELLED", closedAt: new Date() },
    });
    await tx.taskComment.create({
      data: { taskId, authorId: actor.userId, body: `Cancelled: ${data.reason}` },
    });
  });
  const view = toTaskView(await loadTaskOr404(taskId));
  await auditOps(actor, "task.cancelled", "Task", taskId, {
    warehouseId: row.warehouseId,
    after: { reason: data.reason },
  });
  return view;
}

export const addTaskCommentSchema = z.object({
  body: z.string().min(1).max(4000),
});
export type AddTaskCommentInput = z.input<typeof addTaskCommentSchema>;

export async function addTaskComment(actor: ActorContext, taskId: string, input: AddTaskCommentInput) {
  const data = parse(addTaskCommentSchema, input);
  const row = await loadTaskOr404(taskId);
  await assertTaskAccessible(actor, row);
  await prisma.taskComment.create({
    data: { taskId, authorId: actor.userId, body: data.body },
  });
  return getTask(actor, taskId);
}

/** Create + publish in one call from another workflow (support
 *  escalation): the ticket service composes this with its own
 *  transaction-free pre-checks, then links the task to the ticket. */
export async function createTaskInTx(
  tx: Prisma.TransactionClient,
  input: {
    title: string;
    description?: string | null;
    createdById: string;
    assigneeId: string;
    warehouseId?: string | null;
    priority?: string;
    dueAt?: Date | null;
    relatedTicketId?: string | null;
    relatedIncidentId?: string | null;
    relatedPackageId?: string | null;
  },
): Promise<{ id: string }> {
  // P8-R7: the staff-assignee rule applies on this path too (ticket
  // escalation composes it) — validated against the caller's
  // transaction so a bad assignee aborts the whole escalation.
  const assignee = await tx.user.findUnique({
    where: { id: input.assigneeId },
    select: {
      id: true,
      status: true,
      roles: { select: { role: { select: { code: true } } } },
    },
  });
  assertStaffAssigneeUser(assignee);
  const created = await tx.task.create({
    data: {
      title: input.title,
      description: input.description ?? null,
      createdById: input.createdById,
      assigneeId: input.assigneeId,
      warehouseId: input.warehouseId ?? null,
      priority: input.priority ?? "NORMAL",
      status: "ASSIGNED",
      dueAt: input.dueAt ?? null,
      relatedTicketId: input.relatedTicketId ?? null,
      relatedIncidentId: input.relatedIncidentId ?? null,
      relatedPackageId: input.relatedPackageId ?? null,
    },
    select: { id: true },
  });
  if (input.assigneeId !== input.createdById) {
    await notifyUsersInTx(tx, [input.assigneeId], {
      category: "TASK_ASSIGNED",
      title: `New task: ${input.title}`,
      body: input.description?.slice(0, 160) ?? "A task has been assigned to you.",
      entityType: "Task",
      entityId: created.id,
      dedupeKey: `task-assigned:${created.id}:${input.assigneeId}`,
    });
  }
  return created;
}

// ---------------------------------------------------------------------------
// Picker support
// ---------------------------------------------------------------------------

export interface StaffUserOption {
  id: string;
  fullName: string;
  email: string;
  roles: string[];
}

/**
 * Active staff users an actor may pick as an assignee. Global
 * managers see everyone staff-side; warehouse-scoped managers see
 * their warehouses' members plus global staff. The services still
 * re-validate every assignee server-side — this only shapes the
 * picker.
 */
export async function listStaffUserOptions(actor: ActorContext): Promise<StaffUserOption[]> {
  if (
    !hasPermission(actor, "task.create") &&
    !hasPermission(actor, "incident.manage") &&
    !hasPermission(actor, "support.ticket.manage")
  ) {
    return [];
  }
  const users = await prisma.user.findMany({
    where: { status: "ACTIVE" },
    select: {
      id: true,
      fullName: true,
      email: true,
      roles: { select: { role: { select: { code: true } } } },
      memberships: { where: { revokedAt: null }, select: { warehouseId: true } },
    },
    orderBy: { fullName: "asc" },
    take: 300,
  });
  const staffRoles = new Set([
    "SUPER_ADMIN", "ADMIN", "WAREHOUSE_ADMIN", "WAREHOUSE_STAFF",
    "FINANCE", "SUPPORT", "RIDER", "TRANSPORT_DRIVER",
  ]);
  return users
    .map((u) => ({
      id: u.id,
      fullName: u.fullName,
      email: u.email,
      roles: u.roles.map((r) => r.role.code),
      warehouseIds: u.memberships.map((m) => m.warehouseId),
    }))
    .filter((u) => u.roles.some((r) => staffRoles.has(r)))
    .filter(
      (u) =>
        isUnscoped(actor) ||
        u.id === actor.userId ||
        u.warehouseIds.some((w) => actor.warehouseIds.includes(w)) ||
        u.roles.some((r) => ["SUPER_ADMIN", "ADMIN", "FINANCE", "SUPPORT"].includes(r)),
    )
    .map(({ id, fullName, email, roles }) => ({ id, fullName, email, roles }));
}
