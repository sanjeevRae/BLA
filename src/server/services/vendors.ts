import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";

import { prisma } from "@/lib/db/prisma";
import { AuthorizationError, type ActorContext } from "@/lib/auth/actor";
import { ConflictError, DomainValidationError, NotFoundError } from "@/lib/errors";
import {
  BILLING_PREFERENCES,
  VENDOR_ADDRESS_KINDS,
  VENDOR_DOCUMENT_TYPES,
  VENDOR_MANAGER_ROLES,
  VENDOR_VERIFICATION_STATUSES,
  VENDOR_VERIFICATION_TRANSITIONS,
  type VendorVerificationStatus,
} from "@/lib/bookings/domain";
import {
  auditAccessDenied,
  pageArgs,
  pageMeta,
  parse,
  requirePermAudited,
} from "@/server/services/scoping";

/**
 * Vendor organisations (docs/database-schema.md §3; spec §14.1–§14.2).
 * Created by Admin; people join via invitation (the Phase 2 invitation
 * service, vendor-scoped). The verification lifecycle is Admin-run;
 * only APPROVED vendors can book. A suspended vendor's users lose
 * their sessions immediately (security doc §4.1).
 */

type VendorRow = Prisma.VendorGetPayload<object>;

export interface VendorView {
  id: string;
  businessName: string;
  registrationNumber: string | null;
  contactName: string;
  email: string | null;
  phone: string;
  verificationStatus: string;
  verifiedAt: string | null;
  verificationNotes: string | null;
  billingPreference: string;
  creditLimitPaisa: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VendorAddressView {
  id: string;
  vendorId: string;
  kind: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  district: string;
  province: string;
  postalCode: string | null;
  contactName: string | null;
  contactPhone: string | null;
  isApproved: boolean;
}

export interface VendorDocumentView {
  id: string;
  vendorId: string;
  documentType: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  status: string;
  reviewNotes: string | null;
  createdAt: string;
}

export interface VendorUserView {
  id: string;
  userId: string;
  email: string;
  fullName: string;
  vendorRole: string;
  isActive: boolean;
}

export interface VendorAssignmentView {
  id: string;
  warehouseId: string;
  warehouseCode: string;
  kind: string;
  isActive: boolean;
}

function toView(v: VendorRow): VendorView {
  return {
    id: v.id,
    businessName: v.businessName,
    registrationNumber: v.registrationNumber,
    contactName: v.contactName,
    email: v.email,
    phone: v.phone,
    verificationStatus: v.verificationStatus,
    verifiedAt: v.verifiedAt?.toISOString() ?? null,
    verificationNotes: v.verificationNotes,
    billingPreference: v.billingPreference,
    creditLimitPaisa: v.creditLimitPaisa?.toString() ?? null,
    isActive: v.isActive,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

/** Read access: company readers (vendor.read_all / vendor.manage) or
 *  the vendor's own people. Cross-vendor reads are hidden as 404
 *  (security doc §3.4: existence of another tenant's data never leaks). */
async function requireVendorReadable(actor: ActorContext, vendorId: string): Promise<void> {
  if (actor.permissions.has("vendor.read_all") || actor.permissions.has("vendor.manage")) return;
  if (actor.vendorId === vendorId) return;
  await auditAccessDenied(actor, "Vendor", {
    entityId: vendorId,
    reason: actor.vendorId ? "cross_vendor_read" : "missing_permission:vendor.read_all",
  });
  if (actor.vendorId) throw new NotFoundError("Vendor not found");
  throw new AuthorizationError("Missing required permission: vendor.read_all");
}

/** Self-service management (addresses, documents, team): vendor.manage
 *  holders, or the vendor's own OWNER/MANAGER. */
async function requireVendorManageable(actor: ActorContext, vendorId: string): Promise<void> {
  if (actor.permissions.has("vendor.manage")) return;
  if (actor.vendorId === vendorId && actor.vendorRole && VENDOR_MANAGER_ROLES.includes(actor.vendorRole)) {
    return;
  }
  await auditAccessDenied(actor, "Vendor", {
    entityId: vendorId,
    reason: actor.vendorId ? "vendor_self_manage_denied" : "missing_permission:vendor.manage",
  });
  if (actor.vendorId && actor.vendorId !== vendorId) throw new NotFoundError("Vendor not found");
  throw new AuthorizationError("Vendor management requires vendor.manage or the vendor's OWNER/MANAGER role");
}

// ---------------------------------------------------------------------------
// Organisation CRUD
// ---------------------------------------------------------------------------

const moneyString = z
  .string()
  .regex(/^\d+$/, "Amount must be integer paisa")
  .max(20)
  .optional()
  .nullable();

export const createVendorSchema = z.object({
  businessName: z.string().min(2).max(200),
  registrationNumber: z.string().max(80).optional().nullable(),
  contactName: z.string().min(2).max(160),
  email: z.string().email().max(254).optional().nullable(),
  phone: z.string().min(7).max(24),
  billingPreference: z.enum(BILLING_PREFERENCES).default("COD_OFFSET"),
  creditLimitPaisa: moneyString,
});
export type CreateVendorInput = z.infer<typeof createVendorSchema>;

export async function createVendor(actor: ActorContext, input: CreateVendorInput): Promise<VendorView> {
  await requirePermAudited(actor, "vendor.manage", "Vendor");
  const data = parse(createVendorSchema, input);
  const vendor = await prisma.vendor.create({
    data: {
      businessName: data.businessName,
      registrationNumber: data.registrationNumber ?? null,
      contactName: data.contactName,
      email: data.email ?? null,
      phone: data.phone,
      billingPreference: data.billingPreference,
      creditLimitPaisa: data.creditLimitPaisa ? BigInt(data.creditLimitPaisa) : null,
      createdById: actor.userId,
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "vendor.create",
      entityType: "Vendor",
      entityId: vendor.id,
      after: { businessName: vendor.businessName, verificationStatus: vendor.verificationStatus },
    },
  });
  return toView(vendor);
}

export const updateVendorSchema = z.object({
  businessName: z.string().min(2).max(200).optional(),
  registrationNumber: z.string().max(80).optional().nullable(),
  contactName: z.string().min(2).max(160).optional(),
  email: z.string().email().max(254).optional().nullable(),
  phone: z.string().min(7).max(24).optional(),
  billingPreference: z.enum(BILLING_PREFERENCES).optional(),
  creditLimitPaisa: moneyString,
  isActive: z.boolean().optional(),
});
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;

export async function updateVendor(
  actor: ActorContext,
  vendorId: string,
  input: UpdateVendorInput,
): Promise<VendorView> {
  await requirePermAudited(actor, "vendor.manage", "Vendor");
  const data = parse(updateVendorSchema, input);
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) throw new NotFoundError("Vendor not found");
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.vendor.update({
      where: { id: vendorId },
      data: {
        ...(data.businessName !== undefined ? { businessName: data.businessName } : {}),
        ...(data.registrationNumber !== undefined ? { registrationNumber: data.registrationNumber } : {}),
        ...(data.contactName !== undefined ? { contactName: data.contactName } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.phone !== undefined ? { phone: data.phone } : {}),
        ...(data.billingPreference !== undefined ? { billingPreference: data.billingPreference } : {}),
        ...(data.creditLimitPaisa !== undefined
          ? { creditLimitPaisa: data.creditLimitPaisa ? BigInt(data.creditLimitPaisa) : null }
          : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
      },
    });
    if (data.isActive === false) {
      // Deactivation cuts vendor portal access immediately (P3-4):
      // kill the vendor users' sessions, mirroring the verification
      // lifecycle's handling of exits from APPROVED.
      const links = await tx.vendorUser.findMany({
        where: { vendorId, isActive: true },
        select: { userId: true },
      });
      if (links.length > 0) {
        await tx.session.deleteMany({
          where: { userId: { in: links.map((l) => l.userId) } },
        });
      }
    }
    return row;
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "vendor.update",
      entityType: "Vendor",
      entityId: vendorId,
      before: { businessName: vendor.businessName, isActive: vendor.isActive },
      after: { businessName: updated.businessName, isActive: updated.isActive },
    },
  });
  return toView(updated);
}

