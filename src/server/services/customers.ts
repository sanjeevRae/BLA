import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import { AuthorizationError, type ActorContext } from "@/lib/auth/actor";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { CUSTOMER_ADDRESS_KINDS } from "@/lib/bookings/domain";
import { normalizePhone } from "@/lib/bookings/phone";
import {
  auditAccessDenied,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";

/**
 * Customer records (docs/database-schema.md §3; spec §14.3). Customers
 * are deduplicated on the normalised phone; duplicates created through
 * different channels are resolved by merge, never by deletion.
 */

type CustomerRow = Prisma.CustomerGetPayload<object>;
type CustomerAddressRow = Prisma.CustomerAddressGetPayload<object>;

export interface CustomerView {
  id: string;
  fullName: string;
  phone: string;
  normalizedPhone: string;
  email: string | null;
  userId: string | null;
  isMerged: boolean;
  mergedIntoId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerAddressView {
  id: string;
  customerId: string;
  kind: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  district: string;
  province: string;
  municipality: string | null;
  wardNumber: string | null;
  landmark: string | null;
  postalCode: string | null;
  isDefault: boolean;
}

function toView(c: CustomerRow): CustomerView {
  return {
    id: c.id,
    fullName: c.fullName,
    phone: c.phone,
    normalizedPhone: c.normalizedPhone,
    email: c.email,
    userId: c.userId,
    isMerged: c.isMerged,
    mergedIntoId: c.mergedIntoId,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

function toAddressView(a: CustomerAddressRow): CustomerAddressView {
  return {
    id: a.id,
    customerId: a.customerId,
    kind: a.kind,
    addressLine1: a.addressLine1,
    addressLine2: a.addressLine2,
    city: a.city,
    district: a.district,
    province: a.province,
    municipality: a.municipality,
    wardNumber: a.wardNumber,
    landmark: a.landmark,
    postalCode: a.postalCode,
    isDefault: a.isDefault,
  };
}

async function requireCustomerRead(actor: ActorContext): Promise<void> {
  if (
    actor.permissions.has("customer.read") ||
    actor.permissions.has("customer.manage")
  ) {
    return;
  }
  await auditAccessDenied(actor, "Customer", { reason: "missing_permission:customer.read" });
  throw new AuthorizationError("Missing required permission: customer.read");
}

// ---------------------------------------------------------------------------
// Internal: duplicate-aware find-or-create (booking flow)
// ---------------------------------------------------------------------------

/**
 * Resolve a person to a Customer row by normalised phone, creating the
 * record when new. Internal to the service layer — callers perform
 * their own permission checks. Follows merge chains so a merged
 * duplicate resolves to its surviving record.
 */
export async function findOrCreateCustomer(
  tx: Prisma.TransactionClient,
  args: { fullName: string; phone: string; email?: string | null },
  createdById: string | null,
): Promise<CustomerRow> {
  const normalizedPhone = normalizePhone(args.phone);
  const existing = await tx.customer.findUnique({ where: { normalizedPhone } });
  if (existing) {
    if (existing.isMerged && existing.mergedIntoId) {
      const winner = await tx.customer.findUnique({ where: { id: existing.mergedIntoId } });
      if (winner) return winner;
    }
    return existing;
  }
  // Insert with ON CONFLICT DO NOTHING (skipDuplicates): a parallel
  // booking creating the same person must not abort this transaction
  // the way a failed unique insert would (Postgres 25P02) — the row is
  // simply re-read afterwards, whichever transaction won the race.
  await tx.customer.createMany({
    data: [
      {
        fullName: args.fullName,
        phone: args.phone,
        normalizedPhone,
        email: args.email ?? null,
        createdById,
      },
    ],
    skipDuplicates: true,
  });
  const row = await tx.customer.findUnique({ where: { normalizedPhone } });
  if (!row) {
    throw new Error(`Customer find-or-create failed for phone ${normalizedPhone}`);
  }
  if (row.isMerged && row.mergedIntoId) {
    const winner = await tx.customer.findUnique({ where: { id: row.mergedIntoId } });
    if (winner) return winner;
  }
  return row;
}

// ---------------------------------------------------------------------------
// Admin CRUD
// ---------------------------------------------------------------------------

export const createCustomerSchema = z.object({
  fullName: z.string().min(2).max(160),
  phone: z.string().min(7).max(24),
  email: z.string().email().max(254).optional().nullable(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export async function createCustomer(
  actor: ActorContext,
  input: CreateCustomerInput,
): Promise<CustomerView> {
  await requirePermAudited(actor, "customer.manage", "Customer");
  const data = parse(createCustomerSchema, input);
  const normalizedPhone = normalizePhone(data.phone);
  const existing = await prisma.customer.findUnique({ where: { normalizedPhone } });
  if (existing) {
    throw new ConflictError(
      `A customer with this phone already exists (${existing.fullName}, id ${existing.id}) — update or merge that record instead`,
    );
  }
  const customer = await prisma.customer.create({
    data: {
      fullName: data.fullName,
      phone: data.phone,
      normalizedPhone,
      email: data.email ?? null,
      createdById: actor.userId,
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "customer.create",
      entityType: "Customer",
      entityId: customer.id,
      after: { fullName: customer.fullName, normalizedPhone },
    },
  });
  return toView(customer);
}

export const updateCustomerSchema = z.object({
  fullName: z.string().min(2).max(160).optional(),
  phone: z.string().min(7).max(24).optional(),
  email: z.string().email().max(254).optional().nullable(),
});
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export async function updateCustomer(
  actor: ActorContext,
  customerId: string,
  input: UpdateCustomerInput,
): Promise<CustomerView> {
  await requirePermAudited(actor, "customer.manage", "Customer");
  const data = parse(updateCustomerSchema, input);
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new NotFoundError("Customer not found");
  const updated = await prisma.customer.update({
    where: { id: customerId },
    data: {
      ...(data.fullName !== undefined ? { fullName: data.fullName } : {}),
      ...(data.phone !== undefined
        ? { phone: data.phone, normalizedPhone: normalizePhone(data.phone) }
        : {}),
      ...(data.email !== undefined ? { email: data.email } : {}),
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "customer.update",
      entityType: "Customer",
      entityId: customerId,
      before: { fullName: customer.fullName, phone: customer.phone },
      after: { fullName: updated.fullName, phone: updated.phone },
    },
  });
  return toView(updated);
}

export async function getCustomer(actor: ActorContext, customerId: string): Promise<CustomerView> {
  await requireCustomerRead(actor);
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new NotFoundError("Customer not found");
  return toView(customer);
}

export async function listCustomers(
  actor: ActorContext,
  query: { search?: string; page?: number; pageSize?: number } = {},
): Promise<{ customers: CustomerView[]; meta: ReturnType<typeof pageMeta> }> {
  await requireCustomerRead(actor);
  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  const where: Prisma.CustomerWhereInput = {
    isMerged: false,
    ...(query.search
      ? {
          OR: [
            { fullName: { contains: query.search, mode: "insensitive" } },
            { normalizedPhone: { contains: normalizePhone(query.search) } },
            { phone: { contains: query.search } },
          ],
        }
      : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.customer.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    prisma.customer.count({ where }),
  ]);
  return { customers: rows.map(toView), meta: pageMeta(total, page, pageSize) };
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export const customerAddressSchema = z.object({
  kind: z.enum(CUSTOMER_ADDRESS_KINDS).default("DELIVERY"),
  addressLine1: z.string().min(3).max(240),
  addressLine2: z.string().max(240).optional().nullable(),
  city: z.string().min(2).max(120),
  district: z.string().min(2).max(120),
  province: z.string().min(2).max(120),
  municipality: z.string().max(120).optional().nullable(),
  wardNumber: z.string().max(16).optional().nullable(),
  landmark: z.string().max(200).optional().nullable(),
  postalCode: z.string().max(16).optional().nullable(),
  isDefault: z.boolean().default(false),
});
export type CustomerAddressInput = z.infer<typeof customerAddressSchema>;

export async function addCustomerAddress(
  actor: ActorContext,
  customerId: string,
  input: CustomerAddressInput,
): Promise<CustomerAddressView> {
  await requirePermAudited(actor, "customer.manage", "Customer");
  const data = parse(customerAddressSchema, input);
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new NotFoundError("Customer not found");
  const address = await prisma.$transaction(async (tx) => {
    if (data.isDefault) {
      await tx.customerAddress.updateMany({
        where: { customerId },
        data: { isDefault: false },
      });
    }
    return tx.customerAddress.create({ data: { customerId, ...data } });
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "customer.address_add",
      entityType: "Customer",
      entityId: customerId,
      after: { addressId: address.id, district: address.district },
    },
  });
  return toAddressView(address);
}

export async function listCustomerAddresses(
  actor: ActorContext,
  customerId: string,
): Promise<CustomerAddressView[]> {
  if (actor.customerId !== customerId) {
    await requireCustomerRead(actor);
  }
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw new NotFoundError("Customer not found");
  const rows = await prisma.customerAddress.findMany({
    where: { customerId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
  return rows.map(toAddressView);
}

// ---------------------------------------------------------------------------
// Duplicate resolution (spec §14.3): merge, never delete
// ---------------------------------------------------------------------------

export async function mergeCustomers(
  actor: ActorContext,
  winnerId: string,
  loserId: string,
): Promise<CustomerView> {
  await requirePermAudited(actor, "customer.manage", "Customer");
  if (winnerId === loserId) {
    throw new ConflictError("A customer cannot be merged into itself");
  }
  const [winner, loser] = await Promise.all([
    prisma.customer.findUnique({ where: { id: winnerId } }),
    prisma.customer.findUnique({ where: { id: loserId } }),
  ]);
  if (!winner || winner.isMerged) throw new NotFoundError("Surviving customer not found");
  if (!loser || loser.isMerged) throw new NotFoundError("Duplicate customer not found");
  const merged = await prisma.$transaction(async (tx) => {
    await tx.package.updateMany({
      where: { recipientCustomerId: loserId },
      data: { recipientCustomerId: winnerId },
    });
    await tx.order.updateMany({
      where: { customerId: loserId },
      data: { customerId: winnerId },
    });
    return tx.customer.update({
      where: { id: loserId },
      data: { isMerged: true, mergedIntoId: winnerId },
    });
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "customer.merge",
      entityType: "Customer",
      entityId: loserId,
      after: { mergedIntoId: winnerId },
    },
  });
  return toView(merged);
}
