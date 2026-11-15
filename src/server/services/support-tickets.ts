import "server-only";

import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { normalizePhone } from "@/lib/bookings/phone";

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
  TICKET_CATEGORIES,
  TICKET_OPEN_STATUSES,
  TICKET_STATUSES,
} from "@/lib/operations/domain";
import {
  auditAccessDenied,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";
import { auditOps } from "@/server/services/warehouse-ops-shared";
import {
  notifyUsersInTx,
  userIdsWithRoles,
  vendorUserIds,
} from "@/server/services/notifications";
import { createTaskInTx } from "@/server/services/tasks";

/**
 * Support tickets (spec Part 4.10; api-reference §support).
 *
 * Raised by customers and vendors about THEIR OWN orders/packages
 * (ownership resolved server-side from the actor, never from the
 * request body), by support staff on a customer's behalf, or from
 * the public phone-verified tracking complaint. Support staff
 * (support.ticket.manage) reply, assign, resolve and escalate;
 * INTERNAL messages are staff case notes and are NEVER returned to
 * the raiser's view. Support can request operational follow-ups
 * (redelivery, address correction — recorded as ticket requests the
 * warehouse acts on through its own services) and escalate a ticket
 * into an investigation task, but a ticket never moves custody or
 * money itself.
 */

export interface TicketView {
  id: string;
  ticketNumber: string;
  category: string;
  status: string;
  priority: string;
  subject: string;
  description: string;
  raisedById: string | null;
  raiserName: string | null;
  vendorId: string | null;
  customerId: string | null;
  packageId: string | null;
  packageTrackingId: string | null;
  orderId: string | null;
  contactPhone: string | null;
  assignedToId: string | null;
  assigneeName: string | null;
  resolutionNote: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const ticketInclude = {
  raisedBy: { select: { fullName: true } },
  assignedTo: { select: { fullName: true } },
  package: { select: { trackingId: true } },
} satisfies Prisma.SupportTicketInclude;

type TicketRow = Prisma.SupportTicketGetPayload<{ include: typeof ticketInclude }>;

function toTicketView(row: TicketRow): TicketView {
  return {
    id: row.id,
    ticketNumber: row.ticketNumber,
    category: row.category,
    status: row.status,
    priority: row.priority,
    subject: row.subject,
    description: row.description,
    raisedById: row.raisedById,
    raiserName: row.raisedBy?.fullName ?? null,
    vendorId: row.vendorId,
    customerId: row.customerId,
    packageId: row.packageId,
    packageTrackingId: row.package?.trackingId ?? null,
    orderId: row.orderId,
    contactPhone: row.contactPhone,
    assignedToId: row.assignedToId,
    assigneeName: row.assignedTo?.fullName ?? null,
    resolutionNote: row.resolutionNote,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadTicketOr404(id: string): Promise<TicketRow> {
  const row = await prisma.supportTicket.findUnique({ where: { id }, include: ticketInclude });
  if (!row) throw new NotFoundError("Support ticket not found");
  return row;
}

async function lockTicketRow(tx: Prisma.TransactionClient, id: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "app"."SupportTicket" WHERE "id" = ${id} FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError("Support ticket not found");
}

/** The raiser side of a ticket: its owner (vendor org / customer)
 *  or the staff managing it. Everyone else is denied + audited. */
function isTicketRaiserSide(actor: ActorContext, row: TicketRow): boolean {
  if (row.raisedById === actor.userId) return true;
  if (actor.vendorId && row.vendorId === actor.vendorId) return true;
  if (actor.customerId && row.customerId === actor.customerId) return true;
  return false;
}

async function assertTicketReadable(actor: ActorContext, row: TicketRow): Promise<void> {
  if (isTicketRaiserSide(actor, row)) return;
  if (hasPermission(actor, "support.ticket.manage")) return;
  await auditAccessDenied(actor, "SupportTicket", {
    entityId: row.id,
    reason: "ticket_not_owned",
  });
  throw new AuthorizationError("This ticket belongs to another customer/vendor");
}

async function assertTicketManageable(actor: ActorContext): Promise<void> {
  await requirePermAudited(actor, "support.ticket.manage", "SupportTicket");
}

// ---------------------------------------------------------------------------
// Raising
// ---------------------------------------------------------------------------

export const raiseTicketSchema = z.object({
  category: z.enum(TICKET_CATEGORIES),
  subject: z.string().min(3).max(200),
  description: z.string().min(5).max(4000),
  packageId: z.string().uuid().optional(),
  orderId: z.string().uuid().optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).default("NORMAL"),
  contactPhone: z.string().max(30).optional(),
  /** Staff raising on behalf of a customer (by customer record). */
  onBehalfCustomerId: z.string().uuid().optional(),
});
export type RaiseTicketInput = z.input<typeof raiseTicketSchema>;

interface RaiseTicketCore {
  category: string;
  subject: string;
  description: string;
  priority: string;
  contactPhone?: string | null;
  packageId?: string | null;
  orderId?: string | null;
  vendorId?: string | null;
  customerId?: string | null;
  /** Null for phone-verified public complaints without an account. */
  raisedById: string | null;
}

export async function raiseTicketInTx(
  tx: Prisma.TransactionClient,
  core: RaiseTicketCore,
): Promise<{ id: string; ticketNumber: string }> {
  const seq = await tx.$queryRaw<{ nextval: bigint }[]>`
    SELECT nextval('"app"."ticket_number_seq"') AS nextval`;
  const ticketNumber = `TKT-${seq[0].nextval.toString()}`;
  const ticket = await tx.supportTicket.create({
    data: {
      ticketNumber,
      category: core.category,
      status: "OPEN",
      priority: core.priority,
      subject: core.subject,
      description: core.description,
      raisedById: core.raisedById,
      vendorId: core.vendorId ?? null,
      customerId: core.customerId ?? null,
      packageId: core.packageId ?? null,
      orderId: core.orderId ?? null,
      contactPhone: core.contactPhone ?? null,
    },
    select: { id: true, ticketNumber: true },
  });
  if (core.raisedById) {
    await tx.supportTicketMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: core.raisedById,
        body: core.description,
        visibility: "PUBLIC",
      },
    });
  }
  // Support queue is notified in the same transaction.
  const supportUsers = await userIdsWithRoles(tx, ["SUPPORT", "ADMIN", "SUPER_ADMIN"]);
  await notifyUsersInTx(
    tx,
    supportUsers.filter((id) => id !== core.raisedById),
    {
      category: "TICKET_RAISED",
      title: `Support ticket ${ticketNumber} raised`,
      body: `${core.category} — ${core.subject}`,
      entityType: "SupportTicket",
      entityId: ticket.id,
      dedupeKey: `ticket-raised:${ticket.id}`,
    },
  );
  return ticket;
}