export async function getVendor(actor: ActorContext, vendorId: string): Promise<VendorView> {
  await requireVendorReadable(actor, vendorId);
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) throw new NotFoundError("Vendor not found");
  return toView(vendor);
}

export async function listVendors(
  actor: ActorContext,
  query: { search?: string; status?: string; page?: number; pageSize?: number } = {},
): Promise<{ vendors: VendorView[]; meta: ReturnType<typeof pageMeta> }> {
  const { skip, take, page, pageSize } = pageArgs(query.page ?? 1, query.pageSize ?? 25);
  let where: Prisma.VendorWhereInput;
  if (actor.permissions.has("vendor.read_all") || actor.permissions.has("vendor.manage")) {
    where = {
      ...(query.search ? { businessName: { contains: query.search, mode: "insensitive" } } : {}),
      ...(query.status ? { verificationStatus: query.status } : {}),
    };
  } else if (actor.vendorId) {
    // Vendor actors see exactly their own organisation.
    where = { id: actor.vendorId };
  } else {
    await auditAccessDenied(actor, "Vendor", { reason: "missing_permission:vendor.read_all" });
    throw new AuthorizationError("Missing required permission: vendor.read_all");
  }
  const [rows, total] = await Promise.all([
    prisma.vendor.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    prisma.vendor.count({ where }),
  ]);
  return { vendors: rows.map(toView), meta: pageMeta(total, page, pageSize) };
}

