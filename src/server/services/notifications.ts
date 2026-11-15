import "server-only";

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import {
  AuthorizationError,
  hasPermission,
  type ActorContext,
} from "@/lib/auth/actor";
import { prisma } from "@/lib/db/prisma";
import { NotFoundError } from "@/lib/errors";
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationChannel,
} from "@/lib/operations/domain";
import {
  auditAccessDenied,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "./scoping";

/**
 * Notification service (spec Part 17; schema doc §10).
 *
 * One Notification row per (event, channel). Channel adapters:
 *  - IN_APP  — the row IS the delivery (deliveryStatus SENT).
 *  - TRACKING — addressed to a package recipient by phone; the row
 *    is AVAILABLE for retrieval through the phone-verified detailed
 *    tracking view. This is how the delivery OTP reaches the
 *    recipient (P6-R1 closure).
 *  - EMAIL / SMS — adapter records intent only. No provider keys
 *    are configured in this deployment, so rows honestly record
 *    NOT_SENT_NO_PROVIDER; an adapter never claims a send that did
 *    not happen. When provider keys land, only `channelStatus`
 *    changes.
 *
 * Creation happens inside the caller's transaction wherever the
 * triggering event is transactional: if the event rolls back, its
 * notifications roll back with it. `dedupeKey` is unique per row, so
 * a retry of the originating event regenerates the same keys and
 * collides instead of double-notifying.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export interface NotificationView {
  id: string;
  category: string;
  channel: string;
  deliveryStatus: string;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

interface NotificationRow {
  id: string;
  category: string;
  channel: string;
  deliveryStatus: string;
  title: string;
  body: string;
  entityType: string | null;
  entityId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    category: row.category,
    channel: row.channel,
    deliveryStatus: row.deliveryStatus,
    title: row.title,
    body: row.body,
    entityType: row.entityType,
    entityId: row.entityId,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CreateNotificationInput {
  userId?: string | null;
  recipientPhone?: string | null;
  recipientCustomerId?: string | null;
  category: NotificationCategory;
  title: string;
  body: string;
  entityType?: string | null;
  entityId?: string | null;
  payload?: Prisma.InputJsonValue | null;
  /** Base idempotency key for the event; the channel is appended. */
  dedupeKey: string;
  channels: NotificationChannel[];
}

function channelDeliveryStatus(channel: NotificationChannel): string {
  switch (channel) {
    case "IN_APP":
      return "SENT";
    case "TRACKING":
      return "AVAILABLE";
    case "EMAIL":
    case "SMS":
      // No live send adapter is wired in this deployment (provider
      // keys are blank), so the row honestly records intent only.
      // When the provider integration lands, this is the single
      // place that starts returning SENT after a real send.
      return "NOT_SENT_NO_PROVIDER";
  }
}

/**
 * Create the channel rows for one notification event inside `db`
 * (a transaction client wherever the caller is transactional).
 * Returns how many rows were actually created (dedupe collisions
 * and disabled preferences create none).
 */
export async function createNotificationInTx(
  db: Db,
  input: CreateNotificationInput,
): Promise<number> {
  let created = 0;
  for (const channel of input.channels) {
    if (channel === "IN_APP") {
      if (!input.userId) continue;
      // Per-user preferences: an explicitly disabled (category,
      // channel) pair suppresses the row. In-app defaults on.
      const pref = await db.notificationPreference.findUnique({
        where: {
          userId_category_channel: {
            userId: input.userId,
            category: input.category,
            channel: "IN_APP",
          },
        },
        select: { enabled: true },
      });
      if (pref && !pref.enabled) continue;
    }
    if (channel === "TRACKING" && !input.recipientPhone) continue;
    const result = await db.notification.createMany({
      data: [
        {
          userId: input.userId ?? null,
          recipientPhone: input.recipientPhone ?? null,
          recipientCustomerId: input.recipientCustomerId ?? null,
          category: input.category,
          channel,
          deliveryStatus: channelDeliveryStatus(channel),
          title: input.title,
          body: input.body,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          payload: input.payload ?? undefined,
          dedupeKey: `${input.dedupeKey}:${channel}`,
        },
      ],
      skipDuplicates: true,
    });
    created += result.count;
  }
  return created;
}

/** Fan a notification out to many app users (one dedupe branch per user). */
export async function notifyUsersInTx(
  db: Db,
  userIds: Iterable<string>,
  input: Omit<CreateNotificationInput, "userId" | "channels"> & { channels?: NotificationChannel[] },
): Promise<number> {
  let created = 0;
  const seen = new Set<string>();
  for (const userId of userIds) {
    if (seen.has(userId)) continue;
    seen.add(userId);
    created += await createNotificationInTx(db, {
      ...input,
      userId,
      dedupeKey: `${input.dedupeKey}:${userId}`,
      channels: input.channels ?? ["IN_APP"],
    });
  }
  return created;
}