export async function raiseTicket(actor: ActorContext, input: RaiseTicketInput): Promise<TicketView> {
  const data = parse(raiseTicketSchema, input);
  const staffRaising = hasPermission(actor, "support.ticket.manage");

  let vendorId: string | null = null;
  let customerId: string | null = null;
  if (actor.vendorId) {
    vendorId = actor.vendorId;
  } else if (actor.customerId) {
    customerId = actor.customerId;
  } else if (staffRaising && data.onBehalfCustomerId) {
    const customer = await prisma.customer.findUnique({
      where: { id: data.onBehalfCustomerId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundError("Customer not found");
    customerId = customer.id;
  } else if (!staffRaising) {
    await auditAccessDenied(actor, "SupportTicket", { reason: "ticket_raise_not_customer_or_vendor" });
    throw new AuthorizationError("Only customers, vendors and support staff can raise tickets");
  }

  // Ownership of linked records is enforced against the raiser.
  if (data.packageId) {
    const pkg = await prisma.package.findUnique({
      where: { id: data.packageId },
      select: { id: true, recipientCustomerId: true, order: { select: { vendorId: true, customerId: true } } },
    });
    if (!pkg) throw new NotFoundError("Linked package not found");
    if (vendorId && pkg.order.vendorId !== vendorId) {
      await auditAccessDenied(actor, "SupportTicket", { reason: "package_not_own_vendor" });
      throw new AuthorizationError("Vendors can only raise tickets about their own packages");
    }
    if (customerId && pkg.recipientCustomerId !== customerId && pkg.order.customerId !== customerId) {
      await auditAccessDenied(actor, "SupportTicket", { reason: "package_not_own_customer" });
      throw new AuthorizationError("Customers can only raise tickets about their own packages");
    }
  }
  if (data.orderId) {
    const order = await prisma.order.findUnique({
      where: { id: data.orderId },
      select: { id: true, vendorId: true, customerId: true },
    });
    if (!order) throw new NotFoundError("Linked order not found");
    if (vendorId && order.vendorId !== vendorId) {
      await auditAccessDenied(actor, "SupportTicket", { reason: "order_not_own_vendor" });
      throw new AuthorizationError("Vendors can only raise tickets about their own orders");
    }
    if (customerId && order.customerId !== customerId) {
      await auditAccessDenied(actor, "SupportTicket", { reason: "order_not_own_customer" });
      throw new AuthorizationError("Customers can only raise tickets about their own orders");
    }
  }

  const ticket = await prisma.$transaction((tx) =>
    raiseTicketInTx(tx, {
      category: data.category,
      subject: data.subject,
      description: data.description,
      priority: data.priority,
      contactPhone: data.contactPhone ?? null,
      packageId: data.packageId ?? null,
      orderId: data.orderId ?? null,
      vendorId,
      customerId,
      raisedById: actor.userId,
    }),
  );
  const view = toTicketView(await loadTicketOr404(ticket.id));
  await auditOps(actor, "support.ticket_raised", "SupportTicket", ticket.id, {
    after: { ticketNumber: view.ticketNumber, category: data.category },
  });
  return view;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const listTicketsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(TICKET_STATUSES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  openOnly: z.coerce.boolean().default(false),
  assignedToMe: z.coerce.boolean().default(false),
});
export type ListTicketsInput = z.input<typeof listTicketsSchema>;

export async function listTickets(actor: ActorContext, input: ListTicketsInput) {
  const data = parse(listTicketsSchema, input);
  const { skip, take } = pageArgs(data.page, data.pageSize);

  const scope: Prisma.SupportTicketWhereInput[] = [];
  if (hasPermission(actor, "support.ticket.manage")) {
    // staff inbox: everything
  } else if (actor.vendorId) {
    scope.push({ vendorId: actor.vendorId });
  } else if (actor.customerId) {
    scope.push({ customerId: actor.customerId });
  } else {
    scope.push({ raisedById: actor.userId });
  }
  const filters: Prisma.SupportTicketWhereInput[] = [...scope];
  if (data.status) filters.push({ status: data.status });
  if (data.category) filters.push({ category: data.category });
  if (data.openOnly) filters.push({ status: { in: [...TICKET_OPEN_STATUSES] } });
  if (data.assignedToMe) filters.push({ assignedToId: actor.userId });
  const where: Prisma.SupportTicketWhereInput = { AND: filters };
  const [total, rows] = await Promise.all([
    prisma.supportTicket.count({ where }),
    prisma.supportTicket.findMany({
      where,
      include: ticketInclude,
      orderBy: [{ createdAt: "desc" }],
      skip,
      take,
    }),
  ]);
  return { items: rows.map(toTicketView), meta: pageMeta(total, data.page, data.pageSize) };
}

export async function getTicket(actor: ActorContext, ticketId: string) {
  const row = await loadTicketOr404(ticketId);
  await assertTicketReadable(actor, row);
  const staffView = hasPermission(actor, "support.ticket.manage");
  const messages = await prisma.supportTicketMessage.findMany({
    where: {
      ticketId,
      // INTERNAL notes are staff-only — the filter is in the query,
      // not applied after the fact.
      ...(staffView ? {} : { visibility: "PUBLIC" }),
    },
    include: { author: { select: { fullName: true } } },
    orderBy: { createdAt: "asc" },
  });
  return {
    ...toTicketView(row),
    messages: messages.map((m) => ({
      id: m.id,
      body: m.body,
      visibility: m.visibility,
      authorId: m.authorId,
      authorName: m.author.fullName,
      mine: m.authorId === actor.userId,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Conversation + staff workflow
// ---------------------------------------------------------------------------

export const replyTicketSchema = z.object({
  body: z.string().min(1).max(4000),
  /** Staff-only: record an internal case note instead of a reply. */
  internal: z.boolean().default(false),
});
export type ReplyTicketInput = z.input<typeof replyTicketSchema>;

export async function replyToTicket(actor: ActorContext, ticketId: string, input: ReplyTicketInput) {
  const data = parse(replyTicketSchema, input);
  const row = await loadTicketOr404(ticketId);
  await assertTicketReadable(actor, row);
  const staff = hasPermission(actor, "support.ticket.manage");
  if (data.internal && !staff) {
    await auditAccessDenied(actor, "SupportTicket", {
      entityId: ticketId,
      reason: "internal_note_not_staff",
    });
    throw new AuthorizationError("Only support staff can write internal notes");
  }
  if (row.status === "RESOLVED" || row.status === "CLOSED") {
    throw new ConflictError(`Ticket ${row.ticketNumber} is ${row.status} — it cannot take new messages`);
  }
  await prisma.$transaction(async (tx) => {
    await lockTicketRow(tx, ticketId);
    await tx.supportTicketMessage.create({
      data: {
        ticketId,
        authorId: actor.userId,
        body: data.body,
        visibility: data.internal ? "INTERNAL" : "PUBLIC",
      },
    });
    if (!data.internal) {
      // Status nudges: a staff reply moves OPEN → IN_PROGRESS; a
      // raiser reply reopens AWAITING_CUSTOMER threads.
      if (staff && row.status === "OPEN") {
        await tx.supportTicket.update({ where: { id: ticketId }, data: { status: "IN_PROGRESS" } });
      }
      if (!staff && row.status === "AWAITING_CUSTOMER") {
        await tx.supportTicket.update({ where: { id: ticketId }, data: { status: "IN_PROGRESS" } });
      }
      // Notify the other side (same transaction).
      if (staff) {
        const recipients = new Set<string>();
        if (row.raisedById) recipients.add(row.raisedById);
        if (row.vendorId) {
          for (const id of await vendorUserIds(tx, row.vendorId)) recipients.add(id);
        }
        const customerUser = row.customerId
          ? await tx.customer.findUnique({ where: { id: row.customerId }, select: { userId: true } })
          : null;
        if (customerUser?.userId) recipients.add(customerUser.userId);
        recipients.delete(actor.userId);
        await notifyUsersInTx(tx, recipients, {
          category: "TICKET_REPLIED",
          title: `Support replied on ticket ${row.ticketNumber}`,
          body: data.body.slice(0, 160),
          entityType: "SupportTicket",
          entityId: ticketId,
          dedupeKey: `ticket-replied:${ticketId}:${Date.now()}`,
        });
      } else {
        const recipients = new Set<string>(await userIdsWithRoles(tx, ["SUPPORT"]));
        if (row.assignedToId) recipients.add(row.assignedToId);
        recipients.delete(actor.userId);
        await notifyUsersInTx(tx, recipients, {
          category: "TICKET_REPLIED",
          title: `Customer replied on ticket ${row.ticketNumber}`,
          body: data.body.slice(0, 160),
          entityType: "SupportTicket",
          entityId: ticketId,
          dedupeKey: `ticket-replied:${ticketId}:${Date.now()}`,
        });
      }
    }
  });
  await auditOps(actor, "support.ticket_replied", "SupportTicket", ticketId, {
    after: { internal: data.internal },
  });
  return getTicket(actor, ticketId);
}

export const assignTicketSchema = z.object({
  assigneeId: z.string().uuid(),
});
export type AssignTicketInput = z.input<typeof assignTicketSchema>;

export async function assignTicket(actor: ActorContext, ticketId: string, input: AssignTicketInput) {
  const data = parse(assignTicketSchema, input);
  const row = await loadTicketOr404(ticketId);
  await assertTicketManageable(actor);
  const assignee = await prisma.user.findUnique({
    where: { id: data.assigneeId },
    select: {
      id: true,
      status: true,
      roles: { select: { role: { select: { code: true } } } },
    },
  });
  if (!assignee || assignee.status !== "ACTIVE") {
    throw new DomainValidationError("Assignee must be an active user");
  }
  const staffRoles = ["SUPPORT", "ADMIN", "SUPER_ADMIN"];
  if (!assignee.roles.some((r) => staffRoles.includes(r.role.code))) {
    throw new DomainValidationError("Tickets can only be assigned to support staff");
  }
  await prisma.supportTicket.update({
    where: { id: ticketId },
    data: {
      assignedToId: data.assigneeId,
      status: row.status === "OPEN" ? "IN_PROGRESS" : row.status,
    },
  });
  await auditOps(actor, "support.ticket_assigned", "SupportTicket", ticketId, {
    after: { assigneeId: data.assigneeId },
  });
  return toTicketView(await loadTicketOr404(ticketId));
}

export const resolveTicketSchema = z.object({
  resolutionNote: z.string().min(3).max(2000),
});
export type ResolveTicketInput = z.input<typeof resolveTicketSchema>;

export async function resolveTicket(actor: ActorContext, ticketId: string, input: ResolveTicketInput) {
  const data = parse(resolveTicketSchema, input);
  const row = await loadTicketOr404(ticketId);
  await assertTicketManageable(actor);
  if (row.status === "RESOLVED" || row.status === "CLOSED") {
    throw new ConflictError(`Ticket ${row.ticketNumber} is already ${row.status}`);
  }
  await prisma.$transaction(async (tx) => {
    await lockTicketRow(tx, ticketId);
    await tx.supportTicket.update({
      where: { id: ticketId },
      data: {
        status: "RESOLVED",
        resolutionNote: data.resolutionNote,
        resolvedById: actor.userId,
        resolvedAt: new Date(),
      },
    });
    await tx.supportTicketMessage.create({
      data: {
        ticketId,
        authorId: actor.userId,
        body: `Resolved: ${data.resolutionNote}`,
        visibility: "PUBLIC",
      },
    });
    const recipients = new Set<string>();
    if (row.raisedById) recipients.add(row.raisedById);
    if (row.vendorId) {
      for (const id of await vendorUserIds(tx, row.vendorId)) recipients.add(id);
    }
    const customerUser = row.customerId
      ? await tx.customer.findUnique({ where: { id: row.customerId }, select: { userId: true } })
      : null;
    if (customerUser?.userId) recipients.add(customerUser.userId);
    recipients.delete(actor.userId);
    await notifyUsersInTx(tx, recipients, {
      category: "TICKET_RESOLVED",
      title: `Ticket ${row.ticketNumber} resolved`,
      body: data.resolutionNote.slice(0, 160),
      entityType: "SupportTicket",
      entityId: ticketId,
      dedupeKey: `ticket-resolved:${ticketId}`,
    });
  });
  await auditOps(actor, "support.ticket_resolved", "SupportTicket", ticketId, {});
  return toTicketView(await loadTicketOr404(ticketId));
}

export async function closeTicket(actor: ActorContext, ticketId: string) {
  const row = await loadTicketOr404(ticketId);
  // The raiser can close their own resolved ticket; staff can close
  // any resolved ticket (verified closure, Part 4.10).
  if (!isTicketRaiserSide(actor, row)) {
    await assertTicketManageable(actor);
  }
  if (row.status !== "RESOLVED") {
    throw new ConflictError(`Ticket ${row.ticketNumber} is ${row.status} — only RESOLVED tickets close`);
  }
  await prisma.supportTicket.update({
    where: { id: ticketId },
    data: { status: "CLOSED", closedAt: new Date() },
  });
  await auditOps(actor, "support.ticket_closed", "SupportTicket", ticketId, {});
  return toTicketView(await loadTicketOr404(ticketId));
}

// ---------------------------------------------------------------------------
// Operational follow-ups (Part 4.10): support requests — the
// warehouse still performs the work through its own services.
// ---------------------------------------------------------------------------

export const followUpSchema = z.object({
  note: z.string().min(3).max(1000),
});
export type FollowUpInput = z.input<typeof followUpSchema>;

async function requestFollowUp(
  actor: ActorContext,
  ticketId: string,
  input: FollowUpInput,
  kind: "REDELIVERY" | "ADDRESS_CORRECTION",
) {
  const data = parse(followUpSchema, input);
  const row = await loadTicketOr404(ticketId);
  await assertTicketManageable(actor);
  if (!row.packageId) {
    throw new DomainValidationError("This ticket is not linked to a package");
  }
  await prisma.$transaction(async (tx) => {
    await lockTicketRow(tx, ticketId);
    await tx.supportTicketMessage.create({
      data: {
        ticketId,
        authorId: actor.userId,
        body:
          kind === "REDELIVERY"
            ? `Redelivery requested: ${data.note}`
            : `Address correction requested: ${data.note}`,
        visibility: "PUBLIC",
      },
    });
    await tx.supportTicket.update({
      where: { id: ticketId },
      data: {
        category: kind === "REDELIVERY" ? "REDELIVERY_REQUEST" : "ADDRESS_CORRECTION",
        status: "IN_PROGRESS",
      },
    });
  });
  await auditOps(
    actor,
    kind === "REDELIVERY" ? "support.ticket_redelivery_requested" : "support.ticket_address_correction_requested",
    "SupportTicket",
    ticketId,
    { after: { note: data.note } },
  );
  return getTicket(actor, ticketId);
}

export async function requestRedelivery(actor: ActorContext, ticketId: string, input: FollowUpInput) {
  return requestFollowUp(actor, ticketId, input, "REDELIVERY");
}

export async function requestAddressCorrection(actor: ActorContext, ticketId: string, input: FollowUpInput) {
  return requestFollowUp(actor, ticketId, input, "ADDRESS_CORRECTION");
}

export const escalateTicketSchema = z.object({
  assigneeId: z.string().uuid(),
  note: z.string().min(3).max(1000),
});
export type EscalateTicketInput = z.input<typeof escalateTicketSchema>;

/** Escalate a ticket into an investigation TASK (Part 4.10:
 *  "escalation to investigation tasks"). The ticket stays the
 *  customer-facing record; the task carries the internal work. */
export async function escalateTicketToTask(
  actor: ActorContext,
  ticketId: string,
  input: EscalateTicketInput,
) {
  const data = parse(escalateTicketSchema, input);
  const row = await loadTicketOr404(ticketId);
  await assertTicketManageable(actor);
  if (row.status === "RESOLVED" || row.status === "CLOSED") {
    throw new ConflictError(`Ticket ${row.ticketNumber} is ${row.status} — it cannot be escalated`);
  }
  const assignee = await prisma.user.findUnique({
    where: { id: data.assigneeId },
    select: { id: true, status: true },
  });
  if (!assignee || assignee.status !== "ACTIVE") {
    throw new DomainValidationError("Task assignee must be an active user");
  }
  const task = await prisma.$transaction(async (tx) => {
    await lockTicketRow(tx, ticketId);
    const created = await createTaskInTx(tx, {
      title: `Investigate ticket ${row.ticketNumber}: ${row.subject}`,
      description: data.note,
      createdById: actor.userId,
      assigneeId: data.assigneeId,
      priority: row.priority,
      relatedTicketId: ticketId,
      relatedPackageId: row.packageId,
    });
    await tx.supportTicket.update({
      where: { id: ticketId },
      data: { status: "ESCALATED" },
    });
    await tx.supportTicketMessage.create({
      data: {
        ticketId,
        authorId: actor.userId,
        body: `Escalated to an investigation task: ${data.note}`,
        visibility: "INTERNAL",
      },
    });
    return created;
  });
  await auditOps(actor, "support.ticket_escalated", "SupportTicket", ticketId, {
    after: { taskId: task.id, assigneeId: data.assigneeId },
  });
  return { ticket: toTicketView(await loadTicketOr404(ticketId)), taskId: task.id };
}

// ---------------------------------------------------------------------------
// Public tracking complaint (api-reference: POST
// /api/public/track/[trackingId]/complaint). The complainant proves
// the recipient phone number — the same second factor as the
// detailed tracking view — and every failure mode throws the same
// NotFoundError so responses stay indistinguishable. The ticket is
// owned by the recipient customer record; the raiser user is linked
// when the customer holds an account.
// ---------------------------------------------------------------------------

export const trackingComplaintSchema = z.object({
  phone: z.string().min(5).max(30),
  category: z.enum(["NON_RECEIPT", "DAMAGE", "GENERAL"]).default("GENERAL"),
  subject: z.string().min(3).max(200),
  description: z.string().min(5).max(4000),
});
export type TrackingComplaintInput = z.input<typeof trackingComplaintSchema>;

const TRACKING_COMPLAINT_DENIAL =
  "Tracking details are not available for this tracking code and phone number";

export async function raiseTrackingComplaint(
  trackingId: string,
  input: TrackingComplaintInput,
): Promise<{ ticketNumber: string }> {
  const data = parse(trackingComplaintSchema, input);
  const normalized = normalizePhone(data.phone);
  const phoneHash = createHash("sha256").update(normalized).digest("hex");

  const pkg = await prisma.package.findUnique({
    where: { trackingId },
    select: {
      id: true,
      recipientPhone: true,
      recipientCustomerId: true,
      orderId: true,
    },
  });
  if (!pkg) {
    await prisma.trackingAccessAttempt.create({
      data: { trackingId, phoneHash, succeeded: false },
    });
    throw new NotFoundError(TRACKING_COMPLAINT_DENIAL);
  }
  if (normalizePhone(pkg.recipientPhone) !== normalized) {
    await prisma.trackingAccessAttempt.create({
      data: { trackingId, phoneHash, succeeded: false },
    });
    await prisma.auditLog.create({
      data: {
        actorId: null,
        actorRole: null,
        action: "tracking.detailed_access_denied",
        entityType: "Package",
        entityId: pkg.id,
        after: { trackingId, reason: "phone_mismatch_complaint" },
      },
    });
    throw new NotFoundError(TRACKING_COMPLAINT_DENIAL);
  }
  await prisma.trackingAccessAttempt.create({
    data: { trackingId, phoneHash, succeeded: true },
  });

  const customer = pkg.recipientCustomerId
    ? await prisma.customer.findUnique({
        where: { id: pkg.recipientCustomerId },
        select: { userId: true },
      })
    : null;
  const ticket = await prisma.$transaction((tx) =>
    raiseTicketInTx(tx, {
      category: data.category,
      subject: data.subject,
      description: data.description,
      priority: "NORMAL",
      contactPhone: normalized,
      packageId: pkg.id,
      orderId: pkg.orderId,
      customerId: pkg.recipientCustomerId,
      raisedById: customer?.userId ?? null,
    }),
  );
  return { ticketNumber: ticket.ticketNumber };
}