// ---------------------------------------------------------------------------
// Verification lifecycle (submit → review → approve / reject / suspend)
// ---------------------------------------------------------------------------

export const verificationTransitionSchema = z.object({
  target: z.enum(VENDOR_VERIFICATION_STATUSES),
  notes: z.string().max(1000).optional().nullable(),
});
export type VerificationTransitionInput = z.infer<typeof verificationTransitionSchema>;

export async function setVendorVerificationStatus(
  actor: ActorContext,
  vendorId: string,
  input: VerificationTransitionInput,
): Promise<VendorView> {
  await requirePermAudited(actor, "vendor.approve", "Vendor");
  const data = parse(verificationTransitionSchema, input);
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    include: { users: { where: { isActive: true } } },
  });
  if (!vendor) throw new NotFoundError("Vendor not found");
  const current = vendor.verificationStatus as VendorVerificationStatus;
  const allowed = VENDOR_VERIFICATION_TRANSITIONS[current] ?? [];
  if (!allowed.includes(data.target)) {
    throw new ConflictError(
      `Vendor verification cannot move from ${current} to ${data.target}; allowed: ${allowed.join(", ") || "none"}`,
    );
  }
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.vendor.update({
      where: { id: vendorId },
      data: {
        verificationStatus: data.target,
        verificationNotes: data.notes ?? vendor.verificationNotes,
        ...(data.target === "APPROVED"
          ? { verifiedById: actor.userId, verifiedAt: new Date() }
          : {}),
      },
    });
    if (current === "APPROVED" && data.target !== "APPROVED") {
      // Leaving APPROVED (suspend / reject / deactivate) kills the
      // vendor users' sessions immediately (P3-4). Combined with
      // getActorContext resolving vendor links only for APPROVED
      // vendors, a fresh login no longer restores portal access.
      const userIds = vendor.users.map((u) => u.userId);
      if (userIds.length > 0) {
        await tx.session.deleteMany({ where: { userId: { in: userIds } } });
      }
    }
    return row;
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "vendor.verification_change",
      entityType: "Vendor",
      entityId: vendorId,
      before: { verificationStatus: current },
      after: { verificationStatus: data.target, notes: data.notes ?? null },
    },
  });
  return toView(updated);
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

export const vendorAddressSchema = z.object({
  kind: z.enum(VENDOR_ADDRESS_KINDS).default("PICKUP"),
  addressLine1: z.string().min(3).max(240),
  addressLine2: z.string().max(240).optional().nullable(),
  city: z.string().min(2).max(120),
  district: z.string().min(2).max(120),
  province: z.string().min(2).max(120),
  postalCode: z.string().max(16).optional().nullable(),
  contactName: z.string().max(160).optional().nullable(),
  contactPhone: z.string().max(24).optional().nullable(),
  /** Admin-only: create the address already approved for pickup. */
  approve: z.boolean().default(false),
});
export type VendorAddressInput = z.infer<typeof vendorAddressSchema>;