/** Active users holding any of the given roles (global fan-out). */
export async function userIdsWithRoles(
  db: Db,
  roleCodes: string[],
): Promise<string[]> {
  const rows = await db.userRole.findMany({
    where: { role: { code: { in: roleCodes } }, user: { status: "ACTIVE" } },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
}

/** Active WAREHOUSE_ADMIN members of one warehouse. */
export async function warehouseAdminUserIds(
  db: Db,
  warehouseId: string,
): Promise<string[]> {
  const rows = await db.warehouseMembership.findMany({
    where: { warehouseId, revokedAt: null, role: { code: "WAREHOUSE_ADMIN" } },
    select: { userId: true },
  });
  return [...new Set(rows.map((r) => r.userId))];
}

/** All login-enabled users of a vendor organisation. */
export async function vendorUserIds(db: Db, vendorId: string): Promise<string[]> {
  const rows = await db.vendorUser.findMany({
    where: { vendorId },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

// ---------------------------------------------------------------------------
// Per-user reads (the bell / panel)
// ---------------------------------------------------------------------------

export const listNotificationsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  unreadOnly: z.coerce.boolean().default(false),
  category: z.enum(NOTIFICATION_CATEGORIES).optional(),
});
export type ListNotificationsInput = z.input<typeof listNotificationsSchema>;

export async function listMyNotifications(actor: ActorContext, input: ListNotificationsInput) {
  const data = parse(listNotificationsSchema, input);
  await requirePermAudited(actor, "notification.read_own", "Notification");
  const { skip, take } = pageArgs(data.page, data.pageSize);
  // Own rows only — staff lists must never surface recipient rows
  // (userId NULL), which can carry delivery codes.
  const where: Prisma.NotificationWhereInput = {
    AND: [
      { userId: actor.userId },
      { channel: "IN_APP" },
      ...(data.unreadOnly ? [{ readAt: null }] : []),
      ...(data.category ? [{ category: data.category }] : []),
    ],
  };
  const [total, unreadCount, rows] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.count({
      where: { userId: actor.userId, channel: "IN_APP", readAt: null },
    }),
    prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: "desc" }],
      skip,
      take,
    }),
  ]);
  return {
    items: rows.map(toView),
    unreadCount,
    meta: pageMeta(total, data.page, data.pageSize),
  };
}

export async function getMyUnreadCount(actor: ActorContext): Promise<{ count: number }> {
  // Chrome read: roles without notification.read_own (CUSTOMER)
  // simply have no bell count — never an error in the shell.
  if (!hasPermission(actor, "notification.read_own")) return { count: 0 };
  const count = await prisma.notification.count({
    where: { userId: actor.userId, channel: "IN_APP", readAt: null },
  });
  return { count };
}

export async function markNotificationRead(actor: ActorContext, notificationId: string) {
  await requirePermAudited(actor, "notification.read_own", "Notification");
  const row = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!row) throw new NotFoundError("Notification not found");
  if (row.userId !== actor.userId) {
    await auditAccessDenied(actor, "Notification", {
      entityId: notificationId,
      reason: "notification_not_owned",
    });
    throw new AuthorizationError("You can only mark your own notifications read");
  }
  if (!row.readAt) {
    await prisma.notification.update({
      where: { id: notificationId },
      data: { readAt: new Date() },
    });
  }
  const fresh = await prisma.notification.findUniqueOrThrow({ where: { id: notificationId } });
  return toView(fresh);
}

export async function markAllMyNotificationsRead(actor: ActorContext) {
  await requirePermAudited(actor, "notification.read_own", "Notification");
  const result = await prisma.notification.updateMany({
    where: { userId: actor.userId, channel: "IN_APP", readAt: null },
    data: { readAt: new Date() },
  });
  return { marked: result.count };
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export async function getMyNotificationPreferences(actor: ActorContext) {
  await requirePermAudited(actor, "notification.read_own", "Notification");
  const rows = await prisma.notificationPreference.findMany({
    where: { userId: actor.userId },
    orderBy: [{ category: "asc" }, { channel: "asc" }],
  });
  const explicit = new Map(rows.map((r) => [`${r.category}:${r.channel}`, r.enabled]));
  const matrix: { category: string; channel: string; enabled: boolean }[] = [];
  for (const category of NOTIFICATION_CATEGORIES) {
    for (const channel of ["IN_APP", "EMAIL", "SMS"] as const) {
      matrix.push({
        category,
        channel,
        enabled: explicit.get(`${category}:${channel}`) ?? true,
      });
    }
  }
  return matrix;
}

export const updatePreferenceSchema = z.object({
  category: z.enum(NOTIFICATION_CATEGORIES),
  channel: z.enum(["IN_APP", "EMAIL", "SMS"]),
  enabled: z.boolean(),
});
export type UpdatePreferenceInput = z.input<typeof updatePreferenceSchema>;

export async function updateMyNotificationPreference(
  actor: ActorContext,
  input: UpdatePreferenceInput,
) {
  const data = parse(updatePreferenceSchema, input);
  await requirePermAudited(actor, "notification.read_own", "Notification");
  const row = await prisma.notificationPreference.upsert({
    where: {
      userId_category_channel: {
        userId: actor.userId,
        category: data.category,
        channel: data.channel,
      },
    },
    create: {
      userId: actor.userId,
      category: data.category,
      channel: data.channel,
      enabled: data.enabled,
    },
    update: { enabled: data.enabled },
  });
  return { category: row.category, channel: row.channel, enabled: row.enabled };
}