export async function addVendorAddress(
  actor: ActorContext,
  vendorId: string,
  input: VendorAddressInput,
): Promise<VendorAddressView> {
  await requireVendorManageable(actor, vendorId);
  const data = parse(vendorAddressSchema, input);
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) throw new NotFoundError("Vendor not found");
  const approvedByAdmin = data.approve && actor.permissions.has("vendor.manage");
  const address = await prisma.vendorAddress.create({
    data: {
      vendorId,
      kind: data.kind,
      addressLine1: data.addressLine1,
      addressLine2: data.addressLine2 ?? null,
      city: data.city,
      district: data.district,
      province: data.province,
      postalCode: data.postalCode ?? null,
      contactName: data.contactName ?? null,
      contactPhone: data.contactPhone ?? null,
      isApproved: approvedByAdmin,
      approvedById: approvedByAdmin ? actor.userId : null,
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "vendor.address_add",
      entityType: "Vendor",
      entityId: vendorId,
      after: { addressId: address.id, kind: address.kind, isApproved: address.isApproved },
    },
  });
  return address;
}

export async function approveVendorAddress(
  actor: ActorContext,
  addressId: string,
): Promise<VendorAddressView> {
  await requirePermAudited(actor, "vendor.manage", "VendorAddress");
  const address = await prisma.vendorAddress.findUnique({ where: { id: addressId } });
  if (!address) throw new NotFoundError("Vendor address not found");
  const updated = await prisma.vendorAddress.update({
    where: { id: addressId },
    data: { isApproved: true, approvedById: actor.userId },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "vendor.address_approve",
      entityType: "Vendor",
      entityId: address.vendorId,
      after: { addressId },
    },
  });
  return updated;
}

export async function listVendorAddresses(
  actor: ActorContext,
  vendorId: string,
): Promise<VendorAddressView[]> {
  await requireVendorReadable(actor, vendorId);
  return prisma.vendorAddress.findMany({
    where: { vendorId },
    orderBy: { createdAt: "asc" },
  });
}

// ---------------------------------------------------------------------------
// Verification documents (metadata)
// ---------------------------------------------------------------------------

export const vendorDocumentSchema = z.object({
  documentType: z.enum(VENDOR_DOCUMENT_TYPES),
  fileName: z.string().min(1).max(240),
  mimeType: z.string().max(120).optional().nullable(),
  sizeBytes: z.number().int().min(0).optional().nullable(),
  storageKey: z.string().max(300).optional().nullable(),
  sha256: z.string().max(64).optional().nullable(),
});
export type VendorDocumentInput = z.infer<typeof vendorDocumentSchema>;

export async function addVendorDocument(
  actor: ActorContext,
  vendorId: string,
  input: VendorDocumentInput,
): Promise<VendorDocumentView> {
  await requireVendorManageable(actor, vendorId);
  const data = parse(vendorDocumentSchema, input);
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId } });
  if (!vendor) throw new NotFoundError("Vendor not found");
  const doc = await prisma.vendorDocument.create({
    data: {
      vendorId,
      documentType: data.documentType,
      fileName: data.fileName,
      mimeType: data.mimeType ?? null,
      sizeBytes: data.sizeBytes ?? null,
      storageKey: data.storageKey ?? null,
      sha256: data.sha256 ?? null,
      uploadedById: actor.userId,
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "vendor.document_add",
      entityType: "Vendor",
      entityId: vendorId,
      after: { documentId: doc.id, documentType: doc.documentType },
    },
  });
  return {
    id: doc.id,
    vendorId: doc.vendorId,
    documentType: doc.documentType,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    reviewNotes: doc.reviewNotes,
    createdAt: doc.createdAt.toISOString(),
  };
}

export async function reviewVendorDocument(
  actor: ActorContext,
  documentId: string,
  decision: "APPROVED" | "REJECTED",
  notes?: string | null,
): Promise<VendorDocumentView> {
  await requirePermAudited(actor, "vendor.approve", "VendorDocument");
  const doc = await prisma.vendorDocument.findUnique({ where: { id: documentId } });
  if (!doc) throw new NotFoundError("Vendor document not found");
  if (doc.status !== "PENDING_REVIEW") {
    throw new ConflictError(`Document is already ${doc.status}`);
  }
  const updated = await prisma.vendorDocument.update({
    where: { id: documentId },
    data: {
      status: decision,
      reviewedById: actor.userId,
      reviewedAt: new Date(),
      reviewNotes: notes ?? null,
    },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "vendor.document_review",
      entityType: "Vendor",
      entityId: doc.vendorId,
      after: { documentId, decision },
    },
  });
  return {
    id: updated.id,
    vendorId: updated.vendorId,
    documentType: updated.documentType,
    fileName: updated.fileName,
    mimeType: updated.mimeType,
    sizeBytes: updated.sizeBytes,
    status: updated.status,
    reviewNotes: updated.reviewNotes,
    createdAt: updated.createdAt.toISOString(),
  };
}

export async function listVendorDocuments(
  actor: ActorContext,
  vendorId: string,
): Promise<VendorDocumentView[]> {
  await requireVendorReadable(actor, vendorId);
  const rows = await prisma.vendorDocument.findMany({
    where: { vendorId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((doc) => ({
    id: doc.id,
    vendorId: doc.vendorId,
    documentType: doc.documentType,
    fileName: doc.fileName,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    status: doc.status,
    reviewNotes: doc.reviewNotes,
    createdAt: doc.createdAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Warehouse assignments & team
// ---------------------------------------------------------------------------

export async function assignVendorWarehouse(
  actor: ActorContext,
  vendorId: string,
  warehouseId: string,
): Promise<VendorAssignmentView> {
  await requirePermAudited(actor, "vendor.manage", "Vendor");
  const [vendor, warehouse] = await Promise.all([
    prisma.vendor.findUnique({ where: { id: vendorId } }),
    prisma.warehouse.findUnique({ where: { id: warehouseId } }),
  ]);
  if (!vendor) throw new NotFoundError("Vendor not found");
  if (!warehouse) throw new NotFoundError("Warehouse not found");
  if (warehouse.status !== "ACTIVE") {
    throw new DomainValidationError("Only an ACTIVE warehouse can be assigned to a vendor");
  }
  const assignment = await prisma.vendorWarehouseAssignment.upsert({
    where: { vendorId_warehouseId_kind: { vendorId, warehouseId, kind: "ORIGIN" } },
    update: { isActive: true, assignedById: actor.userId },
    create: { vendorId, warehouseId, kind: "ORIGIN", assignedById: actor.userId },
  });
  await prisma.auditLog.create({
    data: {
      actorId: actor.userId,
      actorRole: actor.primaryRole,
      action: "vendor.warehouse_assign",
      entityType: "Vendor",
      entityId: vendorId,
      warehouseId,
      after: { assignmentId: assignment.id, kind: "ORIGIN" },
    },
  });
  return {
    id: assignment.id,
    warehouseId,
    warehouseCode: warehouse.code,
    kind: assignment.kind,
    isActive: assignment.isActive,
  };
}

export async function listVendorAssignments(
  actor: ActorContext,
  vendorId: string,
): Promise<VendorAssignmentView[]> {
  await requireVendorReadable(actor, vendorId);
  const rows = await prisma.vendorWarehouseAssignment.findMany({
    where: { vendorId },
    include: { warehouse: { select: { code: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    warehouseId: r.warehouseId,
    warehouseCode: r.warehouse.code,
    kind: r.kind,
    isActive: r.isActive,
  }));
}

export async function listVendorUsers(
  actor: ActorContext,
  vendorId: string,
): Promise<VendorUserView[]> {
  await requireVendorReadable(actor, vendorId);
  const rows = await prisma.vendorUser.findMany({
    where: { vendorId },
    include: { user: { select: { email: true, fullName: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    email: r.user.email,
    fullName: r.user.fullName,
    vendorRole: r.vendorRole,
    isActive: r.isActive,
  }));
}
